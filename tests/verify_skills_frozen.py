"""Exercise portable writing skills in a clean source or frozen desktop service.

Every run has an empty CODEX_HOME and a disposable library. No existing skill,
manuscript, provider key or application installation is opened by this test.
"""
import argparse
import copy
from http.server import BaseHTTPRequestHandler
import hashlib
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

from http_fixtures import LoopbackHTTPServer


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/tide-archive.yejian.json"
BUILTINS = ("chinese-novelist", "novelskill", "human-writing")
MODES = ("chapter", "continue", "polish", "outline", "characters", "check")
FAKE_KEY = "portable-skills-fixture-not-a-real-key"


class WritingProvider(BaseHTTPRequestHandler):
    received = []
    reply = {"title": "隔离候选", "body": "这段候选不应保存到作品。"}

    def log_message(self, *args):
        pass

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).received.append({"payload": value, "authorization": self.headers.get("Authorization")})
        answer = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(type(self).reply, ensure_ascii=False)}}]}
        content = json.dumps(answer, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


class CleanDesktopService:
    def __init__(self, root, executable=None):
        self.root, self.executable = root, executable
        self.data = root / "library"
        self.codex = root / "empty-codex-home"
        self.data.mkdir()
        self.codex.mkdir()
        self.token = uuid.uuid4().hex
        self.process = self.errors = self.reader = None

    def diagnostics(self):
        if self.errors is None:
            return ""
        self.errors.seek(0)
        return self.errors.read().decode("utf-8", errors="replace")[-12000:]

    def start(self):
        assert self.process is None, "Stop the previous service before restarting"
        command = [str(self.executable)] if self.executable else [sys.executable, str(ROOT / "server.py")]
        self.errors = open(self.root / ("skills-service-" + uuid.uuid4().hex + ".log"), "w+b")
        self.process = subprocess.Popen(command + ["--desktop", "--port", "0", "--data-dir", str(self.data)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding="utf-8", cwd=ROOT,
            env={**os.environ, "CODEX_HOME": str(self.codex), "WRITER_DESKTOP_TOKEN": self.token,
                 "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
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
        diagnostic = ""
        try:
            if self.process is not None:
                process, self.process = self.process, None
                if process.stdin is not None:
                    process.stdin.close()
                    process.stdin = None
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    error = "Desktop service did not stop on stdin EOF"
                    process.terminate()
                    try:
                        process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=5)
                if process.returncode != 0:
                    error = error or "Desktop service exit status: " + str(process.returncode)
                if self.reader is not None:
                    self.reader.join(timeout=1)
                    self.reader = None
            if error:
                diagnostic = self.diagnostics()
        finally:
            if self.errors is not None:
                self.errors.close()
                self.errors = None
        if error and check_exit:
            raise AssertionError(error + "\n" + diagnostic)

    def request(self, path, method="GET", value=None, expected=200, token=True, client=True, origin=None):
        headers = {"Content-Type": "application/json", "X-Writer-Client": "1", "Origin": self.url}
        if not client:
            headers.pop("X-Writer-Client")
        if origin is not None:
            headers["Origin"] = origin
        if token:
            headers["X-Writer-Desktop"] = self.token
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
        request = urllib.request.Request(self.url + path, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as problem:
            status, raw = problem.code, problem.read()
        allowed = expected if isinstance(expected, tuple) else (expected,)
        assert status in allowed, (method, path, status, raw[:700])
        return json.loads(raw)


def mutable_skill(detail, **changes):
    """Only the editable contract is echoed; listing metadata is never input."""
    return {"name": detail["name"], "description": detail["description"], "content": detail["content"],
            "files": copy.deepcopy(detail.get("files", [])), "revision": detail["revision"], **changes}


def verify(executable=None):
    canonical_hash = hashlib.sha256(EXAMPLE.read_bytes()).hexdigest()
    WritingProvider.received = []
    provider = LoopbackHTTPServer(("127.0.0.1", 0), WritingProvider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    endpoint = "http://127.0.0.1:" + str(provider.server_port) + "/v1"
    groups = []
    try:
        with tempfile.TemporaryDirectory(prefix="writer-portable-skills-") as temporary:
            service = CleanDesktopService(Path(temporary).resolve(), executable)
            try:
                service.start()
                request = service.request
                initial = request("/api/skills")
                assert initial["defaults"] == {"skillIds": [], "skillMode": "auto"}
                skills = {item["id"]: item for item in initial["skills"]}
                assert set(skills) == set(BUILTINS)
                assert all(skills[item]["usable"] and skills[item]["builtin"] and skills[item]["origin"] == "builtin"
                           and not skills[item]["available"] for item in BUILTINS)
                assert not list(service.codex.iterdir()), "Discovering built-ins must not install or modify Codex"
                details = {item: request("/api/skills/" + item) for item in BUILTINS}
                for detail in details.values():
                    assert detail["content"].strip()
                    assert isinstance(detail["files"], list)
                request("/api/skills", expected=403, token=False)
                groups.append("clean-machine built-ins without Codex")

                shelf = request("/api/books")["books"]
                book_id = next(item["id"] for item in shelf if item["charCount"] == 101506)
                book_path = "/api/books/" + book_id
                unchanged_book = request(book_path)
                chapter_id = unchanged_book["book"]["chapters"][0]["id"]
                request("/api/ai/settings", "PUT", {"enabled": True, "endpoint": endpoint, "model": "isolated-model", "apiKey": FAKE_KEY})
                plain = {"action": "draft", "chapterIds": [chapter_id], "instruction": "只返回候选，不采用。", "skillIds": [], "skillMode": "auto"}
                empty = request(book_path + "/ai/preview", "POST", plain)
                assert empty["skills"] == [] and empty["skillChars"] == 0
                assert WritingProvider.received == [], "A preview must never call a provider"
                for skill_id in BUILTINS:
                    files = {"SKILL.md": details[skill_id]["content"], **{item["path"]: item["content"] for item in details[skill_id]["files"]}}
                    for mode in MODES:
                        payload = {**plain, "skillIds": [skill_id], "skillMode": mode}
                        count = len(WritingProvider.received)
                        preview = request(book_path + "/ai/preview", "POST", payload)
                        assert len(WritingProvider.received) == count
                        selected = preview["skills"]
                        assert len(selected) == 1 and selected[0]["id"] == skill_id and selected[0]["mode"] == mode
                        assert "SKILL.md" in selected[0]["files"] and len(selected[0]["files"]) > 1
                        assert preview["skillChars"] == sum(len(files[name]) for name in selected[0]["files"])
                        result = request(book_path + "/ai", "POST", payload)
                        received = WritingProvider.received[-1]
                        assert received["authorization"] == "Bearer " + FAKE_KEY
                        messages = received["payload"]["messages"]
                        context = json.loads(messages[1]["content"])
                        supplied = context["writingSkills"][0]
                        assert supplied["id"] == skill_id and supplied["mode"] == mode
                        assert {item["path"]: item["content"] for item in supplied["files"]} == {name: files[name] for name in selected[0]["files"]}
                        assert len(messages[1]["content"]) == preview["contextChars"] == result["contextChars"]
                        assert "不运行技能脚本" in messages[0]["content"]
                assert request(book_path) == unchanged_book, "Testing all skills must not adopt prose candidates"
                assert request("/api/home")["totals"]["todayChars"] == 0
                groups.append("three built-ins, six modes, exact preview and provider context")

                content = "---\nname: 群像对白\ndescription: 保持人物声音\n---\n# 群像对白\n按人物目标写对白。[对白规则](references/dialogue.md)\n"
                create_data = {"name": "群像对白", "description": "保持人物声音", "content": content,
                               "files": [{"path": "references/dialogue.md", "content": "每个人物有独立的措辞与行动。[场景规则](flows/scenes.md)"},
                                         {"path": "references/flows/scenes.md", "content": "在场景压力中检验对白，保留人物信息边界。"}]}
                created = request("/api/skills/custom", "POST", create_data, expected=(200, 201))
                custom_id = created["skill"]["id"]
                assert custom_id.startswith("custom-")
                detail = request("/api/skills/" + custom_id)
                assert detail["content"] == content and detail["name"] == create_data["name"]
                assert detail["files"] == create_data["files"]
                request("/api/skills/settings", "PUT", {"skillIds": [custom_id, BUILTINS[0]], "skillMode": "polish"})
                inherited = request(book_path + "/ai/preview", "POST", {key: value for key, value in plain.items() if key not in ("skillIds", "skillMode")})
                assert inherited["selectedSkillIds"] == [custom_id, BUILTINS[0]]
                assert inherited["skillMode"] == "polish"
                inherited_payload = {key: value for key, value in plain.items() if key not in ("skillIds", "skillMode")}
                actual = request(book_path + "/ai", "POST", inherited_payload)
                sent = json.loads(WritingProvider.received[-1]["payload"]["messages"][1]["content"])["writingSkills"]
                assert [item["id"] for item in sent] == inherited["selectedSkillIds"]
                assert next(item for item in sent if item["id"] == custom_id)["files"] == [
                    {"path": "SKILL.md", "content": content}, *create_data["files"]]
                assert actual["contextChars"] == inherited["contextChars"]
                assert request(book_path + "/ai/preview", "POST", plain)["skills"] == [], "Explicit empty selection must override saved defaults"
                request("/api/skills/custom", "POST", create_data, expected=403, token=False)
                request("/api/skills/custom", "POST", create_data, expected=403, client=False)
                request("/api/skills/custom", "POST", create_data, expected=403, origin="https://foreign.example.invalid")
                request("/api/skills/" + custom_id, "PUT", mutable_skill(detail), expected=403, token=False)
                request("/api/skills/" + custom_id, "DELETE", {"revision": detail["revision"]}, expected=403, token=False)
                groups.append("custom create, reference selection, defaults and desktop authorization")

                exported = request("/api/skills/" + custom_id + "/export")
                request("/api/skills/" + custom_id + "/export", expected=403, token=False)
                assert exported["format"] == "writer-desk-skill" and exported["version"] == 1
                assert exported["content"] == content and exported["files"] == create_data["files"]
                assert not ({"id", "revision", "apiKey", "book", "chapters"} & set(exported))
                encoded_export = json.dumps(exported, ensure_ascii=False)
                assert FAKE_KEY not in encoded_export
                assert unchanged_book["book"]["title"] not in encoded_export
                assert unchanged_book["book"]["chapters"][0]["body"][:40] not in encoded_export
                before_import_preview = request("/api/skills")
                imported_preview = request("/api/skills/import-file", "POST", {"fileName": "群像对白.json", "content": encoded_export, "preview": True})
                assert imported_preview["draft"] == create_data
                markdown_preview = request("/api/skills/import-file", "POST", {"fileName": "独立规则.md", "content": "# 独立规则\n只提供候选。", "preview": True})
                assert markdown_preview["draft"]["content"] == "# 独立规则\n只提供候选。"
                assert request("/api/skills") == before_import_preview, "Import preview must not register or select a skill"
                imported = request("/api/skills/import-file", "POST", {"fileName": "群像对白.json", "content": encoded_export}, expected=(200, 201))
                imported_id = imported["skill"]["id"]
                assert imported_id != custom_id
                assert request("/api/skills/" + imported_id + "/export") == exported
                markdown = request("/api/skills/import-file", "POST", {"fileName": "独立规则.md", "content": "# 独立规则\n只提供候选。"}, expected=(200, 201))
                assert request("/api/skills/" + markdown["skill"]["id"])["content"] == "# 独立规则\n只提供候选。"
                invalid = copy.deepcopy(create_data)
                invalid["files"] = [{"path": "../../private.md", "content": "越界参考"}]
                before_invalid = request("/api/skills")
                request("/api/skills/custom", "POST", invalid, expected=400)
                assert request("/api/skills") == before_invalid
                groups.append("portable Markdown and JSON import/export without manuscripts or secrets")

                updated_content = content + "\n修改后先核对人物已经掌握的信息。"
                changed = request("/api/skills/" + custom_id, "PUT", mutable_skill(detail, content=updated_content))
                changed_detail = request("/api/skills/" + custom_id)
                assert changed["skill"]["id"] == custom_id and changed_detail["content"] == updated_content
                assert changed_detail["revision"] != detail["revision"]
                request("/api/skills/" + custom_id, "PUT", mutable_skill(detail), expected=409)
                service.stop()
                service.start()
                assert request("/api/skills/" + custom_id) == changed_detail
                assert request("/api/skills")["defaults"] == {"skillIds": [custom_id, BUILTINS[0]], "skillMode": "polish"}
                assert all(item["usable"] for item in request("/api/skills")["skills"] if item["id"] in BUILTINS)
                groups.append("revision conflict and restart persistence")

                builtin_detail = request("/api/skills/" + BUILTINS[0])
                override = builtin_detail["content"] + "\n作者在 App 中保存的专属规则。"
                request("/api/skills/" + BUILTINS[0], "PUT", mutable_skill(builtin_detail, content=override))
                local_builtin = request("/api/skills/" + BUILTINS[0])
                assert local_builtin["content"] == override
                service.stop()
                service.start()
                assert request("/api/skills/" + BUILTINS[0])["content"] == override
                request("/api/skills/" + BUILTINS[0], "DELETE", {"revision": local_builtin["revision"]})
                assert request("/api/skills/" + BUILTINS[0])["content"] == builtin_detail["content"]
                assert next(item for item in request("/api/skills")["skills"] if item["id"] == BUILTINS[0])["origin"] == "builtin"
                groups.append("built-in local override survives restart and reset returns bundled rules")

                generation = {"name": "生成的规则", "description": "候选，不自动启用", "content": "# 生成的规则\n先写人物行动，再检查因果。"}
                WritingProvider.reply = generation
                before_generation = request("/api/skills")
                before_ai_settings = request("/api/ai/settings")
                candidate = request("/api/skills/generate", "POST", {"prompt": "请制作一份以人物行动为主的写作 Skill。",
                                    "model": "skill-preview-model", "profileId": before_ai_settings["activeProfileId"]})
                assert all(candidate[key] == generation[key] for key in generation) and candidate["files"] == []
                assert request("/api/skills") == before_generation, "AI generation must remain an unregistered candidate"
                assert request("/api/ai/settings") == before_ai_settings, "A preview's model/profile choice must not modify AI settings"
                assert WritingProvider.received[-1]["payload"]["model"] == "skill-preview-model"
                generated_request = json.dumps(WritingProvider.received[-1]["payload"], ensure_ascii=False)
                assert FAKE_KEY not in generated_request
                assert unchanged_book["book"]["title"] not in generated_request
                assert unchanged_book["book"]["chapters"][0]["body"][:40] not in generated_request
                assert request(book_path) == unchanged_book
                request("/api/skills/generate", "POST", {"prompt": "新的规则"}, expected=403, token=False)
                request("/api/skills/" + custom_id, "DELETE", {"revision": changed_detail["revision"]})
                request("/api/skills/" + custom_id, expected=404)
                assert custom_id not in request("/api/skills")["defaults"]["skillIds"]
                service.stop()
                service.start()
                request("/api/skills/" + custom_id, expected=404)
                assert custom_id not in request("/api/skills")["defaults"]["skillIds"]
                assert request(book_path) == unchanged_book
                assert not list(service.codex.iterdir())
                groups.append("AI preview-only generation, deletion and no manuscript mutation")
            finally:
                service.stop(check_exit=False)
            assert hashlib.sha256(EXAMPLE.read_bytes()).hexdigest() == canonical_hash
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)
    print(json.dumps({"passed": True, "service": "frozen" if executable else "source", "groups": groups,
                      "builtinSkills": len(BUILTINS), "modeRequests": len(BUILTINS) * len(MODES),
                      "exampleCharacters": 101506}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", type=Path)
    arguments = parser.parse_args()
    verify(arguments.service.resolve() if arguments.service else None)
