"""Verify one-time demo seeding only against disposable SQLite databases."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server

SOURCE = ROOT / "examples" / "tide-archive.yejian.json"
CANONICAL = json.loads(SOURCE.read_text("utf-8"))["book"]
CHAPTER_IDS = {item["id"] for item in CANONICAL["chapters"]}
ASSET_HASHES = {path: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in (SOURCE, ROOT / "examples" / "潮汐档案馆.txt")}


class DefaultDemoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-default-demo-")
        self.db = Path(self.temporary.name) / "writer.sqlite3"
        self.previous_db, self.previous_root = server.DB_PATH, server.ROOT
        server.DB_PATH = self.db

    def tearDown(self):
        server.DB_PATH, server.ROOT = self.previous_db, self.previous_root
        self.temporary.cleanup()
        for path, digest in ASSET_HASHES.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest, "Canonical example bytes changed")

    def legacy_library(self, books):
        """Create the pre-migration schema with authored revisions/history."""
        with sqlite3.connect(self.db) as conn:
            conn.execute("CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
            conn.execute("CREATE TABLE history(id INTEGER PRIMARY KEY,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,saved_at TEXT NOT NULL)")
            for index, book in enumerate(books):
                payload = json.dumps(book, ensure_ascii=False)
                conn.execute("INSERT INTO books(id,title,payload,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)", (book["id"], book["title"], payload, 7 + index, "created-original", "updated-original"))
                conn.execute("INSERT INTO history(book_id,revision,payload,saved_at) VALUES(?,?,?,?)", (book["id"], 3, payload, "history-original"))

    def snapshot(self):
        with sqlite3.connect(self.db) as conn:
            return (dict((row[0], row) for row in conn.execute("SELECT id,title,payload,revision,created_at,updated_at FROM books")),
                    list(conn.execute("SELECT * FROM history ORDER BY id")))

    def marker_count(self):
        with sqlite3.connect(self.db) as conn:
            return conn.execute("SELECT count(*) FROM app_migrations WHERE name=?", (server.DEFAULT_EXAMPLE_MIGRATION,)).fetchone()[0]

    def demos(self):
        records, _ = self.snapshot()
        books = [json.loads(row[2]) for row in records.values()]
        return [book for book in books if book["id"] == CANONICAL["id"] or any(
            isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] in CHAPTER_IDS
            for item in book.get("chapters", []))]

    def assert_preserved(self, before):
        after = self.snapshot()
        self.assertEqual({key: after[0][key] for key in before[0]}, before[0], "Existing payloads/revisions/timestamps changed")
        self.assertEqual(after[1], before[1], "Existing history changed")

    def test_fresh_library_contains_complete_demo_and_existing_small_samples(self):
        server.initialize()
        self.assertEqual(len(self.snapshot()[0]), 3)
        self.assertEqual(self.marker_count(), 1)
        demo, = self.demos()
        self.assertEqual(demo["title"], "潮汐档案馆")
        self.assertEqual(len(demo["volumes"]), 6)
        self.assertEqual(len(demo["chapters"]), 36)
        self.assertEqual(sum(item["type"] == "人物" for item in demo["notes"]), 32)
        self.assertEqual(sum(not char.isspace() for item in demo["chapters"] for char in item["body"]), 101506)
        self.assertEqual([item["body"] for item in demo["chapters"]], [item["body"] for item in CANONICAL["chapters"]])
        self.assertEqual(demo, server.validate_book(demo))
        self.assertEqual(demo["atlasViews"], CANONICAL["atlasViews"])
        self.assertNotEqual(demo["id"], CANONICAL["id"])
        self.assertTrue({item["id"] for item in demo["volumes"]}.isdisjoint(item["id"] for item in CANONICAL["volumes"]))

    def test_upgrade_preserves_tiny_samples_personal_work_revisions_and_history(self):
        personal = server.new_book("我的私人草稿")
        personal["chapters"] = [server.chapter("自己的章节", "不可改写的正文", personal["volumes"][0]["id"])]
        self.legacy_library([server.sample_book(), server.sample_short(), personal])
        before = self.snapshot()
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.snapshot()[0]), 4)
        self.assertEqual(len(self.demos()), 1)
        self.assertEqual(self.marker_count(), 1)

    def test_same_title_personal_book_is_not_mistaken_for_the_example(self):
        personal = server.new_book("潮汐档案馆")
        personal["chapters"] = [server.chapter("我的第一章", "这是私人作品", personal["volumes"][0]["id"])]
        self.legacy_library([personal])
        before = self.snapshot()
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.snapshot()[0]), 2)
        self.assertEqual(len(self.demos()), 1)

    def test_damaged_legacy_rows_are_preserved_and_do_not_block_the_demo(self):
        damaged = server.new_book("受损旧行仍保留")
        damaged["chapters"] = [{"id": [], "body": "不能被覆盖的旧数据"}]
        self.legacy_library([damaged])
        with sqlite3.connect(self.db) as conn:
            conn.execute("INSERT INTO books(id,title,payload,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)", ("invalid-json", "原始损坏行", "{not-json", 9, "old-created", "old-updated"))
        before = self.snapshot()
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.snapshot()[0]), 3)
        self.assertEqual(self.marker_count(), 1)

    def test_renamed_edited_imported_copy_is_recognized_without_overwriting(self):
        edited = server.restore_book(CANONICAL)
        edited["title"] = "给朋友演示的修改版"
        edited["chapters"].reverse()
        edited["chapters"][0]["title"] = "重新命名的章节"
        edited["chapters"][0]["body"] = "个人修改后的正文"
        edited["notes"][0]["body"] = "改过的人物介绍"
        self.legacy_library([server.sample_book(), edited])
        before = self.snapshot()
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.snapshot()[0]), 2)
        self.assertEqual(self.marker_count(), 1)
        server.initialize()
        self.assertEqual(self.snapshot(), before)

    def test_one_remaining_recycled_chapter_still_identifies_an_edited_example(self):
        edited = server.restore_book(CANONICAL)
        edited["title"] = "只留下回收章节的演示"
        edited["chapters"] = edited["chapters"][:1]
        edited["chapters"][0]["body"] = "已修改"
        edited["chapters"][0]["deletedAt"] = "2026-10-09T00:00:00Z"
        # This deliberately resembles a raw legacy record rather than revalidating
        # its old links; initialization must never rewrite such existing rows.
        self.legacy_library([edited])
        before = self.snapshot()
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.snapshot()[0]), 1)
        self.assertEqual(self.marker_count(), 1)

    def test_canonical_book_id_identifies_a_copy_with_no_remaining_chapters(self):
        edited = copy.deepcopy(CANONICAL)
        edited["title"] = "完全清空正文的原始副本"
        edited["chapters"] = []
        self.legacy_library([edited])
        before = self.snapshot()
        server.initialize()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.marker_count(), 1)

    def test_restarts_do_not_duplicate_or_resurrect_the_demo(self):
        server.initialize()
        initial = self.snapshot()
        for _ in range(3):
            server.initialize()
        self.assertEqual(self.snapshot(), initial)
        demo, = self.demos()
        with sqlite3.connect(self.db) as conn:
            conn.execute("DELETE FROM books WHERE id=?", (demo["id"],))
        after_removal = self.snapshot()
        server.initialize()
        self.assertEqual(self.snapshot(), after_removal)
        self.assertEqual(self.demos(), [])
        self.assertEqual(self.marker_count(), 1)

    def test_missing_packaged_example_does_not_record_a_completed_migration(self):
        server.ROOT = Path(self.temporary.name) / "missing-assets"
        server.initialize()
        self.assertEqual(self.marker_count(), 0)
        self.assertEqual(len(self.snapshot()[0]), 2)
        server.ROOT = ROOT
        server.initialize()
        self.assertEqual(self.marker_count(), 1)
        self.assertEqual(len(self.snapshot()[0]), 3)

    def test_failed_demo_insert_rolls_back_both_book_and_marker(self):
        self.legacy_library([server.new_book("必须原样保留的私人作品")])
        before = self.snapshot()
        original_insert = server.insert_book

        def interrupted_insert(conn, book):
            original_insert(conn, book)
            raise RuntimeError("模拟示例写入中断")

        with patch.object(server, "insert_book", interrupted_insert):
            with self.assertRaisesRegex(RuntimeError, "模拟示例写入中断"):
                server.initialize()
        self.assertEqual(self.snapshot(), before)
        with sqlite3.connect(self.db) as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_migrations'").fetchone())
        server.initialize()
        self.assert_preserved(before)
        self.assertEqual(len(self.demos()), 1)
        self.assertEqual(self.marker_count(), 1)

    def test_busy_retry_supports_python_without_sqlite_errorcode(self):
        original_connect, calls = server.connect, []

        def first_connection_busy():
            calls.append(True)
            if len(calls) == 1:
                raise sqlite3.OperationalError("database is locked")
            return original_connect()

        with patch.object(server, "connect", first_connection_busy), patch.object(server.time, "sleep") as sleep:
            server.initialize()
        # The first retry initializes successfully; post-startup cleanup opens
        # its own transactions after initialization has committed.
        self.assertEqual(len(calls), 4)
        sleep.assert_called_once_with(0.05)
        self.assertEqual(self.marker_count(), 1)
        self.assertEqual(len(self.demos()), 1)

    def test_simultaneous_process_initialization_seeds_exactly_once(self):
        child = """
import pathlib, sys
sys.path.insert(0, sys.argv[1])
import server
server.DB_PATH = pathlib.Path(sys.argv[2])
print('ready', flush=True)
sys.stdin.readline()
server.initialize()
print('done', flush=True)
"""
        for existing_library in (False, True):
            with self.subTest(existing_library=existing_library):
                server.DB_PATH = self.db = Path(self.temporary.name) / ("old.sqlite3" if existing_library else "fresh.sqlite3")
                if existing_library:
                    self.legacy_library([server.new_book("并发升级时保留的私人作品")])
                    before = self.snapshot()
                processes = []
                try:
                    for _ in range(6):
                        process = subprocess.Popen([sys.executable, "-c", child, str(ROOT), str(self.db)], stdin=subprocess.PIPE,
                                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                                   env={**os.environ, "PYTHONIOENCODING": "utf-8"})
                        processes.append(process)
                    for process in processes:
                        self.assertEqual(process.stdout.readline().strip(), "ready")
                    for process in processes:
                        process.stdin.write("start\n")
                        process.stdin.flush()
                    for process in processes:
                        stdout, stderr = process.communicate(timeout=40)
                        self.assertEqual(process.returncode, 0, stderr)
                        self.assertEqual(stdout.strip(), "done", stderr)
                    self.assertEqual(len(self.demos()), 1)
                    self.assertEqual(self.marker_count(), 1)
                    self.assertEqual(len(self.snapshot()[0]), 2 if existing_library else 3)
                    if existing_library:
                        self.assert_preserved(before)
                finally:
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
