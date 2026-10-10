"""Writing skills use disposable libraries and a loopback AI stub, never a real key."""
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from skills import SkillsService, SkillError, SKILL_IDS, MODES, _tree, MAX_FILE
from ai_service import AIService, AIError, _compact
from verify_ai import Stub, SAMPLE


def write(file, content):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")


def fixture(home):
    for skill_id in SKILL_IDS:
        root = home / "skills" / skill_id
        write(root / "SKILL.md", "---\nname: " + skill_id + "\ndescription: |\n  本机测试写作技能\nmetadata:\n  ignored: not description\n---\n# " + skill_id + "\n")
        write(root / "scripts" / "never-run.py", "raise RuntimeError('must never execute')")
    novelist = home / "skills/chinese-novelist"
    write(novelist / "references/flows/phase3-writing.md", "章写作 [章法](../guides/chapter-guide.md) [别的阶段](phase0-initialization.md)")
    write(novelist / "references/flows/phase0-initialization.md", "UNRELATED INITIALIZATION")
    write(novelist / "references/flows/phase2-planning.md", "规划 [大纲](../guides/outline-template.md)")
    write(novelist / "references/flows/phase4-validation.md", "检查正文")
    write(novelist / "references/guides/chapter-guide.md", "章法 [对白](dialogue-writing.md) [多层](nested/extra.md) [外网](https://example.invalid/private.md)")
    write(novelist / "references/guides/nested/extra.md", "嵌套参考 [循环](../chapter-guide.md)")
    for name in ["dialogue-writing", "outline-template", "character-building", "character-template"]:
        write(novelist / ("references/guides/" + name + ".md"), name)
    for title in ["章节", "续写", "润色", "大纲", "角色", "检查", "新建"]:
        write(home / ("skills/novelskill/references/小说-" + title + ".md"), title + " 模式参考")
    for name in ["fiction", "revision", "forum-prose", "reality", "formats"]:
        write(home / ("skills/human-writing/references/" + name + ".md"), name + " 规则")


class SkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = "http://127.0.0.1:" + str(cls.http.server_port) + "/v1"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="writer-skills-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "codex"
        fixture(self.home)
        self.environment = patch.dict(os.environ, {"CODEX_HOME": str(self.home)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.service = SkillsService(self.root / "data")
        self.ai = AIService(self.root / "data")
        self.book = copy.deepcopy(SAMPLE)
        self.ids = [self.book["chapters"][0]["id"]]
        Stub.mode, Stub.reply, Stub.received = "draft", None, []

    def test_discovery_is_local_read_only_and_does_not_import_or_send(self):
        result = self.service.list()
        self.assertEqual(result["defaults"], {"skillIds": [], "skillMode": "auto"})
        self.assertTrue(all(item["available"] and not item["imported"] for item in result["skills"]))
        self.assertEqual(result["skills"][0]["description"], "本机测试写作技能")
        self.assertFalse(self.service.data_dir.exists())
        self.assertEqual(Stub.received, [])
        with self.assertRaises(SkillError) as error:
            self.service.detail("novelskill")
        self.assertEqual(error.exception.status, 404)

    def test_import_detail_refresh_and_mode_specific_recursive_references(self):
        before = _tree(self.home / "skills/chinese-novelist")
        result = self.service.import_skills(list(SKILL_IDS))
        self.assertTrue(all(item["imported"] for item in result["skills"]))
        self.assertEqual(_tree(self.home / "skills/chinese-novelist"), before)
        self.assertFalse((self.service.library / "chinese-novelist/scripts").exists())
        detail = self.service.detail("novelskill")
        self.assertTrue(detail["content"].startswith("---"))
        self.assertTrue(all(file["path"].startswith("references/") for file in detail["files"]))
        for mode in MODES[1:]:
            selected, _, _ = self.service.selected("draft", list(SKILL_IDS), mode)
            self.assertEqual(len(selected), 3)
            self.assertTrue(all(item["mode"] == mode for item in selected))
        chosen = self.service.selected("draft", list(SKILL_IDS))[0]
        names = {file["path"] for file in chosen[0]["files"]}
        self.assertIn("references/guides/nested/extra.md", names)
        self.assertNotIn("references/flows/phase0-initialization.md", names)
        self.assertNotIn("references/reality.md", {file["path"] for file in chosen[2]["files"]})
        self.assertIn("references/revision.md", {file["path"] for file in chosen[2]["files"]})
        source = self.home / "skills/novelskill/references/小说-章节.md"
        source.write_text("更新参考", encoding="utf-8")
        self.assertTrue(next(item for item in self.service.list()["skills"] if item["id"] == "novelskill")["sourceChanged"])
        self.assertNotIn("更新参考", json.dumps(self.service.detail("novelskill"), ensure_ascii=False))
        self.service.import_skills(["novelskill"])
        self.assertIn("更新参考", json.dumps(self.service.detail("novelskill"), ensure_ascii=False))
        shutil.rmtree(self.home / "skills/novelskill")
        status = next(item for item in self.service.list()["skills"] if item["id"] == "novelskill")
        self.assertFalse(status["available"])
        self.assertTrue(status["imported"])
        self.assertTrue(self.service.detail("novelskill")["imported"])

    def test_defaults_and_explicit_override_validate_selection_and_modes(self):
        for value in [["unknown"], ["../novelskill"], ["novelskill", "novelskill"], "novelskill", [None]]:
            with self.assertRaises(SkillError):
                self.service.import_skills(value)
        with self.assertRaises(SkillError):
            self.service.save_settings({"skillIds": ["novelskill"], "skillMode": "auto"})
        self.service.import_skills(list(SKILL_IDS))
        self.service.save_settings({"skillIds": ["novelskill"], "skillMode": "continue"})
        self.assertEqual(self.service.selected("draft")[0][0]["mode"], "continue")
        self.assertEqual(self.service.selected("draft", [])[0], [])
        self.assertEqual(self.service.selected("relationships", ["human-writing"], "auto")[0][0]["mode"], "characters")
        self.assertEqual(self.service.selected("consistency", ["novelskill"], "auto")[0][0]["mode"], "check")
        self.assertEqual(self.service.selected("outline", ["novelskill"], "auto")[0][0]["mode"], "outline")
        custom = self.service.selected("custom", ["novelskill"], "auto")[0][0]
        self.assertEqual(custom["mode"], "custom")
        self.assertEqual([file["path"] for file in custom["files"]], ["SKILL.md"])
        cover = self.service.selected("book_cover", ["novelskill"], "auto")[0][0]
        self.assertEqual(cover["mode"], "custom")
        self.assertEqual([file["path"] for file in cover["files"]], ["SKILL.md"])
        self.assertEqual(len(self.service.selected("custom", ["novelskill"], "outline")[0][0]["files"]), 2)
        for data in [{"skillIds": [], "skillMode": "bad"}, {"skillIds": []}, {"skillIds": [], "skillMode": "auto", "path": "/tmp"}]:
            with self.assertRaises(SkillError):
                self.service.save_settings(data)

    def test_symlinks_escape_and_oversize_are_rejected_without_source_or_library_damage(self):
        self.service.import_skills(["novelskill"])
        old = self.service.detail("novelskill")
        source = self.home / "skills/novelskill"
        write(source / "references/escape.md", "[escape](../../private.md)")
        with self.assertRaises(SkillError):
            self.service.import_skills(["novelskill"])
        self.assertEqual(self.service.detail("novelskill"), old)
        (source / "references/escape.md").unlink()
        link = source / "references/link.md"
        link.symlink_to(source / "SKILL.md")
        with self.assertRaises(SkillError):
            self.service.import_skills(["novelskill"])
        link.unlink()
        write(source / "references/large.md", "x" * (MAX_FILE + 1))
        with self.assertRaises(SkillError):
            self.service.import_skills(["novelskill"])
        self.assertEqual(self.service.detail("novelskill"), old)

    def test_unavailable_nofollow_is_supported_and_unsafe_settings_errors_are_localized(self):
        original = getattr(os, "O_NOFOLLOW", None)
        if original is not None:
            del os.O_NOFOLLOW
        try:
            self.service.import_skills(["novelskill"])
        finally:
            if original is not None:
                os.O_NOFOLLOW = original
        write(self.service.settings_path, "malformed private config")
        with self.assertRaises(SkillError) as error:
            self.service.list()
        self.assertNotIn("malformed private config", error.exception.message)
        self.assertNotIn(str(self.root), error.exception.message)

    def test_failed_import_and_failed_rollback_preserve_previous_recoverable_copy(self):
        self.service.import_skills(["novelskill"])
        original = Path.rename
        def fail_rename(file, target):
            if file.name.startswith((".import-", ".previous-")):
                raise OSError("private failure path")
            return original(file, target)
        with patch.object(Path, "rename", fail_rename):
            with self.assertRaises(SkillError):
                self.service.import_skills(["novelskill"])
        copies = list(self.service.library.glob(".previous-*"))
        self.assertEqual(len(copies), 1)
        self.assertTrue((copies[0] / "SKILL.md").is_file())

    def test_preview_counts_exact_sent_context_defaults_and_json_priority(self):
        self.service.import_skills(list(SKILL_IDS))
        self.service.save_settings({"skillIds": ["human-writing"], "skillMode": "auto"})
        self.ai.save_settings({"enabled": True, "endpoint": self.endpoint, "model": "stub-model"})
        baseline = self.ai.preview(self.book, "draft", self.ids, skill_ids=[])
        preview = self.ai.preview(self.book, "draft", self.ids)
        self.assertEqual(preview["selectedSkillIds"], ["human-writing"])
        self.assertEqual(preview["skills"][0]["mode"], "chapter")
        self.assertGreater(preview["contextChars"], baseline["contextChars"])
        selected = self.service.selected("draft")[0]
        self.assertEqual(preview["skillChars"], sum(len(file["content"]) for item in selected for file in item["files"]))
        self.assertEqual(Stub.received, [])
        before_book = copy.deepcopy(self.book)
        result = self.ai.run(self.book, "draft", self.ids)
        messages = Stub.received[-1]["payload"]["messages"]
        self.assertEqual(len(messages[1]["content"]), preview["contextChars"])
        self.assertEqual(result["contextChars"], preview["contextChars"])
        self.assertIn("JSON", messages[0]["content"])
        self.assertIn("用户当前要求优先", messages[0]["content"])
        self.assertIn("不运行技能脚本", messages[0]["content"])
        self.assertIn("自查", messages[0]["content"])
        self.assertEqual(self.book, before_book)
        self.ai.run(self.book, "draft", self.ids, skill_ids=[])
        self.assertNotIn("writingSkills", json.loads(Stub.received[-1]["payload"]["messages"][1]["content"]))
        count = len(Stub.received)
        self.ai.save_settings({"contextMode": "manual", "maxContextChars": baseline["contextChars"]})
        self.assertTrue(self.ai.preview(self.book, "draft", self.ids)["overLimit"])
        with self.assertRaises(AIError):
            self.ai.run(self.book, "draft", self.ids)
        self.assertEqual(len(Stub.received), count)

    def test_real_http_skill_routes_and_ai_override_contract(self):
        import server as app
        previous = app.DB_PATH, app.DESKTOP_TOKEN
        app.DB_PATH, app.DESKTOP_TOKEN = self.root / "http-data/writer.sqlite3", ""
        class Quiet(app.Handler):
            def log_message(self, *args):
                pass
        http = None
        try:
            app.initialize()
            http = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            def request(path, method="GET", data=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request("http://127.0.0.1:" + str(http.server_port) + path, data=body, method=method,
                                             headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            self.assertEqual(request("/api/skills")[0], 200)
            self.assertEqual(request("/api/skills/novelskill")[0], 404)
            self.assertEqual(request("/api/skills/import", "POST", {"skillIds": list(SKILL_IDS)})[0], 200)
            self.assertEqual(request("/api/skills/novelskill")[0], 200)
            self.assertEqual(request("/api/skills/..%2F..%2Fprivate")[0], 400)
            self.assertEqual(request("/api/skills/import", "POST", {"skillIds": [], "path": str(self.home)})[0], 400)
            self.assertEqual(request("/api/skills/settings", "PUT", {"skillIds": ["novelskill"], "skillMode": "continue"})[0], 200)
            self.assertEqual(request("/api/skills")[1]["defaults"]["skillMode"], "continue")
            books = request("/api/books")[1]["books"]
            book_id = next(book["id"] for book in books if book["charCount"] == 101506)
            book = request("/api/books/" + book_id)[1]["book"]
            body = {"action": "draft", "chapterIds": [book["chapters"][0]["id"]]}
            path = "/api/books/" + book_id + "/ai"
            preview = request(path + "/preview", "POST", body)[1]
            self.assertEqual(preview["skills"][0]["mode"], "continue")
            self.assertEqual(request(path + "/preview", "POST", {**body, "skillIds": []})[1]["skills"], [])
            self.assertEqual(request(path + "/preview", "POST", {**body, "skillIds": ["unknown"]})[0], 400)
            self.assertEqual(request(path + "/preview", "POST", {**body, "skillIds": None})[0], 400)
            self.assertEqual(request("/api/ai/settings", "PUT", {"enabled": True, "endpoint": self.endpoint, "model": "stub-model"})[0], 200)
            self.assertEqual(request(path, "POST", {**body, "skillMode": "polish"})[1]["skills"][0]["mode"], "polish")
            self.assertEqual(request("/api/books/" + book_id)[1]["book"], book)
        finally:
            if http:
                http.shutdown()
                http.server_close()
                thread.join()
            app.DB_PATH, app.DESKTOP_TOKEN = previous


class InstalledSkillTests(unittest.TestCase):
    def test_installed_three_skills_all_modes_with_read_only_sources(self):
        source = Path.home() / ".codex/skills"
        if not all((source / skill_id / "SKILL.md").is_file() for skill_id in SKILL_IDS):
            self.skipTest("Optional installed writing skills are not present")
        before = {skill_id: _tree(source / skill_id) for skill_id in SKILL_IDS}
        with tempfile.TemporaryDirectory(prefix="writer-real-skills-") as temp:
            service = SkillsService(Path(temp) / "data", codex_home=source.parent)
            service.import_skills(list(SKILL_IDS))
            for mode in MODES[1:]:
                selected = service.selected("draft", list(SKILL_IDS), mode)[0]
                self.assertEqual(len(selected), 3)
                for item in selected:
                    self.assertTrue(item["files"])
                    self.assertTrue(all(file["path"] in before[item["id"]] for file in item["files"]))
            self.assertEqual(before, {skill_id: _tree(source / skill_id) for skill_id in SKILL_IDS})


if __name__ == "__main__":
    unittest.main(verbosity=2)
