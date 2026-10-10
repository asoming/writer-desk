"""Whole-book recycle-bin contracts on disposable, independent HTTP services.

WRITER_DESK_SERVICE may point to a frozen service; no installed library is read.
"""
import concurrent.futures
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
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COVER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Tr8AAAAASUVORK5CYII="
STAMP = "2026-10-10T00:00:00Z"


def service_command(folder):
    executable = os.environ.get("WRITER_DESK_SERVICE")
    return ([executable] if executable else [sys.executable, str(ROOT / "server.py")]) + ["--port", "0", "--data-dir", str(folder)]


class BookTrashTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="writer-book-trash-")
        cls.folder = Path(cls.temporary.name)
        cls.processes, cls.urls = [], []
        for _ in range(2):
            cls.start_service(cls.folder)

    @classmethod
    def start_service(cls, folder):
        process = subprocess.Popen(service_command(folder), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        cls.processes.append(process)
        line = process.stdout.readline().strip()
        if "：http://127.0.0.1:" not in line:
            raise RuntimeError("Disposable service did not start: " + line)
        url = line.split("：", 1)[1]
        cls.urls.append(url)
        return len(cls.urls) - 1

    @classmethod
    def tearDownClass(cls):
        for process in cls.processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            process.stdout.close()
        cls.temporary.cleanup()

    def request(self, path, method="GET", data=None, index=0, origin=None):
        headers = {"Content-Type": "application/json", "X-Writer-Client": "1"}
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(self.urls[index] + path, method=method, headers=headers,
                                     data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=40) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def rich_book(self, kind="long"):
        code, record = self.request("/api/books", "POST", {"title": "回收检验 " + kind, "kind": kind})
        self.assertEqual(code, 201)
        book = record["book"]
        volume = book["volumes"][0]["id"] if kind == "long" else None
        book["cover"] = COVER
        book["chapters"] = [dict(id="chapter-a", title="正文", body="正文 English。\n\n不会丢失的第二段。", volumeId=volume, deletedAt=None),
                            dict(id="chapter-b", title="已回收章节", body="连同关联一起保留", volumeId=volume, deletedAt=STAMP)]
        book["notes"] = [dict(id=item, title=name, type="人物", body="人物资料", aliases=[name + "的别名"],
                              chapterIds=["chapter-a"], deletedAt=None,
                              profile=dict(group="海港", role="主角", desire="返乡", flaw="回避", ending="和解",
                                           arcs=[dict(volumeId=volume, body="人物变化")] if volume else []))
                         for item, name in (("person-a", "沈禾"), ("person-b", "吴舟"))]
        book["outline"] = [dict(id="outline-a", title="全书大纲", body="先写大纲", kind="story", volumeId=None,
                                parentId=None, chapterIds=["chapter-a", "chapter-b"], deletedAt=None)]
        book["relations"] = [dict(id="relation-a", fromId="person-a", toId="person-b", label="同伴", type="friend",
                                  body="共同返乡", stage="重逢", volumeIds=[volume] if volume else [],
                                  chapterIds=["chapter-a", "chapter-b"], deletedAt=None)]
        book["atlasViews"] = [dict(id="view-a", title="海港人物", description="自定义脉络", personIds=["person-a", "person-b"])]
        code, saved = self.request("/api/books/" + book["id"], "PUT", {"book": book, "revision": record["revision"]})
        self.assertEqual(code, 200)
        return self.request("/api/books/" + book["id"])[1]

    def db_row(self, book_id):
        with sqlite3.connect(self.folder / "writer.sqlite3") as conn:
            conn.row_factory = sqlite3.Row
            return dict(conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone())

    def assert_deleted(self, response):
        code, data = response
        self.assertEqual(code, 409)
        self.assertTrue(data["conflict"])
        self.assertTrue(data["deleted"])

    def test_long_and_short_round_trip_preserves_every_payload_field_and_id(self):
        for kind in ("long", "short"):
            original = self.rich_book(kind)
            bid, revision = original["book"]["id"], original["revision"]
            path = "/api/books/" + bid
            before = self.db_row(bid)
            active_before = self.request("/api/books")[1]
            self.assertEqual(self.request(path + "/trash", "POST", {"revision": revision})[0], 200)
            active = self.request("/api/books")[1]
            self.assertEqual(len(active["books"]), len(active_before["books"]) - 1)
            self.assertEqual(active["trashCount"], active_before["trashCount"] + 1)
            self.assertNotIn(bid, [book["id"] for book in active["books"]])
            trash = next(book for book in self.request("/api/trash/books")[1]["books"] if book["id"] == bid)
            self.assertEqual((trash["kind"], trash["cover"], trash["chapterCount"], trash["revision"]), (kind, COVER, 1, revision + 1))
            self.assertTrue(trash["deletedAt"])
            self.assertEqual(self.db_row(bid)["payload"], before["payload"])
            self.assert_deleted(self.request(path))
            code, restored = self.request(path + "/restore", "POST", {"revision": trash["revision"]}, index=1)
            self.assertEqual(code, 200)
            self.assertEqual(restored["book"], original["book"])
            self.assertEqual(restored["revision"], revision + 2)
            self.assertEqual(self.request(path)[1]["book"], original["book"])
            self.assertIsNone(self.db_row(bid)["deleted_at"])

    def test_stale_window_cannot_save_resurrect_or_overwrite_a_recycled_book(self):
        original = self.rich_book()
        book, revision = original["book"], original["revision"]
        path = "/api/books/" + book["id"]
        self.request(path + "/trash", "POST", {"revision": revision})
        changed = copy.deepcopy(book)
        changed["chapters"][0]["body"] = "旧窗口的草稿只可另存，不能覆盖原书。"
        for stale_revision in (revision, revision + 1):
            self.assert_deleted(self.request(path, "PUT", {"book": changed, "revision": stale_revision}, index=1))
        self.assertEqual(json.loads(self.db_row(book["id"])["payload"]), book)
        self.request(path + "/restore", "POST", {"revision": revision + 1})
        code, conflict = self.request(path, "PUT", {"book": changed, "revision": revision}, index=1)
        self.assertEqual(code, 409)
        self.assertTrue(conflict["conflict"])
        self.assertEqual(self.request(path)[1]["book"], book)
        code, copied = self.request("/api/import", "POST", {"format": "yejian-backup", "version": 3, "book": changed}, index=1)
        self.assertEqual(code, 201)
        self.assertNotEqual(copied["book"]["id"], book["id"])
        self.assertEqual(copied["book"]["chapters"][0]["body"], changed["chapters"][0]["body"])

    def test_revision_transactions_serialize_competing_processes(self):
        for competing in ("save", "trash"):
            original = self.rich_book()
            path = "/api/books/" + original["book"]["id"]
            revision = original["revision"]
            changed = copy.deepcopy(original["book"])
            changed["title"] = "并发保存后的书名"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                one = pool.submit(self.request, path + "/trash", "POST", {"revision": revision}, 0)
                two = pool.submit(self.request, path if competing == "save" else path + "/trash",
                                  "PUT" if competing == "save" else "POST",
                                  {"book": changed, "revision": revision} if competing == "save" else {"revision": revision}, 1)
                results = [one.result(), two.result()]
            self.assertEqual(sorted(code for code, _ in results), [200, 409])
            row = self.db_row(original["book"]["id"])
            self.assertEqual(row["revision"], revision + 1)
            if competing == "trash" or results[0][0] == 200:
                self.assertIsNotNone(row["deleted_at"])
                self.assertEqual(json.loads(row["payload"]), original["book"])
            else:
                self.assertIsNone(row["deleted_at"])
                self.assertEqual(json.loads(row["payload"]), changed)

    def test_history_backups_and_exported_files_survive_but_writes_are_blocked(self):
        original = self.rich_book()
        book, revision = original["book"], original["revision"]
        path = "/api/books/" + book["id"]
        self.assertEqual(self.request(path + "/checkpoint", "POST", {})[0], 200)
        code, exported = self.request(path + "/folder", "POST", {})
        self.assertEqual(code, 200)
        folder = Path(exported["folder"])
        files = {str(file.relative_to(folder)): file.read_bytes() for file in folder.rglob("*") if file.is_file()}
        history = self.request(path + "/history")[1]["versions"]
        backups = self.request(path + "/backups")[1]["backups"]
        self.assertTrue(history and backups)
        self.request(path + "/trash", "POST", {"revision": revision})
        self.assertEqual(self.request(path + "/history")[1]["versions"], history)
        self.assertEqual(self.request(path + "/backups")[1]["backups"], backups)
        self.assertEqual(self.request(path + "/history/" + str(history[0]["revision"]))[0], 200)
        for endpoint, data in (("/checkpoint", {}), ("/history/" + str(history[0]["revision"]) + "/restore", {"revision": revision + 1}),
                               ("/ai/preview", {"action": "outline", "chapterIds": [], "instruction": "", "skillIds": []}),
                               ("/ai", {"action": "outline", "chapterIds": [], "instruction": "", "skillIds": []})):
            self.assert_deleted(self.request(path + endpoint, "POST", data))
        self.assertEqual(self.request(path + "/folder", "POST", {})[0], 404)
        self.assertEqual({str(file.relative_to(folder)): file.read_bytes() for file in folder.rglob("*") if file.is_file()}, files)
        self.request(path + "/restore", "POST", {"revision": revision + 1})
        restored = self.request(path)[1]
        restored["book"]["chapters"][1]["deletedAt"] = None
        self.assertEqual(self.request(path, "PUT", {"book": restored["book"], "revision": restored["revision"]})[0], 200)
        self.assertEqual(self.request(path)[1]["book"]["chapters"][1]["deletedAt"], None)

    def test_strict_parameters_state_conflicts_and_origin_guards(self):
        record = self.rich_book()
        path, revision = "/api/books/" + record["book"]["id"], record["revision"]
        for operation in ("trash", "restore"):
            for data in ({}, {"revision": True}, {"revision": 0}, {"revision": "2"}, {"revision": revision, "book": record["book"]}, []):
                self.assertEqual(self.request(path + "/" + operation, "POST", data)[0], 400)
        self.assertEqual(self.request(path + "/trash", "POST", {"revision": revision}, origin="https://foreign.example")[0], 403)
        self.assertEqual(self.request("/api/books/unknown/trash", "POST", {"revision": 1})[0], 404)
        self.assertEqual(self.request(path + "/restore", "POST", {"revision": revision})[0], 409)
        self.assertEqual(self.db_row(record["book"]["id"])["revision"], revision)
        self.request(path + "/trash", "POST", {"revision": revision})
        self.assertEqual(self.request(path + "/restore", "POST", {"revision": revision})[0], 409)
        self.assert_deleted(self.request(path + "/trash", "POST", {"revision": revision + 1}))

    def test_purge_removes_saved_book_history_and_owned_snapshots_but_preserves_exports_and_other_books(self):
        original, other = self.rich_book(), self.rich_book("short")
        book, revision = original["book"], original["revision"]
        path = "/api/books/" + book["id"]
        self.request(path + "/checkpoint", "POST", {})
        backups = self.request(path + "/backups")[1]["backups"]
        self.assertTrue(backups)
        folder = Path(self.request(path + "/folder", "POST", {})[1]["folder"])
        exported = {file.name: file.read_bytes() for file in folder.iterdir()}
        other_backups = self.request("/api/books/" + other["book"]["id"] + "/backups")[1]
        self.request(path + "/trash", "POST", {"revision": revision})
        code, result = self.request(path + "/purge", "POST", {"revision": revision + 1}, index=1)
        self.assertEqual(code, 200)
        self.assertEqual(result, {"ok": True, "id": book["id"]})
        with sqlite3.connect(self.folder / "writer.sqlite3") as conn:
            for table, column in (("books", "id"), ("history", "book_id"), ("backup_runs", "book_id"), ("pending_book_purges", "book_id")):
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM " + table + " WHERE " + column + "=?", (book["id"],)).fetchone()[0], 0)
        backup_folder = self.folder / "backups" / ("book-" + hashlib.sha256(book["id"].encode()).hexdigest())
        self.assertTrue(all(not (backup_folder / backup["token"]).exists() for backup in backups))
        self.assertEqual({file.name: file.read_bytes() for file in folder.iterdir()}, exported)
        self.assertEqual(self.request("/api/books/" + other["book"]["id"])[1], other)
        self.assertEqual(self.request("/api/books/" + other["book"]["id"] + "/backups")[1], other_backups)
        for suffix in ("", "/history", "/backups", "/history/1", "/backups/" + backups[0]["token"]):
            self.assertEqual(self.request(path + suffix)[0], 404)
        for suffix, data in (("/restore", {"revision": revision + 1}), ("/purge", {"revision": revision + 1}),
                              ("/checkpoint", {}), ("/folder", {}), ("/backups/" + backups[0]["token"] + "/restore", {"revision": revision + 1})):
            self.assertEqual(self.request(path + suffix, "POST", data)[0], 404)
        code, missing = self.request(path, "PUT", {"book": book, "revision": revision + 1})
        self.assertEqual(code, 404)
        self.assertTrue(missing["deleted"] and missing["removed"] and missing["conflict"])

    def test_purge_requires_a_recycled_current_revision_and_serializes_with_restore(self):
        record = self.rich_book()
        path, revision = "/api/books/" + record["book"]["id"], record["revision"]
        for data in ({}, {"revision": True}, {"revision": 0}, {"revision": "2"}, {"revision": revision, "path": "/tmp"}, []):
            self.assertEqual(self.request(path + "/purge", "POST", data)[0], 400)
        self.assertEqual(self.request(path + "/purge", "POST", {"revision": revision})[0], 409)
        self.assertEqual(self.request(path + "/purge", "POST", {"revision": revision}, origin="https://foreign.example")[0], 403)
        self.request(path + "/trash", "POST", {"revision": revision})
        self.assertEqual(self.request(path + "/purge", "POST", {"revision": revision})[0], 409)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            purge = pool.submit(self.request, path + "/purge", "POST", {"revision": revision + 1}, 0)
            restore = pool.submit(self.request, path + "/restore", "POST", {"revision": revision + 1}, 1)
            results = purge.result(), restore.result()
        self.assertEqual(sum(code == 200 for code, _ in results), 1)
        if results[0][0] == 200:
            self.assertEqual(results[1][0], 404)
            self.assertEqual(self.request(path)[0], 404)
        else:
            self.assertEqual(results[0][0], 409)
            self.assertEqual(self.request(path)[1]["book"], record["book"])

    def test_legacy_schema_migrates_without_changing_existing_payload_or_history(self):
        original = self.rich_book()["book"]
        legacy = self.folder / "legacy"
        legacy.mkdir()
        payload = json.dumps(original, ensure_ascii=False)
        with sqlite3.connect(legacy / "writer.sqlite3") as conn:
            conn.execute("CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
            conn.execute("CREATE TABLE history(id INTEGER PRIMARY KEY,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,saved_at TEXT NOT NULL)")
            conn.execute("INSERT INTO books VALUES(?,?,?,?,?,?)", (original["id"], original["title"], payload, 19, STAMP, STAMP))
            conn.execute("INSERT INTO history VALUES(1,?,?,?,?)", (original["id"], 18, payload, STAMP))
        index = self.start_service(legacy)
        self.assertEqual(self.request("/api/books/" + original["id"], index=index)[1]["revision"], 19)
        with sqlite3.connect(legacy / "writer.sqlite3") as conn:
            self.assertEqual(conn.execute("SELECT payload,revision,created_at,updated_at,deleted_at FROM books WHERE id=?", (original["id"],)).fetchone(),
                             (payload, 19, STAMP, STAMP, None))
            self.assertEqual(conn.execute("SELECT payload,revision FROM history WHERE book_id=?", (original["id"],)).fetchone(), (payload, 18))

    def test_zz_deleted_default_demo_and_empty_active_library_stay_deleted_after_restart(self):
        active = self.request("/api/books")[1]["books"]
        demo = next(book for book in active if book["title"] == "潮汐档案馆")
        for book in active:
            self.assertEqual(self.request("/api/books/" + book["id"] + "/trash", "POST", {"revision": book["revision"]})[0], 200)
        before = self.request("/api/trash/books")[1]["books"]
        self.assertIn(demo["id"], [book["id"] for book in before])
        index = self.start_service(self.folder)
        self.assertEqual(self.request("/api/books", index=index)[1], {"books": [], "trashCount": len(before)})
        self.assertEqual(self.request("/api/trash/books", index=index)[1]["books"], before)
        with sqlite3.connect(self.folder / "writer.sqlite3") as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM books").fetchone()[0], len(before))

    def test_zzz_purging_the_entire_library_stays_empty_after_concurrent_initialization(self):
        for book in self.request("/api/trash/books")[1]["books"]:
            self.assertEqual(self.request("/api/books/" + book["id"] + "/purge", "POST", {"revision": book["revision"]})[0], 200)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            indices = list(pool.map(lambda _: self.start_service(self.folder), range(2)))
        for index in indices:
            self.assertEqual(self.request("/api/books", index=index)[1], {"books": [], "trashCount": 0})
        with sqlite3.connect(self.folder / "writer.sqlite3") as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM books").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM backup_runs").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM app_migrations WHERE name IN ('initial-library-v1','default-tide-archive-v1')").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
