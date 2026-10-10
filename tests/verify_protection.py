"""Data protection against disposable databases; no user library is accessed."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import protection
import server


class ProtectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-protection-")
        self.previous_db = server.DB_PATH
        server.DB_PATH = Path(self.temporary.name) / "writer.sqlite3"
        server.initialize()
        with server.connect() as conn:
            self.row = next(row for row in conn.execute("SELECT * FROM books") if row["title"] == "潮汐档案馆")
        self.book = json.loads(self.row["payload"])
        self.path = "/api/books/" + self.book["id"]

    def tearDown(self):
        server.DB_PATH = self.previous_db
        self.temporary.cleanup()

    def save(self, body):
        current = server.read_protection(self.path + "/history")["currentRevision"]
        book = copy.deepcopy(self.book)
        book["chapters"][0]["body"] = body
        responses = []
        handler = object.__new__(server.Handler)
        handler.path = self.path
        handler.read_json = lambda: {"book": book, "revision": current}
        handler.send_json = lambda value, status=200: responses.append((status, value))
        handler.do_PUT()
        self.assertEqual(responses[0][0], 200)
        return responses[0][1]

    def current(self):
        with server.connect() as conn:
            row = server.saved_book_row(conn, self.book["id"])
            return server.book_result(row)

    def test_defaults_settings_and_per_book_throttle_persist(self):
        self.assertEqual(server.read_protection("/api/protection/settings")["settings"], protection.DEFAULTS)
        first = server.checkpoint_book(self.book["id"])
        self.assertIsNotNone(first)
        self.assertIsNone(server.checkpoint_book(self.book["id"]))
        server.initialize()
        self.assertIsNone(server.checkpoint_book(self.book["id"]), "Restart cannot reset per-book throttle")
        with server.connect() as conn:
            other = next(row for row in conn.execute("SELECT * FROM books") if row["id"] != self.book["id"])
        self.assertIsNotNone(server.checkpoint_book(other["id"]), "Each work has its own backup interval")
        with server.connect() as conn:
            protection.update_settings(conn, {"enabled": False, "intervalMinutes": 1, "retentionCount": 2})
        with patch.object(protection, "time") as clock:
            clock.time.return_value = 9e12
            self.assertIsNone(server.checkpoint_book(self.book["id"]))
        self.assertIsNotNone(server.checkpoint_book(self.book["id"], force=True), "Manual backup works when automatic backup is off")
        for invalid in ({}, {"enabled": True, "intervalMinutes": 0, "retentionCount": 2},
                        {"enabled": True, "intervalMinutes": 5, "retentionCount": 101},
                        {"enabled": "yes", "intervalMinutes": 5, "retentionCount": 2},
                        {"enabled": True, "intervalMinutes": True, "retentionCount": 2},
                        {"enabled": True, "intervalMinutes": 5, "retentionCount": 2, "apiKey": "must-not-store"}):
            with server.connect() as conn:
                with self.assertRaises(protection.ProtectionError):
                    protection.update_settings(conn, invalid)
        self.assertEqual(server.read_protection("/api/protection/settings")["settings"],
                         {"enabled": False, "intervalMinutes": 1, "retentionCount": 2})

    def test_retention_is_bounded_and_preserves_unmanaged_files(self):
        with server.connect() as conn:
            protection.update_settings(conn, {"enabled": True, "intervalMinutes": 5, "retentionCount": 2})
        first = server.checkpoint_book(self.book["id"], force=True)
        folder = next((server.DB_PATH.parent / "backups").iterdir())
        personal = folder / "自己的资料.json"
        personal.write_text("请保留", "utf-8")
        malformed = folder / ("r1-" + "a" * 32 + ".json")
        malformed.write_text("损坏文件也保留", "utf-8")
        for _ in range(4):
            latest = server.checkpoint_book(self.book["id"], force=True)
        snapshots = server.read_protection(self.path + "/backups")["backups"]
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(snapshots[0]["token"], latest["token"])
        self.assertNotIn(first["token"], [item["token"] for item in snapshots])
        self.assertEqual(personal.read_text("utf-8"), "请保留")
        self.assertEqual(malformed.read_text("utf-8"), "损坏文件也保留")
        self.assertFalse(list(folder.glob("*.tmp")))
        preview = server.read_protection(self.path + "/backups/" + latest["token"])
        self.assertEqual(preview["book"], self.book)
        raw = json.loads((folder / latest["token"]).read_text("utf-8"))
        self.assertEqual(set(raw), {"format", "version", "book", "exportedAt", "writerDeskSnapshot"})
        self.assertNotIn("apiKey", json.dumps(raw))

    def test_failed_automatic_backup_cannot_turn_a_committed_save_into_failure(self):
        with patch.object(protection, "checkpoint", side_effect=OSError("disk full")):
            response = self.save("磁盘备份失败期间仍然保存的正文")
        self.assertEqual(response["revision"], 2)
        self.assertEqual(response["protectionWarning"], protection.WARNING)
        self.assertEqual(self.current()["book"]["chapters"][0]["body"], "磁盘备份失败期间仍然保存的正文")
        self.assertEqual(server.read_protection(self.path + "/history/1")["book"], self.book)
        self.assertIsNotNone(server.checkpoint_book(self.book["id"], force=True))

    def test_restore_preserves_current_then_uses_a_new_revision_and_rejects_stale_windows(self):
        self.save("恢复前必须保留的修改")
        saved_current = self.current()
        history = server.read_protection(self.path + "/history")
        self.assertEqual([item["revision"] for item in history["versions"]], [1])
        self.assertEqual(server.read_protection(self.path + "/history/1")["book"], self.book)
        with self.assertRaises(protection.ProtectionError) as conflict:
            server.write_protection(self.path + "/history/1/restore", {"revision": 1})
        self.assertEqual(conflict.exception.status, 409)
        self.assertTrue(conflict.exception.conflict)
        self.assertEqual(self.current(), saved_current)
        with patch.object(protection, "checkpoint", side_effect=OSError("cannot preserve current book")):
            with self.assertRaises(OSError):
                server.write_protection(self.path + "/history/1/restore", {"revision": 2})
        self.assertEqual(self.current(), saved_current)
        self.assertEqual(server.read_protection(self.path + "/history"), history)
        restored = server.write_protection(self.path + "/history/1/restore", {"revision": 2})
        self.assertEqual(restored["book"], self.book)
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(server.read_protection(self.path + "/history/2")["book"], saved_current["book"])
        before_restore = next(item for item in server.read_protection(self.path + "/backups")["backups"] if item["reason"] == "before-restore")
        self.assertEqual(server.read_protection(self.path + "/backups/" + before_restore["token"])["book"], saved_current["book"])
        self.assertEqual(sum(not char.isspace() for chapter in restored["book"]["chapters"] for char in chapter["body"]), 101506)
        self.assertEqual(len(restored["book"]["notes"]), len(self.book["notes"]))

    def test_backup_restoration_remains_safe_with_retention_one(self):
        with server.connect() as conn:
            protection.update_settings(conn, {"enabled": True, "intervalMinutes": 5, "retentionCount": 1})
        backup = server.checkpoint_book(self.book["id"], force=True)
        self.save("当前版本必须先保留")
        current = self.current()
        restored = server.write_protection(self.path + "/backups/" + backup["token"] + "/restore", {"revision": 2})
        self.assertEqual(restored["book"], self.book)
        snapshots = server.read_protection(self.path + "/backups")["backups"]
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["reason"], "before-restore")
        self.assertEqual(server.read_protection(self.path + "/backups/" + snapshots[0]["token"])["book"], current["book"])
        self.assertEqual(server.read_protection(self.path + "/history/2")["book"], current["book"])

    def test_backup_paths_tokens_and_other_books_cannot_escape(self):
        backup = server.checkpoint_book(self.book["id"], force=True)
        with server.connect() as conn:
            other = next(row for row in conn.execute("SELECT * FROM books") if row["id"] != self.book["id"])
        with self.assertRaises(protection.ProtectionError):
            protection.get_snapshot(server.DB_PATH, self.book["id"], "../../writer.sqlite3", server.validate_book)
        with self.assertRaises(protection.ProtectionError):
            protection.get_snapshot(server.DB_PATH, other["id"], backup["token"], server.validate_book)
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("不可修改", "utf-8")
        folder = next((server.DB_PATH.parent / "backups").iterdir())
        linked = folder / ("r1-" + "b" * 32 + ".json")
        linked.symlink_to(sentinel)
        self.assertEqual(len(server.read_protection(self.path + "/backups")["backups"]), 1)
        with self.assertRaises(protection.ProtectionError):
            protection.get_snapshot(server.DB_PATH, self.book["id"], linked.name, server.validate_book)
        self.assertEqual(sentinel.read_text("utf-8"), "不可修改")
        for child in folder.iterdir():
            child.unlink()
        folder.rmdir()
        folder.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(protection.ProtectionError):
            server.checkpoint_book(self.book["id"], force=True)
        self.assertEqual(list(outside.iterdir()), [sentinel])


class ProtectionApiTests(unittest.TestCase):
    def test_local_api_routes_recover_a_real_book_and_keep_settings_out_of_exports(self):
        with tempfile.TemporaryDirectory(prefix="writer-protection-api-") as directory:
            process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", "0", "--data-dir", directory],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
            try:
                startup = process.stdout.readline().strip()
                self.assertIn("：http://127.0.0.1:", startup)
                url = startup.split("：", 1)[1]
                def request(path, method="GET", value=None):
                    req = urllib.request.Request(url + path, method=method,
                        data=json.dumps(value).encode() if value is not None else None,
                        headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
                    with urllib.request.urlopen(req, timeout=30) as response:
                        return json.load(response)
                for asset in ("/protection.js", "/protection.css"):
                    with urllib.request.urlopen(url + asset) as response:
                        self.assertEqual(response.status, 200)
                self.assertEqual(request("/api/protection/settings")["settings"], protection.DEFAULTS)
                config = {"enabled": True, "intervalMinutes": 10, "retentionCount": 3}
                self.assertEqual(request("/api/protection/settings", "PUT", config)["settings"], config)
                demo = next(book for book in request("/api/books")["books"] if book["title"] == "潮汐档案馆")
                path = "/api/books/" + demo["id"]
                original = request(path)
                book = copy.deepcopy(original["book"])
                book["chapters"][0]["body"] += "\n\n保护接口验收。"
                self.assertEqual(request(path, "PUT", {"book": book, "revision": original["revision"]})["revision"], 2)
                backup = request(path + "/checkpoint", "POST", {})["backup"]
                self.assertEqual(request(path + "/backups/" + backup["token"])["book"], book)
                self.assertEqual(request(path + "/history")["versions"][0]["revision"], 1)
                self.assertEqual(request(path + "/history/1")["book"], original["book"])
                restored = request(path + "/history/1/restore", "POST", {"revision": 2})
                self.assertEqual(restored["book"], original["book"])
                self.assertEqual(restored["revision"], 3)
                self.assertEqual(request(path + "/backups/" + backup["token"] + "/restore", "POST", {"revision": 3})["book"], book)
                with sqlite3.connect(Path(directory) / "writer.sqlite3") as conn:
                    self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            finally:
                process.terminate()
                process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
