"""Exercise a real native/frozen save service in an isolated library.

Run `python tests/verify_portable_library.py` on each native runner, or pass
`--service <frozen executable>` after PyInstaller. No AI endpoint is contacted.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from verify_ai_cover import PNG


def verify(service=None):
    with tempfile.TemporaryDirectory(prefix="writer-native-library-") as temporary:
        data = Path(temporary).resolve() / "data"
        token = uuid.uuid4().hex
        # Keep a stack trace when a native runner blocks before WRITER_READY.
        # runpy changes only the test launcher, not the shipped service.
        diagnostic_launcher = (
            "import faulthandler,runpy,sys; "
            "faulthandler.dump_traceback_later(15); "
            "sys.argv=sys.argv[1:]; "
            "runpy.run_path(sys.argv[0],run_name='__main__')"
        )
        command = ([str(service)] if service else
                   [sys.executable, "-u", "-c", diagnostic_launcher, str(ROOT / "server.py")])
        command += ["--desktop", "--port", "0", "--data-dir", str(data)]
        env = {**os.environ, "WRITER_DESKTOP_TOKEN": token, "PYTHONUTF8": "1"}
        with open(Path(temporary) / "service.log", "w+b") as errors:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                       text=True, encoding="utf-8", env=env, cwd=ROOT)
            try:
                ready = queue.Queue()
                threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
                try:
                    line = ready.get(timeout=30)
                except queue.Empty:
                    raise AssertionError("Native service did not become ready in 30 seconds") from None
                assert line.startswith("WRITER_READY "), "Unexpected startup: " + repr(line)
                base = json.loads(line[len("WRITER_READY "):])["url"]

                def request(method, path, value=None, expected=200, binary=False):
                    payload = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
                    headers = {"X-Writer-Desktop": token, "X-Writer-Client": "1", "Origin": base,
                               "Content-Type": "application/json"}
                    try:
                        with urllib.request.urlopen(urllib.request.Request(base + path, payload, headers, method=method), timeout=20) as response:
                            status, raw = response.status, response.read()
                    except urllib.error.HTTPError as error:
                        status, raw = error.code, error.read()
                    assert status == expected, (method, path, status, raw.decode("utf-8", errors="replace")[:1000])
                    return raw if binary else json.loads(raw)

                for asset in ("/", "/work-plan.js", "/chapter-history.js", "/content-cleanup.js", "/gestures.js", "/gestures.css"):
                    assert request("GET", asset, binary=True), asset
                created = request("POST", "/api/books", {"title": "跨平台本机验收", "kind": "long"}, expected=201)
                assert "protectionWarning" not in created, created
                book, revision = created["book"], created["revision"]
                book_path = "/api/books/" + book["id"]
                secret = "待清理章节正文-" + uuid.uuid4().hex
                target = {"id": str(uuid.uuid4()), "title": "历史章节", "body": secret,
                          "volumeId": book["volumes"][0]["id"], "deletedAt": None}
                book["chapters"] = [target]
                survivor = {**target, "id": str(uuid.uuid4()), "title": "保留章节", "body": "保留正文🌙", "deletedAt": None}
                book["chapters"].append(survivor)
                saved = request("PUT", book_path, {"book": book, "revision": revision})
                revision = saved["revision"]
                assert "protectionWarning" not in saved, saved
                backup = request("POST", book_path + "/checkpoint", {})["backup"]
                assert backup and backup["token"]
                assert request("GET", book_path + "/backups")["backups"]
                folder = request("POST", book_path + "/folder", {})
                directory = Path(folder["folder"])
                assert directory.is_dir()
                assert secret in (directory / "作品.yejian.json").read_text("utf-8")
                image = request("POST", book_path + "/ai/images", {"name": "参考图片", "dataUrl": "data:image/png;base64," + PNG})
                assert request("GET", image["url"], binary=True) == base64.b64decode(PNG)
                target["deletedAt"] = "2026-10-12T01:02:03+00:00"
                saved = request("PUT", book_path, {"book": book, "revision": revision})
                revision = saved["revision"]
                chapter_path = book_path + "/chapters/" + target["id"]
                listed = request("GET", "/api/history/chapters")
                assert any(item["chapterId"] == target["id"] for item in listed["chapters"])
                assert request("GET", chapter_path + "/history")["chapter"]["body"] == secret
                restored = request("POST", chapter_path + "/restore", {"revision": revision})
                revision, book = restored["revision"], restored["book"]
                next(item for item in book["chapters"] if item["id"] == target["id"])["deletedAt"] = "2026-10-12T01:02:03+00:00"
                revision = request("PUT", book_path, {"book": book, "revision": revision})["revision"]
                purged = request("POST", chapter_path + "/purge", {"revision": revision})
                assert not purged.get("cleanupPending"), purged
                assert [item["body"] for item in purged["book"]["chapters"]] == ["保留正文🌙"]
                assert secret not in (directory / "作品.yejian.json").read_text("utf-8")
                assert secret not in json.dumps(request("GET", book_path + "/backups/" + backup["token"]), ensure_ascii=False)
                request("GET", image["url"], expected=404)
                journal = request("GET", "/api/history/chapter-purges")["purges"]
                assert any(item["bookId"] == book["id"] for item in journal)
                # The desktop's stdin pipe is the portable graceful-stop signal.
                process.stdin.close()
                process.wait(timeout=10)
                assert process.returncode == 0, process.returncode
                print("Native library verified: assets, save, backup, folder, images, history, restore, purge and EOF shutdown")
            except BaseException:
                print(f"Native service failure: pid={process.pid}, exit={process.poll()}, executable={command[0]}",
                      file=sys.stderr, flush=True)
                errors.seek(0)
                diagnostic = errors.read().decode("utf-8", errors="replace")[-12000:]
                print(diagnostic or "Native service stderr is empty.", file=sys.stderr, flush=True)
                raise
            finally:
                if process.poll() is None:
                    process.stdin.close()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.terminate()
                        process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", type=Path)
    verify(parser.parse_args().service)
