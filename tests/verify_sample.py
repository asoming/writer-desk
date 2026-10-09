"""Exercise the complete example and real backup API, using a disposable database."""
from collections import Counter
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import validate_book

backup = json.loads((ROOT / "examples/tide-archive.yejian.json").read_text("utf-8"))
book = backup["book"]
assert validate_book(book) == book
chapters, volumes = book["chapters"], book["volumes"]
people = [p for p in book["notes"] if p["type"] == "人物"]
assert len(chapters) == 36 and len(volumes) == 6 and len(people) == 32
assert all(sum(c["volumeId"] == v["id"] for c in chapters) == 6 for v in volumes)
counts = [sum(not ch.isspace() for ch in c["body"]) for c in chapters]
assert min(counts) >= 2600 and 100000 <= sum(counts) <= 115000
paragraphs = Counter(p.strip() for c in chapters for p in re.split(r"\n\s*\n", c["body"]) if len(p.strip()) >= 60)
assert not [p for p, number in paragraphs.items() if number > 1], "Repeated long paragraphs"
assert all(any(p["title"] in c["body"] for c in chapters) for p in people)
assert all(not ({"父亲", "母亲"} & set(p["aliases"])) for p in people)
assert len([o for o in book["outline"] if o["kind"] == "chapter"]) == 36
assert all(p["profile"]["arcs"] for p in people)
print(f"PASS: {sum(counts):,} characters, 6 volumes, 36 chapters, 32 people, valid links and no repeated long paragraphs")


with tempfile.TemporaryDirectory(prefix="writer-desk-sample-") as temporary:
    command = [os.environ["WRITER_DESK_SERVICE"]] if os.environ.get("WRITER_DESK_SERVICE") else [sys.executable, str(ROOT / "server.py")]
    process = subprocess.Popen([*command, "--port", "0", "--data-dir", temporary],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        url = process.stdout.readline().strip().split("：", 1)[1]

        def request(path, method="GET", value=None):
            data = None if value is None else json.dumps(value, ensure_ascii=False).encode()
            req = urllib.request.Request(url + path, data=data, method=method,
                                         headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.load(response)

        manifest = request("/api/examples")["examples"]
        assert manifest[0]["charCount"] == sum(counts)
        first = request("/api/examples/tide-archive", "POST", {})
        second = request("/api/examples/tide-archive", "POST", {})
        assert first["book"]["id"] != second["book"]["id"]
        assert first["book"]["title"] != second["book"]["title"]
        assert {v["id"] for v in first["book"]["volumes"]}.isdisjoint(v["id"] for v in second["book"]["volumes"])
        assert [c["body"] for c in first["book"]["chapters"]] == [c["body"] for c in chapters]
        print("PASS: sample library creates independent editable copies with complete text")

        changed = copy.deepcopy(first["book"])
        original_links = [(o["id"], list(o["chapterIds"])) for o in changed["outline"]]
        changed["chapters"][0]["title"] = "改名验证 — Renamed chapter"
        changed["chapters"][0], changed["chapters"][1] = changed["chapters"][1], changed["chapters"][0]
        result = request("/api/books/" + changed["id"], "PUT", {"book": changed, "revision": first["revision"]})
        reloaded = request("/api/books/" + changed["id"])["book"]
        assert reloaded == changed
        assert [(o["id"], o["chapterIds"]) for o in reloaded["outline"]] == original_links
        restored = request("/api/import", "POST", {**backup, "book": changed})["book"]
        assert [c["body"] for c in restored["chapters"]] == [c["body"] for c in changed["chapters"]]
        assert restored["notes"] != changed["notes"]  # volume references are intentionally remapped
        assert [p["body"] for p in restored["notes"]] == [p["body"] for p in changed["notes"]]
        assert validate_book(restored) == restored
        assert request("/api/books/" + second["book"]["id"])["book"] == second["book"]
        print("PASS: full novel save/reload, rename/reorder links, backup remapping and cross-book isolation")
    finally:
        process.terminate()
        process.wait(timeout=10)

print("Sample verification complete; no user database was modified.")
