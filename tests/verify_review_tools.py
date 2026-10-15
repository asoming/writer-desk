"""Durable marks, import validation and permanent-delete privacy checks."""
import copy
import json
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import review_tools as tools

STAMP = "2026-10-15T00:00:00Z"


def chapter(identity, body, deleted=None):
    return {"id": identity, "body": body, "title": identity, "deletedAt": deleted}


def book(body="开头。\n目标段落。\n结尾。"):
    return {"id": "book", "kind": "long", "chapters": [chapter("one", body), chapter("old", "回收旧章内容", STAMP)],
            "reviewTools": tools.defaults()}


def mark(identity="mark", chapter_id="one", text="目标段落。", start=4, body="修改想法"):
    return {"id": identity, "chapterId": chapter_id, "start": start, "end": start + tools.utf16_length(text),
            "quote": text, "prefix": "", "suffix": "", "body": body, "label": "", "resolved": False,
            "status": "linked", "createdAt": STAMP, "updatedAt": STAMP}


class ReviewToolsTests(unittest.TestCase):
    def test_defaults_upgrade_preserves_other_authored_fields(self):
        source = book()
        source.pop("reviewTools")
        original = copy.deepcopy(source)
        tools.normalize(source)
        self.assertEqual(source.pop("reviewTools"), tools.defaults())
        self.assertEqual(source, original)

    def test_dictionary_trim_deduplicate_and_limit(self):
        source = book()
        source["reviewTools"]["dictionary"] = [" 林舟 ", "林舟", "潮汐档案馆"]
        tools.validate(source)
        self.assertEqual(source["reviewTools"]["dictionary"], ["林舟", "潮汐档案馆"])
        for bad in ([], None, True, 1, "", " ", "字" * 101):
            candidate = book(); candidate["reviewTools"]["dictionary"] = [bad]
            with self.subTest(bad=str(bad)[:20]), self.assertRaises(ValueError):
                tools.validate(candidate)
        source["reviewTools"]["dictionary"] = ["词" + str(index) for index in range(501)]
        with self.assertRaises(ValueError): tools.validate(source)

    def test_round_trip_and_whitelist_only_known_fields(self):
        source = book(); source["reviewTools"]["annotations"] = [mark()]
        source["reviewTools"]["dictionary"] = ["林舟"]
        source["reviewTools"]["unknown"] = "discard"
        source["reviewTools"]["annotations"][0]["filePath"] = "/arbitrary"
        result = tools.validate(source)
        saved = json.loads(json.dumps(result, ensure_ascii=False))
        self.assertEqual(tools.validate(saved), result)
        self.assertNotIn("filePath", result["reviewTools"]["annotations"][0])
        self.assertNotIn("unknown", result["reviewTools"])
        self.assertEqual(result["reviewTools"]["annotations"][0]["prefix"], "开头。\n")

    def test_stale_anchor_is_detached_without_blocking_save_or_matching_other_copy(self):
        source = book("开头。\n另一句。\n结尾。\n目标段落。")
        source["reviewTools"]["annotations"] = [mark()]
        tools.validate(source)
        item = source["reviewTools"]["annotations"][0]
        self.assertEqual(item["status"], "orphaned")
        self.assertEqual(item["start"], 4)
        self.assertEqual(item["quote"], "目标段落。")
        self.assertEqual(item["body"], "修改想法")
        self.assertEqual(item["prefix"], "")

    def test_illegal_ranges_types_dates_foreign_ids_and_duplicates_are_rejected(self):
        for field, bad in (("start", -1), ("end", True), ("start", "4"), ("end", 4), ("end", 50_000_001),
                           ("chapterId", "elsewhere"), ("quote", []), ("quote", " "), ("quote", "甲" * 20001),
                           ("prefix", "甲" * 65), ("body", "甲" * 10001), ("label", "甲" * 201),
                           ("resolved", 1), ("status", []), ("createdAt", "2026-10-15"), ("updatedAt", None)):
            source = book(); item = mark(); item[field] = bad; source["reviewTools"]["annotations"] = [item]
            with self.subTest(field=field, bad=str(bad)[:30]), self.assertRaises((ValueError, TypeError)):
                tools.validate(source)
        source = book(); source["reviewTools"]["annotations"] = [mark()]; source["reviewTools"]["bookmarks"] = [mark()]
        with self.assertRaises(ValueError): tools.validate(source)

    def test_capacity_and_version_are_bounded(self):
        for value in (2, True, "1", None):
            source = book(); source["reviewTools"]["version"] = value
            with self.subTest(value=value), self.assertRaises(ValueError): tools.validate(source)
        source = book(); source["reviewTools"]["annotations"] = [mark(str(index)) for index in range(5001)]
        with self.assertRaises(ValueError): tools.validate(source)

    def test_utf16_context_never_splits_emoji(self):
        source = book("😀" * 40 + "目标。" + "😺" * 40)
        source["reviewTools"]["annotations"] = [mark(text="目标。", start=80)]
        tools.validate(source)
        item = source["reviewTools"]["annotations"][0]
        self.assertEqual(item["prefix"], "😀" * 32)
        self.assertEqual(item["suffix"], "😺" * 32)
        source["reviewTools"]["annotations"][0].update(start=1, end=3, quote="😀")
        tools.validate(source)
        self.assertEqual(source["reviewTools"]["annotations"][0]["status"], "orphaned")

    def test_recycled_chapter_keeps_its_mark_for_recovery(self):
        source = book(); source["reviewTools"]["bookmarks"] = [mark("recycled", "old", "回收旧章", 0)]
        tools.validate(source); tools.normalize(source)
        self.assertEqual(source["reviewTools"]["bookmarks"][0]["chapterId"], "old")
        restored = copy.deepcopy(source); restored["chapters"][1]["deletedAt"] = None
        self.assertEqual(tools.validate(restored)["reviewTools"], source["reviewTools"])

    def test_permanent_purge_removes_quote_body_and_context_in_each_history_copy(self):
        source = book(); source["reviewTools"]["annotations"] = [mark(), mark("removed", "old", "回收旧章", 0, "旧章秘密批注")]
        tools.validate(source)
        original = copy.deepcopy(source)
        after = copy.deepcopy(source); after["chapters"] = after["chapters"][:1]
        clean = tools.sanitize(after, {"old"}, before=source)
        self.assertEqual(len(clean["reviewTools"]["annotations"]), 1)
        self.assertNotIn("旧章秘密", json.dumps(clean, ensure_ascii=False))
        self.assertNotIn("回收旧章", json.dumps(clean, ensure_ascii=False))
        self.assertEqual(source, original)
        self.assertEqual(tools.validate(json.loads(json.dumps(clean))), clean)

    def test_short_merge_offsets_apply_once_and_keep_recycled_marks(self):
        source = book("首篇😀\n\n次篇。")
        source["kind"] = "short"
        source["shortSections"] = [{"id": "one", "start": 0, "end": 4}, {"id": "two", "start": 6, "end": 9}]
        source["reviewTools"]["annotations"] = [mark(text="首篇😀", start=0), mark("second", "two", "次篇。", 0), mark("old", "old", "回收旧章", 0)]
        tools.remap_short_links(source, {"one", "two"}, "one", {"old"}, {"two": 6})
        second = source["reviewTools"]["annotations"][1]
        self.assertEqual((second["chapterId"], second["start"]), ("one", 6))
        tools.remap_short_links(source, {"one", "two"}, "one", {"old"}, {"two": 6})
        self.assertEqual(second["start"], 6)
        self.assertEqual(source["reviewTools"]["annotations"][2]["chapterId"], "old")
        tools.validate(source)

    def test_combined_short_purge_remaps_survivors_and_clears_neighbors_private_context(self):
        import chapter_history
        source = book("公开首段。\n\n秘密章节。\n\n公开末段😀。")
        source["kind"] = "short"
        spans = [{"id": "one", "title": "首", "start": 0, "end": 5}, {"id": "secret", "title": "私", "start": 7, "end": 12}, {"id": "last", "title": "末", "start": 14, "end": 21}]
        source["shortSections"] = spans
        source["reviewTools"]["annotations"] = [mark("first", text="公开首段。", start=0), mark("secret-mark", text="秘密章节。", start=7, body="删除我的秘密批注"), mark("last-mark", text="公开末段😀。", start=14)]
        tools.validate(source)
        clean = chapter_history.sanitize(source, {"secret"})
        self.assertEqual([item["id"] for item in clean["reviewTools"]["annotations"]], ["first", "last-mark"])
        self.assertEqual(clean["reviewTools"]["annotations"][1]["start"], 9)
        self.assertNotIn("秘密", json.dumps(clean, ensure_ascii=False))
        self.assertEqual(tools.validate(clean)["reviewTools"]["annotations"][1]["status"], "linked")

    def test_short_first_owner_purge_preserves_only_remaining_range(self):
        import chapter_history
        source = book("秘密首段。\n\n公开末段。")
        source["kind"] = "short"
        source["shortSections"] = [{"id": "one", "title": "首", "start": 0, "end": 5}, {"id": "last", "title": "末", "start": 7, "end": 12}]
        source["reviewTools"]["annotations"] = [mark("first", text="秘密首段。", start=0), mark("last-mark", text="公开末段。", start=7)]
        tools.validate(source)
        clean = chapter_history.sanitize(source, {"one"})
        remaining = clean["reviewTools"]["annotations"]
        # chapter_history calls sanitize with the original book and replacements.
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["chapterId"], "last")
        self.assertEqual(remaining[0]["start"], 2)
        self.assertNotIn("秘密", json.dumps(clean, ensure_ascii=False))

    def test_half_surrogate_legacy_purge_rounds_like_manuscript_and_keeps_neighbor_mark(self):
        import chapter_history
        source = book("😀SAFE")
        source["kind"] = "short"
        source["shortSections"] = [{"id": "one", "title": "owner", "start": 0, "end": 6}, {"id": "half", "title": "legacy", "start": 0, "end": 1}]
        source["reviewTools"]["annotations"] = [mark("safe", text="SAFE", start=2)]
        tools.validate(source)
        clean = chapter_history.sanitize(source, {"half"})
        self.assertEqual(clean["chapters"][0]["body"], "SAFE")
        self.assertEqual(len(clean["reviewTools"]["annotations"]), 1)
        self.assertEqual(clean["reviewTools"]["annotations"][0]["start"], 0)
        self.assertEqual(tools.validate(clean)["reviewTools"]["annotations"][0]["status"], "linked")

    def test_server_short_alias_import_and_upgrade_are_idempotent_without_mutating_source(self):
        import server
        source = server.new_book("旧短篇", "short")
        owner = source["chapters"][0]
        owner["body"] = "\n\nB"
        source["shortSections"] = [{"id": "old-alias", "title": "旧片段", "start": 2, "end": 3}]
        source["reviewTools"]["bookmarks"] = [mark("alias", "old-alias", "B", 0)]
        original = copy.deepcopy(source)
        checked = server.validate_book(source)
        self.assertEqual(source, original)
        item = checked["reviewTools"]["bookmarks"][0]
        self.assertEqual((item["chapterId"], item["start"], item["end"], item["status"]), (owner["id"], 2, 3, "linked"))
        upgraded = server.upgrade_book(copy.deepcopy(source))
        self.assertEqual(upgraded["reviewTools"]["bookmarks"][0]["start"], 2)
        self.assertEqual(server.upgrade_book(copy.deepcopy(upgraded)), upgraded)
        self.assertEqual(server.validate_book(checked), checked)

    def test_short_import_malformed_marks_reject_cleanly_before_alias_arithmetic(self):
        import server
        for bad in (None, [], "bad", {"annotations": None}, {"annotations": [None]}, {"annotations": [{"chapterId": []}]}):
            source = server.new_book("异常短篇", "short")
            source["reviewTools"] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.validate_book(source)
        source = server.new_book("异常位置", "short")
        source["chapters"][0]["body"] = "正文。"
        source["shortSections"] = [{"id": "alias", "title": "旧正文", "start": 0, "end": 3}]
        item = mark("bad-range", "alias", "正文。", 0)
        item["start"] = "0"
        source["reviewTools"]["annotations"] = [item]
        with self.assertRaises(ValueError):
            server.validate_book(source)

    def test_restoring_a_chapter_before_a_short_owner_does_not_double_add_section_start(self):
        import server
        source = server.new_book("旧短篇", "short")
        owner = source["chapters"][0]
        owner.update(id="old-owner", body="\n\nB")
        source["shortSections"] = [{"id": "old-owner", "title": "剩余片段", "start": 2, "end": 3}]
        restored = server.chapter("恢复的旧片段", "R")
        restored["id"] = "restored"
        source["chapters"].insert(0, restored)
        source["reviewTools"]["bookmarks"] = [mark("owner-bookmark", "old-owner", "B", 2)]
        original = copy.deepcopy(source)
        checked = server.validate_book(source)
        item = checked["reviewTools"]["bookmarks"][0]
        self.assertEqual((item["chapterId"], item["start"], item["end"], item["status"]), ("restored", 5, 6, "linked"))
        self.assertEqual(checked["chapters"][0]["body"], "R\n\n\n\nB")
        self.assertEqual(server.upgrade_book(copy.deepcopy(checked)), checked)
        self.assertEqual(source, original)

    def test_101506_sample_anchors_all_chapters_and_large_dictionary_round_trip(self):
        source = json.loads((ROOT / "examples/tide-archive.yejian.json").read_text())["book"]
        source["reviewTools"] = tools.defaults()
        source["reviewTools"]["dictionary"] = [item["title"] for item in source["notes"] if item.get("type") == "人物"]
        for index, item in enumerate(source["chapters"]):
            line = next(value for value in item["body"].splitlines() if value.strip())
            start = tools.utf16_length(item["body"].split(line, 1)[0])
            source["reviewTools"]["annotations"].append(mark("sample-" + str(index), item["id"], line, start))
        checked = tools.validate(copy.deepcopy(source))
        self.assertEqual(len(checked["reviewTools"]["annotations"]), 36)
        self.assertTrue(all(item["status"] == "linked" for item in checked["reviewTools"]["annotations"]))
        self.assertEqual(tools.validate(json.loads(json.dumps(checked))), checked)
        # A dense 5000-mark chapter must encode the manuscript once per pass,
        # rather than 5000 times; exercise that real upper capacity on 100k text.
        dense = book("序" * 100000 + "目标段落。")
        dense["reviewTools"]["annotations"] = [mark(str(index), text="目标段落。", start=100000) for index in range(5000)]
        started = time.perf_counter(); tools.validate(dense); elapsed = time.perf_counter() - started
        self.assertEqual(len(dense["reviewTools"]["annotations"]), 5000)
        print("Dense mark validation (5000 marks / 100k chapter): %.3fs" % elapsed)


if __name__ == "__main__":
    unittest.main()
