"""Streaming uses fake credentials and a disposable loopback provider only."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIService, AIError
from ai_provider_stream import ReplyPreview
from story_memory import memory_index, select_memory, source_hash, validate_memory
from chat_images import ChatImageStore

SAMPLE = json.loads((ROOT / "examples/tide-archive.yejian.json").read_text("utf-8"))["book"]


class Provider(BaseHTTPRequestHandler):
    mode = "stream"
    calls = []
    envelope = {"reply": '第一行\n第二行「你好」😀', "data": {"text": "候选内容"}}
    pause = None
    resume = None
    image = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append(payload)
        if self.mode in {"unsupported", "generic_error", "context_error"} and payload["stream"]:
            error = {"error": {"param": "stream", "code": "unsupported_parameter", "message": "secret-stub-key"}}
            if self.mode == "generic_error":
                error["error"]["param"] = "model"
            elif self.mode == "context_error":
                error["error"]["code"] = "context_length_exceeded"
            raw = json.dumps(error).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        raw_content = json.dumps(self.envelope, ensure_ascii=False)
        if not payload["stream"] or self.mode == "json":
            raw = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": raw_content}}]}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            self.wfile.write(b": provider heartbeat\r\n\r\n")
            if self.pause is not None:
                self.pause.set()
                self.resume.wait(5)
            for index in range(0, len(raw_content), 3):
                value = {"choices": [{"index": 0, "delta": {"content": raw_content[index:index + 3]}}]}
                raw = ("data: " + json.dumps(value, ensure_ascii=False) + "\r\n\r\n").encode()
                # HTTP writes can split inside Chinese UTF-8 characters.
                for offset in range(0, len(raw), 7):
                    self.wfile.write(raw[offset:offset + 7])
                self.wfile.flush()
            if self.mode != "interrupted":
                value = {"choices": [{"delta": {"images": [{"image_url": {"url": self.image}}]} if self.image else {}, "finish_reason": "length" if self.mode == "length" else "stop"}]}
                self.wfile.write(("data: " + json.dumps(value) + "\n\ndata: [DONE]\n\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


class StreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.service = AIService(self.directory.name)
        self.service.save_settings({"enabled": True, "endpoint": "http://127.0.0.1:" + str(self.server.server_port), "model": "stub", "apiKey": "secret-stub-key"})
        Provider.mode = "stream"
        Provider.calls = []
        Provider.pause = Provider.resume = Provider.image = None
        Provider.envelope = {"reply": '第一行\n第二行「你好」😀', "data": {"text": "候选内容"}}

    def run_chat(self, **kwargs):
        return self.service.run(copy.deepcopy(SAMPLE), "custom", [SAMPLE["chapters"][4]["id"]], "请继续讨论人物行动", chat=True, history=[], **kwargs)

    def test_sse_crlf_utf8_fragments_preview_only_reply_and_validate_final_candidate(self):
        pieces = []
        result = self.run_chat(on_delta=pieces.append)
        self.assertEqual("".join(pieces), Provider.envelope["reply"])
        self.assertGreater(len(pieces), 3)
        self.assertEqual(result["data"], {"text": "候选内容"})
        self.assertTrue(Provider.calls[0]["stream"])
        self.assertNotIn("候选内容", "".join(pieces))

    def test_plain_json_provider_returns_without_repeating_paid_request(self):
        Provider.mode = "json"
        pieces = []
        self.assertEqual(self.run_chat(on_delta=pieces.append)["reply"], Provider.envelope["reply"])
        self.assertEqual(len(Provider.calls), 1)
        self.assertEqual("".join(pieces), Provider.envelope["reply"])

    def test_explicit_unsupported_stream_parameter_falls_back_exactly_once(self):
        Provider.mode = "unsupported"
        self.assertEqual(self.run_chat(on_delta=lambda _: None)["data"], {"text": "候选内容"})
        self.assertEqual([call["stream"] for call in Provider.calls], [True, False])

    def test_generic_provider_error_never_retries_or_leaks_provider_secret(self):
        Provider.mode = "generic_error"
        with self.assertRaises(AIError) as raised:
            self.run_chat(on_delta=lambda _: None)
        self.assertNotIn("secret-stub-key", raised.exception.message)
        self.assertEqual(len(Provider.calls), 1)

    def test_context_rejection_never_retries_or_truncates(self):
        Provider.mode = "context_error"
        with self.assertRaises(AIError) as raised:
            self.run_chat(on_delta=lambda _: None)
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(len(Provider.calls), 1)

    def test_interrupted_and_length_streams_have_no_completed_candidate(self):
        for mode in ("interrupted", "length"):
            Provider.mode = mode
            with self.assertRaises(AIError):
                self.run_chat(on_delta=lambda _: None)

    def test_cancel_after_first_delta_stops_without_any_final_result_or_images(self):
        stopped, pieces = threading.Event(), []
        def delta(text):
            pieces.append(text)
            stopped.set()
        with self.assertRaises(AIError) as raised:
            self.run_chat(on_delta=delta, cancelled=stopped.is_set)
        self.assertEqual(raised.exception.status, 499)
        self.assertEqual(len(pieces), 1)
        self.assertFalse((Path(self.directory.name) / "ai-chat-images").exists())

    def test_ai_memory_is_explicit_source_validated_candidate_and_never_mutates_book(self):
        chapter = SAMPLE["chapters"][0]
        Provider.envelope = {"reply": "章节记忆候选", "data": {"entries": [{"chapterId": chapter["id"], "summary": "沈砚在旧船票中听见父亲的声音。", "characterStates": "沈砚开始调查。", "settingNotes": "只记已发生事件。"}]}}
        book, pieces = copy.deepcopy(SAMPLE), []
        result = self.service.run(book, "memory", [chapter["id"]], "整理这一章", chat=True, history=[], on_delta=pieces.append)
        self.assertEqual(result["data"]["entries"][0]["sourceHash"], source_hash(chapter))
        self.assertEqual(book, SAMPLE)
        self.assertNotIn("storyMemory", book)
        self.assertEqual("".join(pieces), "章节记忆候选")
        Provider.envelope["data"]["entries"][0]["chapterId"] = SAMPLE["chapters"][1]["id"]
        with self.assertRaises(AIError):
            self.service.run(book, "memory", [chapter["id"]], "整理这一章", chat=True, history=[], on_delta=lambda _: None)

    def test_streaming_keeps_image_inputs_and_saves_valid_inline_output_only_at_completion(self):
        from verify_ai_cover import PNG
        Provider.image = "data:image/png;base64," + PNG
        store = ChatImageStore(self.directory.name)
        image = store.save(SAMPLE["id"], "参考.png", Provider.image)
        result = self.service.run(SAMPLE, "custom", [], "参考这张图讨论", chat=True, history=[], attachments=[{"id": image["id"], "name": image["name"]}], on_delta=lambda _: None)
        content = Provider.calls[0]["messages"][-1]["content"]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(len(result["images"]), 1)
        self.assertTrue(store.read(SAMPLE["id"], result["images"][0]["id"])[0])

    def test_real_http_stream_and_memory_routes_keep_book_read_only_and_guard_client_headers(self):
        import server as app
        previous_path, previous_token = app.DB_PATH, app.DESKTOP_TOKEN
        app.DB_PATH, app.DESKTOP_TOKEN = Path(self.directory.name) / "writer.sqlite3", ""
        class Quiet(app.Handler):
            def log_message(self, *args):
                pass
        http = None
        try:
            app.initialize()
            http = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
            threading.Thread(target=http.serve_forever, daemon=True).start()
            base = "http://127.0.0.1:" + str(http.server_port)
            def request(path, data=None, headers=None):
                raw = None if data is None else json.dumps(data).encode()
                return urllib.request.urlopen(urllib.request.Request(base + path, data=raw, headers=headers or {"Content-Type": "application/json", "X-Writer-Client": "1"}), timeout=5)
            with request("/api/books") as response:
                books = json.load(response)["books"]
            book_id = next(book["id"] for book in books if book["charCount"] == 101506)
            with request("/api/books/" + book_id) as response:
                before = json.load(response)
            with request("/api/books/" + book_id + "/memory") as response:
                self.assertEqual(len(json.load(response)["entries"]), 36)
            payload = {"action": "custom", "chapterIds": [before["book"]["chapters"][0]["id"]], "instruction": "讨论主角行动", "chat": True, "history": [], "skillIds": []}
            with request("/api/books/" + book_id + "/ai/stream", payload) as response:
                events = [json.loads(line[5:]) for line in response.read().decode().splitlines() if line.startswith("data:")]
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(events[-1]["result"]["reply"], Provider.envelope["reply"])
            self.assertGreater(len([event for event in events if event["type"] == "delta"]), 2)
            with request("/api/books/" + book_id) as response:
                self.assertEqual(json.load(response), before)
            calls = len(Provider.calls)
            with self.assertRaises(urllib.error.HTTPError) as raised:
                request("/api/books/" + book_id + "/ai/stream", payload, {"Content-Type": "application/json"})
            self.assertEqual(raised.exception.code, 403)
            self.assertEqual(len(Provider.calls), calls)
            # Recycling a book while the provider is paused must terminate the
            # request before its late text/image can become a saved result.
            Provider.pause, Provider.resume = threading.Event(), threading.Event()
            from verify_ai_cover import PNG
            Provider.image = "data:image/png;base64," + PNG
            response = request("/api/books/" + book_id + "/ai/stream", payload)
            self.assertTrue(Provider.pause.wait(2))
            with app.DB_LOCK, app.connect() as conn:
                conn.execute("UPDATE books SET deleted_at=? WHERE id=?", (app.now(), book_id))
            Provider.resume.set()
            events = [json.loads(line[5:]) for line in response.read().decode().splitlines() if line.startswith("data:")]
            response.close()
            self.assertEqual(events[-1]["type"], "error")
            self.assertFalse(any(event["type"] == "result" for event in events))
            self.assertFalse((Path(self.directory.name) / "ai-chat-images" / book_id).exists())
        finally:
            if http:
                http.shutdown()
                http.server_close()
            app.DB_PATH, app.DESKTOP_TOKEN = previous_path, previous_token


class MemoryTests(unittest.TestCase):
    def test_demo_memory_is_local_source_linked_and_retrieves_previous_chapters(self):
        original = copy.deepcopy(SAMPLE)
        index = memory_index(SAMPLE)
        self.assertEqual(len(index["entries"]), 36)
        self.assertTrue(all(entry["source"] == "local-extract" and not entry["stale"] for entry in index["entries"]))
        selected = SAMPLE["chapters"][8]["id"]
        memories = select_memory(SAMPLE, [selected], "沈砚与旧船票")
        self.assertEqual(len(memories), 6)
        self.assertNotIn(selected, [entry["chapterId"] for entry in memories])
        positions = {chapter["id"]: number for number, chapter in enumerate(SAMPLE["chapters"])}
        self.assertTrue(all(positions[entry["chapterId"]] < positions[selected] for entry in memories))
        self.assertEqual(SAMPLE, original)
        for entry in index["entries"]:
            chapter = next(item for item in SAMPLE["chapters"] if item["id"] == entry["chapterId"])
            self.assertEqual(entry["sourceHash"], source_hash(chapter))
            self.assertTrue(all(line in chapter["body"] for line in entry["summary"].splitlines() if line and line != "…"))

    def test_author_summary_becomes_stale_when_source_changes_and_stale_text_is_not_sent(self):
        book = copy.deepcopy(SAMPLE)
        chapter = book["chapters"][0]
        entry = {"chapterId": chapter["id"], "sourceHash": source_hash(chapter), "summary": "作者确认的摘要", "characterStates": "作者确认的人物状态", "settingNotes": "作者确认的设定"}
        book["storyMemory"] = {"version": 1, "enabled": True, "entries": [entry]}
        self.assertEqual(memory_index(book)["entries"][0]["source"], "author")
        chapter["body"] += "\n沈砚走到了新的码头。"
        current = memory_index(book)["entries"][0]
        self.assertTrue(current["stale"])
        self.assertEqual(current["source"], "local-extract")
        self.assertNotIn("作者确认", current["summary"])
        self.assertEqual(current["saved"]["summary"], "作者确认的摘要")
        self.assertNotIn("作者确认", json.dumps(select_memory(book, [book["chapters"][1]["id"]], "继续"), ensure_ascii=False))

    def test_disabled_memory_and_invalid_schema(self):
        book = copy.deepcopy(SAMPLE)
        book["storyMemory"] = {"version": 1, "enabled": False, "entries": []}
        self.assertEqual(select_memory(book, [], "续写"), [])
        for value in ({"version": 1, "enabled": 1, "entries": []}, {"version": True, "enabled": True, "entries": []}, {"version": 1, "enabled": True, "entries": [{"chapterId": "missing"}]}):
            with self.assertRaises(ValueError):
                validate_memory(value, book)

    def test_preview_includes_retrieved_memory_without_replacing_selected_full_text(self):
        with tempfile.TemporaryDirectory() as directory:
            service = AIService(directory)
            selected = SAMPLE["chapters"][10]
            context, _ = service._context(SAMPLE, "draft", [selected["id"]], "承接沈砚的行动")
            self.assertEqual(context["chapters"][0]["body"], selected["body"])
            self.assertTrue(context["storyMemory"])
            self.assertEqual(service.preview(SAMPLE, "draft", [selected["id"]], "承接沈砚的行动")["counts"]["memories"], len(context["storyMemory"]))

    def test_partial_envelope_decoder_escapes_surrogates_and_nested_reply_keys(self):
        parser, pieces = ReplyPreview(), []
        raw = '{"data":{"text":"nested \\"reply\\": should not appear"},"reply":"你好\\n\\ud83d\\ude00\\\"结束"}'
        for char in raw:
            pieces.append(parser.feed(char))
        self.assertEqual("".join(pieces), '你好\n😀"结束')


if __name__ == "__main__":
    unittest.main(verbosity=2)
