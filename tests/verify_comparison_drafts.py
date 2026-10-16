"""Comparison draft/apply lifecycle uses disposable libraries only."""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import chapter_history
import comparison_drafts as comparison
import protection
import server


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="writer-comparison-")
        self.addCleanup(temporary.cleanup)
        self.addCleanup(setattr, server, "DB_PATH", server.DB_PATH)
        server.DB_PATH = Path(temporary.name) / "writer.sqlite3"
        server.initialize()
        self.book = server.new_book("对照修改隔离检验")
        self.chapter = server.chapter("原题", "窗外落下雨。🌧️\n原文保留。", self.book["volumes"][0]["id"])
        self.book["chapters"] = [self.chapter]
        with server.connect() as conn:
            server.insert_book(conn, self.book)
        self.path = f'/api/books/{self.book["id"]}/chapters/{self.chapter["id"]}/comparison'

    def row(self):
        with server.connect() as conn:
            return dict(server.saved_book_row(conn, self.book["id"]))

    def read(self):
        return comparison.read(server, self.path)

    def request(self, result=None, body="窗外升起太阳。☀️\n原文保留。", title="改题"):
        result = self.read() if result is None else result
        draft = result["draft"]
        return {"version": draft["version"] if draft else 0,
                "canonicalFingerprint": draft["canonicalFingerprint"] if draft else result["canonicalFingerprint"],
                "baseline": copy.deepcopy(draft["baseline"] if draft else result["canonical"]),
                "draft": {"title": title, "body": body}}

    def write(self, data=None):
        return comparison.put(server, self.path, self.request() if data is None else data)

    def apply_request(self, result=None, **extra):
        result = self.read() if result is None else result
        return {"version": result["draft"]["version"], "canonicalFingerprint": result["draft"]["canonicalFingerprint"],
                "revision": result["revision"], **extra}

    def apply(self, data=None):
        return comparison.apply(server, self.path + "/apply", self.apply_request() if data is None else data)

    def canonical_update(self, **fields):
        value = json.loads(self.row()["payload"])
        value["chapters"][0].update(fields)
        with server.connect() as conn:
            conn.execute("UPDATE books SET payload=?,revision=revision+1 WHERE id=?", (json.dumps(value, ensure_ascii=False), self.book["id"]))

    def test_creation_and_restart_keep_pair_without_mutating_canonical_history_stats_or_exports(self):
        before = self.row()
        snapshot = server.checkpoint_book(self.book["id"], force=True)
        secret = "只在修改稿保留-" + server.uid()
        result = self.write(self.request(body=secret))
        self.assertEqual(result["draft"]["version"], 1)
        self.assertEqual(result["draft"]["baseline"], comparison.text_pair(self.chapter))
        self.assertFalse(result["stale"])
        self.assertEqual(self.row(), before)
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history WHERE book_id=?", (self.book["id"],)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM writing_activity WHERE book_id=?", (self.book["id"],)).fetchone()[0], 0)
        folder = Path(server.sync_book_folder(self.book["id"], create=True)["folder"])
        self.assertNotIn(secret, (folder / "正文.txt").read_text("utf-8"))
        self.assertNotIn(secret, (folder / "作品.yejian.json").read_text("utf-8"))
        backup = server.read_protection(f'/api/books/{self.book["id"]}/backups/{snapshot["token"]}')
        self.assertNotIn(secret, json.dumps(backup, ensure_ascii=False))
        server.initialize()
        self.assertEqual(self.read(), result)

    def test_draft_version_cas_rejects_other_window_and_original_baseline_replacement(self):
        original_request = self.request()
        first = self.write(original_request)
        with self.assertRaises(protection.ProtectionError) as error:
            self.write(original_request)
        self.assertEqual((error.exception.status, error.exception.conflict), (409, True))
        replaced = self.request(first)
        replaced["baseline"]["body"] = "悄悄替换原文"
        with self.assertRaises(protection.ProtectionError):
            self.write(replaced)
        self.assertEqual(self.read(), first)

    def test_stale_pair_remains_readable_and_editable_but_cannot_apply_without_explicit_rebase(self):
        first = self.write()
        self.canonical_update(body="另一个窗口保存的新正文。")
        stale = self.read()
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["draft"], first["draft"])
        kept = self.write(self.request(stale, body="继续在旧对照稿中修改，退出后仍要保留。"))
        self.assertTrue(kept["stale"])
        self.assertEqual(kept["draft"]["canonicalFingerprint"], first["canonicalFingerprint"])
        before = self.row()
        with self.assertRaises(protection.ProtectionError):
            self.apply(self.apply_request(kept))
        self.assertEqual(self.row(), before)
        # A current fingerprint alone does not silently consent to rebasing.
        request = self.request(kept)
        request["canonicalFingerprint"] = kept["canonicalFingerprint"]
        with self.assertRaises(protection.ProtectionError):
            self.write(request)
        request["rebase"] = True
        rebased = self.write(request)
        self.assertFalse(rebased["stale"])
        self.assertEqual(rebased["draft"]["baseline"], first["draft"]["baseline"])
        self.assertEqual(rebased["draft"]["canonical"]["body"], "另一个窗口保存的新正文。")
        adopted = self.apply(self.apply_request(rebased))
        self.assertEqual(adopted["book"]["chapters"][0]["body"], request["draft"]["body"])

    def test_apply_is_explicit_records_normal_history_stats_and_preserves_original_pair(self):
        draft = self.write(self.request(body=self.chapter["body"] + "\n新增七个汉字。"))
        result = self.apply(self.apply_request(draft))
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["book"]["chapters"][0]["title"], "改题")
        self.assertEqual(result["comparison"]["baseline"], comparison.text_pair(self.chapter))
        self.assertEqual(result["comparison"]["draft"], draft["draft"]["draft"])
        self.assertEqual(result["comparison"]["version"], 2)
        self.assertEqual(result["comparison"]["canonical"], draft["draft"]["draft"])
        self.assertFalse(self.read()["stale"])
        with server.connect() as conn:
            history = json.loads(conn.execute("SELECT payload FROM history WHERE book_id=?", (self.book["id"],)).fetchone()[0])
            self.assertEqual(history["chapters"][0]["body"], self.chapter["body"])
            self.assertEqual(conn.execute("SELECT added_chars FROM writing_activity WHERE book_id=?", (self.book["id"],)).fetchone()[0], 7)
        with self.assertRaises(protection.ProtectionError):
            self.apply(self.apply_request(draft))
        # Reopening the pair and saving it again cannot double count production.
        again = self.apply()
        self.assertEqual(again["comparison"]["baseline"], result["comparison"]["baseline"])
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT added_chars FROM writing_activity WHERE book_id=?", (self.book["id"],)).fetchone()[0], 7)

    def test_apply_cas_checks_book_revision_even_when_other_chapter_changed(self):
        draft = self.write()
        with server.connect() as conn:
            conn.execute("UPDATE books SET revision=revision+1 WHERE id=?", (self.book["id"],))
        with self.assertRaises(protection.ProtectionError):
            self.apply(self.apply_request(draft))
        self.assertFalse(self.read()["stale"])
        self.assertEqual(self.apply()["revision"], 3)

    def test_apply_transaction_failure_rolls_back_book_history_activity_and_pair(self):
        draft = self.write(self.request(body=self.chapter["body"] + "大量新文字。"))
        before = self.row()
        with server.connect() as conn:
            conn.execute("CREATE TRIGGER fail_comparison_apply BEFORE UPDATE ON comparison_drafts BEGIN SELECT RAISE(ABORT,'isolated SQL failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.apply()
        self.assertEqual(self.row(), before)
        self.assertEqual(self.read(), draft)
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history WHERE book_id=?", (self.book["id"],)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM writing_activity WHERE book_id=?", (self.book["id"],)).fetchone()[0], 0)

    def test_apply_validates_reanchored_marks_and_fails_atomically_on_invalid_review_data(self):
        self.write()
        before = self.row()
        with self.assertRaises(ValueError):
            self.apply(self.apply_request(reviewTools={"bookmarks": "invalid"}))
        self.assertEqual(self.row(), before)
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history WHERE book_id=?", (self.book["id"],)).fetchone()[0], 0)
        result = self.apply(self.apply_request(reviewTools={"version": 1, "dictionary": ["太阳"], "annotations": [], "bookmarks": []}))
        self.assertEqual(result["book"]["reviewTools"]["dictionary"], ["太阳"])

    def test_short_story_apply_keeps_one_continuous_manuscript_and_pair_after_restart(self):
        short = server.new_book("连续短篇对照", "short")
        short["chapters"][0]["body"] = "第一段。\n\n第二段。"
        with server.connect() as conn:
            server.insert_book(conn, short)
        chapter_id = short["chapters"][0]["id"]
        path = f'/api/books/{short["id"]}/chapters/{chapter_id}/comparison'
        current = comparison.read(server, path)
        request = {"version": 0, "canonicalFingerprint": current["canonicalFingerprint"],
                   "baseline": current["canonical"], "draft": {"title": "正文", "body": "修改第一段。\n\n第二段。\n\n新增第三段。"}}
        saved = comparison.put(server, path, request)
        result = comparison.apply(server, path + "/apply", {"version": saved["draft"]["version"], "canonicalFingerprint": saved["draft"]["canonicalFingerprint"], "revision": 1})
        self.assertEqual(result["book"]["volumes"], [])
        self.assertEqual(len(result["book"]["chapters"]), 1)
        self.assertEqual(result["book"]["chapters"][0]["id"], chapter_id)
        self.assertEqual(result["book"]["chapters"][0]["body"], request["draft"]["body"])
        server.initialize()
        self.assertEqual(comparison.read(server, path)["draft"]["baseline"], request["baseline"])

    def test_read_is_side_effect_free_and_draft_boundaries_fail_without_writes(self):
        before = self.row()
        self.assertIsNone(self.read()["draft"])
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM comparison_drafts").fetchone()[0], 0)
        for request in (self.request(title="题" * 201), self.request(body="字" * 5_000_001)):
            with self.assertRaises(ValueError):
                self.write(request)
        with patch.object(server, "MAX_BOOK", 32):
            with self.assertRaises(ValueError):
                self.write(self.request(body="字" * 100))
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM comparison_drafts").fetchone()[0], 0)
        self.assertEqual(self.row(), before)

    def test_long_chapter_purge_preserves_other_chapter_pair(self):
        self.write()
        other = server.chapter("另章", "另章原文。", self.book["volumes"][0]["id"])
        value = json.loads(self.row()["payload"])
        value["chapters"].append(other)
        with server.connect() as conn:
            conn.execute("UPDATE books SET payload=? WHERE id=?", (json.dumps(value), self.book["id"]))
        path = self.path.replace(self.chapter["id"], other["id"])
        current = comparison.read(server, path)
        saved = comparison.put(server, path, {"version": 0, "canonicalFingerprint": current["canonicalFingerprint"], "baseline": current["canonical"], "draft": {"title": "另章改题", "body": "另章修改。"}})
        self.canonical_update(deletedAt=server.now())
        chapter_history.write(server, self.path.removesuffix("comparison") + "purge", {"revision": 2})
        self.assertEqual(comparison.read(server, path)["draft"], saved["draft"])

    def test_validation_and_delete_cas_never_mutate_committed_book(self):
        before = self.row()
        for change in ({"version": True}, {"canonicalFingerprint": "bad"}, {"rebase": 1}, {"unknown": "ignored?"}, {"draft": {"title": "x", "body": 1}}, {"baseline": {"title": "x", "body": "wrong"}}):
            request = self.request()
            request.update(change)
            with self.assertRaises((ValueError, protection.ProtectionError)):
                self.write(request)
        created = self.write()
        with self.assertRaises(protection.ProtectionError):
            comparison.delete(server, self.path, {"version": 0})
        self.assertIsNotNone(self.read()["draft"])
        deleted = comparison.delete(server, self.path, {"version": created["draft"]["version"]})
        self.assertIsNone(deleted["draft"])
        self.assertEqual(self.row(), before)

    def test_other_books_chapters_trash_and_missing_ids_are_isolated(self):
        saved = self.write()
        other = server.new_book("不同作品")
        other["chapters"] = [{**self.chapter, "body": "另一部书独立正文。", "volumeId": other["volumes"][0]["id"]}]
        with server.connect() as conn:
            server.insert_book(conn, other)
        other_path = self.path.replace(self.book["id"], other["id"])
        self.assertIsNone(comparison.read(server, other_path)["draft"])
        for path in (self.path.replace(self.chapter["id"], "missing"), self.path.replace(self.book["id"], "missing")):
            with self.assertRaises(protection.ProtectionError) as error:
                comparison.read(server, path)
            self.assertEqual(error.exception.status, 404)
        server.change_book_trash(f'/api/books/{self.book["id"]}/trash', {"revision": 1})
        with self.assertRaises(protection.ProtectionError) as error:
            self.read()
        self.assertEqual(error.exception.status, 409)
        server.change_book_trash(f'/api/books/{self.book["id"]}/restore', {"revision": 2})
        self.assertEqual(self.read()["draft"], saved["draft"])

    def test_chapter_and_book_permanent_purge_remove_drafts_and_private_text(self):
        secret = "已彻底清除的对照草稿-" + server.uid()
        self.write(self.request(body=secret))
        self.canonical_update(deletedAt=server.now())
        with self.assertRaises(protection.ProtectionError):
            self.read()
        chapter_history.write(server, self.path.removesuffix("comparison") + "purge", {"revision": 2})
        with server.connect() as conn:
            self.assertIsNone(comparison.saved(conn, self.book["id"], self.chapter["id"]))
        self.assertNotIn(secret.encode("utf-8"), server.DB_PATH.read_bytes())
        second = server.new_book("整书彻底清除")
        second["chapters"] = [server.chapter("正文", "原文", second["volumes"][0]["id"])]
        with server.connect() as conn:
            server.insert_book(conn, second)
        second_path = f'/api/books/{second["id"]}/chapters/{second["chapters"][0]["id"]}/comparison'
        current = comparison.read(server, second_path)
        comparison.put(server, second_path, {"version": 0, "canonicalFingerprint": current["canonicalFingerprint"], "baseline": current["canonical"], "draft": {"title": "正文", "body": secret}})
        server.change_book_trash(f'/api/books/{second["id"]}/trash', {"revision": 1})
        server.change_book_trash(f'/api/books/{second["id"]}/purge', {"revision": 2})
        with server.connect() as conn:
            self.assertIsNone(comparison.saved(conn, second["id"], second["chapters"][0]["id"]))
        self.assertNotIn(secret.encode("utf-8"), server.DB_PATH.read_bytes())

    def test_legacy_short_alias_purge_removes_whole_combined_pair(self):
        short = server.new_book("旧版短篇", "short")
        first = {"id": "old-short-first", "title": "原短篇", "body": "甲段\n\n乙段", "volumeId": None, "deletedAt": None}
        short["chapters"] = [first]
        short["shortSections"] = [{"id": first["id"], "title": "旧一", "start": 0, "end": 2}, {"id": "old-short-second", "title": "旧二", "start": 4, "end": 6}]
        with server.connect() as conn:
            server.insert_book(conn, short)
        path = f'/api/books/{short["id"]}/chapters/{first["id"]}/comparison'
        current = comparison.read(server, path)
        comparison.put(server, path, {"version": 0, "canonicalFingerprint": current["canonicalFingerprint"], "baseline": current["canonical"], "draft": {"title": "原短篇", "body": "甲段\n\n秘密乙段"}})
        alias_path = path.replace(first["id"], "old-short-second")
        with self.assertRaises(protection.ProtectionError):
            comparison.read(server, alias_path)
        # The alias cleanup path removes any pair that could retain its text.
        with server.connect() as conn:
            comparison.purge_chapters(conn, short["id"], {"old-short-second"}, short=True)
        self.assertIsNone(comparison.read(server, path)["draft"])

    def test_failing_postcommit_snapshot_or_folder_reports_warning_after_pair_and_book_commit(self):
        draft = self.write()
        with patch.object(server, "checkpoint_book", side_effect=OSError("test disk unavailable")), patch.object(server, "sync_book_folder", side_effect=OSError("test folder unavailable")):
            result = self.apply()
        self.assertIn("protectionWarning", result)
        self.assertIn("folderWarning", result)
        self.assertEqual(result["book"]["chapters"][0]["body"], draft["draft"]["draft"]["body"])
        self.assertEqual(self.read()["draft"], result["comparison"])

    def test_main_person_selection_distinguishes_automatic_and_intentionally_empty(self):
        book = copy.deepcopy(self.book)
        person = {"id": "person-a", "type": "人物", "title": "甲", "body": "", "chapterIds": [], "deletedAt": None}
        book["notes"] = [person, {**person, "id": "person-recycled", "deletedAt": server.now()}]
        self.assertNotIn("atlasMainPersonIds", server.validate_book(book))
        book["atlasMainPersonIds"] = []
        self.assertEqual(server.validate_book(book)["atlasMainPersonIds"], [])
        book["atlasMainPersonIds"] = ["person-a", "person-recycled", "person-a"]
        self.assertEqual(server.validate_book(book)["atlasMainPersonIds"], ["person-a", "person-recycled"])
        book["atlasMainPersonIds"] = ["other-book-person"]
        with self.assertRaises(ValueError):
            server.validate_book(book)

    def test_authenticated_http_routes_enforce_client_origin_token_and_draft_cas(self):
        self.addCleanup(setattr, server, "DESKTOP_TOKEN", server.DESKTOP_TOKEN)
        server.DESKTOP_TOKEN = "isolated-comparison-token"
        http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        def stop():
            http.shutdown()
            thread.join(5)
            http.server_close()
        self.addCleanup(stop)
        url = f'http://127.0.0.1:{http.server_port}'
        def request(path, method="GET", data=None, status=200, **headers):
            values = {"Content-Type": "application/json", "X-Writer-Client": "1", "X-Writer-Desktop": server.DESKTOP_TOKEN, **headers}
            req = urllib.request.Request(url + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers=values)
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    actual, body = response.status, json.load(response)
            except urllib.error.HTTPError as error:
                actual, body = error.code, json.loads(error.read())
            self.assertEqual(actual, status, body)
            return body
        current = request(self.path)
        request(self.path, status=403, **{"X-Writer-Desktop": "bad-token"})
        payload = self.request(current)
        request(self.path, "PUT", payload, status=403, **{"Origin": "https://example.invalid"})
        request(self.path, "PUT", payload, status=403, **{"X-Writer-Client": ""})
        saved = request(self.path, "PUT", payload)
        request(self.path, "PUT", payload, status=409)
        request(self.path + "/apply", "POST", self.apply_request(saved), status=403, **{"X-Writer-Desktop": "bad-token"})
        adopted = request(self.path + "/apply", "POST", self.apply_request(saved))
        self.assertEqual(adopted["book"]["chapters"][0]["body"], payload["draft"]["body"])
        request(self.path, "DELETE", {"version": saved["draft"]["version"]}, status=409)
        request(self.path, "DELETE", {"version": adopted["comparison"]["version"]}, status=403, **{"X-Writer-Desktop": "bad-token"})
        self.assertIsNone(request(self.path, "DELETE", {"version": adopted["comparison"]["version"]})["draft"])


if __name__ == "__main__":
    unittest.main()
