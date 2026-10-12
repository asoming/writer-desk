"""Single-body short stories, with disposable legacy libraries and backups."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def legacy_short():
    book = server.new_book("雨中的两个人", "short")
    book["chapters"] = [
        {"id": "old-recycled", "title": "回收的开场", "body": "暂不使用的正文", "volumeId": None, "deletedAt": "2026-10-10"},
        {"id": "old-first", "title": "曾经的第一节", "body": "  许宁开门。🌧\n", "volumeId": None, "deletedAt": None},
        {"id": "old-second", "title": "曾经的第二节", "body": "\n来客归还雨伞。  ", "volumeId": None, "deletedAt": None},
        {"id": "old-empty", "title": "待写的结尾", "body": "", "volumeId": None, "deletedAt": None},
    ]
    book["notes"] = [
        {"id": "person-one", "title": "许宁", "type": "人物", "body": "店主", "aliases": [], "profile": server.empty_profile(),
         "chapterIds": ["old-second", "old-recycled", "old-first"], "deletedAt": None},
        {"id": "person-two", "title": "来客", "type": "人物", "body": "借伞的人", "aliases": [], "profile": server.empty_profile(),
         "chapterIds": ["old-second"], "deletedAt": None},
    ]
    book["outline"] = [{"id": "outline", "title": "还伞", "body": "从相遇到重逢。", "parentId": None, "volumeId": None,
                         "kind": "scene", "chapterIds": ["old-second", "old-empty"], "deletedAt": None}]
    book["relations"] = [{"id": "relation", "fromId": "person-one", "toId": "person-two", "label": "借伞", "body": "善意。",
                           "type": "friend", "stage": "重逢", "volumeIds": [], "chapterIds": ["old-second"], "deletedAt": None}]
    return book


def manuscript(book):
    return next(item for item in book["chapters"] if not item["deletedAt"])


class ShortManuscriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-short-body-")
        self.previous_db = server.DB_PATH
        server.DB_PATH = Path(self.temporary.name) / "writer.sqlite3"
        server.initialize()

    def tearDown(self):
        server.DB_PATH = self.previous_db
        self.temporary.cleanup()

    def insert_legacy(self):
        book = legacy_short()
        with server.connect() as conn:
            server.insert_book(conn, book)
        return book

    def row(self, book_id):
        with server.connect() as conn:
            return server.saved_book_row(conn, book_id)

    def save(self, book, revision):
        responses = []
        handler = object.__new__(server.Handler)
        handler.path = "/api/books/" + book["id"]
        handler.read_json = lambda: {"book": book, "revision": revision}
        handler.send_json = lambda value, status=200: responses.append((status, value))
        handler.do_PUT()
        return responses[0]

    def test_new_story_has_one_empty_body_without_volumes_or_size_minimum(self):
        book = server.new_book("未动笔的短篇", "short")
        self.assertEqual(book["volumes"], [])
        self.assertEqual(len(book["chapters"]), 1)
        self.assertEqual((manuscript(book)["title"], manuscript(book)["body"]), ("正文", ""))
        self.assertEqual(server.validate_book(book), book)
        manuscript(book)["body"] = "一行也可以先保存。"
        self.assertEqual(server.validate_book(book), book)
        manuscript(book)["body"] = "字" * 50000
        self.assertEqual(len(manuscript(server.validate_book(book))["body"]), 50000)

    def test_merge_preserves_verbatim_order_source_titles_and_recycled_text(self):
        original = legacy_short()
        upgraded = server.validate_book(original)
        active = [item for item in upgraded["chapters"] if not item["deletedAt"]]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["id"], "old-first")
        self.assertEqual(active[0]["body"], "  许宁开门。🌧\n\n\n\n来客归还雨伞。  \n\n")
        self.assertEqual(upgraded["chapters"][0], original["chapters"][0])
        self.assertEqual([item["id"] for item in upgraded["shortSections"]], ["old-first", "old-second", "old-empty"])
        first, second, last = upgraded["shortSections"]
        self.assertEqual(first, {"id": "old-first", "title": "曾经的第一节", "start": 0, "end": 10})
        self.assertEqual(second["start"], first["end"] + 2)
        self.assertEqual(last["start"], second["end"] + 2)
        self.assertEqual(last["start"], last["end"])
        self.assertEqual(upgraded["notes"][0]["chapterIds"], ["old-first", "old-recycled"])
        self.assertEqual(upgraded["outline"][0]["chapterIds"], ["old-first"])
        self.assertEqual(upgraded["relations"][0]["chapterIds"], ["old-first"])
        self.assertEqual(server.validate_book(upgraded), upgraded, "Normalization must be idempotent")
        self.assertEqual(len(original["chapters"]), 4, "Validation must not mutate incoming backups")

    def test_read_and_shelf_normalize_without_writing_payload_or_revision(self):
        original = self.insert_legacy()
        before = self.row(original["id"])
        loaded = server.book_result(before)
        summary = server.book_summary(before)
        self.assertEqual((loaded["revision"], summary["chapterCount"], summary["volumeCount"]), (1, 1, 0))
        self.assertEqual(summary["latestChapterTitle"], "曾经的第一节")
        self.assertEqual(self.row(original["id"])["payload"], before["payload"])
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM history WHERE book_id=?", (original["id"],)).fetchone()[0], 0)
        self.assertEqual(server.book_result(self.row(original["id"])), loaded)

    def test_save_preserves_original_history_and_compatible_backups(self):
        original = self.insert_legacy()
        raw_payload = self.row(original["id"])["payload"]
        book = server.book_result(self.row(original["id"]))["book"]
        manuscript(book)["body"] += "\n\n新的结尾。"
        status, result = self.save(book, 1)
        self.assertEqual((status, result["revision"]), (200, 2))
        self.assertEqual(server.book_result(self.row(original["id"]))["book"], book)
        with server.connect() as conn:
            history = conn.execute("SELECT payload FROM history WHERE book_id=?", (original["id"],)).fetchone()[0]
        self.assertEqual(history, raw_payload)
        preview = server.read_protection("/api/books/" + book["id"] + "/history/1")
        self.assertEqual(manuscript(preview["book"])["body"], manuscript(server.validate_book(original))["body"])
        self.assertEqual(preview["book"]["chapters"][0], original["chapters"][0])
        snapshot = server.checkpoint_book(book["id"], force=True)
        backup = server.read_protection("/api/books/" + book["id"] + "/backups/" + snapshot["token"])["book"]
        self.assertEqual(backup, book)
        restored = server.restore_book(backup)
        restored["id"] = book["id"]
        self.assertEqual(restored, book)

    def test_saved_aliases_still_validate_and_ai_requests_resolve_them(self):
        original = self.insert_legacy()
        normalized = server.book_result(self.row(original["id"]))["book"]
        normalized["outline"][0]["chapterIds"] = ["old-second"]
        self.assertEqual(server.validate_book(normalized)["outline"][0]["chapterIds"], ["old-first"])
        calls = []
        class FakeAI:
            def __init__(self, *_args):
                pass
            def preview(self, book, action, ids, *args, **kwargs):
                calls.append((book, action, ids, kwargs))
                return {"chapterIds": ids}
        history = [{"role": "user", "content": "我想改写先前第二节。"}]
        with patch.object(server, "AIService", FakeAI):
            result = server.handle_ai_request("/api/books/" + original["id"] + "/ai/preview",
                                              {"action": "draft", "chapterIds": ["old-second", "old-empty"], "chat": True, "history": history})
        self.assertEqual(result["chapterIds"], ["old-first"])
        self.assertEqual(calls[0][3]["history"], history)
        self.assertEqual(server.short_chapter_ids(normalized, ["old-recycled", "unknown"]), ["old-recycled", "unknown"])
        self.assertEqual(server.short_chapter_ids(normalized, [{"invalid": True}]), [{"invalid": True}])
        self.assertEqual(server.short_chapter_ids(normalized, ["old-second", "old-second"]), ["old-second", "old-second"])
        oversized = ["old-second"] * 501
        self.assertEqual(server.short_chapter_ids(normalized, oversized), oversized)

    def test_all_recycled_text_remains_recoverable_with_a_stable_new_empty_body(self):
        original = legacy_short()
        for item in original["chapters"]:
            item["deletedAt"] = "2026-10-10"
        upgraded = server.validate_book(original)
        self.assertEqual(upgraded["chapters"][:-1], original["chapters"])
        self.assertEqual(manuscript(upgraded)["body"], "")
        self.assertEqual(server.validate_book(original), upgraded)
        self.assertEqual(server.validate_book(upgraded), upgraded)
        # Restoring legacy recycled text appends it to the same manuscript,
        # retaining every byte and leaving the remaining recycled text intact.
        upgraded["chapters"][1]["deletedAt"] = None
        recovered = server.validate_book(upgraded)
        self.assertEqual(manuscript(recovered)["body"], original["chapters"][1]["body"] + "\n\n")
        self.assertEqual(sum(not item["deletedAt"] for item in recovered["chapters"]), 1)
        self.assertEqual(sum(bool(item["deletedAt"]) for item in recovered["chapters"]), 3)

    def test_short_export_contains_only_title_and_continuous_body(self):
        original = self.insert_legacy()
        folder = Path(server.sync_book_folder(original["id"], create=True)["folder"])
        normalized = server.book_result(self.row(original["id"]))["book"]
        self.assertEqual((folder / "正文.txt").read_text("utf-8-sig"),
                         original["title"] + "\n\n" + manuscript(normalized)["body"] + "\n")
        self.assertEqual(json.loads((folder / "作品.yejian.json").read_text("utf-8"))["book"], normalized)
        self.assertNotIn("暂不使用的正文", (folder / "正文.txt").read_text("utf-8-sig"))

    def test_restoring_an_earlier_recycled_body_offsets_existing_source_locations(self):
        original = legacy_short()
        normalized = server.validate_book(original)
        before = copy.deepcopy(normalized["shortSections"])
        old_body = manuscript(normalized)["body"]
        recovered = normalized["chapters"][0]
        recovered["deletedAt"] = None
        result = server.validate_book(normalized)
        self.assertEqual(manuscript(result)["id"], "old-recycled")
        self.assertEqual(manuscript(result)["body"], recovered["body"] + "\n\n" + old_body)
        offset = server.utf16_length(recovered["body"]) + 2
        expected = [{"id": "old-recycled", "title": recovered["title"], "start": 0, "end": offset - 2}]
        expected.extend({**section, "start": section["start"] + offset, "end": section["end"] + offset} for section in before)
        self.assertEqual(result["shortSections"], expected)
        self.assertEqual(server.validate_book(result), result)

    def test_metadata_is_bounded_and_shorter_edits_clamp_navigation_offsets(self):
        book = server.validate_book(legacy_short())
        manuscript(book)["body"] = "改稿。"
        checked = server.validate_book(book)
        self.assertTrue(all(item["end"] <= 3 for item in checked["shortSections"]))
        for change in ({"start": True}, {"start": -1}, {"end": server.MAX_BOOK * 2 + 1}, {"title": None}):
            broken = copy.deepcopy(book)
            broken["shortSections"][0].update(change)
            with self.assertRaises(ValueError):
                server.validate_book(broken)
        broken = copy.deepcopy(book)
        broken["shortSections"].append(copy.deepcopy(broken["shortSections"][0]))
        with self.assertRaises(ValueError):
            server.validate_book(broken)

    def test_legacy_large_single_body_remains_savable_after_merging(self):
        book = server.new_book("旧短篇不丢内容", "short")
        book["chapters"] = [server.chapter("前半", "a" * 2_500_001), server.chapter("后半", "b" * 2_500_001)]
        merged = server.validate_book(book)
        self.assertEqual(len(manuscript(merged)["body"]), 5_000_004)
        self.assertEqual(server.validate_book(merged), merged)

    def test_long_books_keep_volume_chapter_structure_and_export_titles(self):
        original = server.sample_book()
        upgraded = server.validate_book(original)
        self.assertEqual(upgraded, original)
        self.assertEqual(len(upgraded["chapters"]), 3)
        self.assertNotIn("shortSections", upgraded)
        text = server.manuscript_text(upgraded)
        self.assertIn("第一卷\n\n第一章  潮声", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
