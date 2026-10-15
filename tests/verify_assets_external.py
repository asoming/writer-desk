"""Portable assets and external backups use only disposable libraries/disks."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import asset_library
import chapter_history
import external_backups
import protection
import server
from verify_ai_cover import PNG, JPEG, WEBP

STAMP = "2026-10-15T00:00:00Z"


def sample():
    return json.loads((ROOT / "examples/tide-archive.yejian.json").read_text("utf-8"))["book"]


def asset(book, identity="image", kind="image", mime="image/png", data=PNG):
    return {"id": identity, "name": "参考图片", "kind": kind, "mime": mime,
            "data": data, "sourceUrl": "https://example.org/reference", "excerpt": "作者摘录",
            "chapterIds": [book["chapters"][0]["id"]], "noteIds": [],
            "createdAt": STAMP, "updatedAt": STAMP}


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.book = sample()

    def test_full_101506_character_v4_roundtrip_preserves_binary_and_links(self):
        self.book["assetLibrary"] = {"version": 1, "items": [asset(self.book)]}
        self.book["assetLibrary"]["items"][0]["noteIds"] = [self.book["notes"][0]["id"]]
        clean = server.validate_book(self.book)
        self.assertEqual(clean["assetLibrary"], self.book["assetLibrary"])
        envelope = json.loads(json.dumps({"format": "yejian-backup", "version": 4, "book": clean}, ensure_ascii=False))
        restored = server.restore_book(envelope["book"])
        self.assertNotEqual(restored["id"], clean["id"])
        self.assertEqual(restored["assetLibrary"], clean["assetLibrary"])
        self.assertEqual([item["body"] for item in restored["chapters"]], [item["body"] for item in clean["chapters"]])
        self.assertEqual(sum(sum(not char.isspace() for char in item["body"]) for item in clean["chapters"] if not item["deletedAt"]), 101506)
        self.assertEqual(base64.b64decode(restored["assetLibrary"]["items"][0]["data"]), base64.b64decode(PNG))

    def test_raster_pdf_and_text_types_are_verified_against_contents(self):
        for mime, encoded in (("image/png", PNG), ("image/jpeg", JPEG), ("image/webp", WEBP)):
            clean = asset_library.validate(self.book, {"version": 1, "items": [asset(self.book, mime=mime, data=encoded)]})
            self.assertEqual(clean["items"][0]["mime"], mime)
        pdf = base64.b64encode(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n").decode()
        self.assertEqual(asset_library.validate(self.book, {"version": 1, "items": [asset(self.book, kind="pdf", mime="application/pdf", data=pdf)]})["items"][0]["data"], pdf)
        invalid = [dict(kind="exe"), dict(mime="image/jpeg"), dict(data="not base64!"),
                   dict(data=base64.b64encode(b"MZ executable").decode()),
                   dict(kind="pdf", mime="application/pdf", data=base64.b64encode(b"%PDF-1.4 without EOF").decode()),
                   dict(kind="text"), dict(kind="web", mime="", data="", sourceUrl="")]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                asset_library.validate(self.book, {"version": 1, "items": [{**asset(self.book), **changes}]})

    def test_file_total_item_and_association_budgets_are_strict(self):
        value = {"version": 1, "items": [asset(self.book)]}
        for changes in ({"chapterIds": ["another-book"]}, {"noteIds": ["another-book"]},
                        {"chapterIds": "wrong"}, {"name": ""}, {"name": "a" * 201}, {"id": "../file"},
                        {"excerpt": "\ud800"}, {"unexpected": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                asset_library.validate(self.book, {"version": 1, "items": [{**asset(self.book), **changes}]})
        with self.assertRaises(ValueError):
            asset_library.validate(self.book, {"version": 1, "items": value["items"] * 2})
        with patch.object(asset_library, "MAX_FILE", 10), self.assertRaisesRegex(ValueError, "5 MB"):
            asset_library.validate(self.book, value)
        with patch.object(asset_library, "MAX_TOTAL", len(base64.b64decode(PNG))):
            with self.assertRaisesRegex(ValueError, "15 MB"):
                asset_library.validate(self.book, {"version": 1, "items": [asset(self.book), asset(self.book, "second")]})
        with self.assertRaisesRegex(ValueError, "120"):
            asset_library.validate(self.book, {"version": 1, "items": [{**asset(self.book), "id": str(index)} for index in range(121)]})

    def test_web_links_cannot_contain_credentials_or_executable_schemes(self):
        for url in ("javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.org", "https://"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                asset_library.validate(self.book, {"version": 1, "items": [asset(self.book, kind="web", mime="", data="") | {"sourceUrl": url}]})

    def test_purge_drops_exclusive_assets_and_retains_shared_unlinked_and_other_notes(self):
        first, second = [chapter["id"] for chapter in self.book["chapters"][:2]]
        note = self.book["notes"][0]["id"]
        self.book["assetLibrary"] = {"version": 1, "items": [asset(self.book, "exclusive"),
            {**asset(self.book, "shared"), "chapterIds": [first, second]},
            {**asset(self.book, "note-owned"), "chapterIds": [], "noteIds": [note]},
            {**asset(self.book, "unlinked"), "chapterIds": []}]}
        original = copy.deepcopy(self.book)
        clean = asset_library.sanitize(self.book, {first})
        self.assertEqual([item["id"] for item in clean["assetLibrary"]["items"]], ["shared", "note-owned", "unlinked"])
        self.assertEqual(clean["assetLibrary"]["items"][0]["chapterIds"], [second])
        self.assertEqual(clean["assetLibrary"]["items"][0]["data"], PNG)
        clean = asset_library.sanitize(clean, set(), {note})
        self.assertEqual([item["id"] for item in clean["assetLibrary"]["items"]], ["shared", "unlinked"])
        self.assertEqual(self.book, original)


class ExternalBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="writer-external-assets-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.disk = self.root / "disk"
        self.disk.mkdir()
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        protection.initialize(self.conn)
        external_backups.initialize(self.conn)
        self.book = sample()
        self.book["assetLibrary"] = {"version": 1, "items": [asset(self.book)]}
        self.book = server.validate_book(self.book)
        self.row = {"revision": 1}

    def enable(self):
        return external_backups.configure(self.conn, {"enabled": True, "destination": str(self.disk)})

    def namespace(self):
        return self.disk / ("WriterDesk-Backups-" + external_backups.config(self.conn)["libraryId"])

    def folder(self, identity=None):
        return self.namespace() / "backups" / ("book-" + hashlib.sha256((identity or self.book["id"]).encode()).hexdigest())

    def write(self, book=None, revision=1):
        return external_backups.checkpoint(self.conn, {"revision": revision}, book or self.book, server.validate_book, force=True)

    def test_settings_absolute_existing_directory_owner_marker_and_namespace(self):
        defaults = external_backups.settings(self.conn)
        self.assertFalse(defaults["enabled"])
        self.assertIsNone(defaults["lastSuccess"])
        self.enable()
        marker = json.loads((self.namespace() / external_backups.MARKER).read_text())
        self.assertEqual(marker["libraryId"], external_backups.config(self.conn)["libraryId"])
        for value in ({"enabled": True, "destination": "relative/path"}, {"enabled": True, "destination": str(self.root / "missing")}, {"enabled": "yes", "destination": str(self.disk)}, {"enabled": True, "destination": ""}):
            with self.subTest(value=value), self.assertRaises(protection.ProtectionError):
                external_backups.configure(self.conn, value)
        self.assertEqual(external_backups.settings(self.conn)["destination"], str(self.disk))

    def test_snapshot_roundtrip_throttle_and_retention_preserve_assets_and_other_files(self):
        self.enable()
        personal = self.disk / "个人文件.txt"
        personal.write_text("不属于应用", encoding="utf-8")
        protection.update_settings(self.conn, {"enabled": True, "intervalMinutes": 5, "retentionCount": 2})
        for revision in (1, 2, 3):
            self.write(revision=revision)
        files = list(self.folder().glob("r*.json"))
        self.assertEqual(len(files), 2)
        values = [json.loads(file.read_text("utf-8")) for file in files]
        self.assertTrue(all(value["version"] == 4 and value["book"] == self.book for value in values))
        self.assertEqual(personal.read_text("utf-8"), "不属于应用")
        self.assertIsNotNone(external_backups.settings(self.conn)["lastSuccess"])
        self.assertIsNone(external_backups.checkpoint(self.conn, {"revision": 4}, self.book, server.validate_book))

    def test_chapter_purge_rewrites_external_text_assets_and_preserves_other_work(self):
        self.enable()
        target = self.book["chapters"][0]["id"]
        secret = "待删除密文-" + target
        self.book["chapters"][0]["body"] += secret
        self.write()
        other = server.new_book("另一本书")
        other["chapters"] = [server.chapter("正文", "别的作品完整保留", other["volumes"][0]["id"])]
        self.write(other)
        other_files = {file.name: file.read_bytes() for file in self.folder(other["id"]).glob("r*.json")}
        self.assertTrue(external_backups.clean_book(self.conn, self.book["id"], server.validate_book, lambda value: chapter_history.sanitize(value, {target})))
        for file in self.folder().glob("r*.json"):
            value = json.loads(file.read_text("utf-8"))
            self.assertNotIn(secret, file.read_text("utf-8"))
            self.assertFalse(any(item["id"] == target for item in value["book"]["chapters"]))
            self.assertEqual(value["book"]["assetLibrary"]["items"], [])
        self.assertEqual({file.name: file.read_bytes() for file in self.folder(other["id"]).glob("r*.json")}, other_files)

    def test_full_book_purge_removes_owned_snapshots_but_preserves_foreign_files(self):
        self.enable()
        self.write()
        personal = self.folder() / "自己的草稿.txt"
        personal.write_text("外部文件不能删", encoding="utf-8")
        foreign = self.folder() / ("r1-" + "c" * 32 + ".json")
        foreign_value = {"writerDeskSnapshot": {"bookId": "foreign-book"}, "book": {"id": "foreign-book"}}
        foreign.write_text(json.dumps(foreign_value), encoding="utf-8")
        self.assertTrue(external_backups.clean_book(self.conn, self.book["id"], server.validate_book))
        self.assertEqual([file.name for file in self.folder().glob("r*.json")], [foreign.name])
        self.assertEqual(json.loads(foreign.read_text()), foreign_value)
        self.assertEqual(personal.read_text("utf-8"), "外部文件不能删")

    def test_offline_destination_keeps_cleanup_pending_until_disk_returns(self):
        self.enable()
        self.write()
        disconnected = self.root / "disconnected-disk"
        self.disk.rename(disconnected)
        with self.assertRaises(protection.ProtectionError):
            self.write(revision=2)
        self.assertFalse(external_backups.clean_book(self.conn, self.book["id"], server.validate_book))
        disconnected.rename(self.disk)
        self.assertTrue(external_backups.clean_book(self.conn, self.book["id"], server.validate_book))
        self.assertEqual(list(self.folder().glob("r*.json")), [])

    def test_symlinked_destination_namespace_marker_and_snapshot_never_touch_targets(self):
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = outside / "personal.txt"
        sentinel.write_text("保持原样", encoding="utf-8")
        link = self.root / "linked-disk"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest("Symlinks unavailable: " + str(error))
        with self.assertRaises(protection.ProtectionError):
            external_backups.configure(self.conn, {"enabled": True, "destination": str(link)})
        self.enable()
        self.write()
        token_link = self.folder() / ("r8-" + "f" * 32 + ".json")
        token_link.symlink_to(sentinel)
        self.assertFalse(external_backups.clean_book(self.conn, self.book["id"], server.validate_book))
        self.assertTrue(token_link.is_symlink())
        self.assertEqual(sentinel.read_text("utf-8"), "保持原样")
        token_link.unlink()
        marker = self.namespace() / external_backups.MARKER
        marker.unlink()
        marker.symlink_to(sentinel)
        with self.assertRaises(protection.ProtectionError):
            self.write(revision=2)
        self.assertEqual(sentinel.read_text("utf-8"), "保持原样")

    def test_foreign_namespace_and_corrupt_owned_snapshot_block_cleanup_without_overwriting(self):
        library = external_backups.config(self.conn)["libraryId"]
        namespace = self.disk / ("WriterDesk-Backups-" + library)
        namespace.mkdir()
        marker = namespace / external_backups.MARKER
        marker.write_text('{"format":"personal"}', encoding="utf-8")
        with self.assertRaises(protection.ProtectionError):
            self.enable()
        self.assertEqual(marker.read_text(), '{"format":"personal"}')
        marker.unlink()
        namespace.rmdir()
        self.enable()
        self.write()
        damaged = self.folder() / ("r8-" + "e" * 32 + ".json")
        damaged.write_text("unreadable-owned-looking-file", encoding="utf-8")
        self.assertFalse(external_backups.clean_book(self.conn, self.book["id"], server.validate_book))
        self.assertEqual(damaged.read_text(), "unreadable-owned-looking-file")


class ExternalPurgeIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="writer-external-purge-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.previous = server.DB_PATH
        self.addCleanup(setattr, server, "DB_PATH", self.previous)
        server.DB_PATH = self.root / "library.sqlite3"
        server.initialize()
        self.disk = self.root / "external-disk"
        self.disk.mkdir()
        self.book = server.new_book("外部备份清理隔离测试")
        self.secret = "必须清理的独占原文-" + server.uid()
        volume = self.book["volumes"][0]["id"]
        self.book["chapters"] = [server.chapter("待删除", self.secret, volume), server.chapter("保留", "其它正文不受影响", volume)]
        self.target = self.book["chapters"][0]["id"]
        self.book["assetLibrary"] = {"version": 1, "items": [asset(self.book)]}
        with server.connect() as conn:
            external_backups.configure(conn, {"enabled": True, "destination": str(self.disk)})
            server.insert_book(conn, self.book)
            self.namespace_name = "WriterDesk-Backups-" + external_backups.config(conn)["libraryId"]
        server.checkpoint_book(self.book["id"], force=True)

    def snapshots(self):
        return list((self.disk / self.namespace_name).rglob("r*.json"))

    def disconnect(self):
        self.disconnected = self.root / "disconnected"
        self.disk.rename(self.disconnected)

    def reconnect(self):
        self.disconnected.rename(self.disk)

    def test_chapter_purge_durable_job_waits_for_external_disk_and_retries(self):
        with server.connect() as conn:
            self.book["chapters"][0]["deletedAt"] = STAMP
            conn.execute("UPDATE books SET payload=?,revision=2 WHERE id=?", (json.dumps(self.book, ensure_ascii=False), self.book["id"]))
        self.disconnect()
        result = chapter_history.write(server, "/api/books/" + self.book["id"] + "/chapters/" + self.target + "/purge", {"revision": 2})
        self.assertTrue(result.get("cleanupPending"))
        with server.connect() as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM pending_chapter_purges WHERE book_id=?", (self.book["id"],)).fetchone())
            clean = json.loads(server.saved_book_row(conn, self.book["id"])["payload"])
            self.assertNotIn(self.secret, json.dumps(clean, ensure_ascii=False))
            self.assertEqual(clean["assetLibrary"]["items"], [])
        self.reconnect()
        self.assertEqual(chapter_history.cleanup(server, self.book["id"]), [])
        for snapshot in self.snapshots():
            self.assertNotIn(self.secret, snapshot.read_text("utf-8"))
            self.assertEqual(json.loads(snapshot.read_text())["book"]["assetLibrary"]["items"], [])

    def test_whole_book_purge_durable_job_waits_for_external_disk_and_retries(self):
        self.disconnect()
        trashed = server.change_book_trash("/api/books/" + self.book["id"] + "/trash", {"revision": 1})
        result = server.change_book_trash("/api/books/" + self.book["id"] + "/purge", {"revision": trashed["revision"]})
        self.assertTrue(result.get("cleanupPending"))
        with server.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM books WHERE id=?", (self.book["id"],)).fetchone())
            self.assertIsNotNone(conn.execute("SELECT 1 FROM pending_book_purges WHERE book_id=?", (self.book["id"],)).fetchone())
        self.reconnect()
        self.assertFalse(server.cleanup_pending_book_purges(self.book["id"]))
        self.assertEqual(self.snapshots(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
