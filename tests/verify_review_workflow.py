"""Real HTTP journeys for imports, proofreading data, annotations and bookmarks.

Run from source, or pass --service /absolute/path/to/WriterDesk-service to run
the identical journeys against a frozen backend. Every service uses a new,
resolved temporary data directory. The real library and canonical demo are
never changed. No third-party provider or office installation is required.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from formatted_export import render_book_export, reading_sections

SERVICE = None
CANONICAL = ROOT / 'examples/tide-archive.yejian.json'
CANONICAL_HASH = hashlib.sha256(CANONICAL.read_bytes()).hexdigest()
TOKEN = 'isolated-review-workflow'


def plain_export(book, markdown=False):
    text = ('# ' if markdown else '') + book['title'] + '\n\n'
    for section in reading_sections(book):
        text += ('#' * (section['level'] + 1) + ' ' if markdown else '') + section['title'] + '\n\n'
        if section['body']:
            text += section['body'] + '\n\n\n'
    return text.encode('utf-8-sig' if not markdown else 'utf-8')


class ReviewWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='writer-review-http-')
        self.data = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.process = None
        self.errors = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        command = [str(SERVICE)] if SERVICE else [sys.executable, str(ROOT / 'server.py')]
        self.errors = open(self.data / ('service-' + uuid.uuid4().hex + '.log'), 'w+b')
        # Match Electron's actual protocol. WRITER_READY is ASCII-safe even
        # when a frozen Windows Python ignores PYTHONIOENCODING under cp1252.
        self.process = subprocess.Popen(command + ['--desktop', '--port', '0', '--data-dir', str(self.data)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'WRITER_DESKTOP_TOKEN': TOKEN})
        ready = queue.Queue()
        output = self.process.stdout
        threading.Thread(target=lambda: ready.put(output.readline()), daemon=True).start()
        try:
            startup = ready.get(timeout=30).strip()
        except queue.Empty:
            startup = '(WRITER_READY timed out after 30 seconds)'
        if not startup.startswith('WRITER_READY '):
            self.errors.seek(0)
            diagnostic = self.errors.read().decode('utf-8', errors='replace')[-12000:]
            self.fail('Isolated review service did not start: ' + repr(startup) + '\n' + diagnostic)
        self.url = json.loads(startup[len('WRITER_READY '):])['url']

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            # EOF is the desktop's portable graceful-shutdown signal. Detach
            # the closed stream before communicate so it cannot flush it.
            if process.stdin is not None:
                process.stdin.close()
                process.stdin = None
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
        if self.errors is not None:
            self.errors.close()
            self.errors = None

    def tearDown(self):
        self.assertEqual(hashlib.sha256(CANONICAL.read_bytes()).hexdigest(), CANONICAL_HASH)

    def request(self, path, method='GET', data=None, status=200, token=True, raw=False):
        headers = {'Content-Type': 'application/json', 'X-Writer-Client': '1'}
        if token:
            headers['X-Writer-Desktop'] = TOKEN
        payload = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        request = urllib.request.Request(self.url + path, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                code, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            code, result = error.code, json.loads(error.read())
        if raw:
            return code, result
        self.assertEqual(code, status, (path, result))
        return result

    def get(self, identity):
        return self.request('/api/books/' + identity)

    def save(self, record, status=200):
        result = self.request('/api/books/' + record['book']['id'], 'PUT', {'book': record['book'], 'revision': record['revision']}, status)
        if status == 200:
            record['revision'] = result['revision']
        return result

    def demo(self):
        books = self.request('/api/books')['books']
        return self.get(next(book['id'] for book in books if book['title'] == '潮汐档案馆'))

    def editable_demo(self):
        return self.request('/api/import', 'POST', {'format': 'yejian-backup', 'version': 3, 'book': self.demo()['book']}, status=201)

    def manuscript_request(self, content, filename, kind='long'):
        return {'filename': filename, 'content': base64.b64encode(content).decode(), 'kind': kind,
                'title': '', 'options': {'strategy': 'auto', 'encoding': 'auto'}}

    def commit_request(self, source):
        preview = self.request('/api/manuscript-import/preview', 'POST', source)
        return {**source, 'sourceHash': preview['sourceHash'], 'edits': {}, 'requestId': str(uuid.uuid4())}

    def assert_no_marks(self, book, chapter_id, identities):
        for kind in ('annotations', 'bookmarks'):
            for mark in book['reviewTools'][kind]:
                self.assertNotEqual(mark['chapterId'], chapter_id)
                self.assertNotIn(mark['id'], identities)
        self.assertNotIn(chapter_id, [chapter['id'] for chapter in book['chapters']])

    def test_full_demo_three_formats_preview_commit_reopen_and_statistics(self):
        original = self.demo()
        baseline = copy.deepcopy(original['book'])
        shelf_count = len(self.request('/api/books')['books'])
        inputs = [('潮汐档案馆.txt', plain_export(baseline)), ('潮汐档案馆.md', plain_export(baseline, True))]
        content, _, filename = render_book_export(baseline, 'docx', {'cover': False, 'toc': True})
        inputs.append((filename, content))
        imported_ids = []
        for index, (filename, content) in enumerate(inputs):
            source = self.manuscript_request(content, filename)
            preview = self.request('/api/manuscript-import/preview', 'POST', source)
            self.assertEqual(len(self.request('/api/books')['books']), shelf_count + index, 'Preview cannot create a book')
            self.assertEqual(preview['words'], 101506)
            self.assertEqual((len(preview['volumes']), len(preview['chapters'])), (6, 36))
            self.assertEqual([c['body'] for c in preview['chapters']], [c['body'] for c in baseline['chapters']])
            request = {**source, 'sourceHash': preview['sourceHash'], 'edits': {'chapters': {'c0': '第一章 导入后可改标题'}}, 'requestId': str(uuid.uuid4())}
            created = self.request('/api/manuscript-import/commit', 'POST', request, status=201)
            identity = created['book']['id']; imported_ids.append(identity)
            self.assertNotEqual(identity, baseline['id'])
            self.assertEqual(created['book']['chapters'][0]['title'], '第一章 导入后可改标题')
            self.assertEqual([c['body'] for c in created['book']['chapters']], [c['body'] for c in baseline['chapters']])
            stats = self.request('/api/books/' + identity + '/writing-stats')
            self.assertEqual((stats['totalChars'], stats['todayChars']), (101506, 0))
            retry = self.request('/api/manuscript-import/commit', 'POST', request)
            self.assertEqual(retry['book']['id'], identity)
            self.assertEqual(len(self.request('/api/books')['books']), shelf_count + index + 1)
            self.assertEqual(self.get(baseline['id'])['book'], baseline)
        self.stop(); self.start()
        for identity in imported_ids:
            book = self.get(identity)['book']
            self.assertEqual((len(book['volumes']), len(book['chapters'])), (6, 36))
            self.assertEqual(self.request('/api/books/' + identity + '/writing-stats')['todayChars'], 0)
        self.assertEqual(self.get(baseline['id'])['book'], baseline)

    def test_commit_idempotency_concurrency_authentication_and_invalid_requests(self):
        source = self.manuscript_request('第一卷潮声\n第一章旧船票\n正文甲。\n第二章夜归\n正文乙。'.encode(), '隔离稿件.txt')
        request = self.commit_request(source)
        count = len(self.request('/api/books')['books'])
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.request('/api/manuscript-import/commit', 'POST', request, raw=True), range(2)))
        self.assertEqual(sorted(code for code, _ in results), [200, 201])
        self.assertEqual(results[0][1]['book']['id'], results[1][1]['book']['id'])
        self.assertEqual(len(self.request('/api/books')['books']), count + 1)
        altered = {**request, 'edits': {'chapters': {'c0': '另一个标题'}}}
        self.request('/api/manuscript-import/commit', 'POST', altered, status=409)
        for invalid in ({**request, 'sourceHash': '0'*64}, {**request, 'content': '%%%bad'}, {**request, 'arbitraryPath': '/tmp/forbidden'}, {**request, 'requestId': ''}):
            self.request('/api/manuscript-import/commit', 'POST', invalid, status=400)
        self.request('/api/manuscript-import/preview', 'POST', source, status=403, token=False)
        self.request('/api/manuscript-import/commit', 'POST', request, status=403, token=False)
        self.assertEqual(len(self.request('/api/books')['books']), count + 1)
        # Short import retains all source heading text in one continuous body.
        short = self.commit_request({**source, 'kind': 'short'})
        result = self.request('/api/manuscript-import/commit', 'POST', short, status=201)
        self.assertFalse(result['book']['volumes']); self.assertEqual(len(result['book']['chapters']), 1)
        self.assertIn('第二章夜归', result['book']['chapters'][0]['body'])

    def marks(self, book):
        chapter = book['chapters'][0]
        stamp = '2026-10-15T01:02:03+00:00'
        def mark(identity, start, end):
            return {'id': identity, 'chapterId': chapter['id'], 'start': start, 'end': end,
                    'quote': chapter['body'][start:end], 'prefix': '', 'suffix': '', 'body': '确认人物的行动动机。',
                    'label': '开篇线索', 'resolved': False, 'status': 'linked', 'createdAt': stamp, 'updatedAt': stamp}
        return {'version': 1, 'dictionary': ['沈砚', '岑栖', '返潮'],
                'annotations': [mark('annotation-http', 0, 20)], 'bookmarks': [mark('bookmark-http', 100, 120)]}

    def test_review_data_save_reopen_json_import_history_and_snapshot_restore(self):
        record = self.editable_demo(); book = record['book']; identity = book['id']
        book['reviewTools'] = self.marks(book); self.save(record)
        reviewed = self.get(identity); tools = copy.deepcopy(reviewed['book']['reviewTools'])
        self.assertEqual(self.request('/api/books/' + identity + '/writing-stats')['todayChars'], 0)
        snapshot = self.request('/api/books/' + identity + '/checkpoint', 'POST', {})['backup']
        self.assertIsNotNone(snapshot)
        self.stop(); self.start()
        reopened = self.get(identity); self.assertEqual(reopened['book']['reviewTools'], tools)
        imported = self.request('/api/import', 'POST', {'format': 'yejian-backup', 'version': 3, 'book': reopened['book']}, status=201)
        self.assertNotEqual(imported['book']['id'], identity)
        self.assertEqual(imported['book']['reviewTools'], tools)
        reopened['book']['reviewTools']['annotations'][0]['body'] = '后来修改的批注。'; self.save(reopened)
        restored = self.request('/api/books/' + identity + '/history/' + str(reviewed['revision']) + '/restore', 'POST', {'revision': reopened['revision']})
        self.assertEqual(restored['book']['reviewTools'], tools)
        restored['book']['reviewTools']['bookmarks'] = []; self.save(restored)
        snapshot_restore = self.request('/api/books/' + identity + '/backups/' + snapshot['token'] + '/restore', 'POST', {'revision': restored['revision']})
        self.assertEqual(snapshot_restore['book']['reviewTools'], tools)
        bad = copy.deepcopy(snapshot_restore); bad['book']['reviewTools']['annotations'][0]['chapterId'] = 'foreign-chapter'
        self.save(bad, status=400)
        stale = self.get(identity); stale['book']['reviewTools']['annotations'][0].update(quote='这句原文已被改掉', prefix='以前的前文', suffix='以前的后文')
        self.save(stale)
        orphan = self.get(identity)['book']['reviewTools']['annotations'][0]
        self.assertEqual(orphan['status'], 'orphaned'); self.assertEqual((orphan['prefix'], orphan['suffix']), ('', ''))
        self.assertEqual(self.request('/api/books/' + identity + '/writing-stats')['todayChars'], 0)

    def test_recycled_marks_recover_and_permanent_purge_cleans_history_and_backups(self):
        record = self.editable_demo(); book = record['book']; identity = book['id']; chapter_id = book['chapters'][0]['id']
        book['reviewTools'] = self.marks(book); self.save(record)
        self.request('/api/books/' + identity + '/checkpoint', 'POST', {})
        book['chapters'][0]['deletedAt'] = '2026-10-15T01:02:03+00:00'; self.save(record)
        recycled = self.get(identity)
        self.assertEqual(len(recycled['book']['reviewTools']['annotations']), 1, 'Recycle retains recoverable anchors')
        active = {c['id'] for c in recycled['book']['chapters'] if not c['deletedAt']}
        self.assertEqual([m for m in recycled['book']['reviewTools']['annotations'] if m['chapterId'] in active], [])
        recovered = self.request('/api/books/' + identity + '/chapters/' + chapter_id + '/restore', 'POST', {'revision': recycled['revision']})
        self.assertEqual(recovered['book']['reviewTools']['annotations'][0]['status'], 'linked')
        self.assertEqual(recovered['book']['reviewTools']['bookmarks'][0]['chapterId'], chapter_id)
        recovered['book']['chapters'][0]['deletedAt'] = '2026-10-15T01:02:03+00:00'; self.save(recovered)
        purged = self.request('/api/books/' + identity + '/chapters/' + chapter_id + '/purge', 'POST', {'revision': recovered['revision']})
        self.assertFalse(purged.get('cleanupPending', False))
        removed = {'annotation-http', 'bookmark-http'}
        self.assert_no_marks(purged['book'], chapter_id, removed)
        for historical in self.request('/api/books/' + identity + '/history')['versions']:
            self.assert_no_marks(self.request('/api/books/' + identity + '/history/' + str(historical['revision']))['book'], chapter_id, removed)
        for snapshot in self.request('/api/books/' + identity + '/backups')['backups']:
            self.assert_no_marks(self.request('/api/books/' + identity + '/backups/' + snapshot['token'])['book'], chapter_id, removed)
        with closing(sqlite3.connect(self.data / 'writer.sqlite3')) as connection:
            for row in connection.execute('SELECT payload FROM history WHERE book_id=?', (identity,)):
                self.assert_no_marks(json.loads(row[0]), chapter_id, removed)
        for path in (self.data / 'backups').rglob('r*.json'):
            snapshot = json.loads(path.read_text('utf-8'))
            if snapshot.get('book', {}).get('id') == identity:
                self.assert_no_marks(snapshot['book'], chapter_id, removed)
        self.stop(); self.start()
        self.assert_no_marks(self.get(identity)['book'], chapter_id, removed)
        self.assertEqual(self.request('/api/books/' + identity + '/writing-stats')['todayChars'], 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--service', type=Path)
    options, remaining = parser.parse_known_args()
    SERVICE = options.service.resolve() if options.service else None
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
