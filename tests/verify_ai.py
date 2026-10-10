"""AI requests go only to a disposable loopback stub with a fake credential."""
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIService, AIError

SAMPLE = json.loads((ROOT / 'examples/tide-archive.yejian.json').read_text('utf-8'))['book']
FAKE_KEY = 'stub-only-not-a-real-credential'


class Stub(BaseHTTPRequestHandler):
    mode = 'draft'
    received = []
    reply = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.received.append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'payload': payload})
        if self.mode == 'redirect':
            self.send_response(307)
            self.send_header('Location', '/redirect-target')
            self.end_headers()
            return
        if self.mode == 'error':
            self.send_response(401)
            self.end_headers()
            self.wfile.write(FAKE_KEY.encode())
            return
        if self.mode == 'timeout':
            time.sleep(1.2)
        if self.mode == 'invalid':
            result = b'invalid json with ' + FAKE_KEY.encode()
        elif self.mode == 'malformed':
            result = b'{"choices": [null]}'
        elif self.mode == 'large':
            result = b'x' * (2 * 1024 * 1024 + 1)
        elif self.mode == 'plain':
            result = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': self.reply or '自由回答，不是 JSON。'}}]}, ensure_ascii=False).encode()
        else:
            content = self.reply if self.reply is not None else {'title': '测试草稿', 'body': '这是一段隔离测试草稿。'}
            result = json.dumps({'choices': [{'finish_reason': 'length' if self.mode == 'truncated' else 'stop', 'message': {'content': json.dumps(content, ensure_ascii=False)}}]}).encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(result)
        except (BrokenPipeError, ConnectionResetError):
            pass


class AITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = 'http://127.0.0.1:' + str(cls.server.server_address[1]) + '/v1'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='writer-ai-test-')
        self.addCleanup(self.directory.cleanup)
        self.service = AIService(Path(self.directory.name) / 'data')
        self.book = copy.deepcopy(SAMPLE)
        self.ids = [self.book['chapters'][0]['id']]
        Stub.mode, Stub.reply, Stub.received = 'draft', None, []

    def configure(self, **kwargs):
        return self.service.save_settings({'enabled': True, 'endpoint': self.endpoint, 'model': 'stub-model', **kwargs})

    def test_disabled_default_does_not_create_config_or_request(self):
        settings = self.service.get_settings()
        self.assertFalse(settings['enabled'])
        self.assertEqual(settings['model'], '')
        self.assertFalse(self.service.path.exists())
        with self.assertRaises(AIError) as error:
            self.service.run(self.book, 'draft', self.ids)
        self.assertEqual(error.exception.status, 400)
        self.assertEqual(Stub.received, [])

    def test_secret_stays_local_and_empty_preserves_explicit_clear_removes(self):
        public = self.configure(apiKey=FAKE_KEY)
        self.assertNotIn(FAKE_KEY, json.dumps(public))
        self.assertTrue(public['hasKey'])
        self.assertEqual(stat.S_IMODE(self.service.path.stat().st_mode), 0o600)
        self.configure(apiKey='')
        self.service.run(self.book, 'draft', self.ids)
        self.assertEqual(Stub.received[-1]['authorization'], 'Bearer ' + FAKE_KEY)
        self.configure(clearKey=True)
        self.service.run(self.book, 'draft', self.ids)
        self.assertIsNone(Stub.received[-1]['authorization'])
        self.assertNotIn(FAKE_KEY, self.service.path.read_text())

    def test_endpoint_validation_and_local_without_key(self):
        for value in ['http://example.org/v1', 'https://name:secret@example.org/v1', 'https://example.org/v1?api_key=secret', 'file:///tmp/x', 'https://example.org/\nheader']:
            with self.assertRaises(AIError):
                self.configure(endpoint=value)
        self.configure()
        result = self.service.run(self.book, 'draft', self.ids)
        self.assertEqual(result['data']['body'], '这是一段隔离测试草稿。')
        self.assertEqual(Stub.received[0]['path'], '/v1/chat/completions')
        self.assertIsNone(Stub.received[0]['authorization'])
        self.assertEqual(set(Stub.received[0]['payload']), {'model', 'messages', 'stream'})

    def test_explicit_scope_context_limit_and_no_book_mutation(self):
        self.configure()
        original = json.dumps(self.book, ensure_ascii=False)
        whole = self.service.preview(self.book, 'consistency', [c['id'] for c in self.book['chapters']])
        self.assertEqual(whole['counts']['chapters'], 36)
        self.assertEqual(whole['counts']['people'], 32)
        self.assertLess(whole['contextChars'], whole['maxContextChars'])
        self.service.run(self.book, 'draft', self.ids, '继续写一段。')
        context = json.loads(Stub.received[-1]['payload']['messages'][1]['content'])
        self.assertEqual([c['id'] for c in context['chapters']], self.ids)
        self.assertTrue(all(c['id'] != self.book['chapters'][1]['id'] for c in context['chapters']))
        self.assertIn('不可信', Stub.received[-1]['payload']['messages'][0]['content'])
        self.assertEqual(json.dumps(self.book, ensure_ascii=False), original)
        self.configure(maxContextChars=1000)
        before = len(Stub.received)
        self.assertTrue(self.service.preview(self.book, 'draft', self.ids)['overLimit'])
        with self.assertRaises(AIError):
            self.service.run(self.book, 'draft', self.ids)
        self.assertEqual(len(Stub.received), before)

    def test_draft_from_outline_without_chapters_and_connection_without_text(self):
        self.configure()
        preview = self.service.preview(self.book, 'draft', [])
        self.assertEqual(preview['counts']['chapters'], 0)
        self.assertEqual(preview['counts']['outlines'], len(self.book['outline']))
        self.service.run(self.book, 'draft', [])
        context = json.loads(Stub.received[-1]['payload']['messages'][1]['content'])
        self.assertEqual(context['chapters'], [])
        self.assertTrue(self.service.test_connection()['ok'])
        self.assertEqual(Stub.received[-1]['payload']['messages'], [{'role': 'user', 'content': 'Reply with OK.'}])

    def test_blank_book_outline_hierarchy_and_exact_visible_instruction(self):
        self.configure()
        book = {'id': 'blank-book', 'kind': 'long', 'title': '新故事', 'chapters': [], 'outline': [], 'notes': [], 'relations': []}
        nodes = [{'key': 'c1', 'parentKey': 'v1', 'kind': 'chapter', 'title': '第一章', 'body': '主角收到一份失踪名单。'},
                 {'key': 's1', 'parentKey': None, 'kind': 'story', 'title': '全书总纲', 'body': '候选故事主线。'},
                 {'key': 'v1', 'parentKey': 's1', 'kind': 'volume', 'title': '第一卷', 'body': '寻找档案的主人。'},
                 {'key': 'world', 'parentKey': 's1', 'kind': 'setting', 'title': '世界规则', 'body': '档案每天改变一次。'}]
        Stub.reply = {'nodes': nodes}
        prompt = '请生成一卷一章的完整候选大纲，保留世界规则。'
        preview = self.service.preview(book, 'outline', [], prompt, skill_ids=[])
        self.assertEqual(preview['counts']['chapters'], 0)
        self.assertEqual(Stub.received, [])
        result = self.service.run(book, 'outline', [], prompt, skill_ids=[])
        self.assertEqual([node['key'] for node in result['data']['nodes']], ['s1', 'v1', 'c1', 'world'])
        message = Stub.received[-1]['payload']['messages'][1]['content']
        self.assertEqual(json.loads(message)['instruction'], prompt)
        self.assertEqual(len(message), preview['contextChars'])
        self.assertEqual(book['outline'], [])
        for invalid in [[], [nodes[0]], [{**nodes[1], 'parentKey': 'missing'}], [nodes[1], {**nodes[2], 'key': 's1'}],
                        [nodes[1], {**nodes[0], 'parentKey': 's1'}], [nodes[1], {**nodes[2], 'parentKey': 'c1'}, nodes[0]],
                        [nodes[1], {**nodes[3], 'kind': 'unknown'}], [{**nodes[1], 'title': 'x' * 201}]]:
            Stub.reply = {'nodes': invalid}
            with self.assertRaises(AIError) as error:
                self.service.run(book, 'outline', [], prompt)
            self.assertEqual(error.exception.status, 502)
        short = {**book, 'kind': 'short'}
        Stub.reply = {'nodes': [nodes[1], {**nodes[0], 'parentKey': 's1'}]}
        self.assertEqual(len(self.service.run(short, 'outline', [], prompt)['data']['nodes']), 2)
        Stub.reply = {'nodes': [nodes[1], nodes[2], nodes[0]]}
        with self.assertRaises(AIError):
            self.service.run(short, 'outline', [], prompt)

    def test_custom_free_text_requires_prompt_counts_it_and_never_changes_book(self):
        self.configure()
        original = copy.deepcopy(self.book)
        for prompt in ['', ' \n\t ']:
            with self.assertRaises(AIError) as error:
                self.service.preview(self.book, 'custom', [], prompt)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(Stub.received, [])
        Stub.mode, Stub.reply = 'plain', '<img src=x onerror=alert(1)>\n候选名字：潮声、灯塔。'
        prompt = '为本书里的档案馆取两个名字，给出解释。'
        preview = self.service.preview(self.book, 'custom', [], prompt)
        result = self.service.run(self.book, 'custom', [], prompt)
        self.assertEqual(result['data'], {'text': Stub.reply})
        messages = Stub.received[-1]['payload']['messages']
        self.assertIn('操作为custom', messages[0]['content'])
        self.assertIn('不强制JSON', messages[0]['content'])
        self.assertEqual(json.loads(messages[1]['content'])['instruction'], prompt)
        self.assertEqual(len(messages[1]['content']), preview['contextChars'])
        self.assertEqual(self.book, original)
        before = len(Stub.received)
        self.configure(maxContextChars=1000)
        self.assertTrue(self.service.preview(self.book, 'custom', [], prompt)['overLimit'])
        with self.assertRaises(AIError):
            self.service.run(self.book, 'custom', [], prompt)
        self.assertEqual(len(Stub.received), before)

    def test_redirect_is_not_followed_and_error_text_never_echoed(self):
        self.configure(apiKey=FAKE_KEY)
        for mode in ['redirect', 'error', 'invalid', 'malformed', 'truncated', 'large']:
            Stub.mode = mode
            before = len(Stub.received)
            with self.assertRaises(AIError) as error:
                self.service.run(self.book, 'draft', self.ids)
            self.assertNotIn(FAKE_KEY, str(error.exception))
            self.assertEqual(error.exception.status, 502)
            self.assertEqual(len(Stub.received), before + 1)
        self.assertTrue(all(request['path'] == '/v1/chat/completions' for request in Stub.received))

    def test_timeout_returns_safe_local_error(self):
        self.configure(timeoutSeconds=1)
        Stub.mode = 'timeout'
        with self.assertRaises(AIError) as error:
            self.service.run(self.book, 'draft', self.ids)
        self.assertEqual(error.exception.status, 502)
        self.assertIn('超时', str(error.exception))

    def test_relationships_and_consistency_require_selected_verbatim_evidence(self):
        self.configure()
        quote = self.book['chapters'][0]['body'][:40]
        citation = {'chapterId': self.ids[0], 'quote': quote}
        Stub.reply = {'people': [{'name': '测试人物', 'group': '测试', 'description': '待作者核实', 'evidence': [citation]}], 'relationships': [{'from': '测试人物', 'to': '沈砚', 'type': 'cooperate', 'label': '测试关系', 'description': '仅供测试', 'evidence': [citation]}]}
        result = self.service.run(self.book, 'relationships', self.ids)
        self.assertEqual(result['data']['people'][0]['evidence'], [citation])
        Stub.reply['people'][0]['evidence'][0] = {'chapterId': self.ids[0], 'quote': '不在原文里的伪造引文'}
        with self.assertRaises(AIError):
            self.service.run(self.book, 'relationships', self.ids)
        Stub.reply = {'issues': [{'title': '测试疑点', 'description': '待作者核实', 'chapterIds': self.ids, 'evidence': [citation]}]}
        result = self.service.run(self.book, 'consistency', self.ids)
        self.assertEqual(result['data']['issues'][0]['chapterIds'], self.ids)
        Stub.reply['issues'][0]['chapterIds'] = [self.book['chapters'][1]['id']]
        with self.assertRaises(AIError):
            self.service.run(self.book, 'consistency', self.ids)

    def test_real_application_http_routes_scope_errors_and_secret_separation(self):
        import server as app
        previous_path, previous_token = app.DB_PATH, app.DESKTOP_TOKEN
        app.DB_PATH, app.DESKTOP_TOKEN = self.service.data_dir / 'writer.sqlite3', ''
        class Quiet(app.Handler):
            def log_message(self, *args):
                pass
        http = None
        try:
            app.initialize()
            http = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(http.server_port)
            def request(path, method='GET', data=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request(base + path, data=body, method=method, headers={'Content-Type': 'application/json', 'X-Writer-Client': '1'})
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            status, settings = request('/api/ai/settings')
            self.assertEqual(status, 200)
            self.assertFalse(settings['enabled'])
            status, settings = request('/api/ai/settings', 'PUT', {'enabled': True, 'endpoint': self.endpoint, 'model': 'stub-model', 'apiKey': FAKE_KEY})
            self.assertEqual(status, 200)
            self.assertNotIn(FAKE_KEY, json.dumps(settings))
            books = request('/api/books')[1]['books']
            book_id = next(book['id'] for book in books if book['charCount'] == 101506)
            book = request('/api/books/' + book_id)[1]['book']
            body = {'action': 'draft', 'chapterIds': [book['chapters'][0]['id']], 'instruction': ''}
            before = len(Stub.received)
            status, preview = request('/api/books/' + book_id + '/ai/preview', 'POST', body)
            self.assertEqual(status, 200)
            self.assertEqual(preview['counts']['chapters'], 1)
            self.assertEqual(len(Stub.received), before)
            status, result = request('/api/books/' + book_id + '/ai', 'POST', body)
            self.assertEqual(status, 200)
            self.assertEqual(result['bookId'], book_id)
            self.assertEqual(Stub.received[-1]['authorization'], 'Bearer ' + FAKE_KEY)
            self.assertNotIn(FAKE_KEY, json.dumps(result))
            self.assertEqual(request('/api/books/' + book_id + '/ai', 'POST', {**body, 'apiKey': 'forbidden'})[0], 400)
            self.assertEqual(request('/api/books/missing/ai', 'POST', body)[0], 404)
            self.assertEqual(request('/api/ai/test', 'POST', {'body': 'must not be sent'})[0], 400)
            Stub.reply = {'nodes': [{'key': 'story', 'parentKey': None, 'kind': 'story', 'title': '候选总纲', 'body': '一个新的故事方向。'}]}
            outline_body = {'action': 'outline', 'chapterIds': [], 'instruction': '只生成候选总纲。', 'skillIds': []}
            self.assertEqual(request('/api/books/' + book_id + '/ai/preview', 'POST', outline_body)[0], 200)
            self.assertEqual(request('/api/books/' + book_id + '/ai', 'POST', outline_body)[1]['data']['nodes'][0]['kind'], 'story')
            Stub.mode, Stub.reply = 'plain', '自由形式的咨询回答。'
            custom_body = {'action': 'custom', 'chapterIds': [], 'instruction': '请讨论一个创作方向。', 'skillIds': []}
            self.assertEqual(request('/api/books/' + book_id + '/ai', 'POST', custom_body)[1]['data']['text'], Stub.reply)
            self.assertEqual(request('/api/books/' + book_id + '/ai/preview', 'POST', {**custom_body, 'instruction': ''})[0], 400)
            self.assertEqual(request('/api/books/' + book_id)[1]['book'], book)
            self.assertNotIn(FAKE_KEY.encode(), app.DB_PATH.read_bytes())
        finally:
            if http:
                http.shutdown()
                http.server_close()
                thread.join()
            app.DB_PATH, app.DESKTOP_TOKEN = previous_path, previous_token

    def test_symlink_config_is_refused(self):
        self.service.data_dir.mkdir()
        destination = Path(self.directory.name) / 'other.json'
        destination.write_text('{}')
        self.service.path.symlink_to(destination)
        with self.assertRaises(AIError):
            self.service.get_settings()
        self.assertEqual(destination.read_text(), '{}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
