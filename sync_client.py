"""Desktop bridge for the optional self-hosted collaboration hub."""
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid
import collaboration

SyncError = collaboration.SyncError


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None  # Never forward a bearer credential to a redirected host.


def checked_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise SyncError("同步地址无效。")
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise SyncError("请填写同步服务的 HTTP 或 HTTPS 地址。")
    try:
        parsed.port
    except ValueError:
        raise SyncError("同步端口无效。")
    return value.strip().rstrip("/")


class SyncService:
    def __init__(self, data_dir, get_book, save_book, list_books, validator=None):
        self.directory = Path(data_dir) / "sync"
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "desktop-sync.sqlite3"
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        os.chmod(self.path, 0o600)
        self.db.executescript("""
          PRAGMA secure_delete=ON;
          CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bases(space TEXT NOT NULL,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,pending TEXT,PRIMARY KEY(space,book_id));
          CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,url TEXT NOT NULL,workspace TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS chapter_purge_queue(space TEXT NOT NULL,book_id TEXT NOT NULL,chapter_id TEXT NOT NULL,PRIMARY KEY(space,book_id,chapter_id));
          CREATE TABLE IF NOT EXISTS chapter_purge_known(space TEXT NOT NULL,book_id TEXT NOT NULL,chapter_id TEXT NOT NULL,PRIMARY KEY(space,book_id,chapter_id));
          CREATE TABLE IF NOT EXISTS book_purge_queue(space TEXT NOT NULL,book_id TEXT NOT NULL,deleted_at TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(space,book_id));
          CREATE TABLE IF NOT EXISTS book_purge_known(space TEXT NOT NULL,book_id TEXT NOT NULL,PRIMARY KEY(space,book_id));
        """)
        self.db.commit()
        self.get_book, self.save_book, self.list_books = get_book, save_book, list_books
        self.validator = validator
        self.lock = threading.RLock()
        self.server, self.server_thread = None, None
        self.last_result, self.last_error, self.last_sync = None, "", None
        self.stop_event = threading.Event()
        self.worker = threading.Thread(target=self._loop, daemon=True, name="writer-sync-client")
        self.worker.start()

    def _config(self):
        row = self.db.execute("SELECT payload FROM config WHERE id=1").fetchone()
        return json.loads(row["payload"]) if row else None

    def _save_config(self, config):
        with self.db:
            if config is None:
                self.db.execute("DELETE FROM config")
            else:
                self.db.execute("INSERT OR REPLACE INTO config VALUES(1,?)", (collaboration.encode(config),))
                self.db.execute("INSERT OR REPLACE INTO spaces VALUES(?,?,?)", (self._space(config), config["url"], config["workspaceId"]))

    def _request(self, config, method, resource, data=None, public=False):
        url = config["url"] + (resource if public else "/v1/workspaces/" + quote(config["workspaceId"], safe="") + resource)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if not public:
            headers["Authorization"] = "Bearer " + config["token"]
        request = Request(url, data=collaboration.encode(data).encode("utf-8") if data is not None else None, headers=headers, method=method)
        try:
            with build_opener(_NoRedirect()).open(request, timeout=20) as response:
                content = response.read(collaboration.MAX_REQUEST + 1)
            if len(content) > collaboration.MAX_REQUEST:
                raise SyncError("同步服务返回的内容过大。", 413)
            value = json.loads(content)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except HTTPError as error:
            try:
                message = json.loads(error.read(8192)).get("error", "同步请求失败。")
            except (ValueError, UnicodeError):
                message = "同步请求失败。"
            raise SyncError(message, error.code)
        except (URLError, TimeoutError, OSError):
            raise SyncError("暂时无法连接同步服务，稿件仍保存在本机。", 503)
        except (ValueError, UnicodeError):
            raise SyncError("同步服务返回的格式无效。", 502)

    def _space(self, config):
        return hashlib.sha256((config["url"] + "\n" + config["workspaceId"]).encode()).hexdigest()

    def status(self):
        with self.lock:
            config = self._config()
            hub = None
            if self.server:
                host, port = self.server.server_address[:2]
                addresses = ["127.0.0.1"]
                if host not in ("127.0.0.1", "localhost"):
                    try:
                        addresses += list(dict.fromkeys(socket.gethostbyname_ex(socket.gethostname())[2]))
                    except OSError:
                        pass
                hub = {"host": host, "port": port, "urls": [f"http://{address}:{port}/mobile/" for address in addresses]}
            return {"connected": bool(config), "url": config["url"] if config else "", "workspaceId": config["workspaceId"] if config else "", "role": config.get("role", "") if config else "", "autoSync": config.get("autoSync", True) if config else False, "hub": hub, "lastSync": self.last_sync, "error": self.last_error, "result": self.last_result}

    def host_start(self, data):
        if self.server:
            return self.status()
        host, port = data.get("host", "127.0.0.1"), data.get("port", 8766)
        if host not in ("127.0.0.1", "0.0.0.0") or type(port) is not int or not 0 <= port <= 65535:
            raise SyncError("请选择本机或局域网，并填写有效端口。")
        try:
            self.server, self.server_thread = collaboration.start_hub(self.directory / "hub", host, port, validator=self.validator)
        except OSError:
            raise SyncError("同步端口已占用，请更换端口。", 409)
        url = f"http://127.0.0.1:{self.server.server_port}"
        owner_path = self.directory / "owner.json"
        if not self.server.store.configured:
            owner = self.server.store.setup(self.server.store.bootstrap)
            descriptor = os.open(owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(owner, stream)
        elif owner_path.is_file() and not owner_path.is_symlink():
            owner = json.loads(owner_path.read_text("utf-8"))
            self.server.store.authenticate(owner["token"], owner["workspaceId"])
        else:
            self.host_stop()
            raise SyncError("同步空间已初始化，但本机所有者凭据缺失，请连接已有空间或从备份恢复。", 409)
        self._save_config({**owner, "url": url, "autoSync": True})
        return self.status()

    def host_stop(self):
        if self.server:
            server = self.server
            self.server = None
            server.shutdown()
            server.server_close()
            server.store.close()
            self.server_thread = None
        return self.status()

    def connect(self, data):
        url = checked_url(data.get("url"))
        config = {"url": url}
        if data.get("invite"):
            joined = self._request(config, "POST", "/v1/join", {"invite": data["invite"], "name": data.get("name", "作者")}, public=True)
            config.update(joined)
        else:
            config.update(workspaceId=collaboration.identifier(data.get("workspaceId")), token=data.get("token", ""))
            if not isinstance(config["token"], str) or not 20 <= len(config["token"]) <= 200:
                raise SyncError("请填写有效同步凭据。")
            config.update(self._request(config, "GET", "/me"))
        config["autoSync"] = data.get("autoSync", True) is not False
        self._save_config(config)
        self.last_error = ""
        return self.status()

    def sync(self, book_id=None):
        with self.lock:
            config = self._config()
            if not config:
                raise SyncError("请先启动或连接同步服务。", 409)
            self._flush_purges(config)
            remote = self._request(config, "GET", "/books")["books"]
            remote_summaries = {item["id"]: item for item in remote}
            local = self.list_books()
            local_ids = {item["id"] for item in local}
            remote_ids = {item["id"] for item in remote}
            identifiers = [collaboration.identifier(book_id)] if book_id else list(dict.fromkeys([item["id"] for item in local] + [item["id"] for item in remote]))
            results = []
            for current_id in identifiers:
                if self.stop_event.is_set():
                    break
                results.append(self._sync_book(config, current_id, current_id in local_ids, current_id in remote_ids, remote_summaries.get(current_id)))
            self.last_result, self.last_error, self.last_sync = {"books": results}, "", collaboration.now()
            return self.last_result

    def _sync_book(self, config, book_id, has_local, has_remote, summary=None):
        space = self._space(config)
        base = self.db.execute("SELECT * FROM bases WHERE space=? AND book_id=?", (space, book_id)).fetchone()
        local = self.get_book(book_id) if has_local else None
        local_book = collaboration.clean_book(local["book"]) if local else None
        if base and local and not base["pending"] and summary and summary["revision"] == base["revision"] and local_book == json.loads(base["payload"]):
            return {"id": book_id, "status": "unchanged"}
        remote = self._request(config, "GET", "/books/" + quote(book_id, safe="")) if has_remote else None
        if remote and remote["book"].get("permanentlyDeleted"):
            if local and not local_book.get("permanentlyDeleted"):
                self.save_book(remote["book"], local["revision"])
            elif not local:
                self.save_book(remote["book"], None)
            self.forget_book(book_id, remote["book"]["deletedAt"], confirmed_space=space)
            self._set_base(space, book_id, remote)
            self.db.execute("VACUUM")
            return {"id": book_id, "status": "permanently-deleted"}
        removed = set(remote.get("purgedChapterIds", [])) if remote else set()
        if removed:
            import chapter_history
            known = {row[0] for row in self.db.execute("SELECT chapter_id FROM chapter_purge_known WHERE space=? AND book_id=?", (space, book_id))}
            new_removed = removed - known
            with self.db:
                for chapter_id in removed:
                    self.db.execute("INSERT OR IGNORE INTO chapter_purge_known VALUES(?,?,?)", (space, book_id, chapter_id))
            stale_local = bool(local and chapter_history.contains(local_book, removed))
            if local and (stale_local or new_removed):
                sanitized = chapter_history.sanitize(local_book, removed)
                self.save_book({**sanitized, "_syncPurgedChapterIds": sorted(removed)}, local["revision"])
                local = self.get_book(book_id)
                local_book = collaboration.clean_book(local["book"])
            if new_removed or stale_local:
                self.sanitize_chapters(book_id, removed)
            base = self.db.execute("SELECT * FROM bases WHERE space=? AND book_id=?", (space, book_id)).fetchone()
        if not local:
            if not remote:
                raise SyncError("作品不存在。", 404)
            self.save_book({**remote["book"], "_syncPurgedChapterIds": sorted(removed)} if removed else remote["book"], None)
            self._set_base(space, book_id, remote)
            return {"id": book_id, "status": "downloaded"}
        if base and local_book == json.loads(base["payload"]) and not base["pending"]:
            if remote and remote["revision"] != base["revision"]:
                self.save_book(remote["book"], local["revision"])
                self._set_base(space, book_id, remote)
                return {"id": book_id, "status": "downloaded"}
            return {"id": book_id, "status": "unchanged"}
        if config.get("role") == "viewer":
            if remote and (not base or local_book != json.loads(base["payload"])):
                return {"id": book_id, "status": "local-changes-readonly"}
            return {"id": book_id, "status": "readonly"}
        request = json.loads(base["pending"]) if base and base["pending"] else {"requestId": uuid.uuid4().hex, "baseRevision": base["revision"] if base else 0, "book": local_book}
        with self.db:
            if base:
                self.db.execute("UPDATE bases SET pending=? WHERE space=? AND book_id=?", (collaboration.encode(request), space, book_id))
            else:
                self.db.execute("INSERT INTO bases VALUES(?,?,?,?,?)", (space, book_id, 0, "null", collaboration.encode(request)))
        response = self._request(config, "POST", "/sync", request)
        if response.get("conflict"):
            conflict = self._request(config, "GET", "/conflicts/" + response["conflict"]["id"])
            if conflict["resolved"]:
                fresh = self.get_book(book_id)
                if collaboration.clean_book(fresh["book"]) == request["book"]:
                    remote = self._request(config, "GET", "/books/" + quote(book_id, safe=""))
                    self.save_book(remote["book"], fresh["revision"])
                    self._set_base(space, book_id, remote)
                    return {"id": book_id, "status": "resolved"}
                with self.db:
                    self.db.execute("UPDATE bases SET pending=NULL WHERE space=? AND book_id=?", (space, book_id))
                return {"id": book_id, "status": "retry-local-changes"}
            # Keep the local manuscript and the same request until explicit
            # resolution. Retrying cannot create an unbounded conflict list.
            return {"id": book_id, "status": "conflict", "conflict": response["conflict"]}
        fresh = self.get_book(book_id)
        fresh_book = collaboration.clean_book(fresh["book"])
        if fresh_book == request["book"]:
            self.save_book(response["book"], fresh["revision"])
        elif response["book"] != request["book"]:
            merged, conflicts = collaboration.three_way_merge(request["book"], response["book"], fresh_book)
            if not conflicts:
                self.save_book(merged, fresh["revision"])
                self._set_base(space, book_id, response)
                return {"id": book_id, "status": "synced-local-changes"}
            # We have not applied the other writer's merged fields locally.
            # Keep the original base so the next request merges, rather than
            # treating those fields as intentionally removed by this device.
            with self.db:
                self.db.execute("UPDATE bases SET pending=NULL WHERE space=? AND book_id=?", (space, book_id))
            return {"id": book_id, "status": "retry-local-changes"}
        self._set_base(space, book_id, response)
        return {"id": book_id, "status": "synced"}

    def _set_base(self, space, book_id, result):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO bases VALUES(?,?,?,?,NULL)", (space, book_id, result["revision"], collaboration.encode(result["book"])))

    def _local_hub_purge(self, book_id, deleted_at=None, chapter_ids=None):
        directory = self.directory / "hub"
        if self.server:
            store, owned = self.server.store, False
        elif (directory / "collaboration.sqlite3").is_file():
            store, owned = collaboration.HubStore(directory, validator=self.validator), True
        else:
            return set()
        try:
            with store.lock:
                workspaces = [row[0] for row in store.db.execute("SELECT id FROM workspaces")]
                for workspace in workspaces:
                    if chapter_ids is not None:
                        store.purge_chapters({"role": "owner", "workspace": workspace}, {"bookId": book_id, "chapterIds": sorted(chapter_ids)})
                    else:
                        with store.db:
                            row = store.db.execute("SELECT revision,payload FROM books WHERE workspace=? AND id=?", (workspace, book_id)).fetchone()
                            if not row or not json.loads(row["payload"]).get("permanentlyDeleted"):
                                store._purge(workspace, {"id": book_id, "deletedAt": deleted_at, "permanentlyDeleted": True}, (row["revision"] if row else 0) + 1)
                store.compact()
            return set(workspaces)
        finally:
            if owned:
                store.close()

    def _flush_purges(self, config):
        space = self._space(config)
        for row in self.db.execute("SELECT * FROM book_purge_queue WHERE space=?", (space,)).fetchall():
            result = self._request(config, "POST", "/sync", {"requestId": row["request_id"], "baseRevision": 0, "book": {"id": row["book_id"], "deletedAt": row["deleted_at"], "permanentlyDeleted": True}})
            if result.get("cleanupPending"):
                continue
            with self.db:
                self.db.execute("DELETE FROM book_purge_queue WHERE space=? AND book_id=?", (space, row["book_id"]))
                self.db.execute("DELETE FROM chapter_purge_queue WHERE space=? AND book_id=?", (space, row["book_id"]))
                self.db.execute("INSERT OR IGNORE INTO book_purge_known VALUES(?,?)", (space, row["book_id"]))
        book_ids = [row[0] for row in self.db.execute("SELECT DISTINCT book_id FROM chapter_purge_queue WHERE space=?", (space,))]
        for book_id in book_ids:
            ids = [row[0] for row in self.db.execute("SELECT chapter_id FROM chapter_purge_queue WHERE space=? AND book_id=?", (space, book_id))]
            result = self._request(config, "POST", "/chapters/purge", {"bookId": book_id, "chapterIds": ids})
            if result.get("cleanupPending"):
                continue
            with self.db:
                for chapter_id in ids:
                    self.db.execute("INSERT OR IGNORE INTO chapter_purge_known VALUES(?,?,?)", (space, book_id, chapter_id))
                self.db.execute("DELETE FROM chapter_purge_queue WHERE space=? AND book_id=?", (space, book_id))

    def _spaces_for_book(self, book_id):
        values = {row[0] for row in self.db.execute("SELECT space FROM bases WHERE book_id=?", (book_id,))}
        config = self._config()
        if config:
            values.add(self._space(config))
        return values

    def _confirmed_local_space(self, mapping, workspaces):
        if not self.server or not mapping or mapping["workspace"] not in workspaces:
            return False
        parsed = urlsplit(mapping["url"])
        return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1") and (parsed.port or 80) == self.server.server_port

    def forget_book(self, book_id, deleted_at, confirmed_space=None):
        """Erase local managed copies now; durably queue unavailable remotes."""
        collaboration.identifier(book_id)
        with self.lock:
            local_complete = True
            try:
                workspaces = self._local_hub_purge(book_id, deleted_at=deleted_at)
            except (sqlite3.Error, SyncError):
                workspaces, local_complete = set(), False
                self.last_error = "同步副本清理暂未完成，请稍后重试。"
            with self.db:
                for space in self._spaces_for_book(book_id):
                    known = self.db.execute("SELECT 1 FROM book_purge_known WHERE space=? AND book_id=?", (space, book_id)).fetchone()
                    mapping = self.db.execute("SELECT url,workspace FROM spaces WHERE id=?", (space,)).fetchone()
                    if space == confirmed_space or self._confirmed_local_space(mapping, workspaces):
                        self.db.execute("INSERT OR IGNORE INTO book_purge_known VALUES(?,?)", (space, book_id))
                        self.db.execute("DELETE FROM book_purge_queue WHERE space=? AND book_id=?", (space, book_id))
                    elif not known:
                        self.db.execute("INSERT OR IGNORE INTO book_purge_queue VALUES(?,?,?,?)", (space, book_id, deleted_at, uuid.uuid4().hex))
                self.db.execute("UPDATE bases SET payload='null',pending=NULL WHERE book_id=?", (book_id,))
                self.db.execute("DELETE FROM chapter_purge_queue WHERE book_id=?", (book_id,))
            self.db.execute("VACUUM")
            config = self._config()
            if config:
                try:
                    self._flush_purges(config)
                except SyncError as error:
                    self.last_error = str(error)
            return local_complete and not bool(self.db.execute("SELECT 1 FROM book_purge_queue WHERE book_id=? LIMIT 1", (book_id,)).fetchone())

    def sanitize_chapters(self, book_id, ids, sanitize=None):
        collaboration.identifier(book_id)
        ids = {collaboration.identifier(value) for value in ids}
        if not ids:
            return True
        if sanitize is None:
            import chapter_history
            sanitize = chapter_history.sanitize
        with self.lock:
            local_complete = True
            try:
                workspaces = self._local_hub_purge(book_id, chapter_ids=ids)
            except (sqlite3.Error, SyncError):
                workspaces, local_complete = set(), False
                self.last_error = "同步副本清理暂未完成，请稍后重试。"
            with self.db:
                for space in self._spaces_for_book(book_id):
                    mapping = self.db.execute("SELECT url,workspace FROM spaces WHERE id=?", (space,)).fetchone()
                    for chapter_id in ids:
                        known = self.db.execute("SELECT 1 FROM chapter_purge_known WHERE space=? AND book_id=? AND chapter_id=?", (space, book_id, chapter_id)).fetchone()
                        if self._confirmed_local_space(mapping, workspaces):
                            self.db.execute("INSERT OR IGNORE INTO chapter_purge_known VALUES(?,?,?)", (space, book_id, chapter_id))
                            self.db.execute("DELETE FROM chapter_purge_queue WHERE space=? AND book_id=? AND chapter_id=?", (space, book_id, chapter_id))
                        elif not known:
                            self.db.execute("INSERT OR IGNORE INTO chapter_purge_queue VALUES(?,?,?)", (space, book_id, chapter_id))
                for row in self.db.execute("SELECT space,payload FROM bases WHERE book_id=?", (book_id,)).fetchall():
                    value = json.loads(row["payload"])
                    if isinstance(value, dict) and not value.get("permanentlyDeleted"):
                        value = sanitize(value, ids)
                    self.db.execute("UPDATE bases SET payload=?,pending=NULL WHERE space=? AND book_id=?", (collaboration.encode(value), row["space"], book_id))
            self.db.execute("VACUUM")
            config = self._config()
            if config:
                try:
                    self._flush_purges(config)
                except SyncError as error:
                    self.last_error = str(error)
            return local_complete and not bool(self.db.execute("SELECT 1 FROM chapter_purge_queue WHERE book_id=? LIMIT 1", (book_id,)).fetchone())

    def handle(self, method, path, data=None):
        data = data or {}
        with self.lock:
            if method == "GET" and path == "/api/sync/status":
                return self.status()
            if method == "POST" and path == "/api/sync/host-start":
                return self.host_start(data)
            if method == "POST" and path == "/api/sync/host-stop":
                return self.host_stop()
            if method == "POST" and path == "/api/sync/connect":
                return self.connect(data)
            if method == "POST" and path == "/api/sync/disconnect":
                self._save_config(None)
                self.last_result, self.last_error = None, ""
                return self.status()
            if method == "POST" and path == "/api/sync/preferences":
                config = self._config()
                if config:
                    config["autoSync"] = data.get("autoSync") is True
                    self._save_config(config)
                return self.status()
            if method == "POST" and path == "/api/sync/sync":
                return self.sync(data.get("bookId"))
            config = self._config()
            if not config:
                raise SyncError("请先启动或连接同步服务。", 409)
            if method == "GET" and path in ("/api/sync/members", "/api/sync/conflicts"):
                return self._request(config, "GET", "/" + path.rsplit("/", 1)[1])
            if method == "POST" and path in ("/api/sync/invite", "/api/sync/revoke"):
                return self._request(config, "POST", "/" + path.rsplit("/", 1)[1], data)
            if method == "GET" and path.startswith("/api/sync/conflicts/"):
                return self._request(config, "GET", "/conflicts/" + quote(collaboration.identifier(path.rsplit("/", 1)[1]), safe=""))
            if method == "POST" and path == "/api/sync/resolve":
                conflict_id = collaboration.identifier(data.get("id"))
                conflict = self._request(config, "GET", "/conflicts/" + quote(conflict_id, safe=""))
                original_id = conflict["bookId"]
                try:
                    local = self.get_book(original_id)
                except (KeyError, ValueError):
                    local = None
                preserved = None
                if local and collaboration.clean_book(local["book"]) not in (conflict["incoming"], conflict["current"]):
                    preserved = copy.deepcopy(local["book"])
                    preserved["id"] = uuid.uuid4().hex
                    preserved["title"] = preserved["title"][:180] + " · 冲突后修改"
                    self.save_book(preserved, None)
                resolved = self._request(config, "POST", "/conflicts/" + quote(conflict_id, safe="") + "/resolve", data)
                current = self._request(config, "GET", "/books/" + quote(original_id, safe=""))
                self.save_book(current["book"], local["revision"] if local else None)
                self._set_base(self._space(config), original_id, current)
                if resolved["book"]["id"] != original_id:
                    self.save_book(resolved["book"], None)
                    self._set_base(self._space(config), resolved["book"]["id"], resolved)
                return {**resolved, "preservedLocalCopy": preserved["id"] if preserved else None}
            if method == "POST" and path == "/api/sync/presence":
                return self._request(config, "POST", "/presence", data)
            raise SyncError("同步接口不存在。", 404)

    def _loop(self):
        while not self.stop_event.wait(15):
            try:
                with self.lock:
                    config = self._config()
                    if config and config.get("autoSync", True):
                        self.sync()
            except Exception as error:
                self.last_error = str(error) if isinstance(error, SyncError) else "自动同步暂未完成，稿件仍保存在本机。"

    def close(self):
        self.stop_event.set()
        self.worker.join(timeout=25)
        with self.lock:
            self.host_stop()
            self.db.close()
