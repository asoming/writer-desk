"""Chapter-history and permanent-deletion tests use disposable libraries only."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import chapter_history
import protection
import server


class ChapterHistoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="writer-chapter-history-")
        self.addCleanup(temporary.cleanup)
        previous = server.DB_PATH
        self.addCleanup(setattr, server, "DB_PATH", previous)
        server.DB_PATH = Path(temporary.name) / "writer.sqlite3"
        server.initialize()
        self.book = server.new_book("隔离历史")
        volume = self.book["volumes"][0]["id"]
        self.secret = "删除后不得留在应用副本中的正文-" + server.uid()
        self.target = server.chapter("已删除章节", self.secret, volume)
        self.survivor = server.chapter("保留章节", "其它正文🌙完整保留", volume)
        self.book["chapters"] = [self.target, self.survivor]
        with server.connect() as conn:
            server.insert_book(conn, self.book)
        self.snapshot = server.checkpoint_book(self.book["id"], force=True)
        with server.connect() as conn:
            row = server.saved_book_row(conn, self.book["id"])
            server.preserve_history(conn, row, "2026-10-10T09:00:00+00:00")
            self.target["deletedAt"] = "2026-10-12T01:02:03+00:00"
            conn.execute("UPDATE books SET payload=?,revision=2 WHERE id=?", (json.dumps(self.book, ensure_ascii=False), self.book["id"]))
        self.path = "/api/books/" + self.book["id"] + "/chapters/" + self.target["id"]

    def write(self, operation, revision=2):
        return chapter_history.write(server, self.path + "/" + operation, {"revision": revision})

    def row(self):
        with server.connect() as conn:
            return dict(server.saved_book_row(conn, self.book["id"]))

    def backup_dir(self):
        return server.DB_PATH.parent / "backups" / ("book-" + hashlib.sha256(self.book["id"].encode()).hexdigest())

    def test_list_is_read_only_and_date_is_authoritative(self):
        before = self.row()
        with server.connect() as conn:
            history = [tuple(row) for row in conn.execute("SELECT * FROM history")]
        listed = chapter_history.read(server, "/api/history/chapters")
        item = next(item for item in listed["chapters"] if item["bookId"] == self.book["id"])
        self.assertEqual(item["deletedAt"], self.target["deletedAt"])
        self.assertEqual(item["chapterId"], self.target["id"])
        self.assertEqual(item["wordCount"], len(self.secret))
        preview = chapter_history.read(server, self.path + "/history")
        self.assertEqual(preview["chapter"]["body"], self.secret)
        self.assertEqual(self.row(), before)
        with server.connect() as conn:
            self.assertEqual([tuple(row) for row in conn.execute("SELECT * FROM history")], history)
        self.target["deletedAt"] = "旧版未知日期"
        with server.connect() as conn:
            conn.execute("UPDATE books SET payload=? WHERE id=?", (json.dumps(self.book), self.book["id"]))
        item = next(item for item in chapter_history.list_chapters(server)["chapters"] if item["bookId"] == self.book["id"])
        self.assertIsNone(item["deletedAt"], "Never invent a timestamp for old data")

    def test_restore_keeps_body_and_has_revision_guard(self):
        with self.assertRaises(protection.ProtectionError) as conflict:
            self.write("restore", 1)
        self.assertEqual(conflict.exception.status, 409)
        restored = self.write("restore")
        self.assertEqual(restored["revision"], 3)
        chapter = next(item for item in restored["book"]["chapters"] if item["id"] == self.target["id"])
        self.assertIsNone(chapter["deletedAt"])
        self.assertEqual(chapter["body"], self.secret)
        with self.assertRaises(protection.ProtectionError):
            self.write("purge", 3)

    def test_purge_rewrites_each_history_snapshot_export_and_journal(self):
        folder = Path(server.sync_book_folder(self.book["id"], create=True)["folder"])
        personal = folder / "自己的资料.txt"
        personal.write_text("不能删除")
        other = server.new_book("其他书")
        other["chapters"] = [server.chapter("正文", "其他书完整保留", other["volumes"][0]["id"])]
        with server.connect() as conn:
            server.insert_book(conn, other)
            before_other = dict(server.saved_book_row(conn, other["id"]))
            before_history = [dict(row) for row in conn.execute("SELECT * FROM history WHERE book_id=?", (self.book["id"],))]
        result = self.write("purge")
        self.assertEqual(result["revision"], 3)
        self.assertTrue(result["clearBookLocalCopies"])
        self.assertNotIn("cleanupPending", result)
        self.assertEqual([item["body"] for item in result["book"]["chapters"]], [self.survivor["body"]])
        with server.connect() as conn:
            rows = [dict(row) for row in conn.execute("SELECT * FROM history WHERE book_id=?", (self.book["id"],))]
            self.assertEqual(len(rows), len(before_history))
            for before, after in zip(before_history, rows):
                self.assertEqual({key: value for key, value in before.items() if key != "payload"},
                                 {key: value for key, value in after.items() if key != "payload"})
                self.assertNotIn(self.secret, after["payload"])
                self.assertEqual(json.loads(after["payload"])["chapters"][0]["body"], self.survivor["body"])
            self.assertEqual(dict(server.saved_book_row(conn, other["id"])), before_other)
            self.assertEqual(list(conn.execute("SELECT * FROM pending_chapter_purges")), [])
        raw = json.loads((self.backup_dir() / self.snapshot["token"]).read_text())
        self.assertEqual(raw["writerDeskSnapshot"]["revision"], 1)
        self.assertNotIn(self.secret, json.dumps(raw, ensure_ascii=False))
        self.assertEqual(raw["book"]["chapters"][0]["body"], self.survivor["body"])
        self.assertNotIn(self.secret, (folder / "作品.yejian.json").read_text())
        self.assertEqual(personal.read_text(), "不能删除")
        self.assertNotIn(self.secret.encode(), server.DB_PATH.read_bytes(), "secure_delete and checkpoint must remove the app's old SQL payload")
        self.assertEqual(chapter_history.read(server, "/api/history/chapter-purges"),
                         {"purges": [{"bookId": self.book["id"], "purgedAt": result["purgedAt"]}]})

    def test_purge_removes_all_links_but_preserves_authored_notes(self):
        book = copy.deepcopy(self.book)
        person1, person2 = server.uid(), server.uid()
        book["notes"] = [{"id": person1, "title": "人物一", "body": "设定保留", "type": "人物", "chapterIds": [self.target["id"], self.survivor["id"]], "deletedAt": None},
                         {"id": person2, "title": "人物二", "body": "设定二", "type": "人物", "chapterIds": [self.target["id"]], "deletedAt": None}]
        book["outline"] = [{"id": server.uid(), "title": "情节", "body": "情节保留", "chapterIds": [self.target["id"], self.survivor["id"]], "parentId": None, "deletedAt": None}]
        book["relations"] = [{"id": server.uid(), "fromId": person1, "toId": person2, "label": "关系", "body": "关系设定", "chapterIds": [self.target["id"]], "deletedAt": None}]
        with server.connect() as conn:
            conn.execute("UPDATE books SET payload=? WHERE id=?", (json.dumps(book), book["id"]))
        result = self.write("purge")["book"]
        self.assertEqual(result["notes"][0]["body"], "设定保留")
        for item in result["notes"] + result["outline"] + result["relations"]:
            self.assertNotIn(self.target["id"], item["chapterIds"])
        self.assertEqual(result["outline"][0]["chapterIds"], [self.survivor["id"]])

    def test_edited_export_blocks_before_sql_changes(self):
        folder = Path(server.sync_book_folder(self.book["id"], create=True)["folder"])
        export = folder / "作品.yejian.json"
        export.write_text("用户自行改动的文件 " + self.secret)
        before = self.row()
        with self.assertRaises(protection.ProtectionError) as error:
            self.write("purge")
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.row(), before)
        self.assertIn(self.secret, export.read_text())
        self.assertEqual(chapter_history.read(server, "/api/history/chapter-purges"), {"purges": []})

    def test_snapshot_failure_is_durable_and_old_restore_is_sanitized(self):
        original = protection.rewrite_snapshots
        def fail_write(*args, **kwargs):
            if not kwargs.get("dry_run"):
                raise OSError("simulated disk failure")
            return original(*args, **kwargs)
        with patch.object(protection, "rewrite_snapshots", side_effect=fail_write):
            result = self.write("purge")
        self.assertTrue(result["cleanupPending"])
        self.assertEqual(chapter_history.list_chapters(server)["cleanupPendingBooks"], [self.book["id"]])
        path = "/api/books/" + self.book["id"] + "/backups/" + self.snapshot["token"]
        preview = server.read_protection(path)
        self.assertNotIn(self.secret, json.dumps(preview, ensure_ascii=False))
        restored = server.write_protection(path + "/restore", {"revision": 3})
        self.assertNotIn(self.secret, json.dumps(restored, ensure_ascii=False))
        server.initialize()
        self.assertEqual(chapter_history.list_chapters(server)["cleanupPendingBooks"], [])
        self.assertNotIn(self.secret, (self.backup_dir() / self.snapshot["token"]).read_text())

    def test_put_cannot_reintroduce_purged_id_even_at_latest_revision(self):
        self.write("purge")
        responses = []
        handler = object.__new__(server.Handler)
        handler.path = "/api/books/" + self.book["id"]
        handler.read_json = lambda: {"book": self.book, "revision": 3}
        handler.send_json = lambda value, status=200: responses.append((status, value))
        handler.do_PUT()
        self.assertEqual(responses[0][0], 409)
        self.assertNotIn(self.secret, self.row()["payload"])

    def test_sql_failure_rolls_back_and_leaves_files_unchanged(self):
        before = self.row()
        snapshot = (self.backup_dir() / self.snapshot["token"]).read_bytes()
        with server.connect() as conn:
            conn.execute("CREATE TRIGGER refuse_history_change BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'simulated'); END")
        with self.assertRaises(sqlite3.DatabaseError):
            self.write("purge")
        self.assertEqual(self.row(), before)
        self.assertEqual((self.backup_dir() / self.snapshot["token"]).read_bytes(), snapshot)
        self.assertEqual(chapter_history.read(server, "/api/history/chapter-purges"), {"purges": []})

    def test_trashed_book_cannot_restore_chapter_but_can_purge_it(self):
        with server.connect() as conn:
            conn.execute("UPDATE books SET deleted_at=? WHERE id=?", (server.now(), self.book["id"]))
        item = next(item for item in chapter_history.list_chapters(server)["chapters"] if item["bookId"] == self.book["id"])
        self.assertTrue(item["bookDeleted"])
        self.assertFalse(item["canRestore"])
        with self.assertRaises(protection.ProtectionError):
            self.write("restore")
        self.assertNotIn(self.secret, json.dumps(self.write("purge"), ensure_ascii=False))

    def test_old_joined_short_manuscript_removes_only_target_utf16_range(self):
        short = server.new_book("短篇", "short")
        a, b, c = server.chapter("旧一", "删除🌙"), server.chapter("旧二", "保留📚"), server.chapter("旧三", "仍保留")
        short["chapters"] = [a, b, c]
        short["notes"] = [{"id": server.uid(), "title": "仍在正文的人物", "type": "人物", "body": "人物设定", "chapterIds": [b["id"]], "deletedAt": None}]
        joined = server.validate_book(short)
        self.assertEqual(joined["notes"][0]["chapterIds"], [a["id"]])
        clean = server.validate_book(chapter_history.sanitize(joined, {a["id"]}))
        self.assertEqual(clean["chapters"][0]["body"], "\n\n保留📚\n\n仍保留")
        self.assertNotEqual(clean["chapters"][0]["id"], a["id"])
        self.assertEqual([item["id"] for item in clean["shortSections"]], [b["id"], c["id"]])
        self.assertEqual(clean["notes"][0]["chapterIds"], [clean["chapters"][0]["id"]])
        clean = server.validate_book(chapter_history.sanitize(joined, {b["id"]}))
        self.assertEqual(clean["chapters"][0]["body"], "删除🌙\n\n\n\n仍保留")

    def test_malformed_or_symlinked_snapshot_blocks_without_touching_external_data(self):
        foreign = server.DB_PATH.parent / "external.txt"
        foreign.write_text("外部文件不触碰")
        link = self.backup_dir() / ("r2-" + "f" * 32 + ".json")
        link.symlink_to(foreign)
        before = self.row()
        with self.assertRaises(protection.ProtectionError):
            self.write("purge")
        self.assertEqual(self.row(), before)
        self.assertEqual(foreign.read_text(), "外部文件不触碰")
        link.unlink()
        link.write_text("损坏的应用备份 " + self.secret)
        with self.assertRaises(protection.ProtectionError):
            self.write("purge")
        self.assertEqual(self.row(), before)

    def test_wal_reader_keeps_cleanup_pending_until_checkpoint_can_finish(self):
        reader = sqlite3.connect(server.DB_PATH)
        self.addCleanup(reader.close)
        reader.execute("BEGIN")
        reader.execute("SELECT payload FROM books WHERE id=?", (self.book["id"],)).fetchone()
        original_connect = server.connect
        def low_timeout():
            conn = original_connect()
            conn.execute("PRAGMA busy_timeout=10")
            return conn
        with patch.object(server, "connect", side_effect=low_timeout):
            with patch.object(server.ChatImageStore, "purge") as image_purge:
                result = self.write("purge")
                self.assertEqual(image_purge.call_count, 1)
        self.assertTrue(result["cleanupPending"])
        self.assertNotIn(self.secret, self.row()["payload"])
        self.assertEqual(chapter_history.list_chapters(server)["cleanupPendingBooks"], [self.book["id"]])
        reader.rollback()
        with patch.object(server.ChatImageStore, "purge") as image_purge:
            self.assertEqual(chapter_history.cleanup(server), [])
            image_purge.assert_not_called()
        self.assertNotIn(self.secret.encode(), server.DB_PATH.read_bytes())

    def test_short_legacy_sql_and_snapshot_keep_other_joined_parts(self):
        short = server.new_book("迁移后的短篇", "short")
        a, b = server.chapter("旧一", "待彻删🌙"), server.chapter("旧二", "还需保留📚")
        short["chapters"] = [a, b]
        joined = server.validate_book(short)
        with server.connect() as conn:
            server.insert_book(conn, joined)
        snapshot = server.checkpoint_book(short["id"], force=True)
        current = copy.deepcopy(joined)
        current.pop("shortSections")
        current["chapters"] = [{**a, "deletedAt": "2026-10-12T02:00:00Z"}, {**b, "deletedAt": None}]
        with server.connect() as conn:
            row = server.saved_book_row(conn, short["id"])
            server.preserve_history(conn, row, server.now())
            conn.execute("UPDATE books SET payload=?,revision=2 WHERE id=?", (json.dumps(current, ensure_ascii=False), short["id"]))
        path = "/api/books/" + short["id"] + "/chapters/" + a["id"] + "/purge"
        result = chapter_history.write(server, path, {"revision": 2})
        self.assertEqual(result["book"]["chapters"][0]["body"], b["body"])
        saved = server.read_protection("/api/books/" + short["id"] + "/history/1")["book"]
        self.assertEqual(saved["chapters"][0]["body"], "\n\n" + b["body"])
        saved = server.read_protection("/api/books/" + short["id"] + "/backups/" + snapshot["token"])["book"]
        self.assertEqual(saved["chapters"][0]["body"], "\n\n" + b["body"])

    def test_journal_survives_whole_book_purge_without_authored_fields(self):
        result = self.write("purge")
        base = "/api/books/" + self.book["id"]
        server.change_book_trash(base + "/trash", {"revision": 3})
        server.change_book_trash(base + "/purge", {"revision": 4})
        journal = chapter_history.read(server, "/api/history/chapter-purges")
        self.assertEqual(journal, {"purges": [{"bookId": self.book["id"], "purgedAt": result["purgedAt"]}]})
        self.assertNotIn(self.secret, json.dumps(journal, ensure_ascii=False))
        self.assertNotIn(self.target["title"], json.dumps(journal, ensure_ascii=False))

    def test_handler_routes_list_preview_restore_purge_cleanup_and_journal(self):
        def request(path, method="GET", data=None):
            responses = []
            handler = object.__new__(server.Handler)
            handler.path = path
            handler.allowed_client = handler.allowed_host = lambda: True
            handler.read_json = lambda: data
            handler.send_json = lambda value, status=200: responses.append((status, value))
            getattr(handler, "do_" + method)()
            return responses[0]
        status, listing = request("/api/history/chapters")
        self.assertEqual(status, 200)
        self.assertTrue(any(item["chapterId"] == self.target["id"] for item in listing["chapters"]))
        self.assertEqual(request(self.path + "/history")[1]["chapter"]["body"], self.secret)
        self.assertEqual(request(self.path + "/restore", "POST", {"revision": 1})[0], 409)
        status, result = request(self.path + "/purge", "POST", {"revision": 2})
        self.assertEqual(status, 200)
        self.assertNotIn(self.secret, json.dumps(result, ensure_ascii=False))
        self.assertEqual(request("/api/history/chapters/cleanup", "POST", {})[1], {"cleanupPendingBooks": []})
        self.assertEqual(request("/api/history/chapter-purges")[1]["purges"][0]["purgedAt"], result["purgedAt"])

    def test_crashed_checkpoint_and_owned_export_json_temporaries_are_removed(self):
        orphan = self.backup_dir() / (".snapshot-" + server.uid() + ".tmp")
        shutil.copyfile(self.backup_dir() / self.snapshot["token"], orphan)
        folder = Path(server.sync_book_folder(self.book["id"], create=True)["folder"])
        export_orphan = folder / (".writer-desk-" + server.uid() + ".tmp")
        shutil.copyfile(folder / "作品.yejian.json", export_orphan)
        self.assertIn(self.secret, orphan.read_text())
        self.assertIn(self.secret, export_orphan.read_text())
        result = self.write("purge")
        self.assertNotIn("cleanupPending", result)
        self.assertFalse(orphan.exists())
        self.assertFalse(export_orphan.exists())

    def test_unverified_export_text_temporary_blocks_without_deleting_it(self):
        folder = Path(server.sync_book_folder(self.book["id"], create=True)["folder"])
        orphan = folder / (".writer-desk-" + server.uid() + ".tmp")
        orphan.write_text("崩溃留下、未入manifest的旧正文 " + self.secret)
        before = self.row()
        with self.assertRaises(protection.ProtectionError) as error:
            self.write("purge")
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.row(), before)
        self.assertIn(self.secret, orphan.read_text())

    def test_inflight_ai_images_do_not_recreate_purged_content_or_remove_new_images(self):
        from ai_service import AIService, AIError
        from verify_ai_cover import PNG, JPEG
        service = AIService(server.DB_PATH.parent)
        service.save_settings({"enabled": True, "endpoint": "http://127.0.0.1:1/v1", "model": "isolated-fake", "apiKey": "test-only-fake-key"})
        new_image = {}
        def response_after_purge(*args, **kwargs):
            self.assertFalse(server.DB_LOCK._is_owned(), "Network request must not hold the app database lock")
            with server.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.rollback()
            self.write("purge")
            new_image.update(server.ChatImageStore(server.DB_PATH.parent).save(self.book["id"], "新的图片.jpg", "data:image/jpeg;base64," + JPEG))
            return {"content": json.dumps({"reply": "来自旧请求的答复", "data": None}), "images": ["data:image/png;base64," + PNG]}
        with patch.object(AIService, "_request", side_effect=response_after_purge):
            with self.assertRaises(AIError):
                server.handle_ai_request("/api/books/" + self.book["id"] + "/ai", {"action": "custom", "chapterIds": [], "instruction": "旧请求", "skillIds": [], "chat": True, "history": []})
        store = server.ChatImageStore(server.DB_PATH.parent)
        self.assertTrue(store.read(self.book["id"], new_image["id"])[0])
        folder = server.DB_PATH.parent / "ai-chat-images" / store.book_key(self.book["id"])
        self.assertEqual([path.name for path in folder.iterdir()], [new_image["id"]])

    def test_unregistered_importlib_module_can_initialize_and_route_history(self):
        name = "writer_unregistered_history_test"
        self.assertNotIn(name, sys.modules)
        spec = importlib.util.spec_from_file_location(name, ROOT / "server.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.DB_PATH = server.DB_PATH.parent / "unregistered" / "writer.sqlite3"
        module.initialize()
        self.assertEqual(chapter_history.read(module.chapter_history_context(), "/api/history/chapter-purges"), {"purges": []})
        self.assertEqual(chapter_history.read(module.chapter_history_context(), "/api/history/chapters")["chapters"], [])
        self.assertNotIn(name, sys.modules)


if __name__ == "__main__":
    unittest.main(verbosity=2)
