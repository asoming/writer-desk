"""Book-local planning and writing activity, without manuscript duplication.

Planning lives in the book payload so normal JSON exports, snapshots and imports
preserve it. Writing activity stores only dates and character counts in SQLite;
imports and version restores must not call ``record_save``.
"""
import copy
import json
from datetime import date, datetime, timedelta, timezone
import re

DEFAULT_DAILY_GOAL = 2000
MAX_ITEMS = 10000
STAT_DAYS = 90
STATUSES = {"planted", "developing", "resolved"}


def defaults():
    return {"foreshadows": [], "timeline": [], "dailyGoal": DEFAULT_DAILY_GOAL}


def _text(value, label, limit, empty=True):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(label + "格式不正确或长度超出限制")
    return value


def _links(value, allowed, label):
    if (not isinstance(value, list) or len(value) > MAX_ITEMS
            or any(not isinstance(item, str) or item not in allowed for item in value)):
        raise ValueError(label + "必须关联本作品内的内容")
    return list(dict.fromkeys(value))


def validate(book, source=None):
    """Validate extensions against the already validated chapters and people.

    The source may be an untrusted imported/PUT payload; unknown fields are not
    copied. Existing references to recycled items are removed, not reactivated.
    """
    source = book if source is None else source
    raw = source.get("storyTools", defaults())
    if not isinstance(raw, dict):
        raise ValueError("创作工具格式不正确")
    goal = raw.get("dailyGoal", DEFAULT_DAILY_GOAL)
    if type(goal) is not int or not 0 <= goal <= 1_000_000:
        raise ValueError("每日目标须为 0 至 1000000 的整数")
    chapter_ids = {item["id"] for item in book.get("chapters", [])}
    chapter_ids.update(item["id"] for item in book.get("shortSections", []))
    person_ids = {item["id"] for item in book.get("notes", []) if item.get("type") == "人物"}
    clean = {"dailyGoal": goal}
    for key in ("foreshadows", "timeline"):
        records = raw.get(key, [])
        if not isinstance(records, list) or len(records) > MAX_ITEMS:
            raise ValueError("伏笔或时间线列表格式不正确")
        clean[key], seen = [], set()
        for item in records:
            if not isinstance(item, dict):
                raise ValueError("伏笔或事件格式不正确")
            item_id = _text(item.get("id"), "创作条目编号", 100, False)
            if item_id in seen:
                raise ValueError("创作条目编号重复")
            seen.add(item_id)
            record = {"id": item_id, "title": _text(item.get("title", ""), "标题", 200),
                      "body": _text(item.get("body", ""), "说明", 100000),
                      "chapterIds": _links(item.get("chapterIds", []), chapter_ids, "关联正文"),
                      "personIds": _links(item.get("personIds", []), person_ids, "关联人物")}
            if key == "foreshadows":
                status = item.get("status", "planted")
                if not isinstance(status, str) or status not in STATUSES:
                    raise ValueError("伏笔状态须为埋下、推进或回收")
                record["status"] = status
            else:
                record["storyTime"] = _text(item.get("storyTime", ""), "故事时间", 200)
            clean[key].append(record)
    book["storyTools"] = clean
    return normalize(book)


def normalize(book):
    """Upgrade old read views and discard links to recycled chapter/person IDs."""
    tools = book.setdefault("storyTools", defaults())
    if not isinstance(tools, dict):
        return book  # Validation reports corrupted/untrusted fields separately.
    tools.setdefault("dailyGoal", DEFAULT_DAILY_GOAL)
    tools.setdefault("foreshadows", [])
    tools.setdefault("timeline", [])
    chapters = {item["id"] for item in book.get("chapters", []) if not item.get("deletedAt")}
    chapters.update(item["id"] for item in book.get("shortSections", []))
    people = {item["id"] for item in book.get("notes", []) if item.get("type") == "人物" and not item.get("deletedAt")}
    for key in ("foreshadows", "timeline"):
        if not isinstance(tools.get(key), list):
            continue
        for item in tools[key]:
            if not isinstance(item, dict):
                continue
            item["chapterIds"] = [value for value in item.get("chapterIds", []) if value in chapters]
            item["personIds"] = [value for value in item.get("personIds", []) if value in people]
    return book


def sanitize(book, chapter_ids, replacements=None):
    """Remove purged chapter references from a copy, including old short aliases.

    Call from chapter_history.sanitize after its short-body replacement mapping
    is known. It never copies manuscript content into a planning record.
    """
    result = copy.deepcopy(book)
    replacements = replacements or {}
    tools = result.get("storyTools", {})
    for key in ("foreshadows", "timeline"):
        for item in tools.get(key, []):
            item["chapterIds"] = list(dict.fromkeys(replacements.get(value, value)
                for value in item.get("chapterIds", []) if value in replacements or value not in chapter_ids))
    return result


def remap_short_links(book, aliases, manuscript_id, recycled=()):
    """Mirror normalize_short_book for planning links before validating them."""
    for key in ("foreshadows", "timeline"):
        for item in book.get("storyTools", {}).get(key, []):
            item["chapterIds"] = list(dict.fromkeys(manuscript_id if value in aliases and value not in recycled else value
                for value in item.get("chapterIds", [])))
    return book


def initialize(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS writing_activity(book_id TEXT NOT NULL,local_day TEXT NOT NULL,added_chars INTEGER NOT NULL CHECK(added_chars >= 0),updated_at TEXT NOT NULL,PRIMARY KEY(book_id,local_day))")


def character_count(text):
    return sum(not char.isspace() for char in text)


def record_save(conn, before, after, stamp=None, local_day=None):
    """Record positive body growth inside the caller's successful save transaction.

    Run only for a normal author save, after revision and deletion checks. Whole
    book import/create, restore, seeding and chapter undelete are excluded. A
    failed transaction rolls activity back with the manuscript. Metadata-only
    changes and moving/reordering chapters count zero.
    """
    if before.get("id") != after.get("id"):
        raise ValueError("写作统计必须属于同一作品")
    old = {item["id"]: item for item in before.get("chapters", [])}
    added = 0
    if after.get("kind") == "short":
        # Legacy short stories may join multiple active sections on first edit.
        # That migration, and inserting a recovered section, are not production.
        active_ids = {item["id"] for item in after.get("chapters", []) if not item.get("deletedAt")}
        active_ids.update(item["id"] for item in after.get("shortSections", []))
        restored = sum(character_count(item.get("body", "")) for item in old.values()
                       if item.get("deletedAt") and item["id"] in active_ids)
        previous_total = sum(character_count(item.get("body", "")) for item in old.values() if not item.get("deletedAt"))
        current_total = sum(character_count(item.get("body", "")) for item in after.get("chapters", []) if not item.get("deletedAt"))
        added = max(0, current_total - previous_total - restored)
    else:
        for item in after.get("chapters", []):
            if item.get("deletedAt"):
                continue
            previous = old.get(item["id"])
            if previous is not None and previous.get("deletedAt"):
                continue  # Restoring a recycled chapter is not new writing.
            added += max(0, character_count(item.get("body", ""))
                         - character_count(previous.get("body", "") if previous else ""))
    if not added:
        return 0
    today = date.today() if local_day is None else date.fromisoformat(local_day)
    stamp = stamp or datetime.now(timezone.utc).isoformat()
    conn.execute("INSERT INTO writing_activity(book_id,local_day,added_chars,updated_at) VALUES(?,?,?,?) ON CONFLICT(book_id,local_day) DO UPDATE SET added_chars=writing_activity.added_chars+excluded.added_chars,updated_at=excluded.updated_at",
                 (after["id"], today.isoformat(), added, stamp))
    return added


def purge_book(conn, book_id):
    conn.execute("DELETE FROM writing_activity WHERE book_id=?", (book_id,))


def statistics(conn, book, today=None):
    today = date.today() if today is None else date.fromisoformat(today)
    start = today - timedelta(days=STAT_DAYS - 1)
    rows = conn.execute("SELECT local_day,added_chars FROM writing_activity WHERE book_id=? AND local_day>=? AND local_day<=? ORDER BY local_day", (book["id"], start.isoformat(), today.isoformat())).fetchall()
    by_day = {row[0]: row[1] for row in rows}
    days = [{"date": (start + timedelta(days=offset)).isoformat(),
             "addedChars": by_day.get((start + timedelta(days=offset)).isoformat(), 0)} for offset in range(STAT_DAYS)]
    return {"bookId": book["id"], "today": today.isoformat(),
            "dailyGoal": book.get("storyTools", {}).get("dailyGoal", DEFAULT_DAILY_GOAL),
            "todayChars": by_day.get(today.isoformat(), 0),
            "totalChars": sum(character_count(item.get("body", "")) for item in book.get("chapters", []) if not item.get("deletedAt")),
            "days": days}


def read(srv, path):
    """Use the server's authenticated GET dispatch; return None for other paths."""
    match = re.fullmatch(r"/api/books/([^/]+)/writing-stats", path)
    if not match:
        return None
    with srv.DB_LOCK, srv.connect() as conn:
        row = srv.saved_book_row(conn, match.group(1))
        srv.require_active_book(row)
        book = srv.upgrade_book(json.loads(row["payload"]))
        return statistics(conn, book)
