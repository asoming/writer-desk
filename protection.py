"""Bounded local book snapshots. Never stores application credentials."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

DEFAULTS = {"enabled": True, "intervalMinutes": 5, "retentionCount": 20}
TOKEN = re.compile(r"r[1-9][0-9]*-[a-f0-9]{32}\.json\Z")
TEMP_TOKEN = re.compile(r"\.snapshot-[a-f0-9]{32}\.tmp\Z")
WARNING = "作品已保存，但自动备份未完成。请在设置中检查数据保护并重试。"


class ProtectionError(Exception):
    def __init__(self, message, status=400, conflict=False):
        super().__init__(message)
        self.status, self.conflict = status, conflict


def initialize(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS protection_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS backup_runs(book_id TEXT PRIMARY KEY,last_success REAL NOT NULL)")


def settings(conn):
    row = conn.execute("SELECT payload FROM protection_settings WHERE id=1").fetchone()
    return json.loads(row[0]) if row else dict(DEFAULTS)


def update_settings(conn, value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ProtectionError("备份设置格式不正确")
    if type(value["enabled"]) is not bool or type(value["intervalMinutes"]) is not int or not 1 <= value["intervalMinutes"] <= 1440:
        raise ProtectionError("备份间隔应为 1 至 1440 分钟")
    if type(value["retentionCount"]) is not int or not 1 <= value["retentionCount"] <= 100:
        raise ProtectionError("每部作品应保留 1 至 100 份备份")
    result = {key: value[key] for key in DEFAULTS}
    conn.execute("INSERT INTO protection_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                 (json.dumps(result),))
    return result


@contextmanager
def directory(db_path, book_id, create=False):
    """Resolve only fixed directories using descriptors; never follow symlinks."""
    root = Path(os.path.abspath(Path(db_path).parent))
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        raise ProtectionError("当前系统不支持安全创建自动备份", 500)
    flags, descriptors = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, []
    try:
        current = os.open(root.anchor, flags)
        descriptors.append(current)
        for part in root.parts[1:]:
            current = os.open(part, flags, dir_fd=current)
            descriptors.append(current)
        for part in ("backups", "book-" + hashlib.sha256(book_id.encode("utf-8")).hexdigest()):
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
            try:
                current = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    yield None
                    return
                raise
            descriptors.append(current)
        yield current
    except OSError as exc:
        raise ProtectionError("无法访问自动备份目录，请检查磁盘空间、权限和符号链接", 500) from exc
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def summary(book, revision, stamp, **extra):
    chapters = [chapter for chapter in book["chapters"] if not chapter["deletedAt"]]
    return {"revision": revision, "savedAt": stamp, "title": book["title"], "chapterCount": len(chapters),
            "charCount": sum(sum(not char.isspace() for char in chapter["body"]) for chapter in chapters), **extra}


def read_snapshot(folder, token, book_id, validate):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ProtectionError("备份编号不正确")
    try:
        descriptor = os.open(token, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
                raise ValueError("invalid snapshot")
            value = json.load(stream)
        meta = value.get("writerDeskSnapshot", {})
        if (value.get("format") != "yejian-backup" or value.get("version") != 3
                or meta.get("bookId") != book_id or type(meta.get("revision")) is not int
                or meta["revision"] < 1 or not token.startswith("r" + str(meta["revision"]) + "-")
                or not isinstance(meta.get("createdAt"), str) or meta.get("reason") not in ("automatic", "manual", "before-restore")):
            raise ValueError("invalid snapshot")
        book = validate(value.get("book"))
        if book["id"] != book_id:
            raise ValueError("foreign book")
        return {"book": book, **summary(book, meta["revision"], meta["createdAt"], token=token, reason=meta["reason"])}
    except FileNotFoundError as exc:
        raise ProtectionError("这份备份已不存在，请刷新列表", 404) from exc
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        raise ProtectionError("备份无法读取，原有作品未改变", 422) from exc


def entries(folder, book_id, validate):
    result = []
    if folder is None:
        return result
    for token in os.listdir(folder):
        if TOKEN.fullmatch(token):
            try:
                snapshot = read_snapshot(folder, token, book_id, validate)
            except ProtectionError:
                continue  # Never adopt, overwrite or clean up damaged/user files.
            result.append({key: value for key, value in snapshot.items() if key != "book"})
    return sorted(result, key=lambda item: (item["savedAt"], item["token"]), reverse=True)


def list_snapshots(db_path, book_id, validate):
    with directory(db_path, book_id) as folder:
        return entries(folder, book_id, validate)


def get_snapshot(db_path, book_id, token, validate):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ProtectionError("备份编号不正确")
    with directory(db_path, book_id) as folder:
        if folder is None:
            raise ProtectionError("这份备份已不存在，请刷新列表", 404)
        return read_snapshot(folder, token, book_id, validate)


def purge_snapshots(db_path, book_id, validate):
    """Remove verified app snapshots only; exported/user files are never traversed."""
    if not os.path.lexists(Path(db_path).parent / "backups"):
        return
    with directory(db_path, book_id) as folder:
        if folder is None:
            return
        for item in entries(folder, book_id, validate):
            try:
                os.unlink(item["token"], dir_fd=folder)
            except FileNotFoundError:
                pass  # Another service may have completed this same cleanup.
        os.fsync(folder)


def rewrite_snapshots(db_path, book_id, validate, transform, dry_run=False):
    """Rewrite owned snapshots in place, preserving their historical metadata.

    Unknown foreign-book files remain untouched. An unreadable owned-looking
    file blocks completion rather than silently claiming its text was removed.
    No temporary file ever contains the original chapter being purged.
    """
    if not os.path.lexists(Path(db_path).parent / "backups"):
        return
    with directory(db_path, book_id) as folder:
        if folder is None:
            return
        for token in os.listdir(folder):
            temporary_snapshot = bool(TEMP_TOKEN.fullmatch(token))
            if not TOKEN.fullmatch(token) and not temporary_snapshot:
                continue
            try:
                descriptor = os.open(token, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
                with os.fdopen(descriptor, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
                        raise ValueError("invalid snapshot")
                    raw = stream.read()
                value = json.loads(raw)
                meta = value.get("writerDeskSnapshot", {})
                if isinstance(meta, dict) and meta.get("bookId") not in (None, book_id):
                    continue
                if (set(value) != {"format", "version", "exportedAt", "book", "writerDeskSnapshot"}
                        or not isinstance(meta, dict)
                        or set(meta) != {"bookId", "revision", "createdAt", "reason"}):
                    raise ValueError("unrecognized snapshot metadata")
                if temporary_snapshot:
                    # Checkpoint writes these exact format/ownership markers
                    # before renaming its temp. A crash can leave the old text
                    # here even though it never entered the snapshot listing.
                    if (value.get("format") != "yejian-backup" or value.get("version") != 3
                            or not isinstance(meta, dict) or meta.get("bookId") != book_id
                            or type(meta.get("revision")) is not int or meta["revision"] < 1
                            or not isinstance(meta.get("createdAt"), str)
                            or meta.get("reason") not in ("automatic", "manual", "before-restore")
                            or validate(value.get("book"))["id"] != book_id):
                        raise ValueError("invalid temporary snapshot")
                else:
                    # Reuse the normal strict ownership and format validation.
                    read_snapshot(folder, token, book_id, validate)
                clean = validate(transform(value["book"]))
                if clean == value["book"]:
                    continue
                payload = json.dumps({**value, "book": clean}, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
            except FileNotFoundError:
                continue
            except (OSError, ValueError, TypeError, AttributeError, KeyError, ProtectionError) as exc:
                raise ProtectionError("自动备份目录含无法安全清理的文件。请检查数据保护目录后重试。", 409) from exc
            if dry_run:
                continue
            if temporary_snapshot:
                descriptor = os.open(token, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
                with os.fdopen(descriptor, "rb") as stream:
                    if stream.read(64 * 1024 * 1024 + 1) != raw:
                        raise ProtectionError("自动备份临时文件已被修改，请检查后重试。", 409)
                os.unlink(token, dir_fd=folder)
                os.fsync(folder)
                continue
            temporary = ".snapshot-" + uuid.uuid4().hex + ".tmp"
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                # The application normally serializes writers through SQLite;
                # also reject changes by an external editor during this write.
                descriptor = os.open(token, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
                with os.fdopen(descriptor, "rb") as stream:
                    if stream.read(64 * 1024 * 1024 + 1) != raw:
                        raise ProtectionError("自动备份文件已被修改，请检查后重试。", 409)
                os.replace(temporary, token, src_dir_fd=folder, dst_dir_fd=folder)
                os.fsync(folder)
            finally:
                try:
                    os.unlink(temporary, dir_fd=folder)
                except FileNotFoundError:
                    pass


def checkpoint(conn, db_path, row, validate, force=False, reason="automatic"):
    config, tick = settings(conn), time.time()
    previous = conn.execute("SELECT last_success FROM backup_runs WHERE book_id=?", (row["id"],)).fetchone()
    if not force and (not config["enabled"] or previous and tick - previous[0] < config["intervalMinutes"] * 60):
        return None
    book = validate(json.loads(row["payload"]))
    stamp = datetime.now(timezone.utc).isoformat()
    token = "r" + str(row["revision"]) + "-" + uuid.uuid4().hex + ".json"
    value = {"format": "yejian-backup", "version": 3, "exportedAt": stamp, "book": book,
             "writerDeskSnapshot": {"bookId": book["id"], "revision": row["revision"], "createdAt": stamp, "reason": reason}}
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    with directory(db_path, book["id"], create=True) as folder:
        temporary = ".snapshot-" + uuid.uuid4().hex + ".tmp"
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, token, src_dir_fd=folder, dst_dir_fd=folder)
            os.fsync(folder)
            conn.execute("INSERT INTO backup_runs VALUES(?,?) ON CONFLICT(book_id) DO UPDATE SET last_success=excluded.last_success",
                         (book["id"], tick))
            for old in entries(folder, book["id"], validate)[config["retentionCount"]:]:
                os.unlink(old["token"], dir_fd=folder)
            os.fsync(folder)
        finally:
            try:
                os.unlink(temporary, dir_fd=folder)
            except FileNotFoundError:
                pass
    return summary(book, row["revision"], stamp, token=token, reason=reason)
