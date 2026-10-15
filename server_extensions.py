"""Authenticated local API extensions and sync adapters for the desktop library."""
import copy
import json
import re
import threading
from urllib.parse import parse_qs, urlparse

import asset_library
import external_backups
import library_search
from ai_service import AIService
from export_templates import ExportTemplateStore
from sync_client import SyncService, SyncError

_service = None
_service_path = None
_service_lock = threading.RLock()
_factory_lock = threading.RLock()
_closing_paths = set()


def tombstone(row):
    return {"book": {"id": row["book_id"], "deletedAt": row["deleted_at"],
                     "permanentlyDeleted": True}, "revision": 0}


def sync_service(srv):
    global _service, _service_path
    with _service_lock:
        if srv.DB_PATH in _closing_paths:
            raise SyncError('同步服务正在关闭，请重新打开应用。', 503)
        if _service is not None and _service_path == srv.DB_PATH:
            return _service
    # Only factories are serialized. A worker can still reach the closing
    # gate above while an old instance is stopping, without waiting on join.
    with _factory_lock:
        with _service_lock:
            if srv.DB_PATH in _closing_paths:
                raise SyncError('同步服务正在关闭，请重新打开应用。', 503)
            if _service is not None and _service_path == srv.DB_PATH:
                return _service
            previous, previous_path = _service, _service_path
            if previous is not None:
                _closing_paths.add(previous_path)
                _service = _service_path = None
        if previous is not None:
            previous.close()
        return _create_service(srv)


def _create_service(srv):
    global _service, _service_path
    with _service_lock:
        if srv.DB_PATH in _closing_paths:
            raise SyncError('同步服务正在关闭，请重新打开应用。', 503)
        def get_book(identity):
            with srv.DB_LOCK, srv.connect() as conn:
                removed = conn.execute("SELECT * FROM sync_tombstones WHERE book_id=?", (identity,)).fetchone()
                if removed:
                    return tombstone(removed)
                row = srv.saved_book_row(conn, identity)
                result = srv.book_result(row)
                if row["deleted_at"]:
                    result["book"]["deletedAt"] = row["deleted_at"]
                return result

        def list_books():
            with srv.DB_LOCK, srv.connect() as conn:
                rows = conn.execute("SELECT * FROM books").fetchall()
                result = [{"id": row["id"], "revision": row["revision"], "deletedAt": row["deleted_at"]} for row in rows]
                result.extend(tombstone(row)["book"] for row in conn.execute("SELECT * FROM sync_tombstones"))
                return result

        def save_book(value, expected_revision):
            identity = value.get("id")
            if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identity):
                raise SyncError("同步作品编号不正确。", 400)
            if value.get("permanentlyDeleted") is True:
                if srv.trash_expiry(value.get("deletedAt")) is None:
                    raise SyncError("删除时间不正确。", 400)
                with srv.DB_LOCK, srv.connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute("SELECT * FROM books WHERE id=?", (identity,)).fetchone()
                    if row is not None and row["revision"] != expected_revision:
                        raise SyncError("本机稿件已修改，请重新同步。", 409)
                    srv.purge_book_rows(conn, identity, value["deletedAt"])
                srv.cleanup_pending_book_purges(identity)
                return get_book(identity)
            removed_ids = value.get('_syncPurgedChapterIds', [])
            if not isinstance(removed_ids, list) or len(removed_ids) > 10000 or any(not isinstance(item, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', item) for item in removed_ids):
                raise SyncError('同步章节删除记录不正确。', 400)
            deleted_at = value.get("deletedAt")
            if deleted_at is not None and srv.trash_expiry(deleted_at) is None:
                raise SyncError("回收时间不正确。", 400)
            book = srv.validate_book(srv.chapter_history.sanitize(value, set(removed_ids)))
            stamp = srv.now()
            with srv.DB_LOCK, srv.connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                if conn.execute("SELECT 1 FROM sync_tombstones WHERE book_id=?", (identity,)).fetchone():
                    raise SyncError("这部作品已被彻底删除，无法重新同步。", 410)
                row = conn.execute("SELECT * FROM books WHERE id=?", (identity,)).fetchone()
                if row is None:
                    if expected_revision is not None:
                        raise SyncError("本机作品已移除，请重新同步。", 409)
                    srv.insert_book(conn, book)
                    for removed_id in removed_ids:
                        conn.execute('INSERT OR IGNORE INTO chapter_purges VALUES(?,?,?)', (identity, removed_id, stamp))
                    conn.execute("UPDATE books SET deleted_at=? WHERE id=?", (deleted_at, identity))
                else:
                    if row["revision"] != expected_revision:
                        raise SyncError("本机稿件已修改，请重新同步。", 409)
                    if srv.chapter_history.contains(book, srv.chapter_history.purged_ids(conn, identity)):
                        raise SyncError("同步稿件包含本机已彻底删除的章节。", 409)
                    new_purges = set(removed_ids) - srv.chapter_history.purged_ids(conn, identity)
                    if new_purges:
                        for removed_id in new_purges:
                            conn.execute('INSERT OR IGNORE INTO chapter_purges VALUES(?,?,?)', (identity, removed_id, stamp))
                        all_purges = srv.chapter_history.purged_ids(conn, identity)
                        book = srv.validate_book(srv.chapter_history.sanitize(book, all_purges))
                        for previous in conn.execute('SELECT id,payload FROM history WHERE book_id=?', (identity,)).fetchall():
                            clean = srv.validate_book(srv.chapter_history.sanitize(json.loads(previous['payload']), all_purges))
                            conn.execute('UPDATE history SET payload=? WHERE id=?', (json.dumps(clean, ensure_ascii=False), previous['id']))
                        conn.execute('INSERT INTO pending_chapter_purges(book_id,images_cleared) VALUES(?,0) ON CONFLICT(book_id) DO UPDATE SET images_cleared=0', (identity,))
                    if not new_purges and book == srv.book_result(row)['book'] and row['deleted_at'] == deleted_at:
                        result = srv.book_result(row)
                        if deleted_at:
                            result['book']['deletedAt'] = deleted_at
                        return result
                    srv.preserve_history(conn, row, stamp)
                    conn.execute("UPDATE books SET title=?,payload=?,revision=revision+1,updated_at=?,deleted_at=? WHERE id=?",
                                 (book["title"], json.dumps(book, ensure_ascii=False), stamp, deleted_at, identity))
            if removed_ids:
                threading.Thread(target=srv.chapter_history.cleanup, args=(srv, identity), daemon=True, name='writer-synced-purge').start()
            # Downloaded text is not counted as typing on this device.
            if deleted_at is None:
                try:
                    srv.checkpoint_book(identity)
                    srv.sync_book_folder(identity)
                except Exception:
                    pass  # The committed manuscript remains authoritative.
            return get_book(identity)

        _service = SyncService(srv.DB_PATH.parent, get_book, save_book, list_books, validator=srv.validate_book)
        _service_path = srv.DB_PATH
        return _service


def has_sync(srv):
    return (srv.DB_PATH.parent / 'sync' / 'desktop-sync.sqlite3').is_file()


def forget_book(srv, identity, deleted_at):
    # No sync lock is acquired until the root transaction has committed.
    if not has_sync(srv):
        return True
    return sync_service(srv).forget_book(identity, deleted_at)


def sanitize_chapters(srv, identity, ids):
    if not has_sync(srv):
        return True
    return sync_service(srv).sanitize_chapters(identity, ids, srv.chapter_history.sanitize)


def close():
    global _service, _service_path
    with _service_lock:
        previous = _service
        if previous is not None:
            _closing_paths.add(_service_path)
        _service = _service_path = None
    # Never join the worker while holding the registry lock. Its final purge
    # callback may need that lock to observe the closing gate.
    if previous is not None:
        previous.close()


def handle(srv, method, full_path, data=None):
    path = urlparse(full_path).path
    if path == '/api/sync/purge-receipts' and method == 'GET':
        with srv.DB_LOCK, srv.connect() as conn:
            values = {}
            for row in conn.execute('SELECT book_id,chapter_id,purged_at FROM chapter_purges ORDER BY book_id,chapter_id'):
                receipt = values.setdefault(row[0], {'bookId': row[0], 'chapterIds': [], 'purgedAt': row[2], 'permanentlyDeleted': False})
                receipt['chapterIds'].append(row[1])
                receipt['purgedAt'] = max(receipt['purgedAt'], row[2])
            for row in conn.execute('SELECT book_id,deleted_at FROM sync_tombstones'):
                values[row[0]] = {'bookId': row[0], 'chapterIds': [], 'purgedAt': row[1], 'permanentlyDeleted': True}
            return {'purges': list(values.values())}
    if path.startswith('/api/sync/'):
        return sync_service(srv).handle(method, path, data)
    if method == 'GET' and path == '/api/library-search':
        return library_search.read(srv, full_path)
    if path == '/api/export-templates':
        store = ExportTemplateStore(srv.DB_PATH.parent)
        if method == 'GET':
            return store.get()
        if method == 'PUT':
            return store.save(data)
    if path == '/api/ai/profiles' and method == 'POST':
        return AIService(srv.DB_PATH.parent).create_profile(data)
    profile = re.fullmatch(r'/api/ai/profiles/([^/]+)', path)
    if profile and method == 'DELETE':
        return AIService(srv.DB_PATH.parent).delete_profile(profile[1])
    if path == '/api/ai/usage':
        service = AIService(srv.DB_PATH.parent)
        if method == 'GET':
            query = parse_qs(urlparse(full_path).query)
            return service.usage_summary(query.get('bookId', [None])[0])
        if method == 'DELETE':
            if not isinstance(data, dict) or set(data) - {'bookId'}:
                raise ValueError('用量记录参数不正确。')
            return service.clear_usage(data.get('bookId'))
    if path == '/api/external-backups/settings':
        with srv.DB_LOCK, srv.connect() as conn:
            if method == 'GET':
                return {'settings': external_backups.settings(conn)}
            if method == 'PUT':
                return {'settings': external_backups.configure(conn, data)}
    if path == '/api/external-backups/run' and method == 'POST':
        if data != {}:
            raise ValueError('备份参数不正确。')
        completed = 0
        with srv.DB_LOCK, srv.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if not external_backups.settings(conn)['enabled']:
                raise ValueError('请先启用外部备份。')
            for row in conn.execute('SELECT * FROM books WHERE deleted_at IS NULL').fetchall():
                external_backups.checkpoint(conn, row, srv.book_result(row)['book'], srv.validate_book, force=True)
                completed += 1
        return {'count': completed}
    asset = re.fullmatch(r'/api/books/([^/]+)/assets/validate', path)
    if asset and method == 'POST':
        if not isinstance(data, dict) or set(data) != {'asset', 'revision'} or type(data['revision']) is not int:
            raise ValueError('素材参数不正确。')
        with srv.DB_LOCK, srv.connect() as conn:
            row = srv.saved_book_row(conn, asset[1])
            srv.require_active_book(row)
            if row['revision'] != data['revision']:
                raise srv.protection.ProtectionError('作品版本已改变，请保存并重试。', 409, True)
            book = srv.book_result(row)['book']
            candidate = copy.deepcopy(book)
            candidate['assetLibrary']['items'].append(data['asset'])
            clean = srv.validate_book(candidate)
            return {'asset': clean['assetLibrary']['items'][-1]}
    return None
