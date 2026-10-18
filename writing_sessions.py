"""Private, cumulative immersive-writing counters, independent of manuscripts.

Clients checkpoint the same UUID while writing. Replaying an earlier checkpoint
cannot double the totals or replace newer counters. No typed text is stored here,
and these counters never seed or modify the normal saved-growth statistics.
"""
from datetime import date, datetime, timedelta, timezone
import re
from urllib.parse import parse_qs, urlparse
import uuid

import protection

MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000
MAX_TYPED_CHARS = 10_000_000
CLOCK_TOLERANCE_MS = 2000
RECENT_LIMIT = 20
FIELDS = {"id", "bookId", "startedAt", "endedAt", "localDay", "typedChars", "activeMs", "idleMs", "foregroundMs"}
COUNTERS = {"typedChars": "typed_chars", "activeMs": "active_ms", "idleMs": "idle_ms", "foregroundMs": "foreground_ms"}


def initialize(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS writing_sessions(
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        book_title TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL, local_day TEXT NOT NULL,
        typed_chars INTEGER NOT NULL CHECK(typed_chars BETWEEN 0 AND 10000000),
        active_ms INTEGER NOT NULL CHECK(active_ms BETWEEN 0 AND 2592000000),
        idle_ms INTEGER NOT NULL CHECK(idle_ms BETWEEN 0 AND 2592000000),
        foreground_ms INTEGER NOT NULL CHECK(foreground_ms BETWEEN 0 AND 2592000000))""")
    conn.execute("CREATE INDEX IF NOT EXISTS writing_sessions_book ON writing_sessions(book_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS writing_sessions_day ON writing_sessions(local_day,ended_at)")


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("码字日期格式不正确。")
    try:
        result = date.fromisoformat(value)
        if not 2000 <= result.year <= 2100:
            raise ValueError()
        return result
    except ValueError:
        raise ValueError("码字日期格式不正确。") from None


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("码字时间需要包含时区。")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        if not 2000 <= stamp.year <= 2100:
            raise ValueError()
        return stamp
    except (ValueError, OverflowError):
        raise ValueError("码字时间格式不正确。") from None


def iso(stamp):
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate(data, clock=None):
    if not isinstance(data, dict) or set(data) != FIELDS:
        raise ValueError("码字记录参数不正确。")
    identity = data["id"]
    if not isinstance(identity, str) or not re.fullmatch(r"[a-fA-F0-9-]{32,36}", identity):
        raise ValueError("码字记录编号不正确。")
    try:
        identity = str(uuid.UUID(identity))
    except ValueError:
        raise ValueError("码字记录编号不正确。") from None
    book_id = data["bookId"]
    if not isinstance(book_id, str) or not 1 <= len(book_id) <= 100 or any(ord(char) < 32 for char in book_id):
        raise ValueError("码字记录需要关联作品。")
    start, end = timestamp(data["startedAt"]), timestamp(data["endedAt"])
    local_day = day(data["localDay"])
    current = datetime.now(timezone.utc) if clock is None else clock.astimezone(timezone.utc)
    duration = round((end - start).total_seconds() * 1000)
    if not 0 <= duration <= MAX_DURATION_MS or end > current + timedelta(minutes=5):
        raise ValueError("码字时长或结束时间不正确。")
    # A UTC ISO timestamp and the author's calendar can straddle a date boundary.
    # Do not assume the service host shares the author's timezone.
    if abs((local_day - start.date()).days) > 1:
        raise ValueError("码字日期与开始时间不一致。")
    clean = {"id": identity, "bookId": book_id, "startedAt": iso(start), "endedAt": iso(end), "localDay": local_day.isoformat()}
    for key in COUNTERS:
        value = data[key]
        maximum = MAX_TYPED_CHARS if key == "typedChars" else MAX_DURATION_MS
        if type(value) is not int or not 0 <= value <= maximum:
            raise ValueError("码字字数与时长须为非负整数。")
        clean[key] = value
    if (clean["activeMs"] + clean["idleMs"] > duration + CLOCK_TOLERANCE_MS
            or clean["foregroundMs"] > duration + CLOCK_TOLERANCE_MS
            or clean["activeMs"] > clean["foregroundMs"] + CLOCK_TOLERANCE_MS):
        raise ValueError("码字、空闲与前台时间不能超过实际时长。")
    return clean


def speed(chars, active_ms):
    # Match the live readout's Math.round for non-negative counters, including
    # exact halves; Python's round otherwise changes 112.5 to 112 on Home.
    return {"speedPerHour": (chars * 3_600_000 + active_ms // 2) // active_ms if active_ms else 0,
            "speedPerMinute": (chars * 60_000 + active_ms // 2) // active_ms if active_ms else 0}


def record(row):
    result = {"id": row["id"], "bookId": row["book_id"], "bookTitle": row["book_title"],
              "startedAt": row["started_at"], "endedAt": row["ended_at"], "localDay": row["local_day"]}
    result.update((key, row[column]) for key, column in COUNTERS.items())
    return {**result, **speed(result["typedChars"], result["activeMs"])}


def upsert(conn, data, clock=None):
    """Caller holds its regular write lock and transaction; UUID is idempotent."""
    clean = validate(data, clock)
    book = conn.execute("SELECT title,deleted_at FROM books WHERE id=?", (clean["bookId"],)).fetchone()
    if book is None:
        raise protection.ProtectionError("找不到这部作品", 404)
    if book["deleted_at"] is not None:
        error = protection.ProtectionError("作品已移入回收站，码字记录未继续更新。", 409, True)
        error.deleted = True
        raise error
    previous = conn.execute("SELECT * FROM writing_sessions WHERE id=?", (clean["id"],)).fetchone()
    if previous is not None:
        if (previous["book_id"], previous["started_at"], previous["local_day"]) != (clean["bookId"], clean["startedAt"], clean["localDay"]):
            raise protection.ProtectionError("码字记录编号已属于另一次码字。", 409, True)
        if clean["endedAt"] < previous["ended_at"]:
            return record(previous)
        if any(clean[key] < previous[column] for key, column in COUNTERS.items()):
            raise protection.ProtectionError("码字记录已更新，请保留最新记录。", 409, True)
        if clean["endedAt"] == previous["ended_at"] and all(clean[key] == previous[column] for key, column in COUNTERS.items()):
            return record(previous)
    conn.execute("""INSERT INTO writing_sessions VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,
        typed_chars=excluded.typed_chars,active_ms=excluded.active_ms,
        idle_ms=excluded.idle_ms,foreground_ms=excluded.foreground_ms""",
                 (clean["id"], clean["bookId"], book["title"], clean["startedAt"], clean["endedAt"], clean["localDay"],
                  clean["typedChars"], clean["activeMs"], clean["idleMs"], clean["foregroundMs"]))
    return record(conn.execute("SELECT * FROM writing_sessions WHERE id=?", (clean["id"],)).fetchone())


def query(url, allowed):
    try:
        raw = urlparse(url).query
        values = parse_qs(raw, keep_blank_values=True, strict_parsing=True) if raw else {}
    except ValueError:
        raise ValueError("码字记录查询参数不正确。") from None
    if not set(values) <= set(allowed) or any(len(value) != 1 for value in values.values()):
        raise ValueError("码字记录查询参数不正确。")
    result = {key: value[0] for key, value in values.items()}
    if "localDay" in result:
        result["localDay"] = day(result["localDay"]).isoformat()
    if "bookId" in result and not 1 <= len(result["bookId"]) <= 100:
        raise ValueError("码字记录需要关联作品。")
    return result


def recent(conn, local_day=None, book_id=None, limit=RECENT_LIMIT):
    where, arguments = ["books.deleted_at IS NULL"], []
    for clause, value in (("sessions.local_day=?", local_day), ("sessions.book_id=?", book_id)):
        if value is not None:
            where.append(clause)
            arguments.append(value)
    rows = conn.execute("SELECT sessions.* FROM writing_sessions AS sessions JOIN books ON books.id=sessions.book_id WHERE "
                        + " AND ".join(where) + " ORDER BY sessions.ended_at DESC,sessions.id LIMIT ?", (*arguments, limit)).fetchall()
    return [record(row) for row in rows]


def statistics(conn, local_day):
    row = conn.execute("""SELECT COUNT(*),COALESCE(SUM(typed_chars),0),COALESCE(SUM(active_ms),0),
        COALESCE(SUM(idle_ms),0),COALESCE(SUM(foreground_ms),0),MIN(started_at),MAX(ended_at)
        FROM writing_sessions AS sessions JOIN books ON books.id=sessions.book_id
        WHERE books.deleted_at IS NULL AND sessions.local_day=?""", (local_day,)).fetchone()
    today = dict(zip(("count", "typedChars", "activeMs", "idleMs", "foregroundMs", "startedAt", "endedAt"), row))
    today.update(speed(today["typedChars"], today["activeMs"]))
    return {"today": today, "recent": recent(conn)}


def purge_book(conn, book_id):
    conn.execute("DELETE FROM writing_sessions WHERE book_id=?", (book_id,))
