#!/usr/bin/env python3
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import library_search


class LibrarySearchTests(unittest.TestCase):
    def book(self, suffix=""):
        return {"id": "book" + suffix, "title": "码头档案" + suffix, "kind": "long",
                "chapters": [{"id": "chapter", "title": "江宁", "body": "🌊江宁在码头看见沈砚。"},
                             {"id": "trash", "title": "江宁", "body": "江宁旧稿", "deletedAt": "2026"}],
                "outline": [{"id": "outline", "title": "世界", "body": "码头规则"}],
                "notes": [{"id": "person", "type": "人物", "title": "沈砚", "aliases": ["码头先生"], "body": "修复师", "profile": {"desire": "寻找码头档案"}},
                          {"id": "note", "type": "资料", "title": "地图", "body": "旧码头"}],
                "relations": [{"id": "relation", "label": "码头同伴", "body": "共同工作"}],
                "storyTools": {"foreshadows": [{"id": "f", "title": "码头线索", "body": "七张卡片"}], "timeline": [{"id": "t", "title": "抵达", "body": "进入码头", "storyTime": "某日"}]},
                "assetLibrary": {"items": [{"id": "asset", "name": "码头地图", "excerpt": "档案馆旁的旧码头", "data": "binary码头must-not-search"}]}}

    def test_all_sources_and_unicode_offsets(self):
        book = self.book()
        before = copy.deepcopy(book)
        result = library_search.search_books([book], "码头")
        self.assertEqual({item["type"] for item in result["results"]}, {"book", "chapter", "outline", "person", "note", "relation", "foreshadow", "timeline", "asset"})
        hit = next(item for item in library_search.search_books([book], "江宁")["results"] if item["type"] == "chapter" and item["field"] == "body")
        self.assertEqual((hit["start"], hit["end"]), (2, 4))
        self.assertFalse(any(item["id"] == "trash" for item in result["results"]))
        self.assertFalse(any(item["field"] == "data" for item in result["results"]))
        self.assertEqual(book, before)

    def test_cross_book_literal_case_and_deleted_book(self):
        first, second, deleted = self.book(), self.book("2"), self.book("3")
        first["chapters"][0]["body"] = "Foo foo .* $&"
        deleted["deletedAt"] = "2026"
        self.assertEqual({item["bookId"] for item in library_search.search_books([first, second, deleted], "码头")["results"]}, {"book", "book2"})
        self.assertEqual(len(library_search.search_books([first], "Foo")["results"]), 2)
        self.assertEqual(len(library_search.search_books([first], "Foo", case_sensitive=True)["results"]), 1)
        self.assertEqual(len(library_search.search_books([first], ".*")["results"]), 1)
        self.assertEqual(library_search.search_books([first], "[.*]")["results"], [])

    def test_result_and_scan_budgets_are_explicit(self):
        book = self.book()
        book["chapters"][0]["body"] = "hit " * 10000
        result = library_search.search_books([book], "hit")
        self.assertEqual(len(result["results"]), 5)
        self.assertTrue(result["truncated"])
        result = library_search.search_books((self.book(str(index)) for index in range(100)), "码头", limit=20)
        self.assertEqual(len(result["results"]), 20)
        self.assertTrue(result["truncated"])
        for query in ("", " ", "甲" * 201, None):
            with self.assertRaises(ValueError):
                library_search.search_books([], query)

    def test_demo_search_returns_meaningful_excerpts_without_changing_101506_characters(self):
        sample = json.loads((Path(__file__).resolve().parents[1] / "examples/tide-archive.yejian.json").read_text())["book"]
        before = json.dumps(sample, ensure_ascii=False)
        result = library_search.search_books([sample], "沈砚")
        self.assertTrue(result["results"])
        self.assertTrue(any(item["type"] == "chapter" for item in result["results"]))
        self.assertTrue(any(item["type"] == "person" for item in result["results"]))
        self.assertLessEqual(len(result["results"]), 200)
        self.assertEqual(json.dumps(sample, ensure_ascii=False), before)


if __name__ == "__main__":
    unittest.main()
