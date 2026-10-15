"""A closing sync worker may call the root adapter; joining cannot own its gate."""
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server_extensions as extensions
from sync_client import SyncError


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        self.saved = extensions._service, extensions._service_path, extensions._closing_paths
        extensions._service = extensions._service_path = None
        extensions._closing_paths = set()

    def tearDown(self):
        extensions._service, extensions._service_path, extensions._closing_paths = self.saved

    def worker_service(self, srv):
        result = {}
        def close():
            def callback():
                try:
                    extensions.sync_service(srv)
                    result['rebuilt'] = True
                except SyncError as error:
                    result['status'] = error.status
            worker = threading.Thread(target=callback, daemon=True)
            worker.start()
            worker.join(1)
            result['deadlocked'] = worker.is_alive()
        return SimpleNamespace(close=close), result

    def test_shutdown_releases_registry_before_join_and_rejects_rebuild(self):
        srv = SimpleNamespace(DB_PATH=Path('/tmp/shutdown-fixture/writer.sqlite3'))
        service, result = self.worker_service(srv)
        extensions._service, extensions._service_path = service, srv.DB_PATH
        with patch.object(extensions, 'SyncService') as factory:
            extensions.close()
            factory.assert_not_called()
        self.assertEqual(result, {'status': 503, 'deadlocked': False})
        self.assertIsNone(extensions._service)

    def test_replacement_stops_previous_worker_outside_registry_lock(self):
        old = SimpleNamespace(DB_PATH=Path('/tmp/old-sync-fixture/writer.sqlite3'))
        new = SimpleNamespace(DB_PATH=Path('/tmp/new-sync-fixture/writer.sqlite3'), validate_book=lambda value: value)
        service, result = self.worker_service(old)
        replacement = SimpleNamespace(close=lambda: None)
        extensions._service, extensions._service_path = service, old.DB_PATH
        with patch.object(extensions, 'SyncService', return_value=replacement) as factory:
            self.assertIs(extensions.sync_service(new), replacement)
            factory.assert_called_once()
        self.assertEqual(result, {'status': 503, 'deadlocked': False})
        self.assertEqual(extensions._service_path, new.DB_PATH)


if __name__ == '__main__':
    unittest.main(verbosity=2)
