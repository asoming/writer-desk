"""Home aggregates and real HTTP workflows use disposable libraries only."""
import argparse
import copy
from datetime import date, timedelta
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import home_dashboard
import planning
import server

SERVICE = None
CANONICAL = ROOT / 'examples/tide-archive.yejian.json'
CANONICAL_HASH = hashlib.sha256(CANONICAL.read_bytes()).hexdigest()


class AggregateTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT,payload TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT)')
        planning.initialize(self.conn)
        home_dashboard.initialize(self.conn)
        self.today = date(2026, 10, 15)

    def tearDown(self):
        self.conn.close()

    def book(self, title='测试', kind='long', body='甲🌊 乙\n'):
        book = server.new_book(title, kind)
        book['chapters'] = [server.chapter(body=body, volume_id=book['volumes'][0]['id'] if kind == 'long' else None)]
        server.insert_book(self.conn, book)
        return book

    def activity(self, book, day, amount):
        self.conn.execute('INSERT INTO writing_activity VALUES(?,?,?,?)', (book['id'], day.isoformat(), amount, server.now()))

    def stats(self):
        return home_dashboard.statistics(self.conn, server.book_summary, self.today.isoformat())

    def test_empty_library_is_zero_filled_and_read_only(self):
        changes = self.conn.total_changes
        result = self.stats()
        self.assertEqual(result['settings'], {'dailyGoal': 2000})
        self.assertEqual(result['recentBooks'], [])
        self.assertTrue(all(value == 0 for value in result['totals'].values()))
        self.assertEqual(len(result['days']), 90)
        self.assertEqual(result['days'][-1], {'date': '2026-10-15', 'addedChars': 0})
        self.assertEqual(self.conn.total_changes, changes)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM home_settings').fetchone()[0], 0)

    def test_library_aggregates_same_day_books_once_and_ignores_recycled_chapters(self):
        long = self.book()
        long['chapters'].append({**server.chapter(body='secret' * 10), 'deletedAt': server.now()})
        self.conn.execute('UPDATE books SET payload=? WHERE id=?', (json.dumps(long), long['id']))
        short = self.book('短篇', 'short', '海风。')
        self.activity(long, self.today, 7)
        self.activity(short, self.today, 9)
        self.activity(short, self.today + timedelta(days=1), 100)
        result = self.stats()
        self.assertEqual(result['totals']['todayChars'], 16)
        self.assertEqual(result['totals']['totalChars'], 6)
        self.assertEqual(result['totals']['chapterCount'], 2)
        self.assertEqual((result['totals']['longCount'], result['totals']['shortCount']), (1, 1))
        self.assertEqual(result['totals']['writingDays'], 1)
        self.assertEqual(result['totals']['last7Chars'], 16)

    def test_streak_uses_all_history_and_yesterday_until_today_is_finished(self):
        book = self.book()
        for offset in range(1, 122):
            self.activity(book, self.today - timedelta(days=offset), 1)
        result = self.stats()
        self.assertEqual(result['totals']['currentStreak'], 121)
        self.assertEqual(result['totals']['bestStreak'], 121)
        self.assertEqual(result['totals']['writingDays'], 121)
        self.assertEqual(len(result['days']), 90)
        self.assertEqual(result['totals']['todayChars'], 0)
        self.activity(book, self.today, 5)
        self.assertEqual(self.stats()['totals']['currentStreak'], 122)
        self.conn.execute('DELETE FROM writing_activity WHERE local_day=?', ((self.today - timedelta(days=1)).isoformat(),))
        self.assertEqual(self.stats()['totals']['currentStreak'], 1)

    def test_trash_restore_and_permanent_deletion_have_explicit_active_library_scope(self):
        book = self.book()
        self.activity(book, self.today, 10)
        self.conn.execute('UPDATE books SET deleted_at=? WHERE id=?', (server.now(), book['id']))
        self.assertEqual(self.stats()['totals']['bookCount'], 0)
        self.assertEqual(self.stats()['totals']['todayChars'], 0)
        self.conn.execute('UPDATE books SET deleted_at=NULL WHERE id=?', (book['id'],))
        self.assertEqual(self.stats()['totals']['todayChars'], 10)
        planning.purge_book(self.conn, book['id'])
        self.conn.execute('DELETE FROM books WHERE id=?', (book['id'],))
        self.assertEqual(self.stats()['totals']['bookCount'], 0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM writing_activity').fetchone()[0], 0)

    def test_global_goal_is_validated_and_never_changes_book_goals_or_revisions(self):
        self.book()
        before = [tuple(row) for row in self.conn.execute('SELECT * FROM books')]
        for invalid in ({}, {'dailyGoal': True}, {'dailyGoal': -1}, {'dailyGoal': 1000001}, {'dailyGoal': 1.5}, {'dailyGoal': '2500'}, {'dailyGoal': 2500, 'bookId': 'foreign'}, []):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                home_dashboard.update_settings(self.conn, invalid)
        for goal in (0, 3250, 1000000):
            self.assertEqual(home_dashboard.update_settings(self.conn, {'dailyGoal': goal}), {'dailyGoal': goal})
            self.assertEqual(self.stats()['settings']['dailyGoal'], goal)
        self.assertEqual([tuple(row) for row in self.conn.execute('SELECT * FROM books')], before)

    def test_recent_books_are_limited_and_all_book_totals_remain_complete(self):
        for index in range(10):
            book = self.book('作品' + str(index))
            self.conn.execute('UPDATE books SET updated_at=? WHERE id=?', (f'2026-10-{index+1:02d}T00:00:00Z', book['id']))
        result = self.stats()
        self.assertEqual(result['totals']['bookCount'], 10)
        self.assertEqual(result['totals']['totalChars'], 30)
        self.assertEqual(len(result['recentBooks']), 6)
        self.assertEqual(result['recentBooks'][0]['title'], '作品9')


class HomeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='writer-home-http-')
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name).resolve()
        command = [str(SERVICE)] if SERVICE else [sys.executable, str(ROOT / 'server.py')]
        self.process = subprocess.Popen([*command, '--port', '0', '--data-dir', str(self.data)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'WRITER_DESKTOP_TOKEN': 'isolated-home-test'})
        self.addCleanup(self.stop)
        startup = self.process.stdout.readline().strip()
        if '：http://127.0.0.1:' not in startup:
            self.fail('Isolated home service did not start: ' + startup)
        self.url = startup.split('：', 1)[1]

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
            self.process.communicate(timeout=15)
            self.process = None

    def tearDown(self):
        self.assertEqual(hashlib.sha256(CANONICAL.read_bytes()).hexdigest(), CANONICAL_HASH)

    def request(self, path, method='GET', data=None, status=200, token=True, json_body=True):
        headers = {'Content-Type': 'application/json', 'X-Writer-Client': '1'}
        if token:
            headers['X-Writer-Desktop'] = 'isolated-home-test'
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        try:
            with urllib.request.urlopen(urllib.request.Request(self.url + path, data=body, method=method, headers=headers), timeout=30) as response:
                code, raw = response.status, response.read()
        except urllib.error.HTTPError as problem:
            code, raw = problem.code, problem.read()
        self.assertEqual(code, status, (path, raw[:300]))
        return json.loads(raw) if json_body else raw.decode()

    def test_full_example_saved_growth_import_conflict_restore_and_readonly_home(self):
        shelf = self.request('/api/books')['books']
        book_id = next(book['id'] for book in shelf if book['charCount'] == 101506)
        before = self.request('/api/books/' + book_id)
        initial = self.request('/api/home')
        self.assertEqual(initial['totals']['todayChars'], 0)
        self.assertEqual(initial['totals']['totalChars'], sum(book['charCount'] for book in shelf))
        self.assertEqual(self.request('/api/books/' + book_id), before)
        changed = copy.deepcopy(before)
        changed['book']['chapters'][0]['body'] += '\n验证🌊'
        saved = self.request('/api/books/' + book_id, 'PUT', {'book': changed['book'], 'revision': before['revision']})
        self.assertEqual(self.request('/api/home')['totals']['todayChars'], 3)
        self.request('/api/books/' + book_id, 'PUT', {'book': changed['book'], 'revision': before['revision']}, status=409)
        self.assertEqual(self.request('/api/home')['totals']['todayChars'], 3)
        self.request('/api/books/' + book_id, 'PUT', {'book': before['book'], 'revision': saved['revision'], 'saveReason': 'restore'})
        imported = self.request('/api/import', 'POST', {'format': 'yejian-backup', 'version': 4, 'book': before['book']}, status=201)
        home = self.request('/api/home')
        self.assertEqual(home['totals']['todayChars'], 3)
        self.assertEqual(home['totals']['bookCount'], len(shelf) + 1)
        self.assertEqual(home['totals']['totalChars'], initial['totals']['totalChars'] + 101506)
        self.assertNotEqual(imported['book']['id'], book_id)

    def test_global_settings_persist_without_book_write_and_api_static_guards(self):
        before = self.request('/api/books')
        self.assertEqual(self.request('/api/home/settings', 'PUT', {'dailyGoal': 4321}), {'settings': {'dailyGoal': 4321}})
        self.assertEqual(self.request('/api/home')['settings']['dailyGoal'], 4321)
        self.assertEqual(self.request('/api/books'), before)
        self.request('/api/home', status=403, token=False)
        self.request('/api/home/settings', 'PUT', {'dailyGoal': 5}, status=403, token=False)
        self.request('/api/home/settings', 'PUT', {'dailyGoal': True}, status=400)
        self.request('/api/home/settings', 'PUT', {'dailyGoal': 5, 'bookId': 'none'}, status=400)
        for resource in ('home-dashboard.js', 'home-dashboard.css', 'interface-polish.js', 'interface-polish.css'):
            self.assertGreater(len(self.request('/' + resource, json_body=False)), 100)
        self.stop()
        self.process = subprocess.Popen(([str(SERVICE)] if SERVICE else [sys.executable, str(ROOT / 'server.py')]) + ['--port', '0', '--data-dir', str(self.data)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'WRITER_DESKTOP_TOKEN': 'isolated-home-test'})
        self.url = self.process.stdout.readline().strip().split('：', 1)[1]
        self.assertEqual(self.request('/api/home')['settings']['dailyGoal'], 4321)

    def test_real_book_trash_restore_and_purge_refresh_library_counts_and_activity(self):
        initial = self.request('/api/home')
        book_id = next(book['id'] for book in initial['recentBooks'] if book['charCount'] == 101506)
        current = self.request('/api/books/' + book_id)
        current['book']['chapters'][0]['body'] += '新增'
        saved = self.request('/api/books/' + book_id, 'PUT', {'book': current['book'], 'revision': current['revision']})
        written = self.request('/api/home')
        self.assertEqual(written['totals']['todayChars'], 2)
        trashed = self.request('/api/books/' + book_id + '/trash', 'POST', {'revision': saved['revision']})
        hidden = self.request('/api/home')
        self.assertEqual(hidden['totals']['bookCount'], initial['totals']['bookCount'] - 1)
        self.assertEqual(hidden['totals']['totalChars'], written['totals']['totalChars'] - 101508)
        self.assertEqual(hidden['totals']['todayChars'], 0)
        self.assertNotIn(book_id, [book['id'] for book in hidden['recentBooks']])
        restored = self.request('/api/books/' + book_id + '/restore', 'POST', {'revision': trashed['revision']})
        self.assertEqual(self.request('/api/home')['totals']['todayChars'], 2)
        self.assertEqual(self.request('/api/home')['totals']['bookCount'], initial['totals']['bookCount'])
        trashed = self.request('/api/books/' + book_id + '/trash', 'POST', {'revision': restored['revision']})
        self.request('/api/books/' + book_id + '/purge', 'POST', {'revision': trashed['revision']})
        deleted = self.request('/api/home')
        self.assertEqual(deleted['totals']['todayChars'], 0)
        self.assertNotIn(book_id, [book['id'] for book in deleted['recentBooks']])
        with sqlite3.connect(str(self.data / 'writer.sqlite3')) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM writing_activity WHERE book_id=?', (book_id,)).fetchone()[0], 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', type=Path)
    arguments, remaining = parser.parse_known_args()
    SERVICE = arguments.service.resolve() if arguments.service else None
    unittest.main(argv=[sys.argv[0], *remaining])
