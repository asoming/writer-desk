"""Native smoke shutdown targets its own window and never hides cleanup failures."""
import importlib.util
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_smoke", ROOT / "scripts/smoke-native.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class Child:
    pid = 501
    returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        self.wait_timeout = timeout
        self.returncode = 0


class Windows:
    def __init__(self, child):
        self.child = child
        self.windows = {11: (900, True), 22: (child.pid, False), 33: (child.pid, True)}
        self.posted = []
        self.enumerations = 0
        self.reject = False

    def EnumWindows(self, callback, parameter):
        self.enumerations += 1
        for handle in self.windows:
            callback(handle, parameter)
        return True

    def GetWindowThreadProcessId(self, handle, owner):
        owner._obj.value = self.windows[handle][0]
        return 1

    def IsWindowVisible(self, handle):
        return self.windows[handle][1]

    def PostMessageW(self, *args):
        self.posted.append(args)
        return not self.reject


class NativeSmokeTests(unittest.TestCase):
    def test_close_targets_only_stable_visible_window_of_spawned_pid(self):
        child = Child()
        windows = Windows(child)
        with patch.object(smoke.time, "sleep"):
            smoke.close_windows_desktop(child, windows)
        self.assertEqual(windows.enumerations, 2)
        self.assertEqual(windows.posted, [(33, 0x0010, 0, 0)])
        self.assertEqual(child.returncode, 0)
        self.assertGreater(child.wait_timeout, 0)

    def test_window_ownership_is_rechecked_before_close(self):
        child = Child()
        windows = Windows(child)
        original = windows.GetWindowThreadProcessId
        calls = 0

        def ownership(handle, owner):
            nonlocal calls
            original(handle, owner)
            calls += 1
            if calls == 7:
                owner._obj.value = 900

        windows.GetWindowThreadProcessId = ownership
        with patch.object(smoke.time, "sleep"), self.assertRaisesRegex(RuntimeError, "ownership changed"):
            smoke.close_windows_desktop(child, windows)
        self.assertEqual(windows.posted, [])

    def test_ambiguous_windows_fail_without_sending_messages(self):
        child = Child()
        windows = Windows(child)
        windows.windows[44] = (child.pid, True)
        with self.assertRaisesRegex(RuntimeError, "one visible window"):
            smoke.close_windows_desktop(child, windows)
        self.assertEqual(windows.posted, [])

    def test_close_rejection_is_a_failure(self):
        child = Child()
        windows = Windows(child)
        windows.reject = True
        with patch.object(smoke.time, "sleep"), self.assertRaisesRegex(RuntimeError, "rejected"):
            smoke.close_windows_desktop(child, windows)
        self.assertIsNone(child.returncode)

    def test_save_close_timeout_is_a_failure(self):
        child = Child()
        windows = Windows(child)
        child.wait = lambda timeout: (_ for _ in ()).throw(subprocess.TimeoutExpired("isolated", timeout))
        with patch.object(smoke.time, "sleep"), self.assertRaisesRegex(RuntimeError, "normal save/close"):
            smoke.close_windows_desktop(child, windows)

    def test_missing_owned_window_times_out_without_touching_other_app(self):
        child = Child()
        windows = Windows(child)
        windows.windows = {11: (900, True)}
        with patch.object(smoke.time, "sleep"), patch.object(smoke.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(RuntimeError, "stable visible window"):
                smoke.close_windows_desktop(child, windows, timeout=1)
        self.assertEqual(windows.posted, [])

    def test_windows_cleanup_retries_only_permission_errors(self):
        attempts = []

        class Directory:
            def cleanup(self):
                attempts.append(True)
                if len(attempts) < 3:
                    raise PermissionError("cache handle not yet released")

        with patch.object(smoke.sys, "platform", "win32"), patch.object(smoke.time, "sleep"):
            smoke.cleanup_disposable_directory(Directory())
        self.assertEqual(len(attempts), 3)

    def test_windows_cleanup_still_raises_after_bounded_retry(self):
        denied = PermissionError("cache handle still open")

        class Directory:
            def cleanup(self):
                raise denied

        with patch.object(smoke.sys, "platform", "win32"), patch.object(smoke.time, "sleep") as sleep:
            with patch.object(smoke.time, "monotonic", side_effect=[0, 0.1, 6]):
                with self.assertRaises(PermissionError) as result:
                    smoke.cleanup_disposable_directory(Directory())
        self.assertIs(result.exception, denied)
        sleep.assert_called_once_with(0.1)

    def test_other_platform_cleanup_is_not_retried(self):
        class Directory:
            def cleanup(self):
                raise PermissionError("denied")

        with patch.object(smoke.sys, "platform", "linux"), patch.object(smoke.time, "sleep") as sleep:
            with self.assertRaises(PermissionError):
                smoke.cleanup_disposable_directory(Directory())
        sleep.assert_not_called()

    def test_desktop_sqlite_fixture_closes_even_with_live_python_reference(self):
        connections = []
        real_connect = sqlite3.connect

        class LoadedProcess:
            def __init__(self, *_):
                pass

            def until(self, predicate):
                assert predicate("Desktop window loaded; local storage service is ready.")

            def cleanup(self):
                pass

        def connect(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connections.append(connection)
            return connection

        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            (data / "data").mkdir()
            database = data / "data/writer.sqlite3"
            seed = real_connect(database)
            try:
                seed.execute("create table books(id integer)")
                seed.executemany("insert into books values (?)", [(1,), (2,), (3,)])
                seed.commit()
            finally:
                seed.close()
            with patch.object(smoke, "Process", LoadedProcess), patch.object(smoke.sqlite3, "connect", connect):
                with patch.object(smoke.sys, "platform", "linux"):
                    smoke.desktop_smoke(Path("isolated-app"), data)
            self.assertEqual(len(connections), 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                connections[0].execute("select 1")
            database.rename(database.with_suffix(".closed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
