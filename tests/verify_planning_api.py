"""HTTP planning journeys against disposable services and the full demo novel."""
import copy
from contextlib import closing
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
CANONICAL = ROOT / "examples/tide-archive.yejian.json"
CANONICAL_HASH = hashlib.sha256(CANONICAL.read_bytes()).hexdigest()


class PlanningAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-planning-http-")
        self.data = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", "0", "--data-dir", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "WRITER_DESKTOP_TOKEN": "isolated-planning-test"})
        self.addCleanup(self.stop)
        startup = self.process.stdout.readline().strip()
        if "：http://127.0.0.1:" not in startup:
            self.fail("Isolated service did not start: " + startup + self.process.stderr.read())
        self.url = startup.split("：", 1)[1]

    def stop(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
        self.process.communicate(timeout=10)
        self.process = None

    def tearDown(self):
        self.assertEqual(hashlib.sha256(CANONICAL.read_bytes()).hexdigest(), CANONICAL_HASH)

    def request(self, path, method="GET", data=None, status=200, token=True):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
        headers = {"Content-Type": "application/json", "X-Writer-Client": "1"}
        if token:
            headers["X-Writer-Desktop"] = "isolated-planning-test"
        request = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                code, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            code, result = error.code, json.loads(error.read())
        self.assertEqual(code, status, (path, result))
        return result

    def get(self, book_id):
        return self.request("/api/books/" + book_id)

    def save(self, result, status=200):
        response = self.request("/api/books/" + result["book"]["id"], "PUT", {"book": result["book"], "revision": result["revision"]}, status)
        if status == 200:
            result["revision"] = response["revision"]
        return response

    def stats(self, book_id):
        return self.request("/api/books/" + book_id + "/writing-stats")

    def demo(self):
        shelf = self.request("/api/books")["books"]
        return self.get(next(item["id"] for item in shelf if item["title"] == "潮汐档案馆"))

    def plans(self, book):
        person = next(item for item in book["notes"] if item["type"] == "人物")
        return {"dailyGoal": 3000, "foreshadows": [
            {"id": "hint-http", "title": "船票上的声音", "body": "在后续查证来源。", "status": "developing", "chapterIds": [book["chapters"][0]["id"]], "personIds": [person["id"]]}],
            "timeline": [{"id": "event-http", "title": "返潮之前", "storyTime": "返潮前第六日·清晨", "body": "收到船票。", "chapterIds": [book["chapters"][0]["id"]], "personIds": [person["id"]]}]}

    def test_full_novel_plan_save_body_growth_conflict_import_and_restore(self):
        result = self.demo(); book = result["book"]; book_id = book["id"]
        self.assertEqual(self.stats(book_id)["todayChars"], 0)
        self.assertEqual(self.stats(book_id)["totalChars"], 101506)
        book["storyTools"] = self.plans(book)
        self.save(result)
        self.assertEqual(self.get(book_id)["book"]["storyTools"], book["storyTools"])
        self.assertEqual(self.stats(book_id)["todayChars"], 0, "Planning changes are not writing production")
        plan_revision = result["revision"]
        book["chapters"][0]["body"] += "\n海潮又来了。"
        self.save(result)
        self.assertEqual(self.stats(book_id)["todayChars"], 6)
        stale = copy.deepcopy(result); stale["revision"] = plan_revision; stale["book"]["chapters"][0]["body"] += "不会保存。"
        self.save(stale, status=409)
        self.assertEqual(self.stats(book_id)["todayChars"], 6, "Conflict cannot record activity")
        restored = self.request("/api/books/" + book_id + "/history/" + str(plan_revision) + "/restore", "POST", {"revision": result["revision"]})
        self.assertEqual(self.stats(book_id)["todayChars"], 6, "Version restore cannot record activity")
        self.assertEqual(self.stats(book_id)["totalChars"], 101506)
        imported = self.request("/api/import", "POST", {"format": "yejian-backup", "version": 3, "book": restored["book"]}, status=201)
        self.assertNotEqual(imported["book"]["id"], book_id)
        self.assertEqual(imported["book"]["storyTools"], book["storyTools"])
        self.assertEqual(self.stats(imported["book"]["id"])["todayChars"], 0)
        self.assertEqual(self.stats(imported["book"]["id"])["totalChars"], 101506)
        # The diff UI applies selected old paragraphs through a normal PUT,
        # explicitly marked as a restore so those characters are not production.
        partial = self.get(book_id)
        partial["book"]["chapters"][0]["body"] += "恢复的旧段落。"
        self.request("/api/books/" + book_id, "PUT", {"book": partial["book"], "revision": partial["revision"], "saveReason": "restore"})
        self.assertEqual(self.stats(book_id)["todayChars"], 6)
        invalid = self.get(book_id)
        self.request("/api/books/" + book_id, "PUT", {"book": invalid["book"], "revision": invalid["revision"], "saveReason": "anything"}, status=400)
        self.assertEqual(self.stats(book_id)["todayChars"], 6)
        self.request("/api/books/" + book_id + "/writing-stats", status=403, token=False)

    def test_recycled_chapter_preserves_links_through_restore_then_purge_sanitizes_history(self):
        result = self.demo(); book = result["book"]; book_id = book["id"]
        book["storyTools"] = self.plans(book); self.save(result)
        target = book["chapters"][0]; chapter_id = target["id"]
        target["deletedAt"] = "2026-10-15T01:02:03+00:00"; self.save(result)
        current = self.get(book_id)
        for key in ("foreshadows", "timeline"):
            self.assertEqual(current["book"]["storyTools"][key][0]["chapterIds"], [chapter_id])
        target["deletedAt"] = None; self.save(result)
        restored = self.get(book_id)
        for key in ("foreshadows", "timeline"):
            self.assertEqual(restored["book"]["storyTools"][key][0]["chapterIds"], [chapter_id])
        self.assertEqual(restored["book"]["chapters"][0]["body"], target["body"])
        target["deletedAt"] = "2026-10-15T01:02:03+00:00"; self.save(result)
        purged = self.request("/api/books/" + book_id + "/chapters/" + chapter_id + "/purge", "POST", {"revision": result["revision"]})
        self.assertNotIn(chapter_id, [item["id"] for item in purged["book"]["chapters"]])
        histories = self.request("/api/books/" + book_id + "/history")["versions"]
        for item in histories:
            history = self.request("/api/books/" + book_id + "/history/" + str(item["revision"]))["book"]
            for key in ("foreshadows", "timeline"):
                for record in history["storyTools"][key]:
                    self.assertNotIn(chapter_id, record["chapterIds"])
        self.assertEqual(self.stats(book_id)["todayChars"], 0)

    def test_short_story_plans_goal_and_book_purge_do_not_touch_other_statistics(self):
        result = self.request("/api/books", "POST", {"title": "隔离短篇", "kind": "short"}, status=201)
        result = self.get(result["book"]["id"]); book = result["book"]; book_id = book["id"]
        book["storyTools"]["dailyGoal"] = 800
        book["storyTools"]["timeline"] = [{"id": "short-event", "title": "雨停", "storyTime": "晚饭之后", "body": "收起雨伞。", "chapterIds": [book["chapters"][0]["id"]], "personIds": []}]
        book["chapters"][0]["body"] = "窗外雨停了。"
        self.save(result)
        stats = self.stats(book_id)
        self.assertEqual(stats["todayChars"], 6); self.assertEqual(stats["dailyGoal"], 800)
        other = self.demo(); self.assertEqual(self.stats(other["book"]["id"])["todayChars"], 0)
        trash = self.request("/api/books/" + book_id + "/trash", "POST", {"revision": result["revision"]})
        self.request("/api/books/" + book_id + "/writing-stats", status=409)
        self.request("/api/books/" + book_id + "/purge", "POST", {"revision": trash["revision"]})
        with closing(sqlite3.connect(self.data / "writer.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM writing_activity WHERE book_id=?", (book_id,)).fetchone()[0], 0)
        self.request("/api/books/" + book_id + "/writing-stats", status=404)
        self.assertEqual(self.stats(other["book"]["id"])["totalChars"], 101506)


if __name__ == "__main__":
    unittest.main()
