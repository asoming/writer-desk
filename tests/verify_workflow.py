"""Full writing journeys against disposable services, never the user's library.

Run with TMPDIR set to a scratch directory when retaining all test IO under work/.
The canonical 101,506-character novel is only read, never rewritten.
"""
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
sys.path.insert(0, str(ROOT))
import server

CANONICAL_PATHS = (ROOT / "examples/tide-archive.yejian.json", ROOT / "examples/潮汐档案馆.txt")
CANONICAL_HASHES = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in CANONICAL_PATHS}
CANONICAL = json.loads(CANONICAL_PATHS[0].read_text("utf-8"))["book"]


def restore_volume_ids(restored, original):
    """A restored copy gets independent book/volume IDs, retaining every link."""
    normalized = copy.deepcopy(restored)
    normalized["id"] = original["id"]
    volume_ids = {new["id"]: old["id"] for old, new in zip(original["volumes"], normalized["volumes"])}
    for volume in normalized["volumes"]:
        volume["id"] = volume_ids[volume["id"]]
    for item in normalized["chapters"] + normalized["outline"]:
        if item["volumeId"] is not None:
            item["volumeId"] = volume_ids[item["volumeId"]]
    for person in normalized["notes"]:
        if person["type"] == "人物":
            for arc in person["profile"]["arcs"]:
                arc["volumeId"] = volume_ids[arc["volumeId"]]
    for relation in normalized["relations"]:
        relation["volumeIds"] = [volume_ids[item_id] for item_id in relation["volumeIds"]]
    return normalized


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-full-workflow-")
        self.data = Path(self.temporary.name) / "data"
        self.process = None
        self.start()
        self.initial = {book["id"]: self.get_book(book["id"]) for book in self.shelf().values()}

    def tearDown(self):
        self.stop()
        self.temporary.cleanup()
        for path, digest in CANONICAL_HASHES.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "--port", "0", "--data-dir", str(self.data)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        startup = self.process.stdout.readline().strip()
        if "：http://127.0.0.1:" not in startup:
            details = self.process.stderr.read() if self.process.poll() is not None else startup
            self.fail("Disposable workflow service did not start: " + details)
        self.url = startup.split("：", 1)[1]

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
            self.process.communicate(timeout=10)
            self.process = None

    def request(self, path, method="GET", data=None, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
        request = urllib.request.Request(self.url + path, data=body, method=method,
                                         headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                code, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            code, result = error.code, json.loads(error.read())
        self.assertEqual(code, status, (path, result))
        return result

    def get_book(self, book_id):
        return self.request("/api/books/" + book_id)

    def shelf(self):
        return {book["id"]: book for book in self.request("/api/books")["books"]}

    def save(self, book, revision, status=200):
        result = self.request("/api/books/" + book["id"], "PUT", {"book": book, "revision": revision}, status)
        if status == 200:
            self.assertEqual(result["revision"], revision + 1)
            self.assertEqual(self.get_book(book["id"])["book"], book)
        return result

    def assert_other_books_unchanged(self, changed_id):
        for book_id, original in self.initial.items():
            if book_id != changed_id:
                self.assertEqual(self.get_book(book_id), original)

    def test_full_novel_edit_recycle_restore_restart_conflict_and_backup(self):
        demo = next(item for item in self.shelf().values() if item["title"] == "潮汐档案馆")
        self.assertEqual((demo["charCount"], demo["volumeCount"], demo["chapterCount"], demo["personCount"]),
                         (101506, 6, 36, 32))
        loaded = self.get_book(demo["id"])
        book, revision = loaded["book"], loaded["revision"]
        self.assertEqual([chapter["body"] for chapter in book["chapters"]],
                         [chapter["body"] for chapter in CANONICAL["chapters"]])
        untouched_bodies = {chapter["id"]: chapter["body"] for chapter in book["chapters"]}
        folder_result = self.request("/api/books/" + book["id"] + "/folder", "POST", {})
        folder = Path(folder_result["folder"])
        self.assertTrue(folder.is_relative_to(self.data))
        self.assertEqual(folder_result["revision"], revision)
        expected_initial = "\ufeff" + "\n\n".join(
            [book["title"]] + [part for volume in book["volumes"] for part in
                              [volume["title"], *[(chapter["title"] + "\n\n" + chapter["body"])
                                                  for chapter in book["chapters"] if chapter["volumeId"] == volume["id"]]]]) + "\n"
        self.assertEqual((folder / "正文.txt").read_text("utf-8"), expected_initial)

        # Existing chapter/outline/person/relationship links survive a real edit,
        # while a planned extra volume does not create any unwanted prose.
        changed_chapter = book["chapters"][0]
        changed_chapter["body"] += "\n\n验收补记：季临与陆澄把最后一封信重新装好。"
        changed_chapter["title"] += "（修订）"
        book["volumes"].append({"id": "workflow-volume", "title": "第七卷 待写", "summary": "先保留卷纲，再写正文。", "deletedAt": None})
        book["outline"].append({"id": "workflow-outline", "title": "新的投递路线", "kind": "volume", "category": "分卷剧情",
                                "body": "从修订后的第一章回看季临与陆澄的约定。", "parentId": None,
                                "volumeId": "workflow-volume", "chapterIds": [changed_chapter["id"]], "deletedAt": None})
        book["notes"][0]["chapterIds"] = list(dict.fromkeys([*book["notes"][0]["chapterIds"], changed_chapter["id"]]))
        book["relations"][0]["chapterIds"] = list(dict.fromkeys([*book["relations"][0]["chapterIds"], changed_chapter["id"]]))
        revision = self.save(book, revision)["revision"]
        for chapter in book["chapters"][1:]:
            self.assertEqual(chapter["body"], untouched_bodies[chapter["id"]])
        self.assertEqual(json.loads((folder / "作品.yejian.json").read_text("utf-8"))["book"], book)
        self.assertEqual(len(self.get_book(book["id"])["book"]["chapters"]), 36)

        # Moving the first authored volume to the end must move its sixth chapter
        # to the end of the reading order, including the shelf's last prose title.
        book["volumes"].reverse()
        revision = self.save(book, revision)["revision"]
        self.assertEqual(self.shelf()[book["id"]]["latestChapterTitle"], book["chapters"][5]["title"])
        text_after_reorder = (folder / "正文.txt").read_text("utf-8-sig")
        self.assertLess(text_after_reorder.index(book["chapters"][35]["body"]),
                        text_after_reorder.index(book["chapters"][5]["body"]))

        # Recycling a volume retains its six chapters, character arcs and outline
        # links in the backup, but the shelf and reading export exclude it.
        recycled_volume = book["volumes"][1]
        recycled_chapters = [chapter for chapter in book["chapters"] if chapter["volumeId"] == recycled_volume["id"]]
        recycle_stamp = "2026-10-10T00:00:00Z"
        recycled_volume["deletedAt"] = recycle_stamp
        for chapter in recycled_chapters:
            chapter["deletedAt"] = recycle_stamp
        revision = self.save(book, revision)["revision"]
        self.assertEqual((self.shelf()[book["id"]]["volumeCount"], self.shelf()[book["id"]]["chapterCount"]), (6, 30))
        exported_text = (folder / "正文.txt").read_text("utf-8-sig")
        for chapter in recycled_chapters:
            self.assertNotIn(chapter["body"], exported_text)
        backup = json.loads((folder / "作品.yejian.json").read_text("utf-8"))
        self.assertEqual(backup["book"], book)
        restored = self.request("/api/import", "POST", backup, 201)["book"]
        self.assertEqual(restore_volume_ids(restored, book), book)
        self.assertNotEqual(restored["id"], book["id"])
        self.assertTrue({item["id"] for item in restored["volumes"]}.isdisjoint(item["id"] for item in book["volumes"]))

        # A recycled chapter cannot be restored into a recycled volume. Reject
        # atomically, then restore the whole volume and its original chapters.
        invalid_restore = copy.deepcopy(book)
        next(chapter for chapter in invalid_restore["chapters"] if chapter["id"] == recycled_chapters[0]["id"])["deletedAt"] = None
        self.save(invalid_restore, revision, 400)
        self.assertEqual(self.get_book(book["id"])["book"], book)
        recycled_volume["deletedAt"] = None
        for chapter in recycled_chapters:
            chapter["deletedAt"] = None
        revision = self.save(book, revision)["revision"]
        self.assertEqual(self.shelf()[book["id"]]["chapterCount"], 36)
        for chapter in recycled_chapters:
            self.assertIn(chapter["body"], (folder / "正文.txt").read_text("utf-8-sig"))

        # A stale window must keep a recoverable copy instead of overwriting the
        # newer revision. Import is the same full-backup recovery path as UI.
        stale = copy.deepcopy(book)
        book["chapters"][0]["body"] += "\n\n较新的窗口内容。"
        revision = self.save(book, revision)["revision"]
        stale["chapters"][0]["body"] += "\n\n旧窗口仍需保留的内容。"
        conflict = self.save(stale, revision - 1, 409)
        self.assertTrue(conflict["conflict"])
        self.assertEqual(self.get_book(book["id"])["book"], book)
        recovered = self.request("/api/import", "POST", {"format": "yejian-backup", "version": 3, "book": stale}, 201)["book"]
        self.assertEqual(restore_volume_ids(recovered, stale), stale)

        # External edits in the opened folder do not get silently overwritten,
        # and a synchronization warning must not turn a committed save into loss.
        external_text = "文件夹里的独立修改，请保留。"
        (folder / "正文.txt").write_text(external_text, "utf-8")
        previous_backup = (folder / "作品.yejian.json").read_bytes()
        book["chapters"][0]["body"] += "\n\n文件夹冲突期间仍能保存的正文。"
        saved = self.save(book, revision)
        revision = saved["revision"]
        self.assertEqual(saved["folderWarning"], server.FOLDER_WARNING)
        self.assertEqual((folder / "正文.txt").read_text("utf-8"), external_text)
        self.assertEqual((folder / "作品.yejian.json").read_bytes(), previous_backup)
        moved = folder / "我的独立修改.txt"
        (folder / "正文.txt").rename(moved)
        self.request("/api/books/" + book["id"] + "/folder", "POST", {})
        self.assertEqual(json.loads((folder / "作品.yejian.json").read_text("utf-8"))["book"], book)
        self.assertEqual(moved.read_text("utf-8"), external_text)

        before_restart = self.get_book(book["id"])
        self.stop()
        self.start()
        self.assertEqual(self.get_book(book["id"]), before_restart)
        self.assertEqual(len(self.shelf()), len(self.initial) + 2)
        self.assert_other_books_unchanged(book["id"])
        with closing(sqlite3.connect(self.data / "writer.sqlite3")) as connection, connection:
            history = connection.execute("SELECT revision,payload FROM history WHERE book_id=? ORDER BY revision", (book["id"],)).fetchall()
            self.assertEqual([row[0] for row in history], list(range(1, revision)))
            self.assertEqual(json.loads(history[0][1]), self.initial[book["id"]]["book"])
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_outline_and_character_first_for_long_and_short_works(self):
        for kind in ("long", "short"):
            with self.subTest(kind=kind):
                created = self.request("/api/books", "POST", {"title": "从大纲开始 " + kind, "kind": kind}, 201)
                book, revision = created["book"], created["revision"]
                volume_id = book["volumes"][0]["id"] if book["volumes"] else None
                if kind == "short":
                    self.assertEqual(len(book["chapters"]), 1)
                    self.assertEqual(book["chapters"][0]["body"], "")
                else:
                    self.assertEqual(book["chapters"], [])
                book["outline"] = [{"id": "planned-story", "title": "先有大纲", "body": "两个人在雨停前做出选择。", "kind": "story",
                                    "category": "故事主线", "parentId": None, "volumeId": None, "chapterIds": [], "deletedAt": None}]
                book["notes"] = [{"id": item_id, "type": "人物", "title": title, "body": "在正文之前建立的人物。", "aliases": [],
                                  "profile": server.empty_profile(), "chapterIds": [], "deletedAt": None}
                                 for item_id, title in (("first-person", "许宁"), ("second-person", "来客"))]
                book["atlasViews"] = [{"id": "planned-view", "title": "书店人物", "description": "先设定关系，再写作。",
                                       "personIds": [person["id"] for person in book["notes"]]}]
                book["relations"] = [{"id": "planned-relation", "fromId": "first-person", "toId": "second-person", "label": "借伞",
                                      "body": "由陌生到相识。", "type": "friend", "stage": "初识", "volumeIds": [volume_id] if volume_id else [],
                                      "chapterIds": [], "deletedAt": None}]
                revision = self.save(book, revision)["revision"]
                self.assertEqual(self.shelf()[book["id"]]["chapterCount"], 1 if kind == "short" else 0)
                self.assertEqual(self.shelf()[book["id"]]["charCount"], 0)
                book["chapters"] = [{"id": "written-from-plan", "title": "正文", "body": "许宁把伞交给来客。\n\n雨停后，他又回来了。",
                                     "volumeId": volume_id, "deletedAt": None}]
                for item in [*book["outline"], *book["notes"], *book["relations"]]:
                    item["chapterIds"] = ["written-from-plan"]
                revision = self.save(book, revision)["revision"]
                folder = Path(self.request("/api/books/" + book["id"] + "/folder", "POST", {})["folder"])
                self.assertIn(book["chapters"][0]["body"], (folder / "正文.txt").read_text("utf-8-sig"))
                if kind == "short":
                    self.assertEqual((folder / "正文.txt").read_text("utf-8-sig"),
                                     book["title"] + "\n\n" + book["chapters"][0]["body"] + "\n")
                    backup = json.loads((folder / "作品.yejian.json").read_text("utf-8"))
                    self.assertEqual(restore_volume_ids(self.request("/api/import", "POST", backup, 201)["book"], book), book)
                    book["chapters"][0]["body"] += "\n\n整篇修订仍保留全部大纲和人物关联。"
                    self.save(book, revision)
                    self.assert_other_books_unchanged(book["id"])
                    continue
                book["chapters"][0]["deletedAt"] = "2026-10-10T00:00:00Z"
                revision = self.save(book, revision)["revision"]
                self.assertEqual((self.shelf()[book["id"]]["chapterCount"], self.shelf()[book["id"]]["charCount"],
                                  self.shelf()[book["id"]]["latestChapterTitle"]), (0, 0, ""))
                self.assertEqual((folder / "正文.txt").read_text("utf-8-sig"), book["title"] + "\n")
                backup = json.loads((folder / "作品.yejian.json").read_text("utf-8"))
                self.assertEqual(backup["book"], book)
                self.assertEqual(restore_volume_ids(self.request("/api/import", "POST", backup, 201)["book"], book), book)
                book["chapters"][0]["deletedAt"] = None
                self.save(book, revision)
                self.assertEqual(self.shelf()[book["id"]]["chapterCount"], 1)
                self.assert_other_books_unchanged(book["id"])

    def test_shelf_reading_order_handles_unassigned_recycled_and_short_chapters(self):
        created = self.request("/api/books", "POST", {"title": "章节顺序验收"}, 201)
        book, revision = created["book"], created["revision"]
        first_volume = book["volumes"][0]
        book["volumes"] = [{"id": "second-volume", "title": "先读的卷", "summary": "", "deletedAt": None}, first_volume,
                           {"id": "recycled-volume", "title": "已回收卷", "summary": "", "deletedAt": "2026-10-10"}]
        book["chapters"] = [
            {"id": "last-written-volume", "title": "后读卷正文", "body": "甲卷正文", "volumeId": first_volume["id"], "deletedAt": None},
            {"id": "first-read-volume", "title": "先读卷正文", "body": "乙卷正文", "volumeId": "second-volume", "deletedAt": None},
            {"id": "recycled-chapter", "title": "已回收正文", "body": "回收正文", "volumeId": "recycled-volume", "deletedAt": "2026-10-10"},
        ]
        revision = self.save(book, revision)["revision"]
        self.assertEqual(self.shelf()[book["id"]]["latestChapterTitle"], "后读卷正文")
        book["chapters"].insert(0, {"id": "unassigned", "title": "未分卷的结尾", "body": "未分卷正文", "volumeId": None, "deletedAt": None})
        revision = self.save(book, revision)["revision"]
        self.assertEqual(self.shelf()[book["id"]]["latestChapterTitle"], "未分卷的结尾")
        self.assertEqual(self.shelf()[book["id"]]["excerpt"], "乙卷正文")
        book["chapters"][0]["body"] = ""
        revision = self.save(book, revision)["revision"]
        self.assertEqual(self.shelf()[book["id"]]["latestChapterTitle"], "后读卷正文")
        for chapter in book["chapters"]:
            chapter["body"] = ""
        self.save(book, revision)
        self.assertEqual(self.shelf()[book["id"]]["latestChapterTitle"], "未分卷的结尾")

        short = self.request("/api/books", "POST", {"title": "短篇顺序验收", "kind": "short"}, 201)["book"]
        short["chapters"] = [
            {"id": "short-one", "title": "短篇开头", "body": "第一段", "volumeId": None, "deletedAt": None},
            {"id": "short-two", "title": "短篇结尾", "body": "第二段", "volumeId": None, "deletedAt": None},
            {"id": "short-blank", "title": "待写结尾", "body": "", "volumeId": None, "deletedAt": None},
            {"id": "short-recycled", "title": "回收正文", "body": "不可作为结尾", "volumeId": None, "deletedAt": "2026-10-10"},
        ]
        self.request("/api/books/" + short["id"], "PUT", {"book": short, "revision": 1})
        merged = self.get_book(short["id"])["book"]
        active = [item for item in merged["chapters"] if not item["deletedAt"]]
        self.assertEqual([(item["id"], item["title"], item["body"]) for item in active],
                         [("short-one", "短篇开头", "第一段\n\n第二段\n\n")])
        self.assertEqual(self.shelf()[short["id"]]["latestChapterTitle"], "短篇开头")
        self.assertEqual(self.shelf()[short["id"]]["excerpt"], "第一段\n\n第二段\n\n")
        self.assert_other_books_unchanged(book["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
