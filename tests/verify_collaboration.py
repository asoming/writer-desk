#!/usr/bin/env python3
"""Real HTTP, revision merging, offline retries and desktop sync regression."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import sqlite3
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collaboration as hub
from sync_client import SyncService
from server import new_book, chapter, validate_book


class HubTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server, self.thread = hub.start_hub(self.temp.name, port=0, validator=validate_book)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.owner = self.call("/v1/setup", {"bootstrap": self.server.store.bootstrap, "name": "所有者"})
        self.base = "/v1/workspaces/" + self.owner["workspaceId"]
        invite = self.call(self.base + "/invite", {"role": "editor"}, self.owner)
        self.editor = self.call("/v1/join", {"invite": invite["invite"], "name": "共同作者"})
        self.book = new_book("同步测试")
        self.book["chapters"] = [chapter("第一章", "第一段。\n第二段。\n第三段。", self.book["volumes"][0]["id"]), chapter("第二章", "另一章。", self.book["volumes"][0]["id"])]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.store.close()
        self.temp.cleanup()

    def call(self, path, data=None, member=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if member:
            headers["Authorization"] = "Bearer " + member["token"]
        if origin:
            headers["Origin"] = origin
        req = Request(self.url + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        with urlopen(req, timeout=5) as response:
            return json.loads(response.read())

    def sync(self, book, revision=0, member=None, request_id=None):
        return self.call(self.base + "/sync", {"requestId": request_id or uuid.uuid4().hex, "book": book, "baseRevision": revision}, member or self.owner)

    def assert_status(self, status, run):
        with self.assertRaises(HTTPError) as result:
            run()
        self.assertEqual(result.exception.code, status)

    def test_roles_revoke_and_origin(self):
        self.assert_status(401, lambda: self.call(self.base + "/books"))
        self.assert_status(403, lambda: self.call(self.base + "/invite", {"role": "owner"}, self.editor))
        invite = self.call(self.base + "/invite", {"role": "viewer"}, self.owner)
        viewer = self.call("/v1/join", {"invite": invite["invite"], "name": "读者"})
        self.assert_status(403, lambda: self.call("/v1/join", {"invite": invite["invite"], "name": "再次加入"}))
        self.sync(self.book)
        self.assertEqual(len(self.call(self.base + "/books", member=viewer)["books"]), 1)
        self.assert_status(403, lambda: self.sync(self.book, 1, viewer))
        self.assert_status(403, lambda: self.call(self.base + "/books", member=self.owner, origin="https://untrusted.invalid"))
        self.call(self.base + "/revoke", {"id": viewer["memberId"], "kind": "member"}, self.owner)
        self.assert_status(401, lambda: self.call(self.base + "/books", member=viewer))
        pending = self.call(self.base + "/invite", {"role": "editor"}, self.owner)
        self.call(self.base + "/revoke", {"id": pending["id"], "kind": "invite"}, self.owner)
        self.assert_status(403, lambda: self.call("/v1/join", {"invite": pending["invite"], "name": "不可加入"}))
        for secret in [self.owner["token"], self.editor["token"], invite["invite"], pending["invite"]]:
            self.assertNotIn(secret, self.server.store.path.read_bytes().decode("latin1"))

    def test_disjoint_chapters_fields_and_text(self):
        self.sync(self.book)
        left, right = copy.deepcopy(self.book), copy.deepcopy(self.book)
        left["chapters"][0]["body"] = "第一段修改。\n第二段。\n第三段。"
        right["chapters"][1]["title"] = "新章名"
        self.sync(left, 1)
        result = self.sync(right, 1, self.editor)
        self.assertNotIn("conflict", result)
        self.assertEqual(result["book"]["chapters"][0]["body"], left["chapters"][0]["body"])
        self.assertEqual(result["book"]["chapters"][1]["title"], "新章名")
        base = result["book"]
        left, right = copy.deepcopy(base), copy.deepcopy(base)
        left["chapters"][0]["body"] = base["chapters"][0]["body"].replace("第二段", "中间段")
        right["chapters"][0]["body"] = base["chapters"][0]["body"].replace("第三段", "最后段")
        self.sync(left, 3)
        result = self.sync(right, 3, self.editor)
        self.assertNotIn("conflict", result)
        self.assertIn("中间段", result["book"]["chapters"][0]["body"])
        self.assertIn("最后段", result["book"]["chapters"][0]["body"])

    def test_conflicts_idempotency_and_explicit_copy(self):
        self.sync(self.book)
        left, right = copy.deepcopy(self.book), copy.deepcopy(self.book)
        left["chapters"][0]["body"], right["chapters"][0]["body"] = "作者甲的版本。", "作者乙的版本。"
        self.sync(left, 1)
        request_id = uuid.uuid4().hex
        result = self.sync(right, 1, self.editor, request_id)
        self.assertIn("conflict", result)
        self.assertEqual(result, self.sync(right, 1, self.editor, request_id))
        self.assertEqual(len(self.call(self.base + "/conflicts", member=self.editor)["conflicts"]), 1)
        conflict_id = result["conflict"]["id"]
        detail = self.call(self.base + "/conflicts/" + conflict_id, member=self.owner)
        self.assertEqual(detail["incoming"]["chapters"][0]["body"], right["chapters"][0]["body"])
        self.assert_status(409, lambda: self.call(self.base + "/conflicts/" + conflict_id + "/resolve", {"choice": "copy", "expectedRevision": 1}, self.editor))
        copy_result = self.call(self.base + "/conflicts/" + conflict_id + "/resolve", {"choice": "copy", "expectedRevision": 2}, self.editor)
        self.assertNotEqual(copy_result["book"]["id"], self.book["id"])
        self.assertEqual(copy_result["book"]["chapters"][0]["body"], right["chapters"][0]["body"])
        original = self.call(self.base + "/books/" + self.book["id"], member=self.owner)
        self.assertEqual(original["book"]["chapters"][0]["body"], left["chapters"][0]["body"])
        changed = copy.deepcopy(right)
        changed["title"] = "不同请求"
        self.assert_status(409, lambda: self.sync(changed, 1, self.editor, request_id))

    def test_workspace_isolation_tombstones_and_presence(self):
        self.sync(self.book)
        other = uuid.uuid4().hex
        with self.server.store.db:
            self.server.store.db.execute("INSERT INTO workspaces VALUES(?,?)", (other, "其他空间"))
        self.assert_status(403, lambda: self.call("/v1/workspaces/" + other + "/books", member=self.owner))
        deleted = copy.deepcopy(self.book)
        deleted["deletedAt"] = hub.now()
        result = self.sync(deleted, 1)
        self.assertTrue(result["book"]["deletedAt"])
        self.assertEqual(result["book"]["chapters"][0]["body"], self.book["chapters"][0]["body"])
        restored = copy.deepcopy(result["book"])
        restored["deletedAt"] = None
        self.assertFalse(self.sync(restored, 2)["book"].get("deletedAt"))
        self.call(self.base + "/presence", {"bookId": self.book["id"]}, self.editor)
        presence = self.call(self.base + "/presence", {"bookId": self.book["id"]}, self.owner)
        self.assertEqual(len(presence["members"]), 2)

    def test_full_sample_and_restart(self):
        sample = json.loads((Path(__file__).resolve().parents[1] / "examples/tide-archive.yejian.json").read_text())["book"]
        result = self.sync(sample)
        self.assertEqual(sum(len(chapter["body"].replace("\n", "").replace(" ", "")) for chapter in result["book"]["chapters"] if not chapter.get("deletedAt")), 101506)
        self.assertEqual(len(result["book"]["reviewTools"]["bookmarks"]), 6)
        self.server.shutdown();self.server.server_close();self.server.store.close()
        self.server, self.thread = hub.start_hub(self.temp.name, port=0, validator=validate_book)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        result = self.call(self.base + "/books/" + sample["id"], member=self.editor)
        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["book"]["chapters"], sample["chapters"])

    def test_mobile_static_and_traversal(self):
        for path, text in [("/mobile/", "作家工作台"), ("/mobile/sw.js", "writerdesk-mobile"), ("/shared/manuscript-marks.js", "reanchorChapter")]:
            with urlopen(self.url + path) as response:
                self.assertIn(text, response.read().decode())
        self.assert_status(404, lambda: self.call("/mobile/%2e%2e/server.py"))

    def test_permanent_purge_scrubs_revisions_conflicts_replays(self):
        secret = "永久删除不能留下这段原稿。" + uuid.uuid4().hex
        self.book["chapters"][0]["body"] = secret
        first_id = uuid.uuid4().hex
        self.sync(self.book, request_id=first_id)
        left, right = copy.deepcopy(self.book), copy.deepcopy(self.book)
        left["title"], right["title"] = "甲的名称", "乙的名称"
        self.sync(left, 1)
        collision = self.sync(right, 1, self.editor)
        self.assertIn("conflict", collision)
        tombstone = {"id": self.book["id"], "deletedAt": hub.now(), "permanentlyDeleted": True}
        result = self.sync(tombstone, 0)
        self.assertEqual(result["book"], tombstone)
        self.assertFalse(self.call(self.base + "/conflicts", member=self.owner)["conflicts"])
        self.assertEqual(self.server.store.db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0], 0)
        replay = self.sync(self.book, request_id=first_id)
        self.assertEqual(replay["book"], tombstone)
        self.assert_status(410, lambda: self.sync(self.book, 1, self.editor))
        self.server.store.compact()
        for file in Path(self.temp.name).glob("collaboration.sqlite3*"):
            self.assertNotIn(secret.encode(), file.read_bytes())

    def test_chapter_purge_scrubs_history_conflicts_and_replays(self):
        secret = "彻底清理章节原稿" + uuid.uuid4().hex
        self.book["chapters"][0]["body"] = secret
        removed = self.book["chapters"][0]["id"]
        initial_id = uuid.uuid4().hex
        self.sync(self.book, request_id=initial_id)
        left, right = copy.deepcopy(self.book), copy.deepcopy(self.book)
        left["title"], right["title"] = "冲突甲", "冲突乙"
        self.sync(left, 1)
        self.assertIn("conflict", self.sync(right, 1, self.editor))
        result = self.call(self.base + "/chapters/purge", {"bookId": self.book["id"], "chapterIds": [removed]}, self.owner)
        self.assertEqual(result["purgedChapterIds"], [removed])
        current = self.call(self.base + "/books/" + self.book["id"], member=self.editor)
        self.assertNotIn(removed, [item["id"] for item in current["book"]["chapters"]])
        self.assertEqual(current["book"]["chapters"][0]["body"], "另一章。")
        self.assertEqual(current["purgedChapterIds"], [removed])
        conflicts = self.call(self.base + "/conflicts", member=self.owner)["conflicts"]
        self.assertTrue(conflicts)
        self.assert_status(410, lambda: self.call(self.base + "/conflicts/" + conflicts[0]["id"] + "/resolve", {"choice": "manual", "expectedRevision": current["revision"], "book": right}, self.editor))
        self.assert_status(410, lambda: self.sync(self.book, 1, self.editor))
        self.assertNotIn(secret, json.dumps(self.sync(self.book, request_id=initial_id)))
        for file in Path(self.temp.name).glob("collaboration.sqlite3*"):
            self.assertNotIn(secret.encode(), file.read_bytes())

    def test_busy_checkpoint_keeps_purge_pending_until_reader_closes(self):
        secret = "读快照仍持有的原稿" + uuid.uuid4().hex
        self.book["chapters"][0]["body"] = secret
        self.sync(self.book)
        reader = sqlite3.connect(self.server.store.path)
        try:
            reader.execute("BEGIN")
            self.assertIn(secret, reader.execute("SELECT payload FROM books").fetchone()[0])
            changed = copy.deepcopy(self.book)
            changed["title"] = "另一个修订"
            self.sync(changed, 1)
            data = {"bookId": self.book["id"], "chapterIds": [self.book["chapters"][0]["id"]]}
            self.assert_status(503, lambda: self.call(self.base + "/chapters/purge", data, self.owner))
            self.assertIn(secret.encode(), Path(str(self.server.store.path) + "-wal").read_bytes())
        finally:
            reader.close()
        result = self.call(self.base + "/chapters/purge", data, self.owner)
        self.assertTrue(result["ok"])
        for file in Path(self.temp.name).glob("collaboration.sqlite3*"):
            self.assertNotIn(secret.encode(), file.read_bytes())

    def test_migrated_workspace_at_another_endpoint_requires_real_purge(self):
        directory = tempfile.TemporaryDirectory()
        books = {self.book["id"]: {"book": copy.deepcopy(self.book), "revision": 1}}
        def get(book_id):
            return copy.deepcopy(books[book_id])
        def save(book, expected):
            books[book["id"]] = {"book": copy.deepcopy(book), "revision": (expected or 0) + 1}
            return get(book["id"])
        service = SyncService(directory.name, get, save, lambda: [{"id": value} for value in books], validate_book)
        try:
            service.host_start({"host": "127.0.0.1", "port": 0})
            owner = service._config()
            service.sync(self.book["id"])
            with self.server.store.lock:
                service.server.store.db.backup(self.server.store.db)
            service.connect({"url": self.url, "workspaceId": owner["workspaceId"], "token": owner["token"], "autoSync": False})
            calls = []
            real = service._request
            def tracking(config, method, path, data=None, public=False):
                calls.append((config["url"], method, path))
                return real(config, method, path, data, public)
            service._request = tracking
            self.assertTrue(service.sanitize_chapters(self.book["id"], [self.book["chapters"][0]["id"]]))
            self.assertIn((self.url, "POST", "/chapters/purge"), calls)
            remote_member = self.server.store.authenticate(owner["token"], owner["workspaceId"])
            self.assertEqual(len(self.server.store.get_book(remote_member, self.book["id"])["book"]["chapters"]), 1)
            calls.clear()
            self.assertTrue(service.forget_book(self.book["id"], hub.now()))
            self.assertIn((self.url, "POST", "/sync"), calls)
            self.assertTrue(self.server.store.get_book(remote_member, self.book["id"])["book"]["permanentlyDeleted"])
        finally:
            service.close()
            directory.cleanup()

    def test_desktop_offline_retry_and_bidirectional_download(self):
        first, second = {}, {}
        local_temp = tempfile.TemporaryDirectory()
        services = []

        def service(directory, books):
            def get(book_id):
                return copy.deepcopy(books[book_id])
            def save(book, expected):
                current = books.get(book["id"])
                if (current["revision"] if current else None) != expected:
                    raise ValueError("本机版本已变化")
                books[book["id"]] = {"book": copy.deepcopy(book), "revision": expected + 1 if expected is not None else 1}
                return copy.deepcopy(books[book["id"]])
            result = SyncService(directory, get, save, lambda: [{"id": key} for key in books], validate_book)
            services.append(result)
            return result

        try:
            first[self.book["id"]] = {"book": copy.deepcopy(self.book), "revision": 1}
            a = service(Path(local_temp.name) / "a", first)
            a.connect({"url": self.url, "workspaceId": self.owner["workspaceId"], "token": self.owner["token"]})
            a.sync()
            b = service(Path(local_temp.name) / "b", second)
            b.connect({"url": self.url, "workspaceId": self.editor["workspaceId"], "token": self.editor["token"]})
            b.sync()
            self.assertEqual(first[self.book["id"]]["book"], second[self.book["id"]]["book"])
            second[self.book["id"]]["book"]["chapters"][1]["body"] = "离线写下的段落🌊。"
            second[self.book["id"]]["revision"] += 1
            original_request = b._request
            failed_once = [False]
            def drop_response(config, method, path, data=None, public=False):
                result = original_request(config, method, path, data, public)
                if path == "/sync" and not failed_once[0]:
                    failed_once[0] = True
                    raise hub.SyncError("模拟断网", 503)
                return result
            b._request = drop_response
            with self.assertRaises(hub.SyncError):
                b.sync()
            b._request = original_request
            b.sync();a.sync()
            self.assertEqual(first[self.book["id"]]["book"]["chapters"][1]["body"], "离线写下的段落🌊。")
            self.assertEqual(self.call(self.base + "/books/" + self.book["id"], member=self.owner)["revision"], 2)
            first[self.book["id"]]["book"]["chapters"][0]["title"] = "甲的远端改名"
            first[self.book["id"]]["revision"] += 1
            a.sync()
            second[self.book["id"]]["book"]["chapters"][1]["body"] += "发送前的字。"
            second[self.book["id"]]["revision"] += 1
            edited_during_request = [False]
            def continued_typing(config, method, path, data=None, public=False):
                result = original_request(config, method, path, data, public)
                if path == "/sync" and not edited_during_request[0]:
                    edited_during_request[0] = True
                    second[self.book["id"]]["book"]["chapters"][1]["body"] += "请求期间继续输入。"
                    second[self.book["id"]]["revision"] += 1
                return result
            b._request = continued_typing
            self.assertEqual(b.sync()["books"][0]["status"], "synced-local-changes")
            b._request = original_request
            b.sync();a.sync()
            final = first[self.book["id"]]["book"]
            self.assertEqual(final["chapters"][0]["title"], "甲的远端改名")
            self.assertTrue(final["chapters"][1]["body"].endswith("请求期间继续输入。"))
            requests = []
            def summary_only(config, method, path, data=None, public=False):
                requests.append((method, path))
                return original_request(config, method, path, data, public)
            b._request = summary_only
            self.assertEqual(b.sync()["books"][0]["status"], "unchanged")
            self.assertNotIn(("GET", "/books/" + self.book["id"]), requests)
        finally:
            for item in services:
                item.close()
            local_temp.cleanup()


class MergeTest(unittest.TestCase):
    def test_deleted_collection_and_disjoint_additions(self):
        base = {"items": [{"id": "a", "value": 1}, {"id": "b", "value": 2}]}
        left = {"items": [{"id": "b", "value": 2}]}
        right = {"items": [{"id": "a", "value": 1}, {"id": "b", "value": 3}, {"id": "c", "value": 4}]}
        merged, conflicts = hub.three_way_merge(base, left, right)
        self.assertFalse(conflicts)
        self.assertEqual(merged, {"items": [{"id": "b", "value": 3}, {"id": "c", "value": 4}]})
        changed = {"items": [{"id": "a", "value": 5}, {"id": "b", "value": 2}]}
        _, conflicts = hub.three_way_merge(base, left, changed)
        self.assertTrue(conflicts)


if __name__ == "__main__":
    unittest.main()
