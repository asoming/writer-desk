"""Durable comparison pairs, isolated from the committed manuscript.

Only an explicit apply changes the book. Every draft write has a separate CAS
version and a canonical checkpoint so two windows cannot silently replace each
other's drafts or apply over newer author text. Book exports and snapshots do
not include this table.
"""
import copy
import hashlib
import json
import re

import protection

CONFLICT = "对照修改已在另一个窗口变化，请重新打开后继续。"
CANONICAL_CONFLICT = "正文已发生变化，对照稿仍已保留，请重新查看原文后继续。"


def initialize(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS comparison_drafts(
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        baseline_title TEXT NOT NULL, baseline_body TEXT NOT NULL,
        draft_title TEXT NOT NULL, draft_body TEXT NOT NULL,
        canonical_title TEXT NOT NULL, canonical_body TEXT NOT NULL,
        canonical_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(book_id,chapter_id))""")


def route(path):
    return re.fullmatch(r"/api/books/([^/]{1,100})/chapters/([^/]{1,100})/comparison(/apply)?", path)


def text_pair(chapter):
    return {"title": chapter["title"], "body": chapter["body"]}


def fingerprint(pair):
    return hashlib.sha256(json.dumps(pair, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def record(row):
    if row is None:
        return None
    return {"version": row["version"],
            "baseline": {"title": row["baseline_title"], "body": row["baseline_body"]},
            "draft": {"title": row["draft_title"], "body": row["draft_body"]},
            "canonical": {"title": row["canonical_title"], "body": row["canonical_body"]},
            "canonicalFingerprint": row["canonical_fingerprint"], "updatedAt": row["updated_at"]}


def saved(conn, book_id, chapter_id):
    return conn.execute("SELECT * FROM comparison_drafts WHERE book_id=? AND chapter_id=?", (book_id, chapter_id)).fetchone()


def active(srv, conn, book_id, chapter_id):
    row = srv.saved_book_row(conn, book_id)
    srv.require_active_book(row)
    book = srv.upgrade_book(json.loads(row["payload"]))
    chapter = next((item for item in book["chapters"] if item["id"] == chapter_id and not item.get("deletedAt")), None)
    if chapter is None:
        raise protection.ProtectionError("找不到这段正文，请重新打开作品。", 404, True)
    return row, book, chapter


def response(row, chapter, draft):
    canonical = text_pair(chapter)
    current = fingerprint(canonical)
    return {"draft": record(draft), "canonical": canonical,
            "canonicalFingerprint": current, "revision": row["revision"],
            "stale": draft is not None and draft["canonical_fingerprint"] != current}


def read(srv, path):
    match = route(path)
    if not match:
        return None
    if match[3]:
        raise protection.ProtectionError("找不到这个操作", 404)
    with srv.connect() as conn:
        conn.execute("BEGIN")
        row, _, chapter = active(srv, conn, match[1], match[2])
        return response(row, chapter, saved(conn, match[1], match[2]))


def validate_version(data, minimum=0):
    if type(data.get("version")) is not int or data["version"] < minimum:
        raise ValueError("保存对照修改时需要当前草稿版本。")


def validate_fingerprint(data):
    value = data.get("canonicalFingerprint")
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("对照原文校验值不正确。")
    return value


def validate_pair(srv, pair, book):
    if not isinstance(pair, dict) or set(pair) != {"title", "body"}:
        raise ValueError("对照稿标题或正文格式不正确。")
    limit = srv.MAX_BOOK if book["kind"] == "short" else 5_000_000
    return {"title": srv.checked_string(pair["title"], "对照稿标题", 200),
            "body": srv.checked_string(pair["body"], "对照稿正文", limit)}


def check_version(draft, version):
    if version != (draft["version"] if draft is not None else 0):
        raise protection.ProtectionError(CONFLICT, 409, True)


def put(srv, path, data):
    match = route(path)
    if not match:
        return None
    if match[3]:
        raise protection.ProtectionError("找不到这个操作", 404)
    required = {"version", "canonicalFingerprint", "baseline", "draft"}
    if not isinstance(data, dict) or not required <= set(data) <= required | {"rebase"}:
        raise ValueError("对照稿保存参数不正确。")
    validate_version(data)
    supplied = validate_fingerprint(data)
    if "rebase" in data and type(data["rebase"]) is not bool:
        raise ValueError("更新对照原文参数不正确。")
    book_id, chapter_id = match[1], match[2]
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row, book, chapter = active(srv, conn, book_id, chapter_id)
        previous = saved(conn, book_id, chapter_id)
        check_version(previous, data["version"])
        canonical = text_pair(chapter)
        checkpoint = ({"title": previous["canonical_title"], "body": previous["canonical_body"]}
                      if previous is not None and not data.get("rebase", False) else canonical)
        checkpoint_fingerprint = fingerprint(checkpoint)
        if supplied != checkpoint_fingerprint:
            raise protection.ProtectionError(CANONICAL_CONFLICT, 409, True)
        baseline, draft = (validate_pair(srv, data[key], book) for key in ("baseline", "draft"))
        expected_baseline = {"title": previous["baseline_title"], "body": previous["baseline_body"]} if previous is not None else canonical
        if baseline != expected_baseline:
            raise protection.ProtectionError("对照原文已变化，请重新打开对照修改。", 409, True)
        if len(json.dumps([baseline, draft], ensure_ascii=False).encode("utf-8")) > srv.MAX_BOOK * 2:
            raise ValueError("对照稿超过本机保存大小限制。")
        stamp = srv.now()
        conn.execute("""INSERT INTO comparison_drafts VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(book_id,chapter_id) DO UPDATE SET
            version=excluded.version,draft_title=excluded.draft_title,draft_body=excluded.draft_body,
            canonical_title=excluded.canonical_title,canonical_body=excluded.canonical_body,
            canonical_fingerprint=excluded.canonical_fingerprint,updated_at=excluded.updated_at""",
                     (book_id, chapter_id, data["version"] + 1, baseline["title"], baseline["body"],
                      draft["title"], draft["body"], checkpoint["title"], checkpoint["body"], checkpoint_fingerprint, stamp))
        return response(row, chapter, saved(conn, book_id, chapter_id))


def apply(srv, path, data):
    match = route(path)
    if not match:
        return None
    if not match[3]:
        raise protection.ProtectionError("找不到这个操作", 404)
    required = {"version", "canonicalFingerprint", "revision"}
    if not isinstance(data, dict) or not required <= set(data) <= required | {"reviewTools"}:
        raise ValueError("保存修改稿参数不正确。")
    validate_version(data, 1)
    supplied = validate_fingerprint(data)
    if type(data["revision"]) is not int or data["revision"] < 1:
        raise ValueError("保存修改稿时需要当前作品版本。")
    book_id, chapter_id = match[1], match[2]
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row, book, chapter = active(srv, conn, book_id, chapter_id)
        previous = saved(conn, book_id, chapter_id)
        check_version(previous, data["version"])
        current = fingerprint(text_pair(chapter))
        if row["revision"] != data["revision"] or supplied != current or previous["canonical_fingerprint"] != current:
            raise protection.ProtectionError(CANONICAL_CONFLICT, 409, True)
        before = copy.deepcopy(book)
        chapter.update(title=previous["draft_title"], body=previous["draft_body"])
        if "reviewTools" in data:
            book["reviewTools"] = data["reviewTools"]
        book = srv.validate_book(book)
        chapter = next(item for item in book["chapters"] if item["id"] == chapter_id)
        stamp = srv.now()
        srv.preserve_history(conn, row, stamp)
        srv.planning.record_save(conn, before, book, stamp)
        conn.execute("UPDATE books SET payload=?,revision=revision+1,updated_at=? WHERE id=?",
                     (json.dumps(book, ensure_ascii=False), stamp, book_id))
        conn.execute("""UPDATE comparison_drafts SET version=version+1,
            canonical_title=?,canonical_body=?,canonical_fingerprint=?,updated_at=?
            WHERE book_id=? AND chapter_id=?""",
                     (chapter["title"], chapter["body"], fingerprint(text_pair(chapter)), stamp, book_id, chapter_id))
        result = {"book": book, "revision": row["revision"] + 1, "updatedAt": stamp,
                  "comparison": record(saved(conn, book_id, chapter_id))}
    try:
        srv.checkpoint_book(book_id)
    except Exception as exc:
        result["protectionWarning"] = srv.external_backups.WARNING if str(exc) == srv.external_backups.WARNING else protection.WARNING
    try:
        srv.sync_book_folder(book_id)
    except Exception:
        result["folderWarning"] = srv.FOLDER_WARNING
    return result


def delete(srv, path, data):
    match = route(path)
    if not match:
        return None
    if match[3]:
        raise protection.ProtectionError("找不到这个操作", 404)
    if not isinstance(data, dict) or set(data) != {"version"}:
        raise ValueError("删除对照稿参数不正确。")
    validate_version(data)
    with srv.DB_LOCK, srv.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row, _, chapter = active(srv, conn, match[1], match[2])
        check_version(saved(conn, match[1], match[2]), data["version"])
        conn.execute("DELETE FROM comparison_drafts WHERE book_id=? AND chapter_id=?", (match[1], match[2]))
        return response(row, chapter, None)


def purge_book(conn, book_id):
    conn.execute("DELETE FROM comparison_drafts WHERE book_id=?", (book_id,))


def purge_chapters(conn, book_id, chapter_ids, short=False):
    # Any alias can occur inside both saved halves of a continuous short story.
    # Its comparison pairs must therefore be removed as a whole on alias purge.
    if short:
        purge_book(conn, book_id)
        return
    conn.executemany("DELETE FROM comparison_drafts WHERE book_id=? AND chapter_id=?", ((book_id, identity) for identity in chapter_ids))
