#!/usr/bin/env python3
"""Exercise only disposable data with the packaged native service and desktop."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import plistlib
import queue
import secrets
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class Process:
    def __init__(self, command, environment):
        self.lines, self.log = queue.Queue(), []
        self.child = subprocess.Popen(command, env=environment, cwd=ROOT,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, encoding="utf-8", errors="replace", start_new_session=sys.platform != "win32")
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.child.stdout:
            self.log.append(line.rstrip())
            self.lines.put(line.rstrip())

    def until(self, predicate, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=min(0.5, max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                if self.child.poll() is not None:
                    raise RuntimeError("Native process exited before ready:\n" + "\n".join(self.log[-40:]))
                continue
            result = predicate(line)
            if result:
                return result
        raise RuntimeError("Native process timed out:\n" + "\n".join(self.log[-40:]))

    def stop_service(self):
        self.child.stdin.close()
        self.child.wait(timeout=15)
        if self.child.returncode != 0:
            raise RuntimeError("Service did not stop cleanly:\n" + "\n".join(self.log[-40:]))

    def cleanup(self):
        # Only this smoke test's isolated process tree is terminated, never an installed app.
        if sys.platform == "win32":
            if self.child.poll() is None:
                subprocess.run(["taskkill", "/PID", str(self.child.pid), "/T", "/F"], capture_output=True, check=False)
        else:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if sys.platform != "win32":
                os.killpg(self.child.pid, signal.SIGKILL)
            else:
                self.child.kill()
            self.child.wait(timeout=10)
        self.reader.join(timeout=5)
        if self.child.stdout:
            self.child.stdout.close()
        if self.child.stdin and not self.child.stdin.closed:
            self.child.stdin.close()


def locate_app(executable=None):
    if executable:
        executable = executable.resolve()
        backend = executable.parent.parent / "Resources/backend" if sys.platform == "darwin" else executable.parent / "resources/backend"
        return executable, backend
    if sys.platform == "linux":
        return ROOT / "dist/linux-unpacked/writer-desk", ROOT / "dist/linux-unpacked/resources/backend"
    if sys.platform == "win32":
        return ROOT / "dist/win-unpacked/writer-desk.exe", ROOT / "dist/win-unpacked/resources/backend"
    candidates = sorted((ROOT / "dist").glob("mac*/*.app"))
    if len(candidates) != 1:
        raise RuntimeError("Expected exactly one native macOS app bundle in dist")
    contents = candidates[0] / "Contents"
    with (contents / "Info.plist").open("rb") as handle:
        executable = plistlib.load(handle)["CFBundleExecutable"]
    return contents / "MacOS" / executable, contents / "Resources/backend"


def service_smoke(backend, data):
    token = secrets.token_hex(32)
    executable = backend / ("writer-service.exe" if sys.platform == "win32" else "writer-service")
    metadata = json.loads((backend / "build-info.json").read_text("utf-8"))
    assert metadata["platform"] == sys.platform
    fixture_id = None
    marker = "跨平台保存检查 — 中文、emoji 🌙、换行\nsecond line\n"
    checks = []
    for attempt in range(2):
        process = Process([str(executable), "--desktop", "--port", "0", "--data-dir", str(data)],
                          {**os.environ, "WRITER_DESKTOP_TOKEN": token, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"})
        try:
            url = process.until(lambda line: json.loads(line[13:])["url"] if line.startswith("WRITER_READY ") else None)
            def request(path, method="GET", payload=None, authenticated=True):
                headers = {"Content-Type": "application/json", "X-Writer-Client": "1"}
                if authenticated:
                    headers["X-Writer-Desktop"] = token
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
                with urllib.request.urlopen(urllib.request.Request(url + path, body, headers, method=method), timeout=30) as response:
                    result = response.read()
                    return json.loads(result) if path.startswith("/api/") else result
            try:
                request("/api/books", authenticated=False)
                raise AssertionError("Unauthenticated request unexpectedly succeeded")
            except urllib.error.HTTPError as error:
                assert error.code == 403
            assert b"<!doctype html>" in request("/").lower()
            books = request("/api/books")["books"]
            demo_summary = next(book for book in books if book["title"] == "潮汐档案馆")
            demo = request("/api/books/" + urllib.parse.quote(demo_summary["id"], safe=""))["book"]
            assert len(demo["volumes"]) == 6 and len(demo["chapters"]) == 36
            assert sum(not character.isspace() for chapter in demo["chapters"] for character in chapter["body"]) == 101506
            if attempt == 0:
                fixture = request("/api/books", "POST", {"title": "跨平台检查", "kind": "short"})
                fixture_id = fixture["book"]["id"]
                fixture["book"]["chapters"][0]["body"] = marker
                route = "/api/books/" + urllib.parse.quote(fixture_id, safe="")
                saved = request(route, "PUT", {"book": fixture["book"], "revision": fixture["revision"]})
                assert saved["revision"] > fixture["revision"]
                folder = request(route + "/folder", "POST", {})
                assert marker in (Path(folder["folder"]) / "正文.txt").read_text("utf-8")
                assert "protectionWarning" not in saved and "folderWarning" not in saved
                checks.extend(["desktop authentication", "bundled frontend", "101506-character demo", "save and book folder"])
            else:
                restored = request("/api/books/" + urllib.parse.quote(fixture_id, safe=""))["book"]
                assert restored["chapters"][0]["body"] == marker
                checks.append("restart persistence")
            process.stop_service()
        finally:
            process.cleanup()
    return checks


def desktop_smoke(executable, data):
    environment = {**os.environ, "WRITER_DESK_USER_DATA": str(data), "PYTHONIOENCODING": "utf-8"}
    # Do not inherit development interpreter overrides or Electron's Node-only mode.
    for key in ("WRITER_DESK_PYTHON", "WRITER_DESKTOP_TOKEN", "ELECTRON_RUN_AS_NODE"):
        environment.pop(key, None)
    process = Process([str(executable)], environment)
    try:
        process.until(lambda line: "Desktop window loaded; local storage service is ready." in line)
        database = data / "data/writer.sqlite3"
        with closing(sqlite3.connect(database)) as connection:
            assert connection.execute("select count(*) from books").fetchone()[0] >= 3
        return ["native Electron window loaded", "packaged child service", "isolated desktop data seeded"]
    finally:
        process.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-only", action="store_true")
    parser.add_argument("--app", type=Path, help="Test an app extracted/installed from the installer")
    parser.add_argument("--report", type=Path, default=ROOT / "dist/native-smoke.json")
    args = parser.parse_args()
    executable, backend = locate_app(args.app)
    service = backend / ("writer-service.exe" if sys.platform == "win32" else "writer-service")
    subprocess.run([sys.executable, str(ROOT / "tests/verify_portable_library.py"), "--service", str(service)],
                   cwd=ROOT, check=True, env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}, timeout=180)
    with tempfile.TemporaryDirectory(prefix="writer-native-smoke-") as temporary:
        data = Path(temporary)
        checks = ["installed frozen service: folders, backups, images, chapter restore and purge"]
        checks += service_smoke(backend, data / "service")
        if not args.service_only:
            checks += desktop_smoke(executable, data / "desktop")
    metadata = json.loads((backend / "build-info.json").read_text("utf-8"))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({"platform": metadata["platform"], "arch": metadata["arch"],
                                       "version": metadata["version"], "checks": checks, "passed": True}, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"nativeSmokePassed": True, "checks": checks}, ensure_ascii=False))


if __name__ == "__main__":
    main()
