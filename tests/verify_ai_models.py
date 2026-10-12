"""Model discovery and selection use disposable loopback services and fake keys."""
import copy
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIService, AIError, MAX_RESPONSE_BYTES
from verify_ai import SAMPLE, FAKE_KEY


class ModelsStub(BaseHTTPRequestHandler):
    mode = 'normal'
    received = []
    result = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.received.append({'method': 'GET', 'path': self.path, 'authorization': self.headers.get('Authorization')})
        if self.mode == 'redirect':
            self.send_response(302)
            self.send_header('Location', '/should-never-receive-key')
            self.end_headers()
            return
        self.send_response(401 if self.mode == 'error' else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if self.mode == 'large':
            self.wfile.write(b'x' * (MAX_RESPONSE_BYTES + 1))
        elif self.mode in {'error', 'invalid'}:
            self.wfile.write(('provider body secret ' + FAKE_KEY).encode())
        else:
            value = self.result if self.result is not None else {'data': [
                {'id': 'alpha', 'owned_by': FAKE_KEY}, {'id': 'beta'}, {'id': 'alpha'}]}
            self.wfile.write(json.dumps(value).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.received.append({'method': 'POST', 'path': self.path, 'authorization': self.headers.get('Authorization'), 'payload': body})
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
            'content': json.dumps({'reply': '仅供讨论。', 'data': None})}}]}).encode())


class ModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.provider = ThreadingHTTPServer(('127.0.0.1', 0), ModelsStub)
        cls.thread = threading.Thread(target=cls.provider.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.provider.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.provider.shutdown()
        cls.provider.server_close()
        cls.thread.join()

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='writer-models-test-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.environment = patch.dict(os.environ, {'CODEX_HOME': str(self.root / 'codex')})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.service = AIService(self.root / 'data')
        self.service.save_settings({'enabled': True, 'endpoint': self.base + '/v1', 'model': 'custom-existing', 'apiKey': FAKE_KEY})
        ModelsStub.mode, ModelsStub.result, ModelsStub.received = 'normal', None, []

    def test_base_and_chat_completion_urls_derive_same_model_endpoint_with_auth(self):
        for suffix in ['/v1', '/v1/', '/v1/chat/completions', '/v1/chat/completions/']:
            self.service.save_settings({'endpoint': self.base + suffix})
            self.assertEqual(self.service.list_models(), {'models': [{'id': 'alpha'}, {'id': 'beta'}]})
            self.assertEqual(ModelsStub.received[-1], {'method': 'GET', 'path': '/v1/models', 'authorization': 'Bearer ' + FAKE_KEY})
        self.assertEqual(self.service.get_settings()['model'], 'custom-existing')
        self.assertNotIn(FAKE_KEY, json.dumps(self.service.list_models()))

    def test_unsaved_provider_draft_uses_new_or_retained_key_without_writing_settings(self):
        before = self.service.path.read_bytes()
        for data, expected in [({'endpoint': self.base + '/compatible', 'apiKey': 'draft-key'}, 'Bearer draft-key'),
                               ({'endpoint': self.base + '/compatible', 'apiKey': ''}, 'Bearer ' + FAKE_KEY),
                               ({'endpoint': self.base + '/compatible', 'clearKey': True}, None)]:
            self.service.list_models(data)
            self.assertEqual(ModelsStub.received[-1]['path'], '/compatible/models')
            self.assertEqual(ModelsStub.received[-1]['authorization'], expected)
            self.assertEqual(self.service.path.read_bytes(), before)

    def test_empty_or_unconfigured_model_does_not_block_model_discovery(self):
        self.service.save_settings({'enabled': False, 'model': '', 'apiKey': '', 'clearKey': True})
        self.assertEqual(len(self.service.list_models()['models']), 2)
        self.assertIsNone(ModelsStub.received[-1]['authorization'])
        self.assertEqual(self.service.get_settings()['model'], '')

    def test_validation_happens_before_any_external_request(self):
        bad = [None, [], {'apiKey': 'a\nAuthorization: bad'}, {'clearKey': 1}, {'timeoutSeconds': 0},
               {'timeoutSeconds': True}, {'model': 'not-a-discovery-parameter'}, {'endpoint': ''},
               {'endpoint': 'http://not-loopback.test/v1'}, {'endpoint': 'https://name:password@example.test/v1'},
               {'endpoint': 'https://example.test/v1?key=private'}, {'endpoint': 'https://example.test/v1#secret'}]
        for data in bad:
            with self.assertRaises(AIError):
                if data is None:
                    AIService(self.root / 'unconfigured').list_models()
                else:
                    self.service.list_models(data)
        self.assertEqual(ModelsStub.received, [])

    def test_untrusted_response_metadata_and_credential_echo_are_never_forwarded(self):
        ModelsStub.result = {'object': 'list', 'secret': FAKE_KEY, 'data': [
            {'id': 'safe-model', 'owned_by': FAKE_KEY, 'secret': FAKE_KEY},
            {'id': 'prefix-' + FAKE_KEY + '-suffix'}]}
        result = self.service.list_models()
        self.assertEqual(result, {'models': [{'id': 'safe-model'}]})
        self.assertNotIn(FAKE_KEY, json.dumps(result))
        ModelsStub.result = {'data': []}
        self.assertEqual(self.service.list_models(), {'models': []})

    def test_http_invalid_and_oversized_errors_are_safe_and_never_retry(self):
        for mode in ['error', 'invalid', 'large']:
            ModelsStub.mode = mode
            before = len(ModelsStub.received)
            with self.assertRaises(AIError) as error:
                self.service.list_models()
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn(FAKE_KEY, str(error.exception))
            self.assertIn('手动填写', str(error.exception))
            self.assertEqual(len(ModelsStub.received), before + 1)
        ModelsStub.mode = 'normal'
        for result in [{}, {'data': {}}, {'data': [None]}, {'data': [{'id': ''}]},
                       {'data': [{'id': 'invalid\nmodel'}]}, {'data': [{'id': 'x' * 201}]}]:
            ModelsStub.result = result
            with self.assertRaises(AIError) as error:
                self.service.list_models()
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn(FAKE_KEY, str(error.exception))

    def test_redirects_stop_before_credentials_can_reach_the_target(self):
        ModelsStub.mode = 'redirect'
        with self.assertRaises(AIError) as error:
            self.service.list_models()
        self.assertEqual(error.exception.status, 502)
        self.assertIn('重定向', str(error.exception))
        self.assertEqual(len(ModelsStub.received), 1)

    def test_selected_model_snapshot_does_not_change_default_or_manuscript(self):
        book = copy.deepcopy(SAMPLE)
        before = copy.deepcopy(book)
        self.service.run(book, 'custom', [], '继续讨论。', chat=True, history=[], model='beta')
        self.assertEqual(ModelsStub.received[-1]['payload']['model'], 'beta')
        self.assertEqual(self.service.get_settings()['model'], 'custom-existing')
        self.assertEqual(book, before)
        for model in ['', 17, 'x' * 201, 'invalid\nmodel']:
            count = len(ModelsStub.received)
            with self.assertRaises(AIError):
                self.service.run(book, 'custom', [], '继续讨论。', chat=True, history=[], model=model)
            self.assertEqual(len(ModelsStub.received), count)

    def test_real_http_routes_discover_without_changing_books_and_persist_chosen_model(self):
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
            def request(path, data=None, method=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request(base + path, data=body, method=method,
                    headers={'Content-Type': 'application/json', 'X-Writer-Client': '1'})
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            before = request('/api/books')[1]
            self.assertEqual(request('/api/ai/models')[1], {'models': [{'id': 'alpha'}, {'id': 'beta'}]})
            self.assertEqual(request('/api/ai/models', {'endpoint': self.base + '/draft'})[0], 200)
            self.assertEqual(request('/api/ai/models', {'apiKey': 'bad\nkey'})[0], 400)
            self.assertEqual(request('/api/ai/models', {'book': 'private manuscript'})[0], 400)
            status, settings = request('/api/ai/settings', {'model': 'beta'}, 'PUT')
            self.assertEqual(status, 200)
            self.assertEqual(settings['model'], 'beta')
            self.assertNotIn('apiKey', settings)
            self.assertEqual(AIService(self.service.data_dir).get_settings()['model'], 'beta')
            book_id = before['books'][0]['id']
            body = {'action': 'custom', 'chapterIds': [], 'instruction': '仅讨论。', 'chat': True, 'history': [], 'model': 'alpha'}
            self.assertEqual(request('/api/books/' + book_id + '/ai/preview', body)[0], 200)
            self.assertEqual(request('/api/books/' + book_id + '/ai', body)[0], 200)
            self.assertEqual(ModelsStub.received[-1]['payload']['model'], 'alpha')
            self.assertEqual(request('/api/books/' + book_id + '/ai', {**body, 'model': None})[0], 400)
            self.assertEqual(request('/api/books')[1], before)
        finally:
            if http:
                http.shutdown()
                http.server_close()
                thread.join()
            app.DB_PATH, app.DESKTOP_TOKEN = previous_path, previous_token


if __name__ == '__main__':
    unittest.main(verbosity=2)
