"""Cover AI calls only a disposable loopback stub with fake credentials."""
import base64
import copy
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIError, AIService, MAX_IMAGE_BYTES
from verify_ai import Stub, FAKE_KEY, SAMPLE
import server

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGNkYPjPwMDAxMDAgKAAEkIBBZH9Q6gAAAAASUVORK5CYII='
JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxyiiiv3E8w//Z'
WEBP = 'UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA'


class CoverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = ThreadingHTTPServer(('127.0.0.1', 0), Stub)
        cls.thread = threading.Thread(target=cls.stub.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = 'http://127.0.0.1:' + str(cls.stub.server_port) + '/custom/v1'

    @classmethod
    def tearDownClass(cls):
        cls.stub.shutdown()
        cls.stub.server_close()
        cls.thread.join()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='writer-ai-cover-')
        self.addCleanup(self.temporary.cleanup)
        self.service = AIService(Path(self.temporary.name) / 'data')
        self.book = copy.deepcopy(SAMPLE)
        Stub.mode, Stub.reply, Stub.received = 'draft', None, []
        Stub.error_reply, Stub.error_status = None, 400

    def configure(self, **values):
        return self.service.save_settings({'enabled': True, 'endpoint': self.endpoint, 'model': 'stub-text', **values})

    def image(self, encoded=PNG):
        Stub.mode, Stub.reply = 'image', {'data': [{'b64_json': encoded}]}

    def test_legacy_settings_keep_text_config_and_images_require_an_explicit_model(self):
        self.service.data_dir.mkdir()
        old = {'enabled': True, 'endpoint': self.endpoint, 'model': 'legacy-text', 'apiKey': FAKE_KEY, 'maxContextChars': 123456}
        self.service.path.write_text(json.dumps(old))
        settings = self.service.get_settings()
        self.assertEqual(settings['imageModel'], '')
        self.assertEqual(settings['model'], 'legacy-text')
        self.assertEqual(settings['contextMode'], 'manual')
        self.assertEqual(json.loads(self.service.path.read_text()), old)
        with self.assertRaises(AIError) as error:
            self.service.cover_image('蓝色海港的封面背景，不要文字。')
        self.assertEqual(error.exception.status, 400)
        self.assertIn('图片模型', str(error.exception))
        self.assertEqual(Stub.received, [])
        public = self.configure(imageModel='stub-image')
        self.assertEqual(public['imageModel'], 'stub-image')
        self.assertNotIn(FAKE_KEY, json.dumps(public))
        for invalid in [None, [], True, 'x' * 201]:
            with self.assertRaises(AIError):
                self.configure(imageModel=invalid)

    def test_book_cover_text_plan_has_exact_schema_uses_server_material_and_never_sends_a_cover_image(self):
        self.configure()
        self.book['cover'] = 'data:image/png;base64,' + PNG
        original = copy.deepcopy(self.book)
        Stub.reply = {'titles': ['潮汐档案馆', '最后一份来信'], 'coverPrompt': '蓝灰色海港与档案馆，竖幅构图，上方留白，不要文字。'}
        prompt = '请给我两个中文书名和符合悬疑气氛的背景方案。'
        preview = self.service.preview(self.book, 'book_cover', [], prompt, skill_ids=[])
        self.assertEqual(preview['counts']['chapters'], 0)
        self.assertEqual(preview['counts']['outlines'], len(self.book['outline']))
        self.assertEqual(Stub.received, [])
        result = self.service.run(self.book, 'book_cover', [], prompt, skill_ids=[])
        self.assertEqual(result['data'], Stub.reply)
        sent = Stub.received[-1]['payload']['messages']
        self.assertIn('操作为book_cover', sent[0]['content'])
        self.assertEqual(json.loads(sent[1]['content'])['instruction'], prompt)
        self.assertEqual(len(sent[1]['content']), preview['contextChars'])
        self.assertNotIn(PNG, sent[1]['content'])
        self.assertNotIn('cover', json.loads(sent[1]['content']))
        self.assertEqual(self.book, original)
        self.assertTrue(all(item['path'].endswith('/chat/completions') for item in Stub.received))
        for invalid in [{'titles': [], 'coverPrompt': '背景'}, {'titles': ['重复', ' 重复 '], 'coverPrompt': '背景'},
                        {'titles': ['Name', 'NAME'], 'coverPrompt': '背景'}, {'titles': ['x' * 201], 'coverPrompt': '背景'},
                        {'titles': ['有效'], 'coverPrompt': ''}, {'titles': ['有效'], 'coverPrompt': 'data:image/png;base64,' + PNG},
                        {'titles': ['有效'], 'coverPrompt': '背景', 'image': PNG}]:
            Stub.reply = invalid
            with self.assertRaises(AIError) as error:
                self.service.run(self.book, 'book_cover', [], prompt, skill_ids=[])
            self.assertEqual(error.exception.status, 502)

    def test_image_request_uses_same_origin_key_explicit_model_exact_prompt_and_only_base64_rasters(self):
        self.configure(apiKey=FAKE_KEY, imageModel='stub-image', timeoutSeconds=120)
        for encoded, mime in [(PNG, 'png'), (JPEG, 'jpeg'), (WEBP, 'webp')]:
            self.image(encoded)
            before = len(Stub.received)
            prompt = '  可编辑提示词：海港，竖幅，上方留白，不要文字。\n'
            result = self.service.cover_image(prompt)
            self.assertEqual(result, {'image': 'data:image/' + mime + ';base64,' + encoded})
            self.assertEqual(len(Stub.received), before + 1)
            request = Stub.received[-1]
            self.assertEqual(request['path'], '/custom/v1/images/generations')
            self.assertEqual(request['authorization'], 'Bearer ' + FAKE_KEY)
            self.assertEqual(request['payload'], {'model': 'stub-image', 'prompt': prompt, 'n': 1, 'size': '1024x1536'})
        for prompt in ['', ' ', 'x' * 10001, '背景 data:image/png;base64,' + PNG]:
            before = len(Stub.received)
            with self.assertRaises(AIError) as error:
                self.service.cover_image(prompt)
            self.assertEqual(error.exception.status, 400)
            self.assertEqual(len(Stub.received), before)

    def test_image_response_rejects_urls_bad_containers_oversize_and_unsafe_pixel_dimensions(self):
        self.configure(imageModel='stub-image')
        oversized = bytearray(base64.b64decode(PNG))
        oversized[16:20] = (20000).to_bytes(4, 'big')
        oversized[29:33] = zlib.crc32(oversized[12:29]).to_bytes(4, 'big')
        webp_canvas = b'VP8X' + (10).to_bytes(4, 'little') + b'\0' * 4 + (19999).to_bytes(3, 'little') * 2
        webp_body = webp_canvas + base64.b64decode(WEBP)[12:]
        oversized_webp = b'RIFF' + (len(webp_body) + 4).to_bytes(4, 'little') + b'WEBP' + webp_body
        invalids = [{'data': [{'url': self.endpoint + '/must-not-fetch'}]}, {'data': [{'b64_json': PNG, 'url': self.endpoint}]},
                    {'data': []}, {'data': [{'b64_json': PNG}, {'b64_json': PNG}]}, {'data': [{'b64_json': 'invalid!'}]}]
        for content in [b'<svg>not raster</svg>', b'\x89PNG\r\n\x1a\n' + b'garbage' * 20, b'\xff\xd8\xffgarbage\xff\xd9',
                        b'RIFF\0\0\0\0WEBPVP8 garbage', bytes(oversized), oversized_webp, b'x' * (MAX_IMAGE_BYTES + 1)]:
            invalids.append({'data': [{'b64_json': base64.b64encode(content).decode()}]})
        for reply in invalids:
            Stub.mode, Stub.reply = 'image', reply
            before = len(Stub.received)
            with self.assertRaises(AIError) as error:
                self.service.cover_image('背景方案')
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn(FAKE_KEY, str(error.exception))
            self.assertEqual(len(Stub.received), before + 1)
        self.assertTrue(all(request['path'] == '/custom/v1/images/generations' for request in Stub.received))

    def test_images_never_follow_redirects_retry_or_echo_provider_errors(self):
        self.configure(apiKey=FAKE_KEY, imageModel='stub-image', timeoutSeconds=1)
        for mode in ['redirect', 'error', 'invalid', 'timeout']:
            Stub.mode = mode
            before = len(Stub.received)
            with self.assertRaises(AIError) as error:
                self.service.cover_image('背景方案')
            self.assertEqual(error.exception.status, 502)
            self.assertNotIn(FAKE_KEY, str(error.exception))
            self.assertEqual(len(Stub.received), before + 1)
        self.assertTrue(all(request['path'] == '/custom/v1/images/generations' for request in Stub.received))

    def test_new_book_plan_and_image_http_routes_are_read_only_and_preview_never_sends(self):
        old_db, old_token = server.DB_PATH, server.DESKTOP_TOKEN
        server.DB_PATH, server.DESKTOP_TOKEN = self.service.data_dir / 'writer.sqlite3', ''
        class Quiet(server.Handler):
            def log_message(self, *args):
                pass
        http = None
        try:
            server.initialize()
            http = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            def request(path, method='GET', data=None):
                body = None if data is None else json.dumps(data).encode()
                req = urllib.request.Request('http://127.0.0.1:' + str(http.server_port) + path, data=body, method=method,
                                             headers={'Content-Type': 'application/json', 'X-Writer-Client': '1'})
                try:
                    with urllib.request.urlopen(req, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            self.configure(imageModel='stub-image')
            before = request('/api/books')[1]
            body = {'title': '', 'kind': 'long', 'prompt': '请根据海港失踪案设计方案。', 'skillIds': [], 'skillMode': 'auto', 'preview': True}
            code, preview = request('/api/ai/book-cover', 'POST', body)
            self.assertEqual(code, 200)
            self.assertEqual(preview['counts'], dict(chapters=0, outlines=0, people=0, relationships=0))
            self.assertEqual(preview['action'], 'book_cover')
            self.assertIsNone(preview['maxContextChars'])
            self.assertNotIn('bookId', preview)
            self.assertEqual(Stub.received, [])
            Stub.reply = {'titles': ['海港来信'], 'coverPrompt': '海港，迷雾，顶部留白，无文字。'}
            code, result = request('/api/ai/book-cover', 'POST', {**body, 'preview': False})
            self.assertEqual(code, 200)
            self.assertEqual(result['data'], Stub.reply)
            self.assertNotIn('bookId', result)
            for bad in [{**body, 'cover': PNG}, {**body, 'preview': None}, {**body, 'title': []}, {**body, 'kind': []},
                        {**body, 'skillIds': None}, {**body, 'prompt': 'x' * 10001}]:
                self.assertEqual(request('/api/ai/book-cover', 'POST', bad)[0], 400)
            self.image()
            self.assertEqual(request('/api/ai/cover-image', 'POST', {'prompt': '蓝色海港'})[1]['image'], 'data:image/png;base64,' + PNG)
            self.assertEqual(request('/api/ai/cover-image', 'POST', {'prompt': '海港', 'image': PNG})[0], 400)
            self.assertEqual(request('/api/books')[1], before)
            self.configure(contextMode='manual', maxContextChars=1)
            self.assertTrue(request('/api/ai/book-cover', 'POST', body)[1]['overLimit'])
            self.assertEqual(request('/api/ai/book-cover', 'POST', {**body, 'preview': False})[0], 400)
        finally:
            if http:
                http.shutdown()
                http.server_close()
                worker.join()
            server.DB_PATH, server.DESKTOP_TOKEN = old_db, old_token

    def test_cover_template_ids_validate_and_legacy_backups_remain_compatible(self):
        book = server.new_book('封面模板检验')
        self.assertEqual(book['coverTemplate'], '')
        for template in server.COVER_TEMPLATE_IDS:
            original = {**book, 'cover': 'data:image/png;base64,' + PNG, 'coverTemplate': template}
            clean = server.validate_book(original)
            self.assertEqual(clean['coverTemplate'], template)
            self.assertEqual(server.restore_book(clean)['coverTemplate'], template)
            self.assertEqual(clean, original)
        for invalid in ['unknown', '../ocean', None, True, [], {}]:
            with self.assertRaises(ValueError):
                server.validate_book({**book, 'coverTemplate': invalid})
        legacy = {key: value for key, value in book.items() if key != 'coverTemplate'}
        self.assertEqual(server.validate_book(legacy)['coverTemplate'], '')
        self.assertNotIn('coverTemplate', legacy)
        self.assertEqual(server.upgrade_book(copy.deepcopy(legacy))['coverTemplate'], '')


if __name__ == '__main__':
    unittest.main(verbosity=2)
