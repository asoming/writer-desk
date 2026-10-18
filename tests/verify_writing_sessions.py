"""Immersive counters and authenticated HTTP journeys use isolated libraries."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import home_dashboard
import planning
import protection
import server
import writing_sessions
import verify_home_dashboard as home_tests


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT,payload TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT)")
        planning.initialize(self.conn)
        home_dashboard.initialize(self.conn)
        self.book = server.new_book("隔离码字检验")
        self.book["chapters"] = [server.chapter(body="原来的正文", volume_id=self.book["volumes"][0]["id"])]
        server.insert_book(self.conn, self.book)
        self.start = datetime(2026, 10, 17, 20, 0, tzinfo=timezone.utc)
        self.clock = self.start + timedelta(hours=1)

    def payload(self, **changes):
        return {"id": str(uuid.uuid4()), "bookId": self.book["id"],
                "startedAt": writing_sessions.iso(self.start),
                "endedAt": writing_sessions.iso(self.start + timedelta(minutes=10)),
                "localDay": "2026-10-18", "typedChars": 100, "activeMs": 120000,
                "idleMs": 480000, "foregroundMs": 540000, **changes}

    def save(self, data):
        return writing_sessions.upsert(self.conn, data, self.clock)

    def home(self, local_day="2026-10-18"):
        return home_dashboard.statistics(self.conn, server.book_summary, local_day)

    def test_checkpoint_replay_stale_order_and_restart_are_idempotent(self):
        first = self.payload()
        expected = self.save(first)
        before = self.conn.total_changes
        self.assertEqual(self.save(first), expected)
        self.assertEqual(self.conn.total_changes, before)
        newer = {**first, "endedAt": writing_sessions.iso(self.start + timedelta(minutes=20)),
                 "typedChars": 180, "activeMs": 200000, "idleMs": 1000000, "foregroundMs": 1140000}
        latest = self.save(newer)
        self.assertEqual(self.save(first), latest)
        self.assertEqual(self.home()["writingSessions"]["today"]["typedChars"], 180)
        self.assertEqual(self.home()["writingSessions"]["today"]["count"], 1)
        # An initialization/reopen must not seed, double, or clear a checkpoint.
        writing_sessions.initialize(self.conn)
        self.assertEqual(writing_sessions.recent(self.conn), [latest])

    def test_validation_rejects_unbounded_counters_text_unknown_and_invalid_times(self):
        cases = [[], {}, self.payload(body="private manuscript"), self.payload(typedChars=True),
                 self.payload(activeMs=-1), self.payload(idleMs=1.5), self.payload(foregroundMs="10"),
                 self.payload(typedChars=10_000_001), self.payload(activeMs=600001, idleMs=2000),
                 self.payload(activeMs=120000, foregroundMs=1), self.payload(foregroundMs=602001),
                 self.payload(startedAt="2026-10-17T20:00:00"), self.payload(endedAt="not-a-date"),
                 self.payload(localDay="2026-02-30"), self.payload(localDay="2026-10-20"),
                 self.payload(id="' OR 1=1 --"), self.payload(bookId=""),
                 self.payload(endedAt=writing_sessions.iso(self.start - timedelta(seconds=1))),
                 self.payload(endedAt=writing_sessions.iso(self.clock + timedelta(minutes=6))),
                 self.payload(endedAt=writing_sessions.iso(self.start + timedelta(days=31)))]
        before = self.conn.total_changes
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.save(data)
        self.assertEqual(self.conn.total_changes, before)
        self.assertEqual(writing_sessions.recent(self.conn), [])

    def test_identity_and_counter_conflicts_never_overwrite_record(self):
        data = self.payload()
        expected = self.save(data)
        foreign = server.new_book("另一部作品")
        server.insert_book(self.conn, foreign)
        for changes in ({"bookId": foreign["id"]}, {"startedAt": writing_sessions.iso(self.start - timedelta(seconds=1))},
                        {"localDay": "2026-10-17"}, {"typedChars": 99}, {"activeMs": 119999},
                        {"idleMs": 479999}, {"foregroundMs": 539999}):
            with self.subTest(changes=changes), self.assertRaises(protection.ProtectionError) as error:
                self.save({**data, **changes})
            self.assertEqual(error.exception.status, 409)
        self.assertEqual(writing_sessions.recent(self.conn), [expected])

    def test_sessions_never_change_manuscript_saved_growth_revision_or_title_snapshot(self):
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM books")]
        data = self.payload()
        self.save(data)
        result = self.home()
        self.assertEqual(result["totals"]["todayChars"], 0)
        self.assertEqual(result["writingSessions"]["today"]["typedChars"], 100)
        self.assertEqual([tuple(row) for row in self.conn.execute("SELECT * FROM books")], before)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writing_activity").fetchone()[0], 0)
        self.conn.execute("UPDATE books SET title='已改书名' WHERE id=?", (self.book["id"],))
        self.assertEqual(self.save(data)["bookTitle"], "隔离码字检验")
        self.assertEqual(self.home()["writingSessions"]["recent"][0]["bookTitle"], "隔离码字检验")

    def test_home_aggregates_active_local_day_and_reports_weighted_rates_start_end(self):
        first = self.payload()
        self.save(first)
        second = self.payload(typedChars=200, activeMs=60000, idleMs=540000)
        self.save(second)
        self.save(self.payload(localDay="2026-10-17", typedChars=900))
        today = self.home()["writingSessions"]["today"]
        self.assertEqual((today["count"], today["typedChars"], today["activeMs"], today["idleMs"], today["foregroundMs"]),
                         (2, 300, 180000, 1020000, 1080000))
        self.assertEqual((today["speedPerHour"], today["speedPerMinute"]), (6000, 100))
        self.assertEqual((today["startedAt"], today["endedAt"]), (first["startedAt"], first["endedAt"]))
        self.assertEqual(self.home("2026-10-19")["writingSessions"]["today"]["count"], 0)
        self.assertEqual(len(self.home("2026-10-19")["writingSessions"]["recent"]), 3)

    def test_speed_rounding_matches_live_readout_at_exact_halves(self):
        self.assertEqual(writing_sessions.speed(2, 64_000)["speedPerHour"], 113)
        self.assertEqual(writing_sessions.speed(2, 48_000)["speedPerMinute"], 3)

    def test_empty_session_zero_speeds_and_client_timezone_dates_do_not_use_host_day(self):
        self.save(self.payload(typedChars=0, activeMs=0, idleMs=600000, foregroundMs=0))
        empty = self.home()["writingSessions"]["today"]
        self.assertEqual((empty["speedPerHour"], empty["speedPerMinute"], empty["count"]), (0, 0, 1))
        self.assertEqual(self.home("2026-10-17")["writingSessions"]["today"]["count"], 0)
        equivalent = self.payload(startedAt="2026-10-18T04:00:00+08:00", endedAt="2026-10-18T04:10:00+08:00")
        self.assertEqual(self.save(equivalent)["startedAt"], "2026-10-17T20:00:00.000Z")

    def test_trash_restore_missing_book_and_purge_have_active_library_scope(self):
        data = self.payload()
        self.save(data)
        self.conn.execute("UPDATE books SET deleted_at=? WHERE id=?", ("2026-10-18T00:00:00Z", self.book["id"]))
        self.assertEqual(self.home()["writingSessions"]["today"]["count"], 0)
        self.assertEqual(writing_sessions.recent(self.conn), [])
        with self.assertRaises(protection.ProtectionError) as error:
            self.save(data)
        self.assertTrue(error.exception.deleted)
        self.conn.execute("UPDATE books SET deleted_at=NULL WHERE id=?", (self.book["id"],))
        self.assertEqual(self.home()["writingSessions"]["today"]["count"], 1)
        writing_sessions.purge_book(self.conn, self.book["id"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writing_sessions").fetchone()[0], 0)
        with self.assertRaises(protection.ProtectionError) as missing:
            self.save(self.payload(bookId="missing"))
        self.assertEqual(missing.exception.status, 404)

    def test_sql_foreign_key_cascade_and_recent_filter_limit_are_safe(self):
        for index in range(25):
            self.save(self.payload(typedChars=index))
        self.assertEqual(len(writing_sessions.recent(self.conn)), 20)
        self.assertEqual(writing_sessions.recent(self.conn, book_id="' OR 1=1 --"), [])
        self.assertEqual(writing_sessions.recent(self.conn, local_day="2026-10-19"), [])
        self.conn.execute("DELETE FROM books WHERE id=?", (self.book["id"],))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM writing_sessions").fetchone()[0], 0)

    def test_query_validates_dates_duplicates_and_unknown_parameters(self):
        self.assertEqual(writing_sessions.query("/api/home", {"localDay"}), {})
        self.assertEqual(writing_sessions.query("/api/home?localDay=2026-10-18", {"localDay"}), {"localDay": "2026-10-18"})
        for url in ("/api/home?localDay=", "/api/home?localDay=2026-02-30", "/api/home?localDay=0001-01-01", "/api/home?localDay=x&localDay=y",
                    "/api/home?localDay", "/api/home?other=1", "/api/writing-sessions?bookId="):
            with self.subTest(url=url), self.assertRaises(ValueError):
                writing_sessions.query(url, {"localDay", "bookId"})


class SessionHTTPTests(unittest.TestCase):
    # Reuse only the disposable authenticated fixture, not unrelated test cases.
    setUp = home_tests.HomeHTTPTests.setUp
    start = home_tests.HomeHTTPTests.start
    stop = home_tests.HomeHTTPTests.stop
    request = home_tests.HomeHTTPTests.request
    tearDown = home_tests.HomeHTTPTests.tearDown

    def payload(self, book_id):
        end = datetime.now(timezone.utc) - timedelta(seconds=1)
        return {"id": str(uuid.uuid4()), "bookId": book_id, "startedAt": writing_sessions.iso(end - timedelta(minutes=10)),
                "endedAt": writing_sessions.iso(end), "localDay": end.astimezone().date().isoformat(),
                "typedChars": 300, "activeMs": 120000, "idleMs": 480000, "foregroundMs": 590000}

    def test_real_demo_checkpoint_restart_home_and_no_manuscript_or_daily_growth_mutation(self):
        shelf = self.request("/api/books")["books"]
        book_id = next(item["id"] for item in shelf if item["charCount"] == 101506)
        before = self.request("/api/books/" + book_id)
        data = self.payload(book_id)
        self.assertEqual(self.request("/api/home?localDay=" + data["localDay"])["writingSessions"]["today"]["typedChars"], 0)
        expected = self.request("/api/writing-sessions", "POST", data)["session"]
        self.assertEqual(self.request("/api/writing-sessions", "POST", data)["session"], expected)
        self.assertEqual(self.request("/api/writing-sessions?bookId=" + book_id)["sessions"], [expected])
        self.assertEqual(self.request("/api/books/" + book_id), before)
        home = self.request("/api/home?localDay=" + data["localDay"])
        self.assertEqual(home["totals"]["todayChars"], 0)
        self.assertEqual((home["writingSessions"]["today"]["typedChars"], home["writingSessions"]["today"]["count"]), (300, 1))
        self.stop()
        self.start()
        self.assertEqual(self.request("/api/writing-sessions")["sessions"], [expected])
        self.assertEqual(self.request("/api/books/" + book_id), before)

    def test_http_authorization_validation_and_no_raw_text(self):
        book_id = self.request("/api/books")["books"][0]["id"]
        data = self.payload(book_id)
        self.request("/api/writing-sessions", "POST", data, status=403, token=False)
        self.request("/api/writing-sessions", status=403, token=False)
        self.request("/api/writing-sessions", "POST", {**data, "body": "private"}, status=400)
        self.request("/api/writing-sessions", "POST", {**data, "typedChars": True}, status=400)
        self.request("/api/writing-sessions", "POST", {**data, "bookId": "missing"}, status=404)
        self.request("/api/home?localDay=invalid", status=400)
        self.request("/api/writing-sessions?localDay=invalid", status=400)
        self.request("/api/writing-sessions?bookId=missing", status=404)
        self.assertEqual(self.request("/api/writing-sessions")["sessions"], [])

    def test_real_trash_restore_final_purge_removes_only_book_session_rows(self):
        first, other = self.request("/api/books")["books"][:2]
        data = self.payload(first["id"])
        self.request("/api/writing-sessions", "POST", data)
        expected = self.request("/api/writing-sessions", "POST", self.payload(other["id"]))["session"]
        current = self.request("/api/books/" + first["id"])
        trashed = self.request("/api/books/" + first["id"] + "/trash", "POST", {"revision": current["revision"]})
        self.assertEqual(self.request("/api/writing-sessions")["sessions"], [expected])
        self.request("/api/writing-sessions", "POST", data, status=409)
        self.request("/api/writing-sessions?bookId=" + first["id"], status=409)
        restored = self.request("/api/books/" + first["id"] + "/restore", "POST", {"revision": trashed["revision"]})
        self.assertEqual(len(self.request("/api/writing-sessions")["sessions"]), 2)
        trashed = self.request("/api/books/" + first["id"] + "/trash", "POST", {"revision": restored["revision"]})
        self.request("/api/books/" + first["id"] + "/purge", "POST", {"revision": trashed["revision"]})
        self.assertEqual(self.request("/api/writing-sessions")["sessions"], [expected])
        with sqlite3.connect(str(self.data / "writer.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM writing_sessions WHERE book_id=?", (first["id"],)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM writing_sessions WHERE book_id=?", (other["id"],)).fetchone()[0], 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", type=Path)
    arguments, remaining = parser.parse_known_args()
    home_tests.SERVICE = arguments.service.resolve() if arguments.service else None
    unittest.main(argv=[sys.argv[0], *remaining])
