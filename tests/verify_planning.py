"""Planning, activity and purge checks against disposable in-memory libraries."""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from types import SimpleNamespace
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import planning


def sample(kind="long"):
    return {"id": "book-one", "kind": kind, "title": "测试作品", "chapters": [
        {"id": "chapter-one", "title": "第一章", "body": "海上来信。", "deletedAt": None},
        {"id": "chapter-old", "title": "旧章", "body": "已删的旧文字。", "deletedAt": "2026-10-10T00:00:00Z"}],
        "notes": [{"id": "person-one", "type": "人物", "title": "林舟", "deletedAt": None},
                  {"id": "person-old", "type": "人物", "title": "旧人物", "deletedAt": "2026-10-10T00:00:00Z"}]}


def planned(kind="long"):
    book = sample(kind)
    book["storyTools"] = {"dailyGoal": 1500, "foreshadows": [
        {"id": "hint-one", "title": "信上的盐", "body": "第一封信没有邮戳。", "status": "planted",
         "chapterIds": ["chapter-one"], "personIds": ["person-one"]}],
        "timeline": [{"id": "event-one", "title": "港口来信", "storyTime": "第三日清晨", "body": "林舟收到信。",
                      "chapterIds": ["chapter-one"], "personIds": ["person-one"]}]}
    return book


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        planning.initialize(self.conn)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_old_book_default_does_not_add_plots_or_modify_manuscript(self):
        book = sample()
        original = copy.deepcopy(book)
        planning.normalize(book)
        self.assertEqual(book.pop("storyTools"), planning.defaults())
        self.assertEqual(book, original)

    def test_all_book_fields_round_trip_as_json(self):
        book = planned()
        self.assertEqual(planning.validate(copy.deepcopy(book)), book)
        self.assertEqual(planning.validate(json.loads(json.dumps(book))), book)
        other = copy.deepcopy(book)
        other["id"] = "imported-book"
        self.assertEqual(planning.validate(other)["storyTools"], book["storyTools"])

    def test_short_story_uses_same_planning_without_volumes(self):
        book = planned("short")
        book["chapters"] = book["chapters"][:1]
        self.assertEqual(planning.validate(copy.deepcopy(book)), book)

    def test_status_and_goal_validate_without_coercion(self):
        for status in ("complete", "", None, [], 1):
            book = planned()
            book["storyTools"]["foreshadows"][0]["status"] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                planning.validate(book)
        for goal in (-1, 1_000_001, True, "2000", 1.5, None):
            book = planned()
            book["storyTools"]["dailyGoal"] = goal
            with self.subTest(goal=goal), self.assertRaises(ValueError):
                planning.validate(book)
        for goal in (0, 1_000_000):
            book = planned()
            book["storyTools"]["dailyGoal"] = goal
            self.assertEqual(planning.validate(book)["storyTools"]["dailyGoal"], goal)

    def test_invalid_records_and_foreign_links_are_rejected(self):
        variants = []
        for key in ("foreshadows", "timeline"):
            book = planned(); book["storyTools"][key] = {}; variants.append(book)
            book = planned(); book["storyTools"][key].append(copy.deepcopy(book["storyTools"][key][0])); variants.append(book)
            for field, value in (("id", ""), ("title", "a" * 201), ("body", "字" * 100001),
                                 ("chapterIds", ["other-book-chapter"]), ("personIds", ["other-book-person"]),
                                 ("chapterIds", "chapter-one"), ("personIds", [1])):
                book = planned(); book["storyTools"][key][0][field] = value; variants.append(book)
        book = planned(); book["storyTools"]["timeline"][0]["storyTime"] = "a" * 201; variants.append(book)
        book = planned(); book["storyTools"] = []; variants.append(book)
        for index, book in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ValueError):
                planning.validate(book)

    def test_recycled_links_clear_without_destroying_records(self):
        book = planned()
        for key in ("foreshadows", "timeline"):
            book["storyTools"][key][0]["chapterIds"] += ["chapter-old"]
            book["storyTools"][key][0]["personIds"] += ["person-old"]
        planning.validate(book)
        for key in ("foreshadows", "timeline"):
            self.assertEqual(book["storyTools"][key][0]["chapterIds"], ["chapter-one"])
            self.assertEqual(book["storyTools"][key][0]["personIds"], ["person-one"])
        self.assertEqual(book["storyTools"]["foreshadows"][0]["body"], "第一封信没有邮戳。")

    def test_purge_removes_links_in_snapshots_without_mutating_input(self):
        book = planned()
        clean = planning.sanitize(book, {"chapter-one"})
        for key in ("foreshadows", "timeline"):
            self.assertEqual(clean["storyTools"][key][0]["chapterIds"], [])
            self.assertEqual(book["storyTools"][key][0]["chapterIds"], ["chapter-one"])
        self.assertEqual(clean["storyTools"]["timeline"][0]["storyTime"], "第三日清晨")

    def test_purge_short_owner_retains_navigation_to_remaining_text(self):
        clean = planning.sanitize(planned("short"), {"chapter-one"}, {"chapter-one": "remaining-owner"})
        for key in ("foreshadows", "timeline"):
            self.assertEqual(clean["storyTools"][key][0]["chapterIds"], ["remaining-owner"])

    def test_short_legacy_links_remap_to_one_manuscript(self):
        book = planned("short")
        book["storyTools"]["timeline"][0]["chapterIds"] += ["section-two", "chapter-old"]
        planning.remap_short_links(book, {"chapter-one", "section-two", "chapter-old"}, "manuscript", {"chapter-old"})
        self.assertEqual(book["storyTools"]["timeline"][0]["chapterIds"], ["manuscript", "chapter-old"])

    def test_story_time_and_array_order_preserved_without_parsing_dates(self):
        book = planned()
        event = copy.deepcopy(book["storyTools"]["timeline"][0])
        event.update(id="event-two", storyTime="帝国历一百二十年·雨季")
        book["storyTools"]["timeline"].insert(0, event)
        planning.validate(book)
        self.assertEqual([item["id"] for item in book["storyTools"]["timeline"]], ["event-two", "event-one"])
        self.assertEqual(book["storyTools"]["timeline"][0]["storyTime"], "帝国历一百二十年·雨季")

    def test_activity_counts_non_whitespace_codepoints_once(self):
        before = sample(); after = copy.deepcopy(before)
        after["chapters"][0]["body"] += "\n新 字🙂\t"
        self.assertEqual(planning.record_save(self.conn, before, after, local_day="2026-10-15"), 3)
        self.assertEqual(planning.record_save(self.conn, after, after, local_day="2026-10-15"), 0)
        stats = planning.statistics(self.conn, after, "2026-10-15")
        self.assertEqual(stats["todayChars"], 3)
        self.assertEqual(stats["totalChars"], planning.character_count(after["chapters"][0]["body"]))

    def test_metadata_deletion_and_undelete_are_not_production(self):
        before = planned(); after = copy.deepcopy(before)
        after["title"] = "新标题"; after["storyTools"]["dailyGoal"] = 1
        after["chapters"][0]["deletedAt"] = "2026-10-15T00:00:00Z"
        after["chapters"][1]["deletedAt"] = None
        self.assertEqual(planning.record_save(self.conn, before, after, local_day="2026-10-15"), 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writing_activity").fetchone()[0], 0)

    def test_new_author_chapter_counts_but_other_books_stay_independent(self):
        before = sample(); after = copy.deepcopy(before)
        after["chapters"].append({"id": "new-chapter", "body": "第一句。", "deletedAt": None})
        planning.record_save(self.conn, before, after, local_day="2026-10-15")
        other = sample(); other["id"] = "book-two"
        self.assertEqual(planning.statistics(self.conn, after, "2026-10-15")["todayChars"], 4)
        self.assertEqual(planning.statistics(self.conn, other, "2026-10-15")["todayChars"], 0)

    def test_daily_calendar_and_7_30_day_totals(self):
        before = sample(); after = copy.deepcopy(before); after["chapters"][0]["body"] += "字" * 10
        for day in ("2026-07-01", "2026-09-20", "2026-10-10", "2026-10-15"):
            planning.record_save(self.conn, before, after, local_day=day)
        stats = planning.statistics(self.conn, after, "2026-10-15")
        self.assertEqual(len(stats["days"]), 90)
        self.assertEqual(stats["days"][-1]["date"], "2026-10-15")
        self.assertEqual(stats["todayChars"], 10)
        self.assertEqual(sum(day["addedChars"] for day in stats["days"][-7:]), 20)
        self.assertEqual(sum(day["addedChars"] for day in stats["days"][-30:]), 30)

    def test_failed_save_transaction_rolls_statistics_back(self):
        before = sample(); after = copy.deepcopy(before); after["chapters"][0]["body"] += "新字"
        with self.assertRaises(RuntimeError):
            with self.conn:
                planning.record_save(self.conn, before, after, local_day="2026-10-15")
                raise RuntimeError("the manuscript save failed")
        self.assertEqual(planning.statistics(self.conn, after, "2026-10-15")["todayChars"], 0)

    def test_import_and_full_demo_have_zero_today_until_an_author_save(self):
        book = json.loads((ROOT / "examples/tide-archive.yejian.json").read_text("utf-8"))["book"]
        planning.normalize(book)
        stats = planning.statistics(self.conn, book, "2026-10-15")
        self.assertEqual(stats["totalChars"], 101506)
        self.assertEqual(stats["todayChars"], 0)
        self.assertEqual(sum(item["addedChars"] for item in stats["days"]), 0)
        after = copy.deepcopy(book); after["chapters"][19]["body"] += "\n潮声又起。"
        planning.record_save(self.conn, book, after, local_day="2026-10-15")
        self.assertEqual(planning.statistics(self.conn, after, "2026-10-15")["todayChars"], 5)

    def test_demo_planning_has_linked_resolved_and_pending_threads_without_manuscript_changes(self):
        book = json.loads((ROOT / "examples/tide-archive.yejian.json").read_text("utf-8"))["book"]
        tools = book["storyTools"]
        self.assertEqual(len(tools["foreshadows"]), 12)
        self.assertEqual(len(tools["timeline"]), 18)
        self.assertEqual({item["status"] for item in tools["foreshadows"]}, {"planted", "developing", "resolved"})
        self.assertEqual(tools["dailyGoal"], 2000)
        self.assertEqual(planning.validate(copy.deepcopy(book))["storyTools"], tools)
        self.assertTrue(all(item["chapterIds"] and item["personIds"] for item in tools["foreshadows"] + tools["timeline"]))
        self.assertEqual(len(book["chapters"]), 36)
        self.assertEqual(sum(planning.character_count(item["body"]) for item in book["chapters"]), 101506)
        self.assertEqual(tools["timeline"][0]["storyTime"], "十八年前·白沙渡事故夜")
        self.assertIn("第十四日", tools["timeline"][-1]["storyTime"])
        by_title = {item["title"]: item for item in tools["foreshadows"]}
        self.assertEqual(by_title["备用灯尚未修复的线路"]["status"], "developing")
        self.assertEqual(by_title["旧馆四只待查箱子"]["status"], "developing")
        self.assertEqual(by_title["新地址簿里待本人确认的一户"]["status"], "planted")

    def test_short_migration_and_recovered_section_not_counted(self):
        before = sample("short")
        before["chapters"].append({"id": "section-two", "body": "另一段。", "deletedAt": None})
        after = copy.deepcopy(before)
        after["chapters"][0]["body"] += "\n\n另一段。"
        after["chapters"] = after["chapters"][:2]
        self.assertEqual(planning.record_save(self.conn, before, after, local_day="2026-10-15"), 0)
        restored = copy.deepcopy(after)
        restored["chapters"][0]["body"] += "\n\n" + restored["chapters"][1]["body"]
        restored["shortSections"] = [{"id": "chapter-old"}]
        restored["chapters"] = restored["chapters"][:1]
        self.assertEqual(planning.record_save(self.conn, after, restored, local_day="2026-10-15"), 0)
        restored["chapters"][0]["body"] += "新字"
        self.assertEqual(planning.record_save(self.conn, after, restored, local_day="2026-10-15"), 2)

    def test_book_purge_removes_only_its_activity(self):
        before = sample(); after = copy.deepcopy(before); after["chapters"][0]["body"] += "字"
        planning.record_save(self.conn, before, after, local_day="2026-10-15")
        other_before = copy.deepcopy(before); other_after = copy.deepcopy(after)
        other_before["id"] = other_after["id"] = "book-two"
        planning.record_save(self.conn, other_before, other_after, local_day="2026-10-15")
        planning.purge_book(self.conn, "book-one")
        self.assertEqual(planning.statistics(self.conn, after, "2026-10-15")["todayChars"], 0)
        self.assertEqual(planning.statistics(self.conn, other_after, "2026-10-15")["todayChars"], 1)

    def test_api_dispatch_uses_server_active_book_and_shared_connection_contract(self):
        book = planned()
        self.conn.execute("CREATE TABLE books(id TEXT PRIMARY KEY,payload TEXT)")
        self.conn.execute("INSERT INTO books VALUES(?,?)", (book["id"], json.dumps(book)))
        checks = []
        @contextmanager
        def connection():
            yield self.conn
        @contextmanager
        def lock():
            yield
        srv = SimpleNamespace(DB_LOCK=lock(), connect=connection,
            saved_book_row=lambda conn, book_id: {"payload": conn.execute("SELECT payload FROM books WHERE id=?", (book_id,)).fetchone()[0]},
            require_active_book=lambda row: checks.append("active"), upgrade_book=lambda data: data)
        result = planning.read(srv, "/api/books/book-one/writing-stats")
        self.assertEqual(result["bookId"], "book-one")
        self.assertEqual(checks, ["active"])
        self.assertIsNone(planning.read(srv, "/api/books/book-one"))


if __name__ == "__main__":
    unittest.main()
