#!/usr/bin/env python3
"""Disposable real-loopback API checks for the 0.8 desktop integrations."""
import argparse
import copy
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import verify_review_workflow as workflow
import verify_ai_profiles_usage as provider_fixture


class ExtensionsAPI(unittest.TestCase):
    # Reuse only the existing portable process harness, not its test cases.
    setUp = workflow.ReviewWorkflowTests.setUp
    start = workflow.ReviewWorkflowTests.start
    stop = workflow.ReviewWorkflowTests.stop
    request = workflow.ReviewWorkflowTests.request
    get = workflow.ReviewWorkflowTests.get
    save = workflow.ReviewWorkflowTests.save

    def manuscript(self, title="接口回归"):
        result = self.request("/api/books", "POST", {"title": title, "kind": "long"}, status=201)
        book = result["book"]
        volume = book["volumes"][0]["id"]
        book["chapters"] = [{"id": uuid.uuid4().hex, "title": "第一章", "body": "唯一正文针🌊。", "volumeId": volume, "deletedAt": None}, {"id": uuid.uuid4().hex, "title": "第二章", "body": "第二章原稿。", "volumeId": volume, "deletedAt": None}]
        book["notes"] = [{"id": uuid.uuid4().hex, "title": "唯一人物针", "type": "人物", "body": "人物资料。", "deletedAt": None}]
        book["outline"] = [{"id": uuid.uuid4().hex, "title": "唯一大纲针", "body": "剧情安排。", "chapterIds": [book["chapters"][0]["id"]], "deletedAt": None}]
        self.save(result)
        return self.get(book["id"])

    def test_profiles_actual_usage_and_authenticated_clear(self):
        provider_fixture.Provider.calls = []
        provider_fixture.Provider.mode = "json"
        provider_fixture.Provider.pause = provider_fixture.Provider.resume = None
        provider_fixture.Provider.usage = {"prompt_tokens": 1000, "completion_tokens": 400, "total_tokens": 1400, "prompt_tokens_details": {"cached_tokens": 200}}
        provider = ThreadingHTTPServer(("127.0.0.1", 0), provider_fixture.Provider)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        self.addCleanup(provider.server_close)
        self.addCleanup(provider.shutdown)
        initial = self.request("/api/ai/settings")
        self.request("/api/ai/profiles", "POST", {"name": "不可未授权创建"}, status=403, token=False)
        created = self.request("/api/ai/profiles", "POST", {"name": "回归服务"})
        identity = created["activeProfileId"]
        secret = "isolated-extensions-provider-secret"
        settings = self.request("/api/ai/settings", "PUT", {"enabled": True, "endpoint": f"http://127.0.0.1:{provider.server_port}", "model": "requested-model", "apiKey": secret, "pricing": {"input": 2, "output": 8, "cachedInput": 1, "currency": "USD"}})
        self.assertTrue(settings["hasKey"])
        self.assertNotIn(secret, json.dumps(settings))
        book = self.manuscript()
        self.request("/api/books/" + book["book"]["id"] + "/ai", "POST", {"action": "custom", "chapterIds": [], "instruction": "接口用量验收", "skillIds": []})
        usage = self.request("/api/ai/usage?bookId=" + book["book"]["id"])
        self.assertEqual(usage["totals"]["totalTokens"], 1400)
        self.assertEqual(usage["totals"]["requests"], 1)
        self.assertEqual(usage["entries"][0]["model"], "provider-actual")
        self.assertEqual(usage["totals"]["costs"], {"USD": "0.005"})
        self.assertNotIn(secret, json.dumps(usage))
        self.assertNotIn("唯一正文针", json.dumps(usage))
        self.request("/api/ai/usage", "DELETE", {"bookId": book["book"]["id"]}, status=403, token=False)
        self.assertEqual(self.request("/api/ai/usage", "DELETE", {"bookId": book["book"]["id"]})["totals"]["requests"], 0)
        switched = self.request("/api/ai/settings", "PUT", {"profileId": initial["activeProfileId"]})
        self.assertFalse(switched["hasKey"])
        removed = self.request("/api/ai/profiles/" + identity, "DELETE", {})
        self.assertNotIn(identity, [item["id"] for item in removed["profiles"]])

    def test_export_templates_asset_preview_and_cross_book_search(self):
        templates = self.request("/api/export-templates")
        selected = copy.deepcopy(templates["templates"][0])
        selected.update(id="my-submission", name="自定义投稿")
        selected["layout"].update(fontFamily="SimSun", firstLineIndent=2, lineHeight=2, chapterAlign="center")
        templates["templates"].append(selected)
        saved = self.request("/api/export-templates", "PUT", templates)
        self.assertEqual(saved, self.request("/api/export-templates"))
        invalid = copy.deepcopy(templates)
        invalid["templates"][-1]["layout"]["fontFamily"] = "<script>bad</script>"
        self.request("/api/export-templates", "PUT", invalid, status=400)
        self.assertEqual(saved, self.request("/api/export-templates"))
        first, second = self.manuscript("搜索甲"), self.manuscript("搜索乙")
        asset = {"id": uuid.uuid4().hex, "name": "唯一素材针", "kind": "web", "sourceUrl": "https://example.invalid/reference", "excerpt": "网页纯文本摘录。", "chapterIds": [first["book"]["chapters"][0]["id"]], "noteIds": []}
        preview = self.request("/api/books/" + first["book"]["id"] + "/assets/validate", "POST", {"asset": asset, "revision": first["revision"]})
        self.assertEqual(self.get(first["book"]["id"])["book"]["assetLibrary"]["items"], [])
        malicious = {**asset, "sourceUrl": "javascript:alert(1)"}
        self.request("/api/books/" + first["book"]["id"] + "/assets/validate", "POST", {"asset": malicious, "revision": first["revision"]}, status=400)
        first["book"]["assetLibrary"]["items"].append(preview["asset"])
        self.save(first)
        self.assertEqual(len(self.get(first["book"]["id"])["book"]["assetLibrary"]["items"]), 1)
        for needle, kind in [("唯一正文针", "chapter"), ("唯一人物针", "person"), ("唯一大纲针", "outline"), ("唯一素材针", "asset")]:
            result = self.request("/api/library-search?q=" + quote(needle))
            self.assertIn(kind, {item["type"] for item in result["results"]})
            if kind != "asset":
                self.assertEqual({item["bookId"] for item in result["results"]}, {first["book"]["id"], second["book"]["id"]})
        self.request("/api/library-search?q=" + quote("唯一正文针"), status=403, token=False)
        self.request("/api/books/" + second["book"]["id"] + "/trash", "POST", {"revision": second["revision"]})
        found = self.request("/api/library-search?q=" + quote("唯一正文针"))
        self.assertEqual({item["bookId"] for item in found["results"]}, {first["book"]["id"]})

    def test_external_backup_destination_preserves_other_files(self):
        book = self.manuscript("外部备份验收")
        destination = self.data / "external-disk"
        destination.mkdir()
        unrelated = destination / "自己的文件.txt"
        unrelated.write_text("不能覆盖", encoding="utf-8")
        configured = self.request("/api/external-backups/settings", "PUT", {"enabled": True, "destination": str(destination)})
        self.assertTrue(configured["settings"]["enabled"])
        self.assertEqual(configured["settings"]["destination"], str(destination))
        count = self.request("/api/external-backups/run", "POST", {})["count"]
        self.assertGreaterEqual(count, 1)
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "不能覆盖")
        snapshots = list(destination.glob("WriterDesk-Backups-*/backups/**/*.json"))
        if not snapshots:
            snapshots = list(destination.glob("WriterDesk-Backups-*/**/*.json"))
        self.assertTrue(any(json.loads(file.read_text(encoding="utf-8")).get("book", {}).get("id") == book["book"]["id"] for file in snapshots))
        self.request("/api/external-backups/settings", "PUT", {"enabled": True, "destination": "relative"}, status=400)
        self.request("/api/external-backups/run", "POST", {}, status=403, token=False)
        self.request("/api/external-backups/settings", "PUT", {"enabled": False, "destination": str(destination)})

    def test_real_sqlite_sync_two_clients_conflicts_and_permanent_deletion(self):
        peer = ExtensionsAPI("runTest")
        peer.setUp()
        self.addCleanup(peer.doCleanups)
        record = self.manuscript("SQLite 同步回归")
        identity = record["book"]["id"]
        secret = "同步永久清理原稿" + uuid.uuid4().hex
        record["book"]["chapters"][0]["body"] = secret
        self.save(record)
        status = self.request("/api/sync/host-start", "POST", {"host": "127.0.0.1", "port": 0})
        self.assertEqual(status["role"], "owner")
        self.assertNotIn("token", status)
        self.request("/api/sync/preferences", "POST", {"autoSync": False})
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        invite = self.request("/api/sync/invite", "POST", {"role": "editor"})
        joined = peer.request("/api/sync/connect", "POST", {"url": status["url"], "invite": invite["invite"], "name": "第二台电脑", "autoSync": False})
        self.assertEqual(joined["role"], "editor")
        peer.request("/api/sync/sync", "POST", {"bookId": identity})
        downloaded = peer.get(identity)
        self.assertEqual(downloaded["book"]["chapters"][0]["body"], secret)
        self.assertEqual(peer.request("/api/books/" + identity + "/writing-stats")["todayChars"], 0)
        left, right = self.get(identity), peer.get(identity)
        left["book"]["chapters"][0]["title"] = "甲编辑第一章"
        right["book"]["chapters"][1]["body"] = "乙在另一章离线编辑。"
        self.save(left);peer.save(right)
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        merged = peer.request("/api/sync/sync", "POST", {"bookId": identity})
        self.assertFalse(any(book["status"] == "conflict" for book in merged["books"]))
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        for client in (self, peer):
            book = client.get(identity)["book"]
            self.assertEqual(book["chapters"][0]["title"], "甲编辑第一章")
            self.assertEqual(book["chapters"][1]["body"], "乙在另一章离线编辑。")
        left, right = self.get(identity), peer.get(identity)
        left["book"]["chapters"][0]["body"] = secret + "甲的修改"
        right["book"]["chapters"][0]["body"] = secret + "乙的修改"
        self.save(left);peer.save(right)
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        conflict = peer.request("/api/sync/sync", "POST", {"bookId": identity})["books"][0]["conflict"]
        detail = peer.request("/api/sync/conflicts/" + conflict["id"])
        result = peer.request("/api/sync/resolve", "POST", {"id": conflict["id"], "choice": "copy", "expectedRevision": detail["currentRevision"]})
        self.assertNotEqual(result["book"]["id"], identity)
        self.assertEqual(peer.get(identity)["book"]["chapters"][0]["body"], secret + "甲的修改")
        self.assertEqual(peer.get(result["book"]["id"])["book"]["chapters"][0]["body"], secret + "乙的修改")
        # Remove the deliberate conflict copy as well, so byte-level cleanup
        # below can verify that the original manuscript is not cached anywhere.
        for client, book_id in ((peer, result["book"]["id"]), (self, identity)):
            current = client.get(book_id)
            trashed = client.request("/api/books/" + book_id + "/trash", "POST", {"revision": current["revision"]})
            client.request("/api/books/" + book_id + "/purge", "POST", {"revision": trashed["revision"]})
            client.request("/api/sync/sync", "POST", {"bookId": book_id})
        peer.request("/api/sync/sync", "POST", {"bookId": identity})
        self.get_missing(peer, identity)
        with sqlite3.connect(peer.data / "writer.sqlite3") as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM books WHERE id=?", (identity,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history WHERE book_id=?", (identity,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM sync_tombstones WHERE book_id=?", (identity,)).fetchone()[0], 1)
        for directory in (self.data / "sync", peer.data / "sync"):
            for file in directory.rglob("*.sqlite3*"):
                self.assertNotIn(secret.encode(), file.read_bytes(), str(file))
        self.request("/api/sync/host-stop", "POST", {})

    def get_missing(self, client, identity):
        client.request("/api/books/" + identity, status=404)

    def test_chapter_purge_propagates_preserves_offline_edits_and_offline_hub_cleanup(self):
        peer = ExtensionsAPI("runTest")
        peer.setUp()
        self.addCleanup(peer.doCleanups)
        record = self.manuscript("章节清理同步回归")
        identity = record["book"]["id"]
        removed = record["book"]["chapters"][0]["id"]
        secret = "彻底删除章节同步原稿" + uuid.uuid4().hex
        record["book"]["chapters"][0]["body"] = secret
        self.save(record)
        stale = copy.deepcopy(record)
        status = self.request("/api/sync/host-start", "POST", {"host": "127.0.0.1", "port": 0})
        port = status["hub"]["port"]
        self.request("/api/sync/preferences", "POST", {"autoSync": False})
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        invite = self.request("/api/sync/invite", "POST", {"role": "editor"})
        peer.request("/api/sync/connect", "POST", {"url": status["url"], "invite": invite["invite"], "name": "离线作者", "autoSync": False})
        peer.request("/api/sync/sync", "POST", {"bookId": identity})
        offline = peer.get(identity)
        offline["book"]["chapters"][1]["body"] = "其他章节的离线新增🌊。"
        peer.save(offline)
        current = self.get(identity)
        current["book"]["chapters"][0]["deletedAt"] = "2026-10-15T00:00:00+00:00"
        self.save(current)
        purged = self.request("/api/books/" + identity + "/chapters/" + removed + "/purge", "POST", {"revision": current["revision"]})
        self.assertFalse(purged.get("cleanupPending", False), purged)
        for file in (self.data / "sync").rglob("*.sqlite3*"):
            self.assertNotIn(secret.encode(), file.read_bytes(), str(file))
        peer.request("/api/sync/sync", "POST", {"bookId": identity})
        other = peer.get(identity)
        self.assertNotIn(removed, [item["id"] for item in other["book"]["chapters"]])
        self.assertEqual(other["book"]["chapters"][0]["body"], "其他章节的离线新增🌊。")
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        self.assertEqual(self.get(identity)["book"]["chapters"][0]["body"], "其他章节的离线新增🌊。")
        latest = peer.get(identity)
        peer.request("/api/books/" + identity, "PUT", {"book": stale["book"], "revision": latest["revision"]}, status=409)
        # Close the service before another permanent deletion. The desktop
        # still owns the local Hub database and must clean it immediately.
        self.request("/api/sync/host-stop", "POST", {})
        remaining = other["book"]["chapters"][0]["id"]
        other = peer.get(identity)
        other["book"]["chapters"][0]["deletedAt"] = "2026-10-15T00:00:00+00:00"
        peer.save(other)
        offline_purge = peer.request("/api/books/" + identity + "/chapters/" + remaining + "/purge", "POST", {"revision": other["revision"]})
        self.assertTrue(offline_purge.get("cleanupPending"), offline_purge)
        for file in (peer.data / "sync").rglob("*.sqlite3*"):
            self.assertNotIn("其他章节的离线新增🌊。".encode(), file.read_bytes(), str(file))
        self.request("/api/sync/host-start", "POST", {"host": "127.0.0.1", "port": port})
        self.request("/api/sync/preferences", "POST", {"autoSync": False})
        peer.request("/api/sync/sync", "POST", {"bookId": identity})
        self.request("/api/sync/sync", "POST", {"bookId": identity})
        self.assertEqual(self.get(identity)["book"]["chapters"], [])
        cleaned = peer.request("/api/history/chapters/cleanup", "POST", {})
        self.assertNotIn(identity, cleaned["cleanupPendingBooks"])
        # Entire-book deletion must also clean a stopped local Hub, without
        # depending on a later user click on Sync.
        self.request("/api/sync/host-stop", "POST", {})
        latest = self.get(identity)
        trashed = self.request("/api/books/" + identity + "/trash", "POST", {"revision": latest["revision"]})
        final = self.request("/api/books/" + identity + "/purge", "POST", {"revision": trashed["revision"]})
        self.assertTrue(final.get("cleanupPending", False), final)
        with sqlite3.connect(self.data / "sync/hub/collaboration.sqlite3") as conn:
            payload = json.loads(conn.execute("SELECT payload FROM books WHERE id=?", (identity,)).fetchone()[0])
            self.assertTrue(payload["permanentlyDeleted"])
        self.request("/api/sync/host-start", "POST", {"host": "127.0.0.1", "port": port})
        self.request("/api/sync/preferences", "POST", {"autoSync": False})
        self.request("/api/sync/sync", "POST", {"bookId": identity})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", type=Path)
    args, rest = parser.parse_known_args()
    workflow.SERVICE = args.service.resolve() if args.service else None
    unittest.main(argv=[sys.argv[0], *rest])
