"""Check optional planning categories using an isolated API and database."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import new_book, validate_book


def person(person_id, title, deleted_at=None):
    return {"id": person_id, "type": "人物", "title": title, "body": "人物资料",
            "chapterIds": [], "aliases": [], "deletedAt": deleted_at,
            "profile": {"group": "", "role": "", "desire": "", "flaw": "", "ending": "", "arcs": []}}


def planning_book():
    book = new_book("分类验收")
    book["notes"] = [person("person-one", "林舟"), person("person-archived", "陈河", "2026-10-09")]
    book["outline"] = [{"id": "outline-one", "title": "故事构思", "body": "原有大纲内容",
                        "kind": "story", "volumeId": None, "parentId": None,
                        "chapterIds": [], "deletedAt": None}]
    return book


plain = planning_book()
assert validate_book(plain) == plain
assert "atlasViews" not in validate_book(plain)
assert "category" not in validate_book(plain)["outline"][0]
categorized = copy.deepcopy(plain)
categorized["outline"][0]["category"] = "自定义主题"
categorized["atlasViews"] = [{"id": "view-one", "title": "旧案", "description": "保留被回收人物的关联以便恢复。",
                              "personIds": ["person-one", "person-archived"]}]
assert validate_book(categorized) == categorized
assert validate_book({**plain, "atlasViews": []})["atlasViews"] == []


def invalid_variant(name):
    book = copy.deepcopy(categorized)
    if name == "view-list":
        book["atlasViews"] = {}
    elif name == "duplicate-view":
        book["atlasViews"].append(copy.deepcopy(book["atlasViews"][0]))
    elif name == "duplicate-person":
        book["atlasViews"][0]["personIds"] = ["person-one", "person-one"]
    elif name == "foreign-person":
        book["atlasViews"][0]["personIds"] = ["foreign-person"]
    elif name == "non-person":
        book["notes"][0]["type"] = "地点"
    elif name == "members-type":
        book["atlasViews"][0]["personIds"] = "person-one"
    elif name == "member-type":
        book["atlasViews"][0]["personIds"] = [123]
    elif name == "empty-title":
        book["atlasViews"][0]["title"] = " "
    elif name == "title-limit":
        book["atlasViews"][0]["title"] = "字" * 201
    elif name == "description-limit":
        book["atlasViews"][0]["description"] = "字" * 50001
    elif name == "views-limit":
        book["atlasViews"] = [{**book["atlasViews"][0], "id": "view-" + str(i)} for i in range(101)]
    elif name == "members-limit":
        book["atlasViews"][0]["personIds"] = ["person-one"] * 10001
    elif name == "category-type":
        book["outline"][0]["category"] = []
    elif name == "category-limit":
        book["outline"][0]["category"] = "字" * 201
    return book


invalid_names = ["view-list", "duplicate-view", "duplicate-person", "foreign-person", "non-person",
                 "members-type", "member-type", "empty-title", "title-limit", "description-limit",
                 "views-limit", "members-limit", "category-type", "category-limit"]
for name in invalid_names:
    try:
        validate_book(invalid_variant(name))
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid metadata accepted: " + name)
print("PASS: optional fields stay absent; category/view bounds, unique IDs and person membership are validated")

with tempfile.TemporaryDirectory(prefix="writer-desk-categories-") as temporary:
    command = [os.environ["WRITER_DESK_SERVICE"]] if os.environ.get("WRITER_DESK_SERVICE") else [sys.executable, str(ROOT / "server.py")]
    process = subprocess.Popen([*command, "--port", "0", "--data-dir", temporary],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    try:
        startup = process.stdout.readline().strip()
        assert "：http://127.0.0.1:" in startup, startup
        url = startup.split("：", 1)[1]

        def request(path, method="GET", value=None):
            payload = None if value is None else json.dumps(value, ensure_ascii=False).encode()
            req = urllib.request.Request(url + path, data=payload, method=method,
                                         headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    raw = response.read()
                    return response.status, json.loads(raw) if path.startswith("/api/") else raw
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())

        code, created = request("/api/books", "POST", {"title": categorized["title"]})
        assert code == 201
        book = copy.deepcopy(categorized)
        book["id"] = created["book"]["id"]
        book["volumes"] = created["book"]["volumes"]
        bid = book["id"]
        code, saved = request("/api/books/" + bid, "PUT", {"book": book, "revision": 1})
        assert code == 200
        revision = saved["revision"]
        assert request("/api/books/" + bid)[1]["book"] == book

        exported = {"format": "yejian-backup", "version": 3, "book": request("/api/books/" + bid)[1]["book"]}
        backup_file = Path(temporary) / "planning.yejian.json"
        backup_file.write_text(json.dumps(exported, ensure_ascii=False), "utf-8")
        code, restored = request("/api/import", "POST", json.loads(backup_file.read_text("utf-8")))
        assert code == 201 and restored["book"]["id"] != bid
        assert restored["book"]["volumes"][0]["id"] != book["volumes"][0]["id"]
        assert restored["book"]["atlasViews"] == book["atlasViews"]
        assert restored["book"]["outline"] == book["outline"]
        assert restored["book"]["notes"] == book["notes"]
        assert request("/api/books/" + restored["book"]["id"])[1]["book"] == restored["book"]
        print("PASS: custom categories/themes survive API save, reload, JSON export and import; person IDs stay linked")

        _, foreign = request("/api/books", "POST", {"title": "另一本书"})
        foreign_book = foreign["book"]
        foreign_book["notes"] = [person("foreign-person", "外部人物")]
        assert request("/api/books/" + foreign_book["id"], "PUT", {"book": foreign_book, "revision": 1})[0] == 200
        total = len(request("/api/books")[1]["books"])
        for name in ("duplicate-view", "duplicate-person", "foreign-person", "non-person"):
            bad = invalid_variant(name)
            bad["id"], bad["volumes"] = bid, book["volumes"]
            assert request("/api/books/" + bid, "PUT", {"book": bad, "revision": revision})[0] == 400, name
            assert request("/api/books/" + bid)[1]["book"] == book
            assert request("/api/import", "POST", {**exported, "book": bad})[0] == 400, name
        assert len(request("/api/books")[1]["books"]) == total
        for asset in ("/atlas-layout.js", "/atlas.css", "/outline.css", "/vendor/dagre.min.js"):
            if (ROOT / "public" / asset[1:]).exists():
                assert request(asset)[0] == 200, asset
        print("PASS: duplicate/foreign/non-person references reject atomically and available layout assets load")
    finally:
        process.terminate()
        process.wait(timeout=10)

print("Category verification complete; no user database was modified.")
