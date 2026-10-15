"""Private profile/usage accounting against a disposable loopback provider."""
import copy
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler
from http_fixtures import LoopbackHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIService, AIError
from ai_usage import UsageLedger, cost_for, pricing_checked, usage_checked

REAL_CONNECT = sqlite3.connect

BOOK = {'id': 'usage-book', 'kind': 'long', 'title': '测试', 'chapters': [], 'volumes': [], 'outline': [], 'notes': [], 'relations': []}

class Provider(BaseHTTPRequestHandler):
    calls = []
    mode = 'json'
    usage = {'prompt_tokens': 1000, 'completion_tokens': 400, 'total_tokens': 1400, 'prompt_tokens_details': {'cached_tokens': 200}}
    pause = resume = None
    def log_message(self, *args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append((self.headers.get('Authorization'), body))
        if self.pause:
            self.pause.set()
            self.resume.wait(3)
        if body.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            fragments = ['{"reply":"你好', '，已回答","data":null}']
            try:
                for fragment in fragments:
                    self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':fragment}}]})+'\n\n').encode())
                    self.wfile.flush()
                if self.mode != 'interrupted':
                    events = [{'choices':[{'delta':{},'finish_reason':'stop'}]}, {'choices':[], 'model':'provider-actual', 'usage':self.usage}]
                    for event in events:
                        self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
                    self.wfile.write(b'data: [DONE]\n\n')
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        content = '普通回答'
        raw = json.dumps({'model':'provider-actual', 'choices':[{'finish_reason':'stop','message':{'content':content}}], **({'usage':self.usage} if self.usage is not None else {})}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)

class ProfileUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = LoopbackHTTPServer(('127.0.0.1',0),Provider)
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.service=AIService(self.directory.name)
        Provider.calls=[];Provider.mode='json';Provider.pause=Provider.resume=None
        Provider.usage={'prompt_tokens':1000,'completion_tokens':400,'total_tokens':1400,'prompt_tokens_details':{'cached_tokens':200}}
        self.endpoint='http://127.0.0.1:'+str(self.server.server_port)
        self.service.save_settings({'enabled':True,'endpoint':self.endpoint,'model':'requested','apiKey':'fake-first-secret','pricing':{'input':2,'output':8,'cachedInput':1,'currency':'USD'}})
    def run_plain(self, **kwargs):
        return self.service.run(copy.deepcopy(BOOK),'custom',[],'讨论情节',skill_ids=[],**kwargs)
    def test_profiles_isolate_keys_clear_delete_and_legacy_settings(self):
        original=self.service.get_settings();first=original['activeProfileId']
        second=self.service.create_profile({'name':'备用服务'})
        self.assertFalse(second['hasKey']);self.assertEqual(second['model'],'')
        second_id=second['activeProfileId']
        self.service.save_settings({'enabled':True,'endpoint':self.endpoint,'model':'second','apiKey':'fake-second-secret'})
        selected=self.service.save_settings({'profileId':first})
        self.assertEqual(selected['model'],'requested');self.assertTrue(selected['hasKey'])
        self.service.save_settings({'profileId':second_id,'clearKey':True})
        stored=self.service.path.read_text()
        self.assertIn('fake-first-secret',stored);self.assertNotIn('fake-second-secret',stored)
        self.assertNotIn('fake-first-secret',json.dumps(self.service.get_settings()))
        self.service.delete_profile(first)
        self.assertNotIn('fake-first-secret',self.service.path.read_text())
        with self.assertRaises(AIError):self.service.delete_profile(second_id)
        with self.assertRaises(AIError):self.service.save_settings({'profileId':'missing'})
    def test_actual_provider_tokens_price_cached_and_no_manuscript_or_key(self):
        before=copy.deepcopy(BOOK);result=self.run_plain()
        self.assertEqual(result['data']['text'],'普通回答');self.assertEqual(BOOK,before)
        summary=self.service.usage_summary(BOOK['id']);row=summary['entries'][0]
        self.assertEqual(row['usage'],{'inputTokens':1000,'outputTokens':400,'totalTokens':1400,'cachedInputTokens':200})
        self.assertEqual(row['cost'],'0.005');self.assertEqual(row['model'],'provider-actual');self.assertEqual(row['result'],'complete')
        self.assertGreaterEqual(row['durationMs'],0)
        raw=(Path(self.directory.name)/'ai-usage.sqlite3').read_bytes()
        for secret in (b'fake-first-secret','讨论情节'.encode(),'普通回答'.encode(),self.endpoint.encode()):self.assertNotIn(secret,raw)
        self.assertEqual(self.service.usage_summary('other-book')['totals']['requests'],0)
    def test_unknown_usage_or_price_is_never_zero_cost(self):
        Provider.usage=None;self.run_plain();row=self.service.usage_summary()['entries'][0]
        self.assertIsNone(row['usage']);self.assertIsNone(row['cost'])
        self.assertIsNone(self.service.usage_summary()['totals']['totalTokens'])
        Provider.usage={'total_tokens':17};self.run_plain();row=self.service.usage_summary()['entries'][0]
        self.assertEqual(row['usage'],{'totalTokens':17});self.assertIsNone(row['cost'])
        self.assertIsNone(cost_for({'inputTokens':1,'outputTokens':1},pricing_checked({'input':1,'output':1,'cachedInput':.5})))
        self.assertEqual(cost_for({'inputTokens':1,'outputTokens':1},pricing_checked({'input':0,'output':0})),'0')
    def test_stream_usage_only_final_event_and_interrupt_are_accounted_once(self):
        self.service.save_settings({'requestStreamUsage':True})
        self.service.run(BOOK,'custom',[],'对话',skill_ids=[],chat=True,history=[],on_delta=lambda _:None)
        self.assertEqual(Provider.calls[0][1]['stream_options'],{'include_usage':True})
        summary=self.service.usage_summary();self.assertEqual(summary['totals']['requests'],1);self.assertEqual(summary['entries'][0]['usage']['totalTokens'],1400)
        Provider.mode='interrupted'
        with self.assertRaises(AIError):self.service.run(BOOK,'custom',[],'对话',skill_ids=[],chat=True,history=[],on_delta=lambda _:None)
        row=self.service.usage_summary()['entries'][0];self.assertEqual(row['result'],'error');self.assertIsNone(row['usage']);self.assertIsNone(row['cost'])
        self.assertEqual(len(Provider.calls),2)
    def test_request_pins_profile_while_global_choice_changes(self):
        first=self.service.get_settings()['activeProfileId'];second=self.service.create_profile({'name':'另一个服务'})['activeProfileId']
        self.service.save_settings({'endpoint':self.endpoint,'model':'second','enabled':True,'apiKey':'fake-second-secret'})
        Provider.pause=threading.Event();Provider.resume=threading.Event();errors=[]
        def run():
            try:self.run_plain(profile_id=first)
            except Exception as error:errors.append(error)
        worker=threading.Thread(target=run);worker.start();self.assertTrue(Provider.pause.wait(2))
        self.service.save_settings({'profileId':second});Provider.resume.set();worker.join(4)
        self.assertFalse(errors);self.assertFalse(worker.is_alive());self.assertEqual(Provider.calls[0][0],'Bearer fake-first-secret')
        self.assertEqual(self.service.usage_summary()['entries'][0]['profileId'],first)
    def test_validation_does_not_create_paid_request_record_and_clear_is_book_scoped(self):
        with self.assertRaises(AIError):self.run_plain(model='bad\nmodel')
        self.assertEqual(Provider.calls,[]);self.assertEqual(self.service.usage_summary()['totals']['requests'],0)
        self.run_plain();other={**BOOK,'id':'another'};self.service.run(other,'custom',[],'讨论',skill_ids=[])
        self.service.clear_usage(BOOK['id']);self.assertEqual(self.service.usage_summary()['totals']['requests'],1)
        self.assertEqual(self.service.usage_summary()['entries'][0]['bookId'],'another')
    def test_malformed_usage_and_prices_are_not_fabricated(self):
        self.assertIsNone(usage_checked({'prompt_tokens':True,'completion_tokens':-1,'total_tokens':2.5}))
        for value in ({'input':float('nan')},{'input':-1},{'input':True},{'currency':'<x>'},{'output':1000001}):
            with self.assertRaises(ValueError):pricing_checked(value)
        self.assertEqual(pricing_checked({'input':0})['input'],0)
        with self.assertRaises(AIError):self.service.save_settings({'pricing':{'input':-1}})


class UsageConnectionTests(unittest.TestCase):
    """Keep real SQLite handles alive so garbage collection cannot hide leaks."""
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.ledger = UsageLedger(self.directory.name)

    @contextmanager
    def connections(self, fail_sql=None):
        handles = []
        class TrackedConnection(sqlite3.Connection):
            closes = 0
            def execute(self, sql, *args, **kwargs):
                if fail_sql and sql.startswith(fail_sql):
                    raise sqlite3.OperationalError('injected statement failure')
                return super().execute(sql, *args, **kwargs)
            def close(self):
                self.closes += 1
                return super().close()
        def connect(*args, **kwargs):
            handle = REAL_CONNECT(*args, factory=TrackedConnection, **kwargs)
            handles.append(handle)
            return handle
        try:
            with patch('ai_usage.sqlite3.connect', side_effect=connect):
                yield handles
        finally:
            # A failing regression assertion must not strand the test's own file.
            for handle in handles:
                if not handle.closes:
                    handle.close()

    def assert_closed(self, handles, expected):
        self.assertEqual(len(handles), expected)
        for handle in handles:
            self.assertEqual(handle.closes, 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                handle.execute('SELECT 1')

    def record(self, book_id='connection-test'):
        return self.ledger.record(book_id=book_id, action='custom', settings={},
                                  usage={'inputTokens': 2, 'outputTokens': 1, 'totalTokens': 3},
                                  duration_ms=4, result='complete')

    def saved_count(self):
        with closing(REAL_CONNECT(str(self.ledger.path))) as handle:
            return handle.execute('SELECT count(*) FROM usage').fetchone()[0]

    def test_successful_record_summary_and_clear_close_immediately_and_commit(self):
        with self.connections() as handles:
            self.record()
            self.assert_closed(handles, 1)
            self.assertEqual(self.saved_count(), 1, 'A separate real connection sees the committed row')
            self.assertEqual(self.ledger.summary()['totals']['requests'], 1)
            self.assert_closed(handles, 2)
            self.assertEqual(self.ledger.clear()['totals']['requests'], 0)
            self.assert_closed(handles, 5)  # DELETE, VACUUM, then returned summary.
            self.assertEqual(self.saved_count(), 0)

    def test_record_failure_rolls_back_insert_before_close(self):
        self.ledger.summary()  # Commit the schema before the failing transaction.
        with self.connections('DELETE FROM usage WHERE id IN') as handles:
            with self.assertRaisesRegex(sqlite3.OperationalError, 'injected'):
                self.record()
            self.assert_closed(handles, 1)
            self.assertEqual(self.saved_count(), 0, 'The earlier INSERT must be rolled back')

    def test_summary_delete_and_vacuum_errors_release_real_handles(self):
        self.record()
        for sql in ('SELECT data FROM usage', 'DELETE FROM usage', 'VACUUM'):
            with self.subTest(sql=sql), self.connections(sql) as handles:
                with self.assertRaisesRegex(sqlite3.OperationalError, 'injected'):
                    self.ledger.summary() if sql.startswith('SELECT') else self.ledger.clear()
                self.assert_closed(handles, 2 if sql == 'VACUUM' else 1)
                self.assertEqual(self.saved_count(), 0 if sql == 'VACUUM' else 1)

    def test_connection_setup_errors_close_before_propagating(self):
        for sql in ('PRAGMA journal_mode=DELETE', 'CREATE TABLE IF NOT EXISTS usage'):
            with self.subTest(sql=sql), self.connections(sql) as handles:
                with self.assertRaisesRegex(sqlite3.OperationalError, 'injected'):
                    self.ledger.summary()
                self.assert_closed(handles, 1)
        if sys.platform != 'win32':
            with self.connections() as handles, patch('ai_usage.os.chmod', side_effect=OSError('injected permissions failure')):
                with self.assertRaisesRegex(OSError, 'permissions'):
                    self.ledger.summary()
                self.assert_closed(handles, 1)

if __name__=='__main__':unittest.main(verbosity=2)
