"""Deleted-chapter history and precise removal from app-managed book copies.

Only IDs and a purge timestamp survive permanent deletion. A durable cleanup
job and the tombstones prevent an old history/backup from restoring removed
text after an interrupted filesystem update.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import safe_fs as os
import re
import stat

import protection
import planning
import asset_library
import external_backups

PENDING_WARNING = "章节已从稿件和历史版本中删除，但备份或同步副本清理尚未完成，将在后台重试。"
FOLDER_WARNING = "作品文件夹中的文件已被手动修改或无法确认归属。请先移走或删除这些文件，再彻底删除章节。"
CONFLICT = "作品已在另一个窗口更新，请刷新历史记录后重试。"
FOLDER_TEMP = re.compile(r"\.writer-desk-[a-f0-9]{32}\.tmp\Z")


def initialize(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS chapter_purges(book_id TEXT NOT NULL,chapter_id TEXT NOT NULL,purged_at TEXT NOT NULL,PRIMARY KEY(book_id,chapter_id))")
    conn.execute("CREATE TABLE IF NOT EXISTS pending_chapter_purges(book_id TEXT PRIMARY KEY,images_cleared INTEGER NOT NULL DEFAULT 0)")
    if "images_cleared" not in {row[1] for row in conn.execute("PRAGMA table_info(pending_chapter_purges)")}:
        conn.execute("ALTER TABLE pending_chapter_purges ADD COLUMN images_cleared INTEGER NOT NULL DEFAULT 0")


def purged_ids(conn, book_id):
    return {row[0] for row in conn.execute("SELECT chapter_id FROM chapter_purges WHERE book_id=?", (book_id,))}


def image_cleanup_pending(conn, book_id):
    return bool(conn.execute("SELECT 1 FROM pending_chapter_purges WHERE book_id=? AND images_cleared=0", (book_id,)).fetchone())


def contains(book, chapter_ids):
    return any(item.get("id") in chapter_ids for key in ("chapters", "shortSections") for item in book.get(key, []) if isinstance(item, dict))


def _short_ranges(book, chapter_ids):
    """Keep non-purged parts of an old, already joined short manuscript."""
    sections = book.get("shortSections", [])
    removed = [item for item in sections if item.get("id") in chapter_ids]
    active = next((item for item in book.get("chapters", []) if not item.get("deletedAt")), None)
    if not removed or active is None:
        return {}
    body, boundaries, units = active.get("body", ""), [0], 0
    for char in body:
        units += 2 if ord(char) > 0xffff else 1
        boundaries.append(units)
    spans = []
    for section in removed:
        start, end = max(0, min(section["start"], units)), max(0, min(section["end"], units))
        # Do not leave half an emoji if a legacy range ended inside a pair.
        start = max(value for value in boundaries if value <= start)
        end = next((value for value in boundaries if value >= end), units)
        if start < end:
            spans.append((start, end))
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    encoded = body.encode("utf-16-le")
    pieces, previous = [], 0
    for start, end in merged:
        pieces.append(encoded[previous * 2:start * 2])
        previous = end
    pieces.append(encoded[previous * 2:])
    active["body"] = b"".join(pieces).decode("utf-16-le")

    def adjusted(value):
        value = max(0, min(value, units))
        return value - sum(max(0, min(value, end) - start) for start, end in merged if start < value)

    remaining = [{**item, "start": adjusted(item["start"]), "end": adjusted(item["end"])}
                 for item in sections if item.get("id") not in chapter_ids]
    replacements = {}
    if active["id"] in chapter_ids and remaining:
        occupied = {item["id"] for item in book["chapters"] if item is not active} | chapter_ids
        replacement = next((item["id"] for item in remaining if item["id"] not in occupied), None)
        if replacement is None:
            replacement = hashlib.sha256((book["id"] + ":purged-manuscript").encode()).hexdigest()
            while replacement in occupied:
                replacement += "x"
        replacements[active["id"]] = replacement
        active["id"] = replacement
    book["shortSections"] = remaining
    return replacements


def sanitize(book, chapter_ids):
    """Remove one chapter without deleting other authored chapters or notes."""
    result = copy.deepcopy(book)
    if not chapter_ids:
        return result
    replacements = _short_ranges(result, chapter_ids) if result.get("kind") == "short" else {}
    result["chapters"] = [item for item in result.get("chapters", []) if item["id"] not in chapter_ids]
    if result.get("kind") == "short" and not any(not item.get("deletedAt") for item in result["chapters"]):
        # The continuous short manuscript must have an owner, but never reuse
        # an ID whose content has just been permanently removed. A stable ID
        # also keeps repeated cleanup of old snapshots deterministic.
        occupied = set(chapter_ids) | {item["id"] for item in result["chapters"]}
        prefix = result["id"][:70] + "-manuscript"
        suffix = hashlib.sha256("\0".join(sorted(chapter_ids)).encode()).hexdigest()[:12]
        identity = prefix + "-" + suffix
        while identity in occupied:
            identity += "x"
        result["chapters"].append({"id": identity, "title": "正文", "body": "", "volumeId": None, "deletedAt": None})
    if "shortSections" in result:
        result["shortSections"] = [item for item in result["shortSections"] if item["id"] not in chapter_ids]
        if not result["shortSections"]:
            result.pop("shortSections")
    for key in ("notes", "outline", "relations"):
        for item in result.get(key, []):
            if "chapterIds" in item:
                # Old short-story normalization mapped all original chapter
                # links to the combined owner. When its first section is
                # removed, keep those links to the remaining continuous text.
                item["chapterIds"] = list(dict.fromkeys(replacements.get(value, value)
                                                       for value in item["chapterIds"]
                                                       if value in replacements or value not in chapter_ids))
    memory = result.get("storyMemory")
    if isinstance(memory, dict):
        memory["entries"] = [entry for entry in memory.get("entries", []) if entry.get("chapterId") not in chapter_ids]
        # A combined short manuscript changed when any original section was removed.
        if result.get("kind") == "short":
            memory["entries"] = []
    result = planning.sanitize(result, chapter_ids, replacements)
    import review_tools
    result = review_tools.sanitize(result, chapter_ids, replacements, before=book)
    # Preserve links to remaining text after a legacy short-story merge.
    for item in result.get("assetLibrary", {}).get("items", []):
        item["chapterIds"] = [replacements.get(value, value) for value in item.get("chapterIds", [])]
    return asset_library.sanitize(result, chapter_ids)


def valid_date(value):
    if not isinstance(value, str) or not value or len(value) > 100:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value if stamp.tzinfo is not None and stamp.utcoffset() is not None else None
    except (ValueError, OverflowError):
        return None


def list_chapters(srv):
    result = []
    with srv.connect() as conn:
        pending = [row[0] for row in conn.execute("SELECT book_id FROM pending_chapter_purges ORDER BY book_id")]
        for row in conn.execute("SELECT * FROM books ORDER BY updated_at DESC"):
            book = srv.upgrade_book(json.loads(row["payload"]))
            removed = purged_ids(conn, row["id"])
            for chapter in book["chapters"]:
                if not chapter.get("deletedAt") or chapter["id"] in removed:
                    continue
                result.append({"bookId": book["id"], "bookTitle": book["title"], "kind": book["kind"],
                               "revision": row["revision"], "bookDeleted": row["deleted_at"] is not None,
                               "chapterId": chapter["id"], "title": chapter["title"],
                               "deletedAt": valid_date(chapter["deletedAt"]),
                               "wordCount": sum(not char.isspace() for char in chapter["body"]),
                               "canRestore": row["deleted_at"] is None})
    result.sort(key=lambda item: (item["deletedAt"] or "", item["bookId"], item["chapterId"]), reverse=True)
    return {"chapters": result, "cleanupPendingBooks": pending}


def route(path):
    return re.fullmatch(r"/api/books/([^/]+)/chapters/([^/]+)/(history|restore|purge)", path)


def deleted_chapter(book, chapter_id):
    chapter = next((item for item in book["chapters"] if item["id"] == chapter_id), None)
    if chapter is None:
        raise protection.ProtectionError("这段已删除内容已不存在，请刷新历史记录。", 404)
    if not chapter.get("deletedAt"):
        raise protection.ProtectionError("只能在历史记录中处理已删除的章节。", 409, True)
    return chapter


def read(srv, path):
    if path == "/api/history/chapter-purges":
        with srv.connect() as conn:
            return {"purges": [{"bookId": row[0], "purgedAt": row[1]} for row in
                               conn.execute("SELECT book_id,MAX(purged_at) FROM chapter_purges GROUP BY book_id ORDER BY book_id")]}
    if path == "/api/history/chapters":
        return list_chapters(srv)
    match = route(path)
    if not match:
        return None
    book_id, chapter_id, operation = match.groups()
    if operation != "history":
        raise protection.ProtectionError("找不到这个操作", 404)
    with srv.connect() as conn:
        row = srv.saved_book_row(conn, book_id)
        book = srv.upgrade_book(json.loads(row["payload"]))
        chapter = deleted_chapter(book, chapter_id)
        return {"bookId": book_id, "bookTitle": book["title"], "kind": book["kind"],
                "revision": row["revision"], "bookDeleted": row["deleted_at"] is not None,
                "chapter": chapter, "deletedAt": valid_date(chapter["deletedAt"])}


def check_folder(srv, book_id):
    """Do not delete or overwrite manually edited exports during a purge."""
    if not os.path.lexists(srv.book_folder_path(book_id)):
        return
    try:
        with srv.book_folder_directory(book_id, False) as (folder, _):
            if folder is None:
                return
            raw = srv.folder_file(folder, srv.FOLDER_MANIFEST)
            if raw is None:
                if any(srv.folder_file(folder, name, digest_only=True) is not None for name in srv.FOLDER_FILES):
                    raise ValueError("unmanaged exports")
                folder_temporaries(srv, folder, book_id, None)
                return
            value = json.loads(raw)
            if (not isinstance(value, dict) or value.get("format") != "writer-desk-folder"
                    or value.get("bookId") != book_id or not isinstance(value.get("files"), dict)
                    or set(value["files"]) != set(srv.FOLDER_FILES)
                    or "pending" in value and (not isinstance(value["pending"], dict) or set(value["pending"]) != set(srv.FOLDER_FILES))):
                raise ValueError("unmanaged exports")
            for name in srv.FOLDER_FILES:
                digest = srv.folder_file(folder, name, digest_only=True)
                allowed = {value["files"][name], value.get("pending", {}).get(name)}
                if digest is not None and digest not in allowed:
                    raise ValueError("edited export")
            folder_temporaries(srv, folder, book_id, value)
    except (OSError, ValueError, TypeError, srv.FolderExportError) as exc:
        raise protection.ProtectionError(FOLDER_WARNING, 409) from exc


def folder_temporaries(srv, folder, book_id, manifest, remove=False):
    """Recognize crash leftovers without adopting arbitrary user text files."""
    allowed_hashes = {value for key in ("files", "pending") for value in (manifest or {}).get(key, {}).values()
                      if isinstance(value, str)}
    for name in os.listdir(folder):
        if not FOLDER_TEMP.fullmatch(name):
            continue
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > srv.MAX_REQUEST:
                raise ValueError("unverified export temporary")
            raw = stream.read()
        digest = hashlib.sha256(raw).hexdigest()
        owned = digest in allowed_hashes
        if not owned:
            try:
                value = json.loads(raw)
                if (value.get("format") == "yejian-backup" and value.get("version") in (3, 4)
                        and set(value) == {"format", "version", "exportedAt", "book"}
                        and isinstance(value.get("exportedAt"), str)):
                    owned = srv.validate_book(value.get("book"))["id"] == book_id
                elif value.get("format") == "writer-desk-folder" and value.get("bookId") == book_id:
                    values = value.get("files")
                    pending = value.get("pending", {})
                    owned = (set(value) <= {"format", "bookId", "revision", "files", "pending"}
                             and type(value.get("revision")) is int and value["revision"] >= 0
                             and isinstance(values, dict) and set(values) == set(srv.FOLDER_FILES)
                             and isinstance(pending, dict) and (not pending or set(pending) == set(srv.FOLDER_FILES))
                             and all(item is None or isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}", item) for item in pending.values())
                             and all(item is None or isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}", item) for item in values.values()))
            except (ValueError, TypeError, AttributeError):
                pass
        if not owned:
            raise ValueError("unverified export temporary")
        if remove:
            # Recheck content after verification. Do not follow a swapped link
            # or remove a file an external editor has since changed.
            if srv.folder_file(folder, name, digest_only=True) != digest:
                raise ValueError("changed export temporary")
            os.unlink(name, dir_fd=folder)
    if remove:
        os.fsync(folder)


def cleanup(srv, book_id=None):
    """Retry committed cleanup jobs without removing another book's content."""
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        query = "SELECT book_id,images_cleared FROM pending_chapter_purges" + (" WHERE book_id=?" if book_id is not None else "")
        rows = conn.execute(query, (book_id,) if book_id is not None else ()).fetchall()
        completed = {}
        for job in rows:
            identity = job[0]
            row = conn.execute("SELECT * FROM books WHERE id=?", (identity,)).fetchone()
            if row is None:
                # Whole-book cleanup has its own durable job and no future
                # history restore can reach this book's removed SQL record.
                conn.execute("DELETE FROM pending_chapter_purges WHERE book_id=?", (identity,))
                continue
            ids = purged_ids(conn, identity)
            try:
                check_folder(srv, identity)
                protection.rewrite_snapshots(srv.DB_PATH, identity, srv.validate_book, lambda value: sanitize(value, ids))
                if not external_backups.clean_book(conn, identity, srv.validate_book, lambda value: sanitize(value, ids)):
                    raise protection.ProtectionError(external_backups.WARNING, 503)
                if os.path.lexists(srv.book_folder_path(identity)):
                    with srv.book_folder_directory(identity, False) as (folder, _):
                        if folder is not None:
                            raw_manifest = srv.folder_file(folder, srv.FOLDER_MANIFEST)
                            manifest = json.loads(raw_manifest) if raw_manifest is not None else None
                            folder_temporaries(srv, folder, identity, manifest, remove=True)
                            book = srv.validate_book(sanitize(json.loads(row["payload"]), ids))
                            srv.sync_folder_files(folder, identity, book, row["revision"], row["updated_at"], False)
                if not job["images_cleared"]:
                    srv.ChatImageStore(srv.DB_PATH.parent).purge(identity)
                    conn.execute("UPDATE pending_chapter_purges SET images_cleared=1 WHERE book_id=?", (identity,))
            except Exception:
                # Never log payloads, local filenames or authored text. The
                # job is retained across shutdown and retried at startup.
                continue
            completed[identity] = ids
        # SQL was written with secure_delete. A successful checkpoint also
        # removes superseded payloads from the application's live WAL file.
        conn.commit()
        try:
            busy = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        except Exception:
            busy = 1
    # A sync callback acquires DB_LOCK while holding the sync lock. Release
    # this DB transaction before touching sync caches or contacting the hub.
    synced = []
    if not busy:
        for identity, ids in completed.items():
            try:
                if srv.server_extensions.sanitize_chapters(srv, identity, ids):
                    synced.append(identity)
            except Exception:
                pass  # Keep the durable job for offline/revoked spaces.
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for identity in synced:
            if purged_ids(conn, identity) == completed[identity]:
                conn.execute("DELETE FROM pending_chapter_purges WHERE book_id=? AND images_cleared=1", (identity,))
        pending_query = "SELECT book_id FROM pending_chapter_purges" + (" WHERE book_id=?" if book_id is not None else "") + " ORDER BY book_id"
        return [row[0] for row in conn.execute(pending_query, (book_id,) if book_id is not None else ())]


def write(srv, path, data):
    if path == "/api/history/chapters/cleanup":
        if not isinstance(data, dict) or data:
            raise protection.ProtectionError("清理重试不接受文件路径。")
        return {"cleanupPendingBooks": cleanup(srv)}
    match = route(path)
    if not match:
        return None
    book_id, chapter_id, operation = match.groups()
    if operation not in ("restore", "purge"):
        raise protection.ProtectionError("找不到这个操作", 404)
    if not isinstance(data, dict) or set(data) != {"revision"} or type(data["revision"]) is not int or data["revision"] < 1:
        raise protection.ProtectionError("处理章节时需要当前保存版本。")
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = srv.saved_book_row(conn, book_id)
        if row["revision"] != data["revision"]:
            raise protection.ProtectionError(CONFLICT, 409, True)
        existing_purges = purged_ids(conn, book_id)
        raw = json.loads(row["payload"])
        book = srv.upgrade_book(copy.deepcopy(raw))
        if operation == "purge" and chapter_id in existing_purges:
            # Retrying a partially completed cleanup is idempotent.
            result = {**srv.book_result(row), "removedChapterIds": [chapter_id], "clearBookLocalCopies": True}
        else:
            chapter = deleted_chapter(book, chapter_id)
            stamp = srv.now()
            if operation == "restore":
                srv.require_active_book(row)
                chapter["deletedAt"] = None
                deleted_volumes = {item["id"] for item in book["volumes"] if item["deletedAt"]}
                if chapter.get("volumeId") in deleted_volumes:
                    chapter["volumeId"] = None
                book = srv.validate_book(book)
                srv.preserve_history(conn, row, stamp)
            else:
                ids = existing_purges | {chapter_id}
                check_folder(srv, book_id)
                protection.rewrite_snapshots(srv.DB_PATH, book_id, srv.validate_book, lambda value: sanitize(value, ids), dry_run=True)
                book = srv.validate_book(sanitize(raw, ids))
                # Rewrite each saved version separately; keep unrelated history
                # IDs, revisions, timestamps and chapter bodies unchanged.
                for saved in conn.execute("SELECT id,payload FROM history WHERE book_id=?", (book_id,)).fetchall():
                    clean = srv.validate_book(sanitize(json.loads(saved["payload"]), ids))
                    conn.execute("UPDATE history SET payload=? WHERE id=?", (json.dumps(clean, ensure_ascii=False), saved["id"]))
                conn.execute("INSERT INTO chapter_purges VALUES(?,?,?)", (book_id, chapter_id, stamp))
                conn.execute("INSERT INTO pending_chapter_purges(book_id,images_cleared) VALUES(?,0) ON CONFLICT(book_id) DO UPDATE SET images_cleared=0", (book_id,))
            conn.execute("UPDATE books SET payload=?,revision=revision+1,updated_at=? WHERE id=?", (json.dumps(book, ensure_ascii=False), stamp, book_id))
            result = {"book": book, "revision": row["revision"] + 1, "updatedAt": stamp}
            if operation == "purge":
                result.update(removedChapterIds=[chapter_id], clearBookLocalCopies=True, purgedAt=stamp)
    if operation == "purge":
        if "purgedAt" not in result:
            with srv.connect() as conn:
                result["purgedAt"] = conn.execute("SELECT MAX(purged_at) FROM chapter_purges WHERE book_id=?", (book_id,)).fetchone()[0]
        if cleanup(srv, book_id):
            result.update(cleanupPending=True, cleanupWarning=PENDING_WARNING)
    else:
        try:
            srv.checkpoint_book(book_id)
            srv.sync_book_folder(book_id)
        except Exception:
            result["folderWarning"] = srv.FOLDER_WARNING
    return result
