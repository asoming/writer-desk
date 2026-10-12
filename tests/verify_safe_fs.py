"""Native storage contracts against disposable directories on every target OS."""
import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import safe_fs


class DescriptorOwnershipTests(unittest.TestCase):
    class Parent:
        def __init__(self):
            self.releases = 0

        def _release(self):
            self.releases += 1

    def test_descriptor_close_cannot_release_a_reused_descriptors_parent(self):
        old, new = self.Parent(), self.Parent()
        parents = {7: old}

        def close_and_reuse(descriptor):
            self.assertEqual(descriptor, 7)
            self.assertNotIn(7, parents, "Ownership must be detached before the CRT close")
            self.assertEqual(old.releases, 0, "Ancestors stay pinned throughout close")
            parents[7] = new  # Another thread immediately receives this integer.

        safe_fs._close_pinned_descriptor(7, close_and_reuse, parents)
        self.assertIs(parents[7], new)
        self.assertEqual(old.releases, 1)
        self.assertEqual(new.releases, 0)

    def test_stream_exit_and_close_keep_their_exact_parent_after_descriptor_reuse(self):
        for operation in ("close", "context"):
            with self.subTest(operation=operation):
                old, new = self.Parent(), self.Parent()
                parents = {7: old}
                test = self

                class ReusingStream:
                    closed = False

                    def __enter__(self):
                        return self

                    def __exit__(self, *args):
                        self.close()

                    def close(self):
                        if not self.closed:
                            self.closed = True
                            test.assertNotIn(7, parents)
                            test.assertEqual(old.releases, 0)
                            parents[7] = new

                stream = safe_fs._pin_stream(ReusingStream(), 7, parents)
                self.assertNotIn(7, parents, "The stream now owns the parent directly")
                if operation == "context":
                    with stream:
                        self.assertEqual(old.releases, 0)
                else:
                    stream.close()
                stream.close()  # Includes the later destructor's idempotent path.
                self.assertIs(parents[7], new)
                self.assertEqual(old.releases, 1)
                self.assertEqual(new.releases, 0)

    def test_failed_close_still_releases_only_the_original_parent(self):
        old, new = self.Parent(), self.Parent()
        parents = {7: old}

        def fail_and_reuse(descriptor):
            parents[descriptor] = new
            raise OSError("simulated close failure")

        with self.assertRaises(OSError):
            safe_fs._close_pinned_descriptor(7, fail_and_reuse, parents)
        self.assertIs(parents[7], new)
        self.assertEqual(old.releases, 1)
        self.assertEqual(new.releases, 0)


class SafeStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-safe-fs-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.flags = safe_fs.O_RDONLY | safe_fs.O_DIRECTORY | safe_fs.O_NOFOLLOW

    def test_posix_keeps_native_descriptor_apis(self):
        if os.name != "nt":
            self.assertIs(safe_fs.open, os.open)
            self.assertIs(safe_fs.replace, os.replace)
            self.assertIs(safe_fs.supports_dir_fd, os.supports_dir_fd)
        self.assertIn(safe_fs.open, safe_fs.supports_dir_fd)

    def test_relative_io_replace_link_and_cleanup(self):
        directory = safe_fs.open(self.root, self.flags)
        try:
            safe_fs.mkdir("owned", 0o700, dir_fd=directory)
            child = safe_fs.open("owned", self.flags, dir_fd=directory)
            try:
                descriptor = safe_fs.open("temporary", safe_fs.O_WRONLY | safe_fs.O_CREAT | safe_fs.O_EXCL | safe_fs.O_NOFOLLOW, 0o600, dir_fd=child)
                with safe_fs.fdopen(descriptor, "wb") as stream:
                    stream.write("本机正文🌙".encode())
                    stream.flush()
                    safe_fs.fsync(stream.fileno())
                with self.assertRaises(FileExistsError):
                    safe_fs.open("temporary", safe_fs.O_WRONLY | safe_fs.O_CREAT | safe_fs.O_EXCL | safe_fs.O_NOFOLLOW, 0o600, dir_fd=child)
                safe_fs.replace("temporary", "saved", src_dir_fd=child, dst_dir_fd=child)
                safe_fs.fsync(child)
                descriptor = safe_fs.open("saved", safe_fs.O_RDONLY | safe_fs.O_NOFOLLOW, dir_fd=child)
                with safe_fs.fdopen(descriptor, "rb") as stream:
                    self.assertEqual(stream.read().decode(), "本机正文🌙")
                safe_fs.link("saved", "linked", src_dir_fd=child, dst_dir_fd=child, follow_symlinks=False)
                with self.assertRaises(FileExistsError):
                    safe_fs.link("saved", "linked", src_dir_fd=child, dst_dir_fd=child, follow_symlinks=False)
                self.assertEqual(set(safe_fs.listdir(child)), {"saved", "linked"})
                self.assertEqual(safe_fs.stat("saved", dir_fd=child, follow_symlinks=False).st_nlink, 2)
                safe_fs.unlink("linked", dir_fd=child)
                safe_fs.unlink("saved", dir_fd=child)
                self.assertEqual(safe_fs.listdir(child), [])
            finally:
                safe_fs.close(child)
        finally:
            safe_fs.close(directory)

    def test_links_are_rejected_without_touching_the_target(self):
        external = self.root / "outside"
        external.mkdir()
        sentinel = external / "keep.txt"
        sentinel.write_text("保留", encoding="utf-8")
        linked = self.root / "linked"
        if os.name == "nt":
            result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(linked), str(external)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        else:
            linked.symlink_to(external, target_is_directory=True)
        with self.assertRaises(OSError) as error:
            safe_fs.open(linked, self.flags)
        self.assertIn(error.exception.errno, (errno.ELOOP, errno.ENOTDIR))
        self.assertEqual(sentinel.read_text("utf-8"), "保留")
        self.assertEqual(list(external.iterdir()), [sentinel])

    @unittest.skipUnless(os.name == "nt", "Windows native handle contract")
    def test_windows_pins_every_ancestor_until_the_last_child_closes(self):
        ancestor = self.root / "ancestor"
        folder = ancestor / "child"
        folder.mkdir(parents=True)
        # Opening only the deepest directory must pin the whole chain.
        descriptor = safe_fs.open(folder, self.flags)
        moved = self.root / "moved"
        try:
            with self.assertRaises(PermissionError):
                ancestor.rename(moved)
            for name in ("../escape", "..", str(self.root / "absolute"), "entry:stream", "NUL", "trailing.", "space "):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    safe_fs.open(name, safe_fs.O_RDONLY | safe_fs.O_NOFOLLOW, dir_fd=descriptor)
        finally:
            safe_fs.close(descriptor)
        ancestor.rename(moved)
        self.assertTrue((moved / "child").is_dir())
        with self.assertRaises(OSError):
            safe_fs.listdir(descriptor)


if __name__ == "__main__":
    unittest.main(verbosity=2)
