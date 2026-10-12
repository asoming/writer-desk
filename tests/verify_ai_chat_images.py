"""Image conversations use a loopback fake provider and isolated book storage."""
import base64
import copy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIService, AIError
from chat_images import ChatImageStore
from verify_ai import SAMPLE, FAKE_KEY
from verify_ai_cover import PNG, JPEG, WEBP
import server

PNG_URL = "data:image/png;base64," + PNG
JPEG_URL = "data:image/jpeg;base64," + JPEG


class ImageProvider(BaseHTTPRequestHandler):
    received = []
    message = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.received.append({"payload": payload, "path": self.path, "authorization": self.headers.get("Authorization")})
        body = json.dumps({"choices": [{"finish_reason": "stop", "message": self.message}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ChatImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.provider = ThreadingHTTPServer(("127.0.0.1", 0), ImageProvider)
        cls.thread = threading.Thread(target=cls.provider.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = "http://127.0.0.1:" + str(cls.provider.server_port) + "/v1"

    @classmethod
    def tearDownClass(cls):
        cls.provider.shutdown()
        cls.provider.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="writer-ai-images-")
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "data"
        environment = patch.dict(os.environ, {"CODEX_HOME": str(Path(self.directory.name) / "codex")})
        environment.start()
        self.addCleanup(environment.stop)
        self.service = AIService(self.data)
        self.service.save_settings({"enabled": True, "endpoint": self.endpoint, "model": "fake-vision", "apiKey": FAKE_KEY})
        self.book = copy.deepcopy(SAMPLE)
        self.store = ChatImageStore(self.data)
        self.image = self.store.save(self.book["id"], "参考图.png", PNG_URL)
        self.ref = {"id": self.image["id"], "name": self.image["name"]}
        ImageProvider.received = []
        self.reply({"reply": "可以参考画面中的色彩。", "data": None})

    def reply(self, value):
        ImageProvider.message = {"content": json.dumps(value, ensure_ascii=False)}

    def run_chat(self, instruction="参考图片，讨论故事。", **kwargs):
        return self.service.run(self.book, "custom", [], instruction, skill_ids=[], chat=True, history=kwargs.pop("history", []), **kwargs)

    def test_current_image_and_native_text_history_are_sent_without_mutating_books(self):
        before = copy.deepcopy(self.book)
        history = [{"role": "user", "content": "  先前的问题\n"}, {"role": "assistant", "content": "先前的回答🌙"}]
        prompt = "  这张图怎么样？\n"
        preview = self.service.preview(self.book, "custom", [], prompt, skill_ids=[], chat=True, history=history, attachments=[self.ref])
        self.assertEqual(ImageProvider.received, [])
        result = self.run_chat(prompt, history=history, attachments=[self.ref])
        sent = ImageProvider.received[0]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["authorization"], "Bearer " + FAKE_KEY)
        messages = sent["payload"]["messages"]
        self.assertEqual(messages[2:-1], history)
        self.assertEqual(messages[-1], {"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": PNG_URL}}]})
        self.assertEqual(result["imageCount"], 1)
        self.assertEqual(result["imageBytes"], len(base64.b64decode(PNG)))
        self.assertEqual(preview["contextChars"], len(messages[1]["content"]) + sum(len(message["content"]) for message in history) + len(prompt))
        self.assertEqual(result["contextChars"], preview["contextChars"])
        self.assertEqual(self.book, before)

    def test_pure_images_and_history_assistant_images_keep_standard_provider_roles(self):
        history = [{"role": "user", "content": "", "attachments": [self.ref]}, {"role": "assistant", "content": "", "attachments": [self.ref]}]
        self.run_chat("", history=history, attachments=[self.ref])
        messages = ImageProvider.received[-1]["payload"]["messages"]
        self.assertEqual(messages[2]["role"], "user")
        self.assertEqual(messages[2]["content"][1]["image_url"]["url"], PNG_URL)
        self.assertEqual(messages[3], {"role": "assistant", "content": "[图片]"})
        self.assertIsInstance(messages[1]["content"], list)
        self.assertIn("第 1 轮历史助手", messages[1]["content"][1]["text"])
        self.assertEqual(messages[1]["content"][2]["image_url"]["url"], PNG_URL)
        self.assertTrue(all(isinstance(message["content"], str) for message in messages if message["role"] == "assistant"))
        self.assertEqual(messages[-1]["content"][0]["text"], "")

    def test_preview_and_manual_context_count_text_only_but_retain_all_images(self):
        history = [{"role": "user", "content": "图", "attachments": [self.ref]}, {"role": "assistant", "content": "图片只作参考", "attachments": [self.ref]}]
        values = dict(chat=True, history=history, attachments=[self.ref], skill_ids=[])
        preview = self.service.preview(self.book, "custom", [], "继续讨论", **values)
        self.assertEqual(preview["historyChars"], len("图图片只作参考"))
        self.assertEqual(preview["imageCount"], 3)
        self.service.save_settings({"contextMode": "manual", "maxContextChars": preview["contextChars"]})
        self.assertFalse(self.service.preview(self.book, "custom", [], "继续讨论", **values)["overLimit"])
        self.run_chat("继续讨论", history=history, attachments=[self.ref])
        self.service.save_settings({"maxContextChars": preview["contextChars"] - 1})
        before = len(ImageProvider.received)
        with self.assertRaises(AIError):
            self.run_chat("继续讨论", history=history, attachments=[self.ref])
        self.assertEqual(len(ImageProvider.received), before)

    def test_invalid_cross_book_missing_duplicate_and_over_budget_images_never_reach_provider(self):
        another = self.store.save("other-book", "second.jpg", JPEG_URL)
        for attachments in ["image", {}, [self.ref] * 5, [self.ref, self.ref], [{"id": another["id"]}], [{"id": "../secret"}], [{"id": self.ref["id"], "url": PNG_URL}], [{"id": self.ref["id"], "name": ""}]]:
            with self.assertRaises(AIError):
                self.run_chat(attachments=attachments)
        for history in [[{"role": "user", "content": "", "attachments": []}, {"role": "assistant", "content": "答复"}],
                        [{"role": "user", "content": "图", "attachments": None}, {"role": "assistant", "content": "答复"}]]:
            with self.assertRaises(AIError):
                self.run_chat(history=history)
        with patch("ai_service.MAX_CHAT_IMAGE_BYTES", self.image["bytes"] - 1), self.assertRaises(AIError):
            self.run_chat(attachments=[self.ref])
        with self.assertRaises(AIError):
            self.service.preview(self.book, "custom", [], "说明", attachments=[self.ref])
        self.assertEqual(ImageProvider.received, [])

    def test_content_parts_message_images_and_json_images_are_saved_and_displayable(self):
        envelope = {"reply": "这是构图参考。", "data": None}
        formats = [
            {"content": [{"type": "text", "text": json.dumps(envelope, ensure_ascii=False)}, {"type": "image_url", "image_url": {"url": PNG_URL}}]},
            {"content": json.dumps(envelope, ensure_ascii=False), "images": [{"type": "image_url", "image_url": {"url": PNG_URL}}]},
            {"content": json.dumps({**envelope, "images": [{"name": "示意图.png", "dataUrl": PNG_URL}]}, ensure_ascii=False)},
            {"content": [{"type": "text", "text": "这是图片参考。"}, {"type": "image_url", "image_url": PNG_URL}]},
        ]
        for message in formats:
            ImageProvider.message = message
            result = self.run_chat()
            self.assertTrue(result["reply"])
            self.assertIsNone(result["data"])
            self.assertEqual(len(result["images"]), 1)
            metadata = result["images"][0]
            self.assertEqual(set(metadata), {"id", "name", "url", "mime", "bytes"})
            self.assertEqual(self.store.read(self.book["id"], metadata["id"])[0], base64.b64decode(PNG))
            self.assertNotIn("data:image", json.dumps(result))

    def test_image_only_replies_are_valid_but_invalid_images_keep_valid_text_with_warning(self):
        for message in [{"content": None, "images": [{"image_url": {"url": PNG_URL}}]},
                        {"content": [{"type": "image_url", "image_url": {"url": PNG_URL}}]},
                        {"content": json.dumps({"reply": "", "data": None, "images": [PNG_URL]})}]:
            ImageProvider.message = message
            result = self.run_chat()
            self.assertEqual(result["reply"], "")
            self.assertIsNone(result["data"])
            self.assertEqual(len(result["images"]), 1)
        for invalid in ["https://example.invalid/image.png", "file:///tmp/private.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,broken"]:
            self.reply({"reply": "文字保持可读", "data": None, "images": [invalid]})
            result = self.run_chat()
            self.assertEqual(result["reply"], "文字保持可读")
            self.assertIn("imageWarning", result)
            self.assertNotIn("images", result)
            self.reply({"reply": "", "data": None, "images": [invalid]})
            with self.assertRaises(AIError) as error:
                self.run_chat()
            self.assertEqual(error.exception.status, 502)
        ImageProvider.message = {"content": json.dumps({"reply": "文字仍保留", "data": None}), "images": {"url": PNG_URL}}
        result = self.run_chat()
        self.assertEqual(result["reply"], "文字仍保留")
        self.assertIn("imageWarning", result)

    def test_candidate_validation_is_still_required_before_images_are_saved(self):
        self.reply({"reply": "候选正文。", "data": {"text": "尚未采用的候选。"}, "images": [JPEG_URL]})
        result = self.run_chat()
        self.assertEqual(result["data"], {"text": "尚未采用的候选。"})
        before = set((self.data / "ai-chat-images" / self.store.book_key(self.book["id"])).iterdir())
        self.reply({"reply": "无效候选", "data": {"title": "不能冒充当前操作"}, "images": [PNG_URL]})
        with self.assertRaises(AIError):
            self.run_chat()
        self.assertEqual(set((self.data / "ai-chat-images" / self.store.book_key(self.book["id"])).iterdir()), before)
        self.reply({"reply": "", "data": {"text": "缺少文字答复的候选"}, "images": ["data:image/webp;base64," + WEBP]})
        with self.assertRaises(AIError):
            self.run_chat()
        self.assertEqual(set((self.data / "ai-chat-images" / self.store.book_key(self.book["id"])).iterdir()), before)

    def test_inline_json_image_size_does_not_count_as_answer_text_length(self):
        content = base64.b64decode(PNG)
        payload = b"description\0" + b"x" * 100000
        chunk = len(payload).to_bytes(4, "big") + b"tEXt" + payload
        chunk += zlib.crc32(chunk[4:]).to_bytes(4, "big")
        content = content[:33] + chunk + content[33:]
        data_url = "data:image/png;base64," + base64.b64encode(content).decode()
        self.reply({"reply": "图片已返回。", "data": None, "images": [{"dataUrl": data_url}]})
        result = self.run_chat()
        self.assertEqual(result["reply"], "图片已返回。")
        self.assertEqual(result["images"][0]["bytes"], len(content))
        self.assertNotIn("data:image", json.dumps(result))

    def test_http_upload_read_recycle_restore_purge_and_thirty_day_cleanup_are_scoped(self):
        previous_path, previous_token = server.DB_PATH, server.DESKTOP_TOKEN
        server.DB_PATH, server.DESKTOP_TOKEN = self.data / "writer.sqlite3", ""
        class Quiet(server.Handler):
            def log_message(self, *args):
                pass
        http = None
        try:
            server.initialize()
            http = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            base = "http://127.0.0.1:" + str(http.server_port)

            def request(path, data=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request(base + path, data=body, headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        value = response.read()
                        return response.status, value if response.headers.get_content_type().startswith("image/") else json.loads(value)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            book = request("/api/books", {"title": "图片验收", "kind": "short"})[1]
            book_id = book["book"]["id"]
            path = "/api/books/" + book_id
            original = request(path)[1]
            status, image = request(path + "/ai/images", {"name": "参考图.png", "dataUrl": PNG_URL})
            self.assertEqual(status, 200)
            self.assertEqual(request(image["url"]), (200, base64.b64decode(PNG)))
            self.assertEqual(request(path)[1], original)
            body = {"action": "custom", "chapterIds": [], "instruction": "", "chat": True, "history": [], "skillIds": [], "attachments": [{"id": image["id"], "name": image["name"]}]}
            before = len(ImageProvider.received)
            self.assertEqual(request(path + "/ai/preview", body)[1]["imageCount"], 1)
            self.assertEqual(len(ImageProvider.received), before)
            self.assertEqual(request(path + "/ai", body)[0], 200)
            self.assertEqual(request(path)[1], original)
            for changes in [{"attachments": None}, {"chat": False}, {"attachments": [{"id": "../secret"}]}]:
                self.assertEqual(request(path + "/ai/preview", {**body, **changes})[0], 400)
            trash = request(path + "/trash", {"revision": book["revision"]})[1]
            self.assertEqual(request(image["url"])[0], 200)
            self.assertEqual(request(path + "/ai/images", {"name": "new", "dataUrl": PNG_URL})[0], 409)
            restored = request(path + "/restore", {"revision": trash["revision"]})[1]
            self.assertEqual(request(image["url"])[0], 200)
            trash = request(path + "/trash", {"revision": restored["revision"]})[1]
            self.assertEqual(request(path + "/purge", {"revision": trash["revision"]})[0], 200)
            self.assertEqual(request(image["url"])[0], 404)
            self.assertEqual(list((self.data / "ai-chat-images" / self.store.book_key(book_id)).iterdir()), [])
            # A different book's images survive final and automatic deletion.
            self.assertTrue(self.store.read(self.book["id"], self.image["id"])[0])
            book = request("/api/books", {"title": "过期图片", "kind": "long"})[1]
            book_id = book["book"]["id"]
            image = request("/api/books/" + book_id + "/ai/images", {"name": "参考", "dataUrl": PNG_URL})[1]
            request("/api/books/" + book_id + "/trash", {"revision": book["revision"]})
            with server.connect() as conn:
                conn.execute("UPDATE books SET deleted_at=? WHERE id=?", ((datetime.now(timezone.utc) - timedelta(days=31)).isoformat(), book_id))
            self.assertIn(book_id, server.cleanup_expired_books())
            self.assertEqual(request(image["url"])[0], 404)
            self.assertEqual(list((self.data / "ai-chat-images" / self.store.book_key(book_id)).iterdir()), [])
        finally:
            if http:
                http.shutdown()
                http.server_close()
                thread.join()
            server.DB_PATH, server.DESKTOP_TOKEN = previous_path, previous_token


if __name__ == "__main__":
    unittest.main(verbosity=2)
