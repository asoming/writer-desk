"""Library-wide writing totals from committed activity, without touching books."""
from datetime import date, timedelta

import planning

STAT_DAYS = 90
RECENT_LIMIT = 6


def initialize(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS home_settings(id INTEGER PRIMARY KEY CHECK(id=1),daily_goal INTEGER NOT NULL CHECK(daily_goal BETWEEN 0 AND 1000000))")


def settings(conn):
    row = conn.execute("SELECT daily_goal FROM home_settings WHERE id=1").fetchone()
    return {"dailyGoal": row[0] if row is not None else planning.DEFAULT_DAILY_GOAL}


def update_settings(conn, data):
    if not isinstance(data, dict) or set(data) != {"dailyGoal"} or type(data["dailyGoal"]) is not int or not 0 <= data["dailyGoal"] <= 1_000_000:
        raise ValueError("每日目标须为 0 至 1000000 的整数")
    conn.execute("INSERT INTO home_settings(id,daily_goal) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET daily_goal=excluded.daily_goal", (data["dailyGoal"],))
    return settings(conn)


def statistics(conn, summarize, today=None):
    """One read snapshot. Recycled books are excluded until restored.

    ``writing_activity`` is populated only by successful author saves, never
    imports, seeded examples, restore operations or incoming synchronization.
    It contains counts rather than manuscript text. The independent global
    daily goal does not rewrite any book's existing storyTools.dailyGoal.
    """
    today = date.today() if today is None else date.fromisoformat(today)
    start = today - timedelta(days=STAT_DAYS - 1)
    activity = conn.execute("SELECT activity.local_day,SUM(activity.added_chars) FROM writing_activity AS activity JOIN books ON books.id=activity.book_id WHERE books.deleted_at IS NULL AND activity.local_day<=? GROUP BY activity.local_day ORDER BY activity.local_day", (today.isoformat(),)).fetchall()
    by_day = {row[0]: row[1] for row in activity if row[1] > 0}
    days = [{"date": (start + timedelta(days=offset)).isoformat(), "addedChars": by_day.get((start + timedelta(days=offset)).isoformat(), 0)} for offset in range(STAT_DAYS)]
    streak = 0
    cursor = today if by_day.get(today.isoformat(), 0) else today - timedelta(days=1)
    while by_day.get(cursor.isoformat(), 0):
        streak += 1
        cursor -= timedelta(days=1)
    best, run, previous = 0, 0, None
    for stamp in sorted(by_day):
        current = date.fromisoformat(stamp)
        run = run + 1 if previous is not None and current == previous + timedelta(days=1) else 1
        best = max(best, run)
        previous = current
    totals = {"todayChars": by_day.get(today.isoformat(), 0), "totalChars": 0, "bookCount": 0,
              "longCount": 0, "shortCount": 0, "chapterCount": 0, "writingDays": len(by_day),
              "currentStreak": streak, "bestStreak": best,
              "last7Chars": sum(day["addedChars"] for day in days[-7:]),
              "last30Chars": sum(day["addedChars"] for day in days[-30:])}
    recent = []
    for row in conn.execute("SELECT * FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC,id"):
        book = summarize(row)
        totals["bookCount"] += 1
        totals["longCount" if book["kind"] == "long" else "shortCount"] += 1
        totals["totalChars"] += book["charCount"]
        totals["chapterCount"] += book["chapterCount"]
        if len(recent) < RECENT_LIMIT:
            recent.append(book)
    return {"today": today.isoformat(), "settings": settings(conn), "totals": totals, "days": days, "recentBooks": recent}
