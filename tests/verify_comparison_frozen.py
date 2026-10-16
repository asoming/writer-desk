"""Verify shipped comparison storage through a real service and its restarts.

``--service`` targets the actual PyInstaller executable on native CI. Without
it, the same journey runs against source. Only disposable data is ever opened;
all pipes, logs and SQLite readers close before Windows temporary cleanup.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/tide-archive.yejian.json"


class DesktopService:
    def __init__(self, data, executable=None):
        self.data, self.executable = data, executable
        self.token = uuid.uuid4().hex
        self.process = self.errors = None
        self.reader = None

    def diagnostics(self):
        if self.errors is None:
            return ""
        self.errors.seek(0)
        return self.errors.read().decode("utf-8", errors="replace")[-12000:]

    def start(self):
        assert self.process is None, "Previous service must exit before restart"
        command = [str(self.executable)] if self.executable else [sys.executable, str(ROOT / "server.py")]
        self.errors = open(self.data / ("comparison-service-" + uuid.uuid4().hex + ".log"), "w+b")
        self.process = subprocess.Popen(command + ["--desktop", "--port", "0", "--data-dir", str(self.data)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding="utf-8",
            cwd=ROOT, env={**os.environ, "WRITER_DESKTOP_TOKEN": self.token, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        ready, output = queue.Queue(), self.process.stdout
        self.reader = threading.Thread(target=lambda: ready.put(output.readline()), daemon=True)
        self.reader.start()
        try:
            line = ready.get(timeout=30)
        except queue.Empty:
            line = "(WRITER_READY timed out after 30 seconds)"
        assert line.startswith("WRITER_READY "), repr(line) + "\n" + self.diagnostics()
        self.reader.join(timeout=1)
        self.url = json.loads(line[len("WRITER_READY "):])["url"]

    def stop(self, check_exit=True):
        error = None
        try:
            if self.process is not None:
                process, self.process = self.process, None
                if process.stdin is not None:
                    process.stdin.close()
                    process.stdin = None
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    error = "Service did not stop on desktop stdin EOF"
                    process.terminate()
                    try:
                        process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=5)
                if process.returncode != 0:
                    error = error or "Service exit status: " + str(process.returncode)
                if self.reader is not None:
                    self.reader.join(timeout=1)
                    self.reader = None
            diagnostic = self.diagnostics() if error else ""
        finally:
            if self.errors is not None:
                self.errors.close()
                self.errors = None
        if error and check_exit:
            raise AssertionError(error + "\n" + diagnostic)

    def request(self, path, method="GET", value=None, expected=200, token=True):
        headers = {"Content-Type": "application/json", "X-Writer-Client": "1", "Origin": self.url}
        if token:
            headers["X-Writer-Desktop"] = self.token
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
        request = urllib.request.Request(self.url + path, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as problem:
            status, raw = problem.code, problem.read()
        assert status == expected, (method, path, status, raw[:500])
        return json.loads(raw)


def verify(executable=None):
    example_hash = hashlib.sha256(EXAMPLE.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="writer-comparison-native-") as temporary:
        data = Path(temporary).resolve()
        service = DesktopService(data, executable)
        try:
            service.start()
            request = service.request
            shelf = request("/api/books")["books"]
            book_id = next(book["id"] for book in shelf if book["charCount"] == 101506)
            book_path = "/api/books/" + book_id
            original = request(book_path)
            chapter = original["book"]["chapters"][0]
            chapter_path = book_path + "/chapters/" + chapter["id"]
            path = chapter_path + "/comparison"
            current = request(path)
            assert current["draft"] is None and current["stale"] is False
            request(path, expected=403, token=False)
            suffix = "\n这份修改稿独立保留。🌊"
            payload = {"version": 0, "canonicalFingerprint": current["canonicalFingerprint"],
                       "baseline": current["canonical"], "draft": {"title": "修订章名", "body": chapter["body"] + suffix}}
            draft = request(path, "PUT", payload)
            assert draft["draft"]["version"] == 1 and not draft["stale"]
            assert request(book_path) == original, "An independent draft must not write canonical text or revision"
            assert request("/api/home")["totals"]["todayChars"] == 0
            request(path, "PUT", payload, expected=409)
            request(path, "PUT", payload, expected=403, token=False)
            datetime.fromisoformat(draft["draft"]["updatedAt"])
            service.stop()
            # Context managers alone do not close sqlite3 readers on Windows.
            with closing(sqlite3.connect(str(data / "writer.sqlite3"))) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(comparison_drafts)")}
                assert {"book_id", "chapter_id", "baseline_body", "draft_body", "canonical_fingerprint", "version", "updated_at"} <= columns
                stored = conn.execute("SELECT baseline_body,draft_body,version FROM comparison_drafts WHERE book_id=? AND chapter_id=?", (book_id, chapter["id"])).fetchone()
                assert stored == (chapter["body"], payload["draft"]["body"], 1)

            service.start()
            assert request(path) == draft, "Both halves and their original checkpoint must survive restart"
            apply_data = {"version": draft["draft"]["version"], "canonicalFingerprint": draft["draft"]["canonicalFingerprint"], "revision": original["revision"]}
            request(path + "/apply", "POST", apply_data, expected=403, token=False)
            applied = request(path + "/apply", "POST", apply_data)
            assert applied["book"]["chapters"][0]["body"] == payload["draft"]["body"]
            assert applied["book"]["chapters"][0]["title"] == "修订章名"
            assert applied["comparison"]["baseline"] == payload["baseline"]
            assert applied["comparison"]["draft"] == payload["draft"]
            assert applied["comparison"]["version"] == 2
            history = request(book_path + "/history/" + str(original["revision"]))
            assert history["book"]["chapters"][0]["body"] == chapter["body"]
            assert applied["book"]["reviewTools"] == original["book"]["reviewTools"], "Appending prose must preserve existing paragraph anchors"
            expected_added = sum(not char.isspace() for char in suffix)
            assert request("/api/home")["totals"]["todayChars"] == expected_added
            request(path + "/apply", "POST", apply_data, expected=409)
            service.stop()

            service.start()
            restored = request(path)
            assert restored["draft"] == applied["comparison"] and not restored["stale"]
            assert request(book_path)["book"]["chapters"][0]["body"] == payload["draft"]["body"]
            assert request("/api/home")["totals"]["todayChars"] == expected_added
            # The same packaged module handles a continuous short manuscript.
            short = request("/api/books", "POST", {"title": "短篇对照验收", "kind": "short"}, expected=201)
            short_id = short["book"]["id"]
            short_book_path = "/api/books/" + short_id
            short_path = short_book_path + "/chapters/" + short["book"]["chapters"][0]["id"] + "/comparison"
            short_current = request(short_path)
            short_pair = {"title": "正文", "body": "短篇独立修改稿。\n\n第二段保留。"}
            short_draft = request(short_path, "PUT", {"version": 0, "canonicalFingerprint": short_current["canonicalFingerprint"], "baseline": short_current["canonical"], "draft": short_pair})
            assert request(short_book_path)["book"]["chapters"][0]["body"] == ""
            short_applied = request(short_path + "/apply", "POST", {"version": short_draft["draft"]["version"], "canonicalFingerprint": short_draft["draft"]["canonicalFingerprint"], "revision": short["revision"]})
            assert short_applied["book"]["volumes"] == [] and len(short_applied["book"]["chapters"]) == 1
            assert short_applied["book"]["chapters"][0]["body"] == short_pair["body"]
            # Permanent removal must not leave a second manuscript in the table.
            applied["book"]["chapters"][0]["deletedAt"] = datetime.now(timezone.utc).isoformat()
            deleted = request(book_path, "PUT", {"book": applied["book"], "revision": applied["revision"]})
            purged = request(chapter_path + "/purge", "POST", {"revision": deleted["revision"]})
            assert not purged.get("cleanupPending"), purged
            request(path, expected=404)
            trashed = request(short_book_path + "/trash", "POST", {"revision": short_applied["revision"]})
            request(short_book_path + "/purge", "POST", {"revision": trashed["revision"]})
            request(short_path, expected=404)
            service.stop()
            with closing(sqlite3.connect(str(data / "writer.sqlite3"))) as conn:
                assert conn.execute("SELECT COUNT(*) FROM comparison_drafts").fetchone()[0] == 0
        finally:
            service.stop(check_exit=False)
        assert hashlib.sha256(EXAMPLE.read_bytes()).hexdigest() == example_hash
    print("Native comparison verified: frozen schema, 101506-character example, independent pair, restart, explicit apply, CAS/auth, short manuscript and purge")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", type=Path)
    arguments = parser.parse_args()
    verify(arguments.service.resolve() if arguments.service else None)
