"""Destructive lifecycle tests use disposable libraries and never installed data."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import protection


class PurgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-book-purge-")
        self.addCleanup(self.temporary.cleanup)
        self.previous_db = server.DB_PATH
        self.addCleanup(setattr, server, "DB_PATH", self.previous_db)
        server.DB_PATH = Path(self.temporary.name) / "writer.sqlite3"
        server.initialize()

    def book(self, deleted_at=None):
        book = server.new_book("隔离清理检验")
        book["chapters"] = [server.chapter("正文", "此正文只能属于这部作品。", book["volumes"][0]["id"])]
        with server.connect() as conn:
            server.insert_book(conn, book)
            conn.execute("UPDATE books SET deleted_at=? WHERE id=?", (deleted_at, book["id"]))
        return book

    def exists(self, book_id):
        with server.connect() as conn:
            return bool(conn.execute("SELECT 1 FROM books WHERE id=?", (book_id,)).fetchone())

    def snapshot(self, book):
        return server.checkpoint_book(book["id"], force=True)

    def trash(self, book):
        return server.change_book_trash("/api/books/" + book["id"] + "/trash", {"revision": 1})

    def purge(self, book):
        return server.change_book_trash("/api/books/" + book["id"] + "/purge", {"revision": 2})

    def backup_dir(self, book):
        return server.DB_PATH.parent / "backups" / ("book-" + hashlib.sha256(book["id"].encode()).hexdigest())

    def pending(self, book):
        with server.connect() as conn:
            return bool(conn.execute("SELECT 1 FROM pending_book_purges WHERE book_id=?", (book["id"],)).fetchone())

    def test_exact_30_day_boundary_timezone_offsets_future_bad_and_naive_dates(self):
        moment = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
        cutoff = moment - timedelta(days=30)
        due = [self.book(cutoff.isoformat()), self.book((cutoff - timedelta(microseconds=1)).isoformat()),
               self.book(cutoff.astimezone(timezone(timedelta(hours=8))).isoformat()), self.book(cutoff.isoformat().replace("+00:00", "Z"))]
        retained = [self.book((cutoff + timedelta(microseconds=1)).isoformat()), self.book((moment + timedelta(days=1)).isoformat()),
                    self.book("not-a-date"), self.book("2020-01-01T00:00:00"), self.book(""), self.book(None), self.book("9999-12-31T23:59:59Z")]
        with server.connect() as conn:
            before = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM books")}
        self.assertEqual(set(server.cleanup_expired_books(moment)), {book["id"] for book in due})
        self.assertTrue(all(not self.exists(book["id"]) for book in due))
        with server.connect() as conn:
            for book in retained:
                self.assertEqual(dict(conn.execute("SELECT * FROM books WHERE id=?", (book["id"],)).fetchone()), before[book["id"]])
        self.assertIsNone(server.trash_expiry("not-a-date"))
        self.assertIsNone(server.trash_expiry("2020-01-01T00:00:00"))
        self.assertEqual(server.trash_expiry(cutoff.isoformat()), moment)
        with self.assertRaises(ValueError):
            server.cleanup_expired_books(moment.replace(tzinfo=None))

    def test_only_whole_book_deleted_at_authorizes_expiry_and_startup_removes_due_books(self):
        active = self.book()
        active["chapters"][0]["deletedAt"] = "2000-01-01T00:00:00Z"
        with server.connect() as conn:
            conn.execute("UPDATE books SET payload=?,created_at=?,updated_at=? WHERE id=?", (json.dumps(active), "2000", "2000", active["id"]))
        due = self.book((datetime.now(timezone.utc) - timedelta(days=31)).isoformat())
        unknown = self.book("2000-01-01")
        server.initialize()
        self.assertFalse(self.exists(due["id"]))
        self.assertTrue(self.exists(active["id"]) and self.exists(unknown["id"]))
        with server.connect() as conn:
            self.assertEqual(json.loads(conn.execute("SELECT payload FROM books WHERE id=?", (active["id"],)).fetchone()[0]), active)

    def test_automatic_expiry_removes_history_runs_and_owned_snapshots(self):
        book = self.book()
        snapshot = self.snapshot(book)
        with server.connect() as conn:
            row = server.saved_book_row(conn, book["id"])
            server.preserve_history(conn, row, server.now())
            conn.execute("UPDATE books SET deleted_at=? WHERE id=?", ((datetime.now(timezone.utc) - timedelta(days=31)).isoformat(), book["id"]))
        server.cleanup_expired_books()
        with server.connect() as conn:
            for table, column in (("books", "id"), ("history", "book_id"), ("backup_runs", "book_id"), ("pending_book_purges", "book_id")):
                self.assertIsNone(conn.execute("SELECT 1 FROM " + table + " WHERE " + column + "=?", (book["id"],)).fetchone())
        self.assertFalse((self.backup_dir(book) / snapshot["token"]).exists())
        with self.assertRaises(protection.ProtectionError) as error:
            server.checkpoint_book(book["id"])
        self.assertEqual(error.exception.status, 404)

    def test_disk_failure_keeps_a_durable_cleanup_job_and_restart_retries(self):
        book = self.book()
        snapshot = self.snapshot(book)
        self.trash(book)
        with patch.object(protection, "purge_snapshots", side_effect=OSError("simulated private path")):
            result = self.purge(book)
        self.assertTrue(result["cleanupPending"])
        self.assertFalse(self.exists(book["id"]))
        self.assertTrue(self.pending(book))
        self.assertTrue((self.backup_dir(book) / snapshot["token"]).is_file())
        server.initialize()
        self.assertFalse(self.pending(book))
        self.assertFalse((self.backup_dir(book) / snapshot["token"]).exists())
        self.assertFalse(self.exists(book["id"]))

    def test_symlinked_snapshot_directory_is_not_followed_and_cleanup_can_retry_safely(self):
        book = self.book()
        snapshot = self.snapshot(book)
        folder = self.backup_dir(book)
        held = folder.with_name(folder.name + "-held")
        folder.rename(held)
        external = Path(self.temporary.name) / "external"
        external.mkdir()
        sentinel = external / snapshot["token"]
        sentinel.write_text("用户文件，不属于应用管理。")
        folder.symlink_to(external, target_is_directory=True)
        self.trash(book)
        self.assertTrue(self.purge(book)["cleanupPending"])
        self.assertEqual(sentinel.read_text(), "用户文件，不属于应用管理。")
        self.assertTrue((held / snapshot["token"]).exists())
        folder.unlink()
        held.rename(folder)
        server.cleanup_expired_books()
        self.assertFalse(self.pending(book))
        self.assertFalse((folder / snapshot["token"]).exists())
        self.assertEqual(sentinel.read_text(), "用户文件，不属于应用管理。")

    def test_snapshot_cleanup_preserves_other_books_unknown_files_links_subdirectories_and_exported_folders(self):
        book, other = self.book(), self.book()
        owned, foreign = self.snapshot(book), self.snapshot(other)
        folder, other_folder = self.backup_dir(book), self.backup_dir(other)
        other_content = (other_folder / foreign["token"]).read_bytes()
        foreign_name = "r1-" + "a" * 32 + ".json"
        shutil.copyfile(other_folder / foreign["token"], folder / foreign_name)
        (folder / "user-note.txt").write_text("不得删除用户文件")
        (folder / "unknown.json").write_text("不属于自动快照")
        (folder / "nested").mkdir()
        (folder / "nested" / "owned-looking.json").write_text("不能递归删除")
        link = folder / ("r1-" + "b" * 32 + ".json")
        link.symlink_to(other_folder / foreign["token"])
        export = Path(server.sync_book_folder(book["id"], create=True)["folder"])
        export_before = {item.name: item.read_bytes() for item in export.iterdir()}
        self.trash(book)
        self.assertNotIn("cleanupPending", self.purge(book))
        self.assertFalse((folder / owned["token"]).exists())
        self.assertEqual((folder / foreign_name).read_bytes(), other_content)
        self.assertEqual((other_folder / foreign["token"]).read_bytes(), other_content)
        self.assertTrue(link.is_symlink())
        self.assertEqual((folder / "user-note.txt").read_text(), "不得删除用户文件")
        self.assertEqual((folder / "nested" / "owned-looking.json").read_text(), "不能递归删除")
        self.assertEqual({item.name: item.read_bytes() for item in export.iterdir()}, export_before)
        self.assertTrue(self.exists(other["id"]))

    def test_failed_database_transaction_rolls_back_the_purge_and_does_not_touch_snapshots(self):
        book = self.book()
        snapshot = self.snapshot(book)
        self.trash(book)
        with server.connect() as conn:
            conn.execute("CREATE TRIGGER refuse_book_delete BEFORE DELETE ON books BEGIN SELECT RAISE(ABORT,'simulated failure'); END")
        with self.assertRaises(Exception):
            self.purge(book)
        self.assertTrue(self.exists(book["id"]))
        self.assertFalse(self.pending(book))
        self.assertTrue((self.backup_dir(book) / snapshot["token"]).exists())

    def test_running_worker_expires_books_and_stop_wakes_its_long_wait_without_hanging(self):
        book = self.book((datetime.now(timezone.utc) - timedelta(days=31)).isoformat())
        stop, worker = server.start_trash_cleanup(interval=0.01)
        try:
            deadline = time.monotonic() + 3
            while self.exists(book["id"]) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.exists(book["id"]))
        finally:
            stop.set()
            worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        stop, worker = server.start_trash_cleanup(interval=60)
        self.assertTrue(worker.daemon)
        start = time.monotonic()
        stop.set()
        worker.join(timeout=0.5)
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic() - start, 0.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
