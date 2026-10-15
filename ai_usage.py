"""Private local usage ledger. Never stores prompts, replies, URLs or credentials."""
from datetime import datetime, timezone
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import uuid

_LOCK = threading.RLock()
MAX_ROWS = 20000


def pricing_checked(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict) or set(value) - {'input', 'output', 'cachedInput', 'currency'}:
        raise ValueError('AI 单价设置不正确。')
    result = {'currency': value.get('currency', 'USD')}
    if not isinstance(result['currency'], str) or len(result['currency']) != 3 or not result['currency'].isascii() or not result['currency'].isalpha():
        raise ValueError('费用币种须为三个英文字母。')
    result['currency'] = result['currency'].upper()
    for key in ('input', 'output', 'cachedInput'):
        price = value.get(key)
        if price is not None and (type(price) not in (int, float) or not math.isfinite(price) or not 0 <= price <= 1000000):
            raise ValueError('AI 单价须为每百万 Token 的非负数，留空表示未知。')
        result[key] = price
    return result


def usage_checked(value):
    if not isinstance(value, dict):
        return None
    result = {}
    for key, aliases in {'inputTokens': ('prompt_tokens', 'input_tokens'), 'outputTokens': ('completion_tokens', 'output_tokens'), 'totalTokens': ('total_tokens',)}.items():
        for name in aliases:
            token = value.get(name)
            if type(token) is int and 0 <= token <= 10**12:
                result[key] = token
                break
    details = value.get('prompt_tokens_details', value.get('input_tokens_details'))
    cached = details.get('cached_tokens') if isinstance(details, dict) else None
    if type(cached) is int and 0 <= cached <= result.get('inputTokens', 10**12):
        result['cachedInputTokens'] = cached
    return result or None


def cost_for(usage, pricing):
    if not usage or any(name not in usage for name in ('inputTokens', 'outputTokens')) or pricing['input'] is None or pricing['output'] is None:
        return None
    if pricing['cachedInput'] is not None and 'cachedInputTokens' not in usage:
        return None
    count = usage['inputTokens']
    cached = usage.get('cachedInputTokens', 0) if pricing['cachedInput'] is not None else 0
    amount = Decimal(count - cached) * Decimal(str(pricing['input'])) + Decimal(usage['outputTokens']) * Decimal(str(pricing['output']))
    if cached:
        amount += Decimal(cached) * Decimal(str(pricing['cachedInput']))
    return str((amount / Decimal(1000000)).normalize())


class UsageLedger:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'ai-usage.sqlite3'

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise ValueError('AI 用量记录文件不可为符号链接。')
        conn = sqlite3.connect(str(self.path), timeout=10)
        if os.name != 'nt':
            os.chmod(self.path, 0o600)
        conn.execute('PRAGMA journal_mode=DELETE')
        conn.execute('CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, book_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL)')
        return conn

    def record(self, *, book_id, action, settings, usage, duration_ms, result):
        pricing = pricing_checked(settings.get('pricing'))
        secrets = [profile.get('apiKey') for profile in settings.get('profiles', [])] + [settings.get('apiKey')]
        def safe(value, limit):
            text = str(value or '')[:limit]
            for secret in secrets:
                if secret:
                    text = text.replace(secret, '[redacted]')
            return text
        row = {'id': uuid.uuid4().hex, 'bookId': book_id, 'createdAt': datetime.now(timezone.utc).isoformat(),
               'profileId': safe(settings.get('activeProfileId', 'default'), 80), 'profileName': safe(settings.get('name', '默认服务'), 100),
               'model': safe(settings.get('model'), 200), 'action': safe(action, 40), 'result': result,
               'durationMs': max(0, round(duration_ms)), 'usage': usage, 'cost': cost_for(usage, pricing), 'currency': pricing['currency'], 'pricing': pricing}
        with _LOCK, self._connect() as conn:
            conn.execute('INSERT INTO usage VALUES (?,?,?,?)', (row['id'], book_id, row['createdAt'], json.dumps(row, ensure_ascii=False)))
            conn.execute('DELETE FROM usage WHERE id IN (SELECT id FROM usage ORDER BY created_at DESC LIMIT -1 OFFSET ?)', (MAX_ROWS,))
        return row

    def summary(self, book_id=None):
        with _LOCK, self._connect() as conn:
            sql, args = ('SELECT data FROM usage ORDER BY created_at DESC', ()) if book_id is None else ('SELECT data FROM usage WHERE book_id=? ORDER BY created_at DESC', (book_id,))
            rows = [json.loads(row[0]) for row in conn.execute(sql, args)]
        totals = {'requests': len(rows), 'knownUsageRequests': 0, 'unknownUsageRequests': 0, 'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0, 'costs': {}, 'unknownCostRequests': 0}
        reported = {key: 0 for key in ('inputTokens', 'outputTokens', 'totalTokens')}
        for row in rows:
            usage = row['usage']
            totals['knownUsageRequests' if usage else 'unknownUsageRequests'] += 1
            for key in ('inputTokens', 'outputTokens', 'totalTokens'):
                if usage and key in usage:
                    totals[key] += usage[key]
                    reported[key] += 1
            if row['cost'] is None:
                totals['unknownCostRequests'] += 1
            else:
                currency = row['currency']
                totals['costs'][currency] = str(Decimal(totals['costs'].get(currency, '0')) + Decimal(row['cost']))
        for key in reported:
            if not reported[key]:
                totals[key] = None
        totals['reportedRequests'] = reported
        return {'bookId': book_id, 'totals': totals, 'entries': rows[:500], 'truncated': len(rows) > 500}

    def clear(self, book_id=None):
        with _LOCK, self._connect() as conn:
            conn.execute('PRAGMA secure_delete=ON')
            conn.execute('DELETE FROM usage' if book_id is None else 'DELETE FROM usage WHERE book_id=?', () if book_id is None else (book_id,))
        with _LOCK, self._connect() as conn:
            conn.execute('VACUUM')
        return self.summary(book_id)
