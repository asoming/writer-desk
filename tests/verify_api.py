"""Integration checks against disposable servers; never uses the user's data."""
import base64
import concurrent.futures
import copy
from contextlib import closing
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parents[1]
checks = []
png_cover = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Tr8AAAAASUVORK5CYII="


def chapter(item_id, title, body="", volume_id=None, deleted_at=None):
    return {"id": item_id, "title": title, "body": body, "volumeId": volume_id, "deletedAt": deleted_at}


def person(item_id, title, chapter_ids=None):
    return {"id": item_id, "type": "人物", "title": title, "body": "人物资料", "aliases": [],
            "profile": {"group": "", "role": "", "desire": "", "flaw": "", "ending": "", "arcs": []},
            "chapterIds": chapter_ids or [], "deletedAt": None}


def normalize_restored(restored, original):
    """Restore changes book/volume IDs while preserving text and links."""
    result = copy.deepcopy(restored)
    result["id"] = original["id"]
    mapping = {new["id"]: old["id"] for old, new in zip(original["volumes"], result["volumes"])}
    for volume in result["volumes"]:
        volume["id"] = mapping[volume["id"]]
    for item in result["chapters"] + result["outline"]:
        if item["volumeId"] is not None:
            item["volumeId"] = mapping[item["volumeId"]]
    for note in result["notes"]:
        if note["type"] == "人物":
            for arc in note["profile"]["arcs"]:
                arc["volumeId"] = mapping[arc["volumeId"]]
    for relation in result["relations"]:
        relation["volumeIds"] = [mapping[v] for v in relation["volumeIds"]]
    return result


with tempfile.TemporaryDirectory(prefix="yejian-verify-") as tmp:
    processes = []
    try:
        urls = []
        for _ in range(2):
            process = subprocess.Popen(
                [sys.executable, str(root / "server.py"), "--port", "0", "--data-dir", tmp],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            processes.append(process)
            startup = process.stdout.readline().strip()
            if "：http://127.0.0.1:" not in startup:
                detail = process.stderr.read().strip() if process.poll() is not None else startup
                raise RuntimeError("Cannot start disposable local verification server: " + detail)
            urls.append(startup.split("：", 1)[1])

        def request(path, method="GET", data=None, origin=None, index=0, raw=None):
            headers = {"Content-Type": "application/json", "X-Writer-Client": "1"}
            if origin:
                headers["Origin"] = origin
            payload = raw if raw is not None else (json.dumps(data, ensure_ascii=False).encode() if data is not None else None)
            req = urllib.request.Request(urls[index] + path, data=payload, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=40) as response:
                    result = response.read()
                    return response.status, json.loads(result) if path.startswith("/api/") else result
            except urllib.error.HTTPError as error:
                return error.code, json.loads(error.read())

        def passed(name):
            checks.append(name)

        assert request("/")[0] == 200
        assert request("/../../server.py")[0] == 404
        for asset in ("/app.js", "/style.css", "/story-analysis.js", "/workspace.js"):
            if (root / "public" / asset[1:]).exists():
                assert request(asset)[0] == 200
        passed("static app and safe asset allowlist")
        assert request("/api/books", "POST", {"title": "x"}, origin="https://foreign.example")[0] == 403
        passed("cross-origin writes rejected")

        code, result = request("/api/books", "POST", {"title": "API 验收"})
        assert code == 201
        book = result["book"]
        bid, revision = book["id"], result["revision"]
        assert book["chapters"] == [] and len(book["volumes"]) == 1 and book["cover"] == ""
        volume_id = book["volumes"][0]["id"]
        book["outline"] = [{"id": "outline-one", "title": "故事构思", "body": "先写大纲", "kind": "story",
                            "volumeId": None, "parentId": None, "chapterIds": [], "deletedAt": None}]
        code, result = request("/api/books/" + bid, "PUT", {"book": book, "revision": revision})
        assert code == 200
        revision = result["revision"]
        assert request("/api/books/" + bid)[1]["book"] == book
        passed("new long work starts with a volume and permits outline-only planning")

        book["cover"] = png_cover
        book["coverTemplate"] = "ocean"
        book["volumes"][0]["summary"] = "归来与追寻"
        book["volumes"].append({"id": "volume-two", "title": "第二卷 重逢", "summary": "第二卷梗概", "deletedAt": None})
        book["chapters"] = [chapter("chapter-one", "第一章", "中文，英文 English 123。\n\n第二段🙂", volume_id),
                            chapter("chapter-two", "第二章", "第二卷正文", "volume-two"),
                            chapter("chapter-blank", "后续待写", volume_id="volume-two"),
                            chapter("trash-test", "回收章节", "应在备份内", volume_id, "2026-10-09T00:00:00Z")]
        book["notes"] = [person("note-test", "姓名", ["chapter-one"]), person("person-two", "另一人")]
        book["notes"][0]["aliases"] = ["小名", "曾用名"]
        book["notes"][0]["profile"].update(group="雾港", role="主角", desire="找回信", flaw="回避", ending="坦然面对",
                                            arcs=[{"volumeId": volume_id, "body": "从逃避到返乡"}, {"volumeId": "volume-two", "body": "主动寻找"}])
        book["outline"][0]["chapterIds"] = ["chapter-one"]
        book["outline"].append({"id": "outline-child", "title": "第二卷", "body": "卷中事件", "kind": "volume",
                                "volumeId": "volume-two", "parentId": "outline-one", "chapterIds": ["chapter-two", "trash-test"], "deletedAt": None})
        book["relations"] = [{"id": "relation-one", "fromId": "note-test", "toId": "person-two", "label": "同伴",
                              "body": "关系说明", "type": "friend", "stage": "从误会到同伴", "volumeIds": [volume_id, "volume-two"],
                              "chapterIds": ["chapter-one"], "deletedAt": None}]
        code, result = request("/api/books/" + bid, "PUT", {"book": book, "revision": revision})
        assert code == 200
        revision = result["revision"]
        assert request("/api/books/" + bid)[1]["book"] == book
        passed("cover, volumes, outline types, aliases, character arcs and relationship groups persist")
        assert request("/api/books/" + bid, "PUT", {"book": book, "revision": revision - 1})[0] == 409
        passed("stale revision rejected")

        count = len(request("/api/books")[1]["books"])
        for invalid in ({"format": "yejian-backup", "version": 9, "book": book},
                        {"format": "yejian-backup", "version": 3, "book": {"id": "bad", "title": "x", "chapters": [], "notes": [], "volumes": "invalid"}}):
            assert request("/api/import", "POST", invalid)[0] == 400
        assert len(request("/api/books")[1]["books"]) == count
        passed("invalid imports are atomic")

        for version in (1, 2, 3):
            code, result = request("/api/import", "POST", {"format": "yejian-backup", "version": version, "book": book})
            assert code == 201
            restored = result["book"]
            assert restored["id"] != bid
            assert not ({v["id"] for v in restored["volumes"]} & {v["id"] for v in book["volumes"]})
            assert normalize_restored(restored, book) == book
        passed("v1/v2/v3 backups retain all fields and remap every volume reference")

        code, short = request("/api/books", "POST", {"title": "短篇验收", "kind": "short", "cover": png_cover, "coverTemplate": "neon"})
        assert code == 201
        assert short["book"]["kind"] == "short" and short["book"]["volumes"] == []
        assert len(short["book"]["chapters"]) == 1 and short["book"]["chapters"][0]["body"] == ""
        assert short["book"]["chapters"][0]["title"] == "正文"
        listed = {b["id"]: b for b in request("/api/books")[1]["books"]}
        assert listed[bid]["cover"] == png_cover and listed[bid]["volumeCount"] == 2
        assert listed[bid]["coverTemplate"] == "ocean" and short["book"]["coverTemplate"] == "neon"
        assert listed[bid]["outlineCount"] == 2 and listed[bid]["personCount"] == 2
        assert listed[bid]["latestChapterTitle"] == "第二章" and listed[bid]["chapterCount"] == 3
        assert listed[short["book"]["id"]]["kind"] == "short" and listed[short["book"]["id"]]["latestChapterTitle"] == "正文"
        bad_short = copy.deepcopy(short["book"])
        bad_short["volumes"] = copy.deepcopy(book["volumes"])
        assert request("/api/books/" + bad_short["id"], "PUT", {"book": bad_short, "revision": 1})[0] == 400
        passed("long/short shelves expose covers and counts; short works reject volumes")

        for invalid in ("foreign-link", "cycle", "relation-endpoint", "chapter-volume", "outline-volume", "duplicate-volume",
                        "deleted-volume", "outline-kind", "character-arc", "relation-volume", "relation-type", "aliases"):
            bad = copy.deepcopy(book)
            if invalid == "foreign-link":
                bad["outline"][0]["chapterIds"] = ["another-book-chapter"]
            elif invalid == "cycle":
                bad["outline"][0]["parentId"] = "outline-child"
            elif invalid == "relation-endpoint":
                bad["relations"][0]["toId"] = "outside-person"
            elif invalid == "chapter-volume":
                bad["chapters"][0]["volumeId"] = "foreign-volume"
            elif invalid == "outline-volume":
                bad["outline"][0]["volumeId"] = "foreign-volume"
            elif invalid == "duplicate-volume":
                bad["volumes"].append(copy.deepcopy(bad["volumes"][0]))
            elif invalid == "deleted-volume":
                bad["volumes"][0]["deletedAt"] = "2026-10-09"
            elif invalid == "outline-kind":
                bad["outline"][0]["kind"] = "unknown"
            elif invalid == "character-arc":
                bad["notes"][0]["profile"]["arcs"][0]["volumeId"] = "foreign-volume"
            elif invalid == "relation-volume":
                bad["relations"][0]["volumeIds"] = ["foreign-volume"]
            elif invalid == "relation-type":
                bad["relations"][0]["type"] = "unknown"
            else:
                bad["notes"][0]["aliases"] = [123]
            assert request("/api/books/" + bid, "PUT", {"book": bad, "revision": revision})[0] == 400, invalid
            assert request("/api/books/" + bid)[1]["revision"] == revision
        passed("bad chapter/person/volume links, cycles, deleted volumes and field types reject atomically")

        for cover in ("https://example.com/cover.png", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
                      "data:image/png;base64,not-base64!", "data:image/png;base64," + base64.b64encode(b"not a PNG").decode(),
                      png_cover.replace("image/png", "image/jpeg"), "a" * (2 * 1024 * 1024 + 1)):
            bad = copy.deepcopy(book)
            bad["cover"] = cover
            assert request("/api/books/" + bid, "PUT", {"book": bad, "revision": revision})[0] == 400
            assert request("/api/books/" + bid)[1]["revision"] == revision
        passed("external/SVG/malformed/mismatched/oversize covers reject without changing saved work")

        book["chapters"][0]["title"] = "重新命名"
        book["chapters"].reverse()
        code, result = request("/api/books/" + bid, "PUT", {"book": book, "revision": revision})
        assert code == 200
        revision = result["revision"]
        assert request("/api/books/" + bid)[1]["book"] == book
        passed("chapter rename/reordering retains outline, character and volume links")

        archived = copy.deepcopy(book)
        for item in archived["chapters"]:
            item["deletedAt"] = "2026-10-09"
        archived["volumes"][0]["deletedAt"] = "2026-10-09"
        code, result = request("/api/books/" + bid, "PUT", {"book": archived, "revision": revision})
        assert code == 200
        revision = result["revision"]
        assert request("/api/books/" + bid)[1]["book"] == archived
        code, result = request("/api/books/" + bid, "PUT", {"book": book, "revision": revision})
        assert code == 200
        revision = result["revision"]
        passed("final chapter can enter trash; archived chapter/volume references remain recoverable")

        legacy = {"id": "legacy-book", "title": "旧作品", "chapters": [{"id": "legacy-chapter", "title": "旧章节", "body": "原文不可丢", "deletedAt": None}],
                  "notes": [{"id": "legacy-person", "type": "人物", "title": "旧人物", "body": "旧设定", "deletedAt": None}]}
        with closing(sqlite3.connect(pathlib.Path(tmp) / "writer.sqlite3")) as connection, connection:
            connection.execute("INSERT INTO books(id,title,payload,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)", (legacy["id"], legacy["title"], json.dumps(legacy), 7, "old", "old"))
        _, old = request("/api/books/legacy-book")
        _, second_read = request("/api/books/legacy-book", index=1)
        assert old == second_read and old["revision"] == 7
        upgraded = old["book"]
        assert upgraded["chapters"][0]["volumeId"] == upgraded["volumes"][0]["id"]
        assert upgraded["chapters"][0]["body"] == legacy["chapters"][0]["body"]
        assert upgraded["notes"][0]["aliases"] == [] and upgraded["notes"][0]["profile"]["arcs"] == []
        for version in (1, 2):
            code, result = request("/api/import", "POST", {"format": "yejian-backup", "version": version, "book": legacy})
            assert code == 201
            assert result["book"]["chapters"][0]["volumeId"] == result["book"]["volumes"][0]["id"]
            assert result["book"]["chapters"][0]["body"] == "原文不可丢"
        code, result = request("/api/books/legacy-book", "PUT", {"book": legacy, "revision": 7})
        assert code == 200 and request("/api/books/legacy-book")[1]["book"] == upgraded
        passed("legacy reads/imports/saves upgrade deterministically without losing text or changing read revisions")

        gate = threading.Barrier(2)

        def competing(index):
            candidate = copy.deepcopy(book)
            candidate["chapters"][0]["body"] = "窗口 " + str(index)
            gate.wait()
            return request("/api/books/" + bid, "PUT", {"book": candidate, "revision": revision}, index=index)[0]

        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            statuses = sorted(pool.map(competing, [0, 1]))
        assert statuses == [200, 409], statuses
        passed("two server processes cannot overwrite the same revision")

        _, large = request("/api/books", "POST", {"title": "临界大小验收"})
        large_book = large["book"]
        large_book["chapters"] = [chapter("large-" + str(i), "章节 " + str(i)) for i in range(6)]
        budget = 25 * 1024 * 1024 - 10 - len(json.dumps(large_book, ensure_ascii=False).encode())
        for item in large_book["chapters"]:
            length = min(4_999_999, budget)
            item["body"] = "a" * length
            budget -= length
        assert budget == 0
        assert request("/api/books/" + large_book["id"], "PUT", {"book": large_book, "revision": 1})[0] == 200
        pretty = json.dumps({"format": "yejian-backup", "version": 3, "book": large_book}, ensure_ascii=False, indent=2).encode()
        assert len(pretty) > 25 * 1024 * 1024
        code, result = request("/api/import", "POST", raw=pretty)
        assert code == 201, (code, result)
        assert normalize_restored(result["book"], large_book) == large_book
        passed("near-25-MiB formatted v3 backup restores successfully")
        print(json.dumps({"passed": checks, "count": len(checks)}, ensure_ascii=False, indent=2))
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait(timeout=5)
