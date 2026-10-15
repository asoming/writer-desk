"""Binary export routes against an ephemeral library, never personal books."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class ExportHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='writer-exports-')
        cls.process = subprocess.Popen([sys.executable, str(ROOT / 'server.py'), '--port', '0', '--data-dir', cls.directory.name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        startup = cls.process.stdout.readline().strip()
        if '：http://127.0.0.1:' not in startup:
            cls.process.terminate();cls.process.wait(timeout=10)
            raise RuntimeError('Disposable export server failed: ' + startup + cls.process.stderr.read())
        cls.url = startup.split('：', 1)[1]

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate();cls.process.wait(timeout=10)
        cls.process.stdout.close();cls.process.stderr.close();cls.directory.cleanup()

    def request(self, path, method='GET', data=None, origin=None):
        headers = {'Content-Type': 'application/json', 'X-Writer-Client': '1'}
        if origin:
            headers['Origin'] = origin
        request = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data).encode(), method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_actual_binary_downloads_remain_book_scoped_and_read_only(self):
        status, _, payload = self.request('/api/books', 'POST', {'title': '只导出这本书'})
        self.assertEqual(status, 201)
        record = json.loads(payload);book = record['book'];bid = book['id']
        book['chapters'] = [{'id': 'only-chapter', 'title': '只这一章', 'body': '必须包含的本书正文 & <安全转义>。', 'volumeId': book['volumes'][0]['id'], 'deletedAt': None}]
        status, _, payload = self.request('/api/books/' + bid, 'PUT', {'book': book, 'revision': record['revision']})
        self.assertEqual(status, 200)
        before = self.request('/api/books/' + bid)[2]
        for format_, mime in [('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), ('epub', 'application/epub+zip'), ('html', 'text/html; charset=utf-8')]:
            status, headers, payload = self.request('/api/books/' + bid + '/export-formatted', 'POST', {'format': format_, 'cover': False, 'toc': True, 'paper': 'a4', 'font': 14, 'lang': 'zh'})
            self.assertEqual(status, 200)
            self.assertEqual(headers.get('Content-Type'), mime)
            if format_ != 'html':
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    self.assertIsNone(archive.testzip())
            else:
                self.assertIn('必须包含的本书正文 &amp; &lt;安全转义&gt;。'.encode(), payload)
                self.assertNotIn('沈砚把裁纸刀放下时'.encode(), payload)
        self.assertEqual(self.request('/api/books/' + bid)[2], before)
        self.assertEqual(self.request('/api/books/' + bid + '/export-formatted', 'POST', {'format': 'pdf'})[0], 400)
        self.assertEqual(self.request('/api/books/' + bid + '/export-formatted', 'POST', {'format': 'docx'}, 'https://foreign.example')[0], 403)
        self.assertEqual(self.request('/api/books/missing-book/export-formatted', 'POST', {'format': 'epub'})[0], 404)
        for name in ('formatted-export.js', 'formatted-export.css'):
            self.assertEqual(self.request('/' + name)[0], 200)


if __name__ == '__main__':
    unittest.main()
