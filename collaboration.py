#!/usr/bin/env python3
"""Self-hosted WriterDesk sync hub. No external service or account is required."""
import argparse
import copy
import difflib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import ssl
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from urllib.parse import urlsplit, unquote
import uuid

MAX_REQUEST = 30 * 1024 * 1024
MAX_BOOK = 25 * 1024 * 1024
MOBILE_ROOT = Path(__file__).resolve().parent / "mobile"
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
MISSING = object()


class SyncError(ValueError):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status, self.details = status, details


def now():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise SyncError("无效的同步编号。")
    return value


def clean_book(book):
    if not isinstance(book, dict):
        raise SyncError("作品格式无效。")
    result = copy.deepcopy(book)
    identifier(result.get("id"))
    if result.get("permanentlyDeleted") is True:
        stamp = result.get("deletedAt")
        if not isinstance(stamp, str) or not 1 <= len(stamp) <= 100:
            raise SyncError("作品删除时间无效。")
        return {"id": result["id"], "deletedAt": stamp, "permanentlyDeleted": True}
    if result.get("kind") not in ("long", "short") or not isinstance(result.get("title"), str) or len(result["title"]) > 200:
        raise SyncError("作品名称或类型无效。")
    for key in ("chapters", "volumes", "outline", "notes", "relations"):
        values = result.get(key, [])
        if not isinstance(values, list) or len(values) > 10000:
            raise SyncError("作品内容超出同步限制。")
        seen = set()
        for item in values:
            if not isinstance(item, dict):
                raise SyncError("作品条目格式无效。")
            item_id = identifier(item.get("id"))
            if item_id in seen:
                raise SyncError("作品条目编号重复。")
            seen.add(item_id)
        result[key] = values
    for item in result["chapters"]:
        if not isinstance(item.get("body"), str) or not isinstance(item.get("title"), str):
            raise SyncError("章节格式无效。")
    result.pop("revision", None)
    result.pop("updatedAt", None)
    if len(encode(result).encode("utf-8")) > MAX_BOOK:
        raise SyncError("作品过大，无法同步。", 413)
    return result


def _text_merge(base, left, right):
    """Merge independent character edits; overlapping changes require a choice."""
    edits = []
    for source, value in enumerate((left, right)):
        for tag, start, end, a, b in difflib.SequenceMatcher(None, base, value, autojunk=len(base) > 10000).get_opcodes():
            if tag != "equal":
                edits.append((start, end, value[a:b], source))
    unique = []
    for edit in sorted(edits, key=lambda value: (value[0], value[1], value[3])):
        if any(edit[:3] == other[:3] for other in unique):
            continue
        for other in unique:
            # Adjacent replacements are independent. Insertions at a changed
            # boundary are ambiguous, as are two different same-point inserts.
            overlap = max(edit[0], other[0]) < min(edit[1], other[1])
            insertion = (edit[0] == edit[1] and other[0] <= edit[0] <= other[1]) or (other[0] == other[1] and edit[0] <= other[0] <= edit[1])
            if overlap or insertion:
                return None
        unique.append(edit)
    result = base
    for start, end, value, _ in sorted(unique, reverse=True):
        result = result[:start] + value + result[end:]
    return result


def three_way_merge(base, current, incoming):
    """Return (merged, conflict paths). Inputs remain untouched."""
    conflicts = []

    def merge(old, left, right, path):
        if left == right:
            return left if left is MISSING else copy.deepcopy(left)
        if left == old:
            return right if right is MISSING else copy.deepcopy(right)
        if right == old:
            return left if left is MISSING else copy.deepcopy(left)
        if all(isinstance(value, dict) for value in (old, left, right)):
            result = {}
            for key in sorted(set(old) | set(left) | set(right)):
                value = merge(old.get(key, MISSING), left.get(key, MISSING), right.get(key, MISSING), path + "/" + key)
                if value is not MISSING:
                    result[key] = value
            return result
        if all(isinstance(value, list) for value in (old, left, right)) and all(all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in value) for value in (old, left, right)):
            maps = [{item["id"]: item for item in value} for value in (old, left, right)]
            order_old, order_left, order_right = [[item["id"] for item in value] for value in (old, left, right)]
            common = set(order_old) & set(order_left) & set(order_right)
            sequences = [[key for key in order if key in common] for order in (order_old, order_left, order_right)]
            if sequences[1] != sequences[0] and sequences[2] != sequences[0] and sequences[1] != sequences[2]:
                conflicts.append(path + "/order")
            primary = order_right if sequences[1] == sequences[0] else order_left
            order = list(dict.fromkeys(primary + order_left + order_right + order_old))
            result = []
            for key in order:
                value = merge(*(mapping.get(key, MISSING) for mapping in maps), path + "/" + key)
                if value is not MISSING:
                    result.append(value)
            return result
        if all(isinstance(value, str) for value in (old, left, right)) and path.endswith("/body") and max(map(len, (old, left, right))) < 200000:
            value = _text_merge(old, left, right)
            if value is not None:
                return value
        conflicts.append(path or "/")
        return left if left is MISSING else copy.deepcopy(left)

    return merge(base, current, incoming, ""), conflicts


class HubStore:
    def __init__(self, directory, bootstrap=None, validator=None):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "collaboration.sqlite3"
        self.lock = threading.RLock()
        self.bootstrap = bootstrap or secrets.token_urlsafe(32)
        self.validator = validator
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=1000")
        os.chmod(self.path, 0o600)
        self.db.executescript("""
          PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
          CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen REAL NOT NULL DEFAULT 0,book_id TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,role TEXT NOT NULL,label TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS books(workspace TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace,id));
          CREATE TABLE IF NOT EXISTS revisions(workspace TEXT NOT NULL,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace,book_id,revision));
          CREATE TABLE IF NOT EXISTS requests(member TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(member,id));
          CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,book_id TEXT NOT NULL,member TEXT NOT NULL,base_revision INTEGER NOT NULL,current_revision INTEGER NOT NULL,base TEXT NOT NULL,current TEXT NOT NULL,incoming TEXT NOT NULL,paths TEXT NOT NULL,created_at TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS chapter_purges(workspace TEXT NOT NULL,book_id TEXT NOT NULL,chapter_id TEXT NOT NULL,purged_at TEXT NOT NULL,PRIMARY KEY(workspace,book_id,chapter_id));
        """)
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    def validate(self, value):
        book = clean_book(value)
        if book.get("permanentlyDeleted"):
            return book
        if self.validator:
            deleted = book.get("deletedAt")
            try:
                book = self.validator(book)
            except (ValueError, TypeError, KeyError) as error:
                raise SyncError(str(error))
            if deleted is not None:
                if not isinstance(deleted, str) or len(deleted) > 100:
                    raise SyncError("作品删除时间无效。")
                book["deletedAt"] = deleted
        return book

    @property
    def configured(self):
        with self.lock:
            return bool(self.db.execute("SELECT 1 FROM workspaces LIMIT 1").fetchone())

    def setup(self, secret, name="我的作品", owner="作者"):
        with self.lock, self.db:
            if self.configured:
                raise SyncError("同步服务已经初始化。", 409)
            if not isinstance(secret, str) or not hmac.compare_digest(secret, self.bootstrap):
                raise SyncError("初始化口令无效。", 403)
            workspace, member, token = uuid.uuid4().hex, uuid.uuid4().hex, secrets.token_urlsafe(40)
            self.db.execute("INSERT INTO workspaces VALUES(?,?)", (workspace, str(name)[:100]))
            self.db.execute("INSERT INTO members(id,workspace,name,role,token_hash) VALUES(?,?,?,?,?)", (member, workspace, str(owner)[:100], "owner", digest(token)))
            self.bootstrap = secrets.token_urlsafe(32)
            return {"workspaceId": workspace, "memberId": member, "role": "owner", "token": token}

    def authenticate(self, token, workspace=None):
        if not isinstance(token, str) or not 20 <= len(token) <= 200:
            raise SyncError("请先加入同步空间。", 401)
        hashed = digest(token)
        with self.lock:
            row = self.db.execute("SELECT * FROM members WHERE token_hash=?", (hashed,)).fetchone()
            if not row or row["revoked"] or not hmac.compare_digest(row["token_hash"], hashed):
                raise SyncError("同步凭据已失效。", 401)
            if workspace is not None and row["workspace"] != workspace:
                raise SyncError("无权访问这个同步空间。", 403)
            return dict(row)

    def join(self, data):
        token, name = data.get("invite"), data.get("name", "作者")
        if not isinstance(token, str) or not 20 <= len(token) <= 200 or not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise SyncError("请填写邀请口令和姓名。")
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM invites WHERE token_hash=?", (digest(token),)).fetchone()
            if not row or row["revoked"] or row["used"] or row["expires"] < time.time() or not hmac.compare_digest(row["token_hash"], digest(token)):
                raise SyncError("邀请口令已使用、撤销或过期。", 403)
            member, credential = uuid.uuid4().hex, secrets.token_urlsafe(40)
            self.db.execute("UPDATE invites SET used=1 WHERE id=?", (row["id"],))
            self.db.execute("INSERT INTO members(id,workspace,name,role,token_hash) VALUES(?,?,?,?,?)", (member, row["workspace"], name.strip(), row["role"], digest(credential)))
            return {"workspaceId": row["workspace"], "memberId": member, "role": row["role"], "token": credential}

    def invite(self, member, data):
        if member["role"] != "owner":
            raise SyncError("只有空间所有者可以管理成员。", 403)
        role = data.get("role", "editor")
        if role not in ("editor", "viewer"):
            raise SyncError("成员权限无效。")
        hours = data.get("expiresHours", 24)
        if type(hours) not in (int, float) or not 0 < hours <= 168:
            raise SyncError("邀请有效期必须在 7 天以内。")
        token, invite_id, expires = secrets.token_urlsafe(32), uuid.uuid4().hex, time.time() + hours * 3600
        with self.lock, self.db:
            self.db.execute("INSERT INTO invites(id,workspace,role,label,token_hash,expires) VALUES(?,?,?,?,?,?)", (invite_id, member["workspace"], role, str(data.get("label", ""))[:100], digest(token), expires))
        return {"id": invite_id, "invite": token, "role": role, "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat()}

    def members(self, member):
        with self.lock:
            members = [dict(row) for row in self.db.execute("SELECT id,name,role,revoked,last_seen,book_id FROM members WHERE workspace=?", (member["workspace"],))]
            invites = []
            if member["role"] == "owner":
                invites = [dict(row) for row in self.db.execute("SELECT id,role,label,expires,used,revoked FROM invites WHERE workspace=? ORDER BY expires DESC LIMIT 100", (member["workspace"],))]
            return {"members": members, "invites": invites}

    def revoke(self, member, data):
        if member["role"] != "owner":
            raise SyncError("只有空间所有者可以管理成员。", 403)
        target = identifier(data.get("id"))
        kind = data.get("kind", "member")
        if target == member["id"]:
            raise SyncError("不能撤销自己的所有者凭据。")
        table = {"member": "members", "invite": "invites"}.get(kind)
        if not table:
            raise SyncError("撤销类型无效。")
        with self.lock, self.db:
            count = self.db.execute(f"UPDATE {table} SET revoked=1 WHERE id=? AND workspace=?", (target, member["workspace"])).rowcount
            if not count:
                raise SyncError("成员或邀请不存在。", 404)
        return {"ok": True}

    def list_books(self, member):
        with self.lock:
            result = []
            for row in self.db.execute("SELECT * FROM books WHERE workspace=? ORDER BY updated_at DESC", (member["workspace"],)):
                book = json.loads(row["payload"])
                result.append({"id": row["id"], "title": book.get("title", ""), "kind": book.get("kind", "short"), "deletedAt": book.get("deletedAt"), "permanentlyDeleted": book.get("permanentlyDeleted", False), "revision": row["revision"], "updatedAt": row["updated_at"], "purgedChapterIds": self.purged_chapters(member["workspace"], row["id"])})
            return {"books": result}

    def get_book(self, member, book_id):
        identifier(book_id)
        with self.lock:
            row = self.db.execute("SELECT * FROM books WHERE workspace=? AND id=?", (member["workspace"], book_id)).fetchone()
            if not row:
                raise SyncError("同步作品不存在。", 404)
            return {"book": json.loads(row["payload"]), "revision": row["revision"], "updatedAt": row["updated_at"], "purgedChapterIds": self.purged_chapters(member["workspace"], book_id)}

    def purged_chapters(self, workspace, book_id):
        return [row[0] for row in self.db.execute("SELECT chapter_id FROM chapter_purges WHERE workspace=? AND book_id=? ORDER BY chapter_id", (workspace, book_id))]

    def purge_chapters(self, member, data):
        if member["role"] == "viewer":
            raise SyncError("只读成员不能彻底删除同步章节。", 403)
        book_id, ids = identifier(data.get("bookId")), data.get("chapterIds")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 10000:
            raise SyncError("章节清理编号无效。")
        ids = {identifier(value) for value in ids}
        import chapter_history
        workspace = member["workspace"]

        def sanitize(value):
            if not isinstance(value, dict) or value.get("permanentlyDeleted"):
                return value
            result = self.validate(chapter_history.sanitize(value, ids))
            if result.get("kind") == "short":
                for chapter in result["chapters"]:
                    if chapter["id"] in ids:
                        chapter["id"] = digest(result["id"] + ":sync-purge:" + ",".join(sorted(ids)))
            return result

        with self.lock, self.db:
            added = ids - set(self.purged_chapters(workspace, book_id))
            stamp = now()
            for chapter_id in ids:
                self.db.execute("INSERT OR IGNORE INTO chapter_purges VALUES(?,?,?,?)", (workspace, book_id, chapter_id, stamp))
            current = self.db.execute("SELECT * FROM books WHERE workspace=? AND id=?", (workspace, book_id)).fetchone()
            if current and added:
                self._write(workspace, sanitize(json.loads(current["payload"])), current["revision"] + 1)
            for row in self.db.execute("SELECT revision,payload FROM revisions WHERE workspace=? AND book_id=?", (workspace, book_id)).fetchall():
                self.db.execute("UPDATE revisions SET payload=? WHERE workspace=? AND book_id=? AND revision=?", (encode(sanitize(json.loads(row["payload"]))), workspace, book_id, row["revision"]))
            for row in self.db.execute("SELECT id,base,current,incoming FROM conflicts WHERE workspace=? AND book_id=?", (workspace, book_id)).fetchall():
                self.db.execute("UPDATE conflicts SET base=?,current=?,incoming=? WHERE id=?", (*(encode(sanitize(json.loads(row[key]))) for key in ("base", "current", "incoming")), row["id"]))
            for member_row in self.db.execute("SELECT id FROM members WHERE workspace=?", (workspace,)).fetchall():
                for row in self.db.execute("SELECT id,response FROM requests WHERE member=?", (member_row[0],)).fetchall():
                    value = json.loads(row["response"])
                    if value.get("book", {}).get("id") == book_id:
                        value["book"] = sanitize(value["book"])
                        value["purgedChapterIds"] = self.purged_chapters(workspace, book_id)
                        self.db.execute("UPDATE requests SET response=? WHERE member=? AND id=?", (encode(value), member_row[0], row["id"]))
            return {"ok": True, "bookId": book_id, "purgedChapterIds": self.purged_chapters(workspace, book_id)}

    def presence(self, member, data):
        book_id = data.get("bookId", "")
        if book_id:
            identifier(book_id)
        with self.lock, self.db:
            self.db.execute("UPDATE members SET last_seen=?,book_id=? WHERE id=?", (time.time(), book_id, member["id"]))
            return {"members": [{"id": row["id"], "name": row["name"], "role": row["role"], "bookId": row["book_id"]} for row in self.db.execute("SELECT id,name,role,book_id FROM members WHERE workspace=? AND revoked=0 AND last_seen>?", (member["workspace"], time.time()-45))]}

    def _write(self, workspace, book, revision):
        payload, stamp = encode(book), now()
        self.db.execute("INSERT OR REPLACE INTO books VALUES(?,?,?,?,?)", (workspace, book["id"], revision, payload, stamp))
        self.db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (workspace, book["id"], revision, payload))
        return {"book": book, "revision": revision, "updatedAt": stamp}

    def _purge(self, workspace, book, revision):
        payload, stamp = encode(book), now()
        self.db.execute("INSERT OR REPLACE INTO books VALUES(?,?,?,?,?)", (workspace, book["id"], revision, payload, stamp))
        self.db.execute("DELETE FROM revisions WHERE workspace=? AND book_id=?", (workspace, book["id"]))
        self.db.execute("DELETE FROM conflicts WHERE workspace=? AND book_id=?", (workspace, book["id"]))
        self.db.execute("DELETE FROM chapter_purges WHERE workspace=? AND book_id=?", (workspace, book["id"]))
        response = {"book": book, "revision": revision, "updatedAt": stamp}
        member_ids = [row[0] for row in self.db.execute("SELECT id FROM members WHERE workspace=?", (workspace,))]
        for member_id in member_ids:
            for row in self.db.execute("SELECT id,response FROM requests WHERE member=?", (member_id,)).fetchall():
                value = json.loads(row["response"])
                if value.get("book", {}).get("id") == book["id"]:
                    self.db.execute("UPDATE requests SET response=? WHERE member=? AND id=?", (encode(response), member_id, row["id"]))
        return response

    def compact(self):
        with self.lock:
            if self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise sqlite3.OperationalError("sync checkpoint is busy")
            self.db.execute("VACUUM")
            if self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise sqlite3.OperationalError("sync checkpoint is busy")

    def sync(self, member, data):
        if member["role"] == "viewer":
            raise SyncError("只读成员不能修改作品。", 403)
        request_id = identifier(data.get("requestId"))
        book = self.validate(data.get("book"))
        revision = data.get("baseRevision", 0)
        if type(revision) is not int or revision < 0:
            raise SyncError("同步版本无效。")
        request_hash = digest(encode({"book": book, "baseRevision": revision}))
        workspace, book_id = member["workspace"], book["id"]
        with self.lock, self.db:
            replay = self.db.execute("SELECT * FROM requests WHERE member=? AND id=?", (member["id"], request_id)).fetchone()
            if replay:
                if not hmac.compare_digest(replay["hash"], request_hash):
                    raise SyncError("同步请求编号已用于其他内容。", 409)
                return json.loads(replay["response"])
            removed = set(self.purged_chapters(workspace, book_id))
            if removed:
                import chapter_history
                if chapter_history.contains(book, removed):
                    raise SyncError("同步稿件包含已彻底删除的章节，请先同步最新清理记录。", 410)
            current = self.db.execute("SELECT * FROM books WHERE workspace=? AND id=?", (workspace, book_id)).fetchone()
            current_revision = current["revision"] if current else 0
            if current and json.loads(current["payload"]).get("permanentlyDeleted"):
                if not book.get("permanentlyDeleted"):
                    raise SyncError("作品已彻底删除，旧设备的稿件不能恢复这个编号。", 410)
                response = {"book": json.loads(current["payload"]), "revision": current_revision, "updatedAt": current["updated_at"]}
                self.db.execute("INSERT INTO requests VALUES(?,?,?,?)", (member["id"], request_id, request_hash, encode(response)))
                return response
            if book.get("permanentlyDeleted"):
                response = self._purge(workspace, book, current_revision + 1)
                self.db.execute("INSERT INTO requests VALUES(?,?,?,?)", (member["id"], request_id, request_hash, encode(response)))
                return response
            if revision > current_revision or (not current and revision):
                raise SyncError("同步基准版本不存在。", 409)
            merged, paths = book, []
            base = None
            if current and revision != current_revision:
                base_row = self.db.execute("SELECT payload FROM revisions WHERE workspace=? AND book_id=? AND revision=?", (workspace, book_id, revision)).fetchone()
                base = json.loads(base_row["payload"]) if base_row else None
                if base is None:
                    paths = ["/new-book"]
                else:
                    merged, paths = three_way_merge(base, json.loads(current["payload"]), book)
                    # A simultaneous book deletion and edit is always explicit.
                    left = json.loads(current["payload"])
                    if bool(left.get("deletedAt")) != bool(book.get("deletedAt")) and left != base and book != base:
                        paths.append("/deletedAt")
            if paths:
                conflict = uuid.uuid4().hex
                self.db.execute("INSERT INTO conflicts VALUES(?,?,?,?,?,?,?,?,?,?,?,0)", (conflict, workspace, book_id, member["id"], revision, current_revision, encode(base), current["payload"], encode(book), encode(paths), now()))
                response = {"conflict": {"id": conflict, "bookId": book_id, "paths": paths, "currentRevision": current_revision}, "book": json.loads(current["payload"]), "revision": current_revision}
            elif current and encode(merged) == current["payload"]:
                response = {"book": merged, "revision": current_revision, "updatedAt": current["updated_at"]}
            else:
                response = self._write(workspace, self.validate(merged), current_revision + 1)
            self.db.execute("INSERT INTO requests VALUES(?,?,?,?)", (member["id"], request_id, request_hash, encode(response)))
            return response

    def conflicts(self, member):
        with self.lock:
            return {"conflicts": [{"id": row["id"], "bookId": row["book_id"], "paths": json.loads(row["paths"]), "createdAt": row["created_at"]} for row in self.db.execute("SELECT * FROM conflicts WHERE workspace=? AND resolved=0 ORDER BY created_at DESC", (member["workspace"],))]}

    def conflict(self, member, conflict_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM conflicts WHERE id=? AND workspace=?", (identifier(conflict_id), member["workspace"])).fetchone()
            if not row:
                raise SyncError("冲突记录不存在。", 404)
            current = self.get_book(member, row["book_id"])
            return {"id": row["id"], "bookId": row["book_id"], "base": json.loads(row["base"]), "current": current["book"], "currentRevision": current["revision"], "originalCurrent": json.loads(row["current"]), "incoming": json.loads(row["incoming"]), "paths": json.loads(row["paths"]), "resolved": bool(row["resolved"])}

    def resolve(self, member, conflict_id, data):
        if member["role"] == "viewer":
            raise SyncError("只读成员不能解决冲突。", 403)
        with self.lock, self.db:
            conflict = self.conflict(member, conflict_id)
            if conflict["resolved"]:
                raise SyncError("这个冲突已经处理。", 409)
            current = self.get_book(member, conflict["bookId"])
            if data.get("expectedRevision") != current["revision"]:
                raise SyncError("作品又有新版本，请重新查看后处理。", 409)
            choice = data.get("choice")
            if choice == "current":
                response = current
            elif choice == "copy":
                book = copy.deepcopy(conflict["incoming"])
                book["id"], book["title"] = uuid.uuid4().hex, book["title"][:180] + " · 冲突副本"
                response = self._write(member["workspace"], self.validate(book), 1)
            elif choice == "manual":
                book = self.validate(data.get("book"))
                if book["id"] != conflict["bookId"]:
                    raise SyncError("冲突作品编号不匹配。")
                import chapter_history
                if chapter_history.contains(book, set(self.purged_chapters(member["workspace"], book["id"]))):
                    raise SyncError("同步稿件包含已彻底删除的章节，请先同步最新清理记录。", 410)
                response = self._write(member["workspace"], book, current["revision"] + 1)
            else:
                raise SyncError("请保留当前版本、另存冲突副本或提交手动合并内容。")
            # Revisions and the immutable conflict record retain both originals.
            self.db.execute("UPDATE conflicts SET resolved=1 WHERE id=?", (conflict_id,))
            return response


class HubHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer otherwise performs reverse DNS during every bind. Local
        # and LAN service startup must also work with no DNS or mDNS available.
        TCPServer.server_bind(self)
        self.server_name = "localhost" if self.server_address[0] == "127.0.0.1" else self.server_address[0]
        self.server_port = self.server_address[1]

    def __init__(self, address, store, allowed_origins=()):
        self.store, self.allowed_origins = store, set(allowed_origins)
        super().__init__(address, HubHandler)


class HubHandler(BaseHTTPRequestHandler):
    server_version = "WriterDeskSync/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, *_args):
        pass  # Never log invite credentials, tokens, or manuscript request data.

    def _origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        host = self.headers.get("Host", "")
        scheme = "https" if isinstance(self.connection, ssl.SSLSocket) else "http"
        # A same-host HTTPS reverse proxy terminates TLS before this HTTP hop.
        # Cross-host origins remain rejected; auth uses explicit bearer tokens.
        if origin not in (scheme + "://" + host, "https://" + host) and origin not in self.server.allowed_origins:
            raise SyncError("请求来源未获允许。", 403)

    def _send(self, status, value):
        body = encode(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _data(self):
        if self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Type", "").startswith("application/json"):
            raise SyncError("请使用 JSON 请求。", 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise SyncError("请求长度无效。")
        if not 0 < length <= MAX_REQUEST:
            raise SyncError("同步请求过大或为空。", 413)
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeError, ValueError):
            raise SyncError("请求格式无效。")
        if not isinstance(value, dict):
            raise SyncError("请求格式无效。")
        return value

    def do_OPTIONS(self):
        try:
            self._origin()
            self.send_response(204)
            origin = self.headers.get("Origin")
            if origin in self.server.allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
        except SyncError as error:
            self._send(error.status, {"error": str(error)})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method):
        try:
            self._origin()
            path = urlsplit(self.path).path
            if method == "GET" and path in ("/", "/mobile"):
                # Relative assets and the service-worker scope require this
                # canonical directory, including its trailing slash.
                self.send_response(302)
                self.send_header("Location", "/mobile/")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                return
            if method == "GET" and (path.startswith("/mobile/") or path in ("/shared/manuscript-marks.js", "/shared/i18n.js")):
                return self._static(path)
            if method == "GET" and path == "/v1/status":
                return self._send(200, {"service": "WriterDeskSync", "protocol": 1, "configured": self.server.store.configured})
            data = self._data() if method == "POST" else {}
            if method == "POST" and path == "/v1/setup":
                return self._send(201, self.server.store.setup(data.get("bootstrap"), data.get("workspaceName", "我的作品"), data.get("name", "作者")))
            if method == "POST" and path == "/v1/join":
                return self._send(201, self.server.store.join(data))
            token = self.headers.get("Authorization", "")
            if not token.startswith("Bearer "):
                raise SyncError("请先加入同步空间。", 401)
            parts = path.strip("/").split("/")
            if len(parts) < 4 or parts[:2] != ["v1", "workspaces"]:
                raise SyncError("接口不存在。", 404)
            member = self.server.store.authenticate(token[7:], identifier(parts[2]))
            resource = parts[3:]
            store = self.server.store
            if method == "GET" and resource == ["me"]:
                result = {"workspaceId": member["workspace"], "memberId": member["id"], "name": member["name"], "role": member["role"]}
            elif method == "GET" and resource == ["books"]:
                result = store.list_books(member)
            elif method == "GET" and len(resource) == 2 and resource[0] == "books":
                result = store.get_book(member, resource[1])
            elif method == "GET" and resource == ["members"]:
                result = store.members(member)
            elif method == "POST" and resource == ["invite"]:
                result = store.invite(member, data)
            elif method == "POST" and resource == ["revoke"]:
                result = store.revoke(member, data)
            elif method == "POST" and resource == ["presence"]:
                result = store.presence(member, data)
            elif method == "POST" and resource == ["sync"]:
                result = store.sync(member, data)
                if result.get("book", {}).get("permanentlyDeleted"):
                    try:
                        store.compact()
                    except sqlite3.Error:
                        raise SyncError("同步副本清理暂未完成，请稍后重试。", 503, {"cleanupPending": True})
                result["purgedChapterIds"] = store.purged_chapters(member["workspace"], data.get("book", {}).get("id", ""))
            elif method == "POST" and resource == ["chapters", "purge"]:
                result = store.purge_chapters(member, data)
                try:
                    store.compact()
                except sqlite3.Error:
                    raise SyncError("同步副本清理暂未完成，请稍后重试。", 503, {"cleanupPending": True})
            elif method == "GET" and resource == ["conflicts"]:
                result = store.conflicts(member)
            elif method == "GET" and len(resource) == 2 and resource[0] == "conflicts":
                result = store.conflict(member, resource[1])
            elif method == "POST" and len(resource) == 3 and resource[0] == "conflicts" and resource[2] == "resolve":
                result = store.resolve(member, resource[1], data)
            else:
                raise SyncError("接口不存在。", 404)
            self._send(200, result)
        except SyncError as error:
            self._send(error.status, {"error": str(error), **({"details": error.details} if error.details is not None else {})})
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception:
            self._send(500, {"error": "同步服务暂时无法处理请求。"})

    def _static(self, path):
        if path in ("/shared/manuscript-marks.js", "/shared/i18n.js"):
            source = MOBILE_ROOT.parent / "public" / path.rsplit("/", 1)[1]
            body = source.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return
        name = "index.html" if path in ("/", "/mobile/", "/mobile/index.html") else unquote(path.removeprefix("/mobile/"))
        allowed = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "purge-model.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8", "sw.js": "text/javascript; charset=utf-8", "manifest.webmanifest": "application/manifest+json", "icon.svg": "image/svg+xml"}
        if name not in allowed:
            raise SyncError("文件不存在。", 404)
        source = MOBILE_ROOT / name
        if not source.is_file() or source.is_symlink():
            raise SyncError("手机界面文件不存在。", 404)
        body = source.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", allowed[name])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
        if name == "sw.js":
            self.send_header("Service-Worker-Allowed", "/mobile/")
        self.end_headers()
        self.wfile.write(body)


def start_hub(directory, host="127.0.0.1", port=8766, cert=None, key=None, allowed_origins=(), validator=None):
    store = HubStore(directory, validator=validator)
    try:
        server = HubHTTPServer((host, port), store, allowed_origins)
        if cert or key:
            if not cert or not key:
                raise SyncError("HTTPS 需要同时提供证书和私钥。")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True, name="writer-sync-hub")
        thread.start()
        return server, thread
    except Exception:
        store.close()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--cert")
    parser.add_argument("--key")
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()
    from server import validate_book
    server, thread = start_hub(args.data_dir, args.host, args.port, args.cert, args.key, args.allow_origin, validate_book)
    if not server.store.configured:
        print("一次性初始化口令（仅在可信设备上输入）:", server.store.bootstrap, flush=True)
    print(f"WriterDesk Sync: {'https' if args.cert else 'http'}://{args.host}:{server.server_port}/mobile/", flush=True)
    try:
        while thread.is_alive():
            thread.join(1)
    except KeyboardInterrupt:
        server.shutdown()
    finally:
        server.server_close()
        server.store.close()


if __name__ == "__main__":
    main()
