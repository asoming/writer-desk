"""Exercise independent work folders using temporary databases/directories only."""
import copy
import errno
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def long_book():
    book = server.new_book("两卷之间")
    first = book["volumes"][0]
    first["title"] = "卷甲"
    second = {"id": "second-volume", "title": "卷乙", "summary": "先读这一卷", "deletedAt": None}
    archived = {"id": "deleted-volume", "title": "回收的卷", "summary": "保留", "deletedAt": "2026-10-09"}
    book["volumes"] = [second, first, archived]
    book["chapters"] = [server.chapter("甲章", "甲章正文", first["id"]),
                        server.chapter("乙章", "乙章正文", second["id"]),
                        server.chapter("卷外章", "未分卷正文"),
                        {**server.chapter("回收章", "不得出现在TXT", second["id"]), "deletedAt": "2026-10-09"},
                        {**server.chapter("回收卷内章", "不得出现在TXT之二", archived["id"]), "deletedAt": "2026-10-09"}]
    person = {"id": "person-one", "type": "人物", "title": "余舟", "body": "人物介绍", "aliases": ["小余"],
              "profile": server.empty_profile(), "chapterIds": [book["chapters"][0]["id"], book["chapters"][-1]["id"]], "deletedAt": None}
    person["profile"]["arcs"] = [{"volumeId": first["id"], "body": "人物变化"}]
    book["notes"] = [person]
    book["outline"] = [{"id": "outline-one", "title": "全书构思", "body": "保留全文", "kind": "story", "category": "故事主线",
                        "parentId": None, "volumeId": None, "chapterIds": [book["chapters"][1]["id"]], "deletedAt": None}]
    book["atlasViews"] = [{"id": "view-one", "title": "人物分图", "description": "保留关联", "personIds": [person["id"]]}]
    return server.validate_book(book)


class FolderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-book-folders-")
        self.previous_db = server.DB_PATH
        server.DB_PATH = Path(self.temporary.name) / "data" / "writer.sqlite3"
        server.initialize()
        self.book = long_book()
        with server.connect() as conn:
            server.insert_book(conn, self.book)

    def tearDown(self):
        server.DB_PATH = self.previous_db
        self.temporary.cleanup()

    def folder(self, book=None):
        return server.book_folder_path((book or self.book)["id"])

    def update_saved(self, book=None):
        book = book or self.book
        with server.connect() as conn:
            conn.execute("UPDATE books SET title=?,payload=?,revision=revision+1,updated_at=? WHERE id=?",
                         (book["title"], json.dumps(book, ensure_ascii=False), server.now(), book["id"]))

    def saved(self):
        with server.connect() as conn:
            row = conn.execute("SELECT * FROM books WHERE id=?", (self.book["id"],)).fetchone()
        return dict(row)

    def test_long_text_uses_volume_order_and_backup_retains_every_recycled_link(self):
        result = server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(result, {"folder": str(self.folder()), "revision": 1})
        text = (self.folder() / "正文.txt").read_text("utf-8-sig")
        self.assertLess(text.index("卷乙"), text.index("卷甲"))
        self.assertLess(text.index("乙章正文"), text.index("甲章正文"))
        self.assertLess(text.index("甲章正文"), text.index("未分卷正文"))
        self.assertNotIn("不得出现在TXT", text)
        self.assertNotIn("回收的卷", text)
        backup = json.loads((self.folder() / "作品.yejian.json").read_text("utf-8"))
        self.assertEqual(backup["format"], "yejian-backup")
        self.assertEqual(backup["version"], 3)
        self.assertEqual(backup["book"], self.book)
        restored = server.restore_book(backup["book"])
        self.assertEqual([item["body"] for item in restored["chapters"]], [item["body"] for item in self.book["chapters"]])
        self.assertEqual(restored["atlasViews"], self.book["atlasViews"])
        self.assertEqual(restored["notes"][0]["chapterIds"], self.book["notes"][0]["chapterIds"])

    def test_short_work_has_an_independent_folder_without_volume_headers(self):
        short = server.new_book("同名短篇", "short")
        short["chapters"] = [server.chapter("正文", "第一段\n\n第二段")]
        with server.connect() as conn:
            server.insert_book(conn, short)
        result = server.sync_book_folder(short["id"], create=True)
        text = (Path(result["folder"]) / "正文.txt").read_text("utf-8-sig")
        self.assertEqual(text, "同名短篇\n\n第一段\n\n第二段\n")
        self.assertNotEqual(Path(result["folder"]), self.folder())
        self.assertEqual(json.loads((Path(result["folder"]) / "作品.yejian.json").read_text("utf-8"))["book"], short)

    def test_renaming_keeps_the_directory_and_unmanaged_files_while_same_titles_stay_separate(self):
        server.sync_book_folder(self.book["id"], create=True)
        folder = self.folder()
        attachment = folder / "自己的资料.txt"
        attachment.write_text("不可覆盖", "utf-8")
        self.book["title"] = "../../改名后的书 📚"
        self.update_saved()
        result = server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(Path(result["folder"]), folder)
        self.assertTrue((folder / "正文.txt").read_text("utf-8-sig").startswith(self.book["title"]))
        self.assertEqual(attachment.read_text("utf-8"), "不可覆盖")
        other = server.new_book(self.book["title"])
        with server.connect() as conn:
            server.insert_book(conn, other)
        self.assertNotEqual(server.sync_book_folder(other["id"], create=True)["folder"], result["folder"])

    def test_arbitrary_existing_book_id_is_hashed_without_path_traversal(self):
        with server.connect() as conn:
            conn.execute("DELETE FROM books WHERE id=?", (self.book["id"],))
            self.book["id"] = "../../另一部作品"
            server.insert_book(conn, self.book)
        result = server.sync_book_folder(self.book["id"], create=True)
        expected = "book-" + hashlib.sha256(self.book["id"].encode("utf-8")).hexdigest()
        self.assertEqual(Path(result["folder"]).name, expected)
        self.assertEqual(Path(result["folder"]).parent, server.DB_PATH.parent / "books")

    def test_normal_save_does_not_opt_in_to_folders_or_unsupported_platform_checks(self):
        self.assertFalse(self.folder().exists())
        with patch.object(server, "book_folder_directory", side_effect=AssertionError("must not access folder APIs")), patch.object(server.os, "supports_dir_fd", set()):
            self.assertIsNone(server.sync_book_folder(self.book["id"]))
        self.assertFalse((server.DB_PATH.parent / "books").exists())
        with patch.object(server.os, "supports_dir_fd", set()):
            with self.assertRaises(server.FolderExportError) as raised:
                server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(raised.exception.code, "FOLDER_UNSUPPORTED")

    def test_uncreated_folder_under_a_symlink_data_root_does_not_affect_saving(self):
        alias = Path(self.temporary.name) / "data-alias"
        alias.symlink_to(server.DB_PATH.parent, target_is_directory=True)
        server.DB_PATH = alias / "writer.sqlite3"
        self.assertIsNone(server.sync_book_folder(self.book["id"]))
        with self.assertRaises(server.FolderExportError) as raised:
            server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(raised.exception.code, "FOLDER_UNSAFE")

    def test_preexisting_user_named_files_are_never_adopted_or_overwritten(self):
        self.folder().mkdir(parents=True)
        user_file = self.folder() / "正文.txt"
        user_file.write_text("用户自己建立的正文", "utf-8")
        with self.assertRaises(server.FolderExportError) as raised:
            server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(raised.exception.code, "FOLDER_CONFLICT")
        self.assertEqual(user_file.read_text("utf-8"), "用户自己建立的正文")
        self.assertFalse((self.folder() / "作品.yejian.json").exists())

    def test_external_edits_block_both_exports_without_losing_saved_data(self):
        server.sync_book_folder(self.book["id"], create=True)
        backup_path = self.folder() / "作品.yejian.json"
        previous_backup = backup_path.read_bytes()
        user_file = self.folder() / "正文.txt"
        user_file.write_text("用户在文件夹里修改的正文", "utf-8")
        self.book["chapters"][0]["body"] = "SQLite中最新的正文"
        self.update_saved()
        with self.assertRaises(server.FolderExportError):
            server.sync_book_folder(self.book["id"])
        self.assertEqual(json.loads(self.saved()["payload"]), self.book)
        self.assertEqual(user_file.read_text("utf-8"), "用户在文件夹里修改的正文")
        self.assertEqual(backup_path.read_bytes(), previous_backup)

    def test_committed_put_returns_success_even_when_folder_sync_and_stderr_both_fail(self):
        for log_error in (OSError(errno.ENOSPC, "log disk full"), ValueError("I/O operation on closed file")):
            with self.subTest(log_error=type(log_error).__name__):
                before = self.saved()
                self.book["chapters"][0]["body"] = "提交成功后日志失败也不能丢失保存响应 " + str(before["revision"])
                handler = object.__new__(server.Handler)
                handler.path = "/api/books/" + self.book["id"]
                handler.read_json = lambda: {"book": self.book, "revision": before["revision"]}
                responses = []
                handler.send_json = lambda data, status=200: responses.append((status, data))
                broken_log = unittest.mock.Mock()
                broken_log.write.side_effect = log_error
                with patch.object(server, "sync_book_folder", side_effect=server.FolderExportError(server.FOLDER_FAILURE, 500)), patch.object(server.sys, "stderr", broken_log):
                    handler.do_PUT()
                self.assertEqual(len(responses), 1)
                status, result = responses[0]
                self.assertEqual(status, 200)
                self.assertEqual(result["revision"], before["revision"] + 1)
                self.assertEqual(result["folderWarning"], server.FOLDER_WARNING)
                self.assertEqual(self.saved()["revision"], result["revision"])
                self.assertEqual(json.loads(self.saved()["payload"]), self.book)

    def test_removed_owned_file_is_recreated_but_a_modified_manifest_is_preserved(self):
        server.sync_book_folder(self.book["id"], create=True)
        (self.folder() / "正文.txt").unlink()
        server.sync_book_folder(self.book["id"], create=True)
        self.assertTrue((self.folder() / "正文.txt").exists())
        manifest = self.folder() / server.FOLDER_MANIFEST
        manifest.write_text("用户自己的文件", "utf-8")
        with self.assertRaises(server.FolderExportError):
            server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(manifest.read_text("utf-8"), "用户自己的文件")

    def test_symlinks_in_books_root_book_directory_or_managed_files_do_not_escape(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        sentinel = outside / "untouched.txt"
        sentinel.write_text("外部文件", "utf-8")
        books = server.DB_PATH.parent / "books"
        books.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(server.FolderExportError) as raised:
            server.sync_book_folder(self.book["id"], create=True)
        self.assertEqual(raised.exception.code, "FOLDER_UNSAFE")
        books.unlink()
        books.mkdir()
        self.folder().symlink_to(outside, target_is_directory=True)
        with self.assertRaises(server.FolderExportError):
            server.sync_book_folder(self.book["id"], create=True)
        self.folder().unlink()
        server.sync_book_folder(self.book["id"], create=True)
        for name in (*server.FOLDER_FILES, server.FOLDER_MANIFEST):
            with self.subTest(name=name):
                path = self.folder() / name
                original = path.read_bytes()
                path.unlink()
                path.symlink_to(sentinel)
                with self.assertRaises(server.FolderExportError) as raised:
                    server.sync_book_folder(self.book["id"], create=True)
                self.assertEqual(raised.exception.code, "FOLDER_UNSAFE")
                self.assertTrue(path.is_symlink())
                self.assertEqual(sentinel.read_text("utf-8"), "外部文件")
                path.unlink()
                path.write_bytes(original)
        self.assertEqual(list(outside.iterdir()), [sentinel])

    def test_interrupted_atomic_exports_can_resume_even_after_another_saved_revision(self):
        server.sync_book_folder(self.book["id"], create=True)
        self.book["chapters"][0]["body"] = "第二版完整正文"
        self.update_saved()
        original_replace = server.os.replace

        def fail_on(target):
            def replace(source, destination, **kwargs):
                if destination == target:
                    raise OSError(errno.ENOSPC, "sensitive/path must not reach the API")
                return original_replace(source, destination, **kwargs)
            return replace

        with patch.object(server.os, "replace", fail_on("作品.yejian.json")):
            with self.assertRaises(server.FolderExportError):
                server.sync_book_folder(self.book["id"])
        self.assertIn("第二版完整正文", (self.folder() / "正文.txt").read_text("utf-8-sig"))
        self.assertEqual(json.loads((self.folder() / "作品.yejian.json").read_text("utf-8"))["book"]["chapters"][0]["body"], "甲章正文")
        self.book["chapters"][0]["body"] = "第三版仍须完整"
        self.update_saved()
        with patch.object(server.os, "replace", fail_on("正文.txt")):
            with self.assertRaises(server.FolderExportError):
                server.sync_book_folder(self.book["id"])
        server.sync_book_folder(self.book["id"])
        self.assertEqual(json.loads((self.folder() / "作品.yejian.json").read_text("utf-8"))["book"], self.book)
        self.assertIn("第三版仍须完整", (self.folder() / "正文.txt").read_text("utf-8-sig"))
        self.assertFalse(list(self.folder().glob(".writer-desk-*.tmp")))
        self.assertEqual(json.loads(self.saved()["payload"]), self.book)

    def test_multiple_processes_finish_with_the_latest_saved_snapshot(self):
        server.sync_book_folder(self.book["id"], create=True)
        child = """
import json, pathlib, sys, time
sys.path.insert(0, sys.argv[1])
import server
server.DB_PATH = pathlib.Path(sys.argv[2])
book_id = sys.argv[3]
print('ready', flush=True)
sys.stdin.readline()
for index in range(3):
    with server.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM books WHERE id=?', (book_id,)).fetchone()
        book = json.loads(row['payload'])
        book['chapters'][0]['body'] = 'process ' + sys.argv[4] + ' revision ' + str(row['revision'] + 1)
        conn.execute('UPDATE books SET payload=?,revision=revision+1,updated_at=? WHERE id=?', (json.dumps(book, ensure_ascii=False), server.now(), book_id))
    time.sleep(0.005)
    server.sync_book_folder(book_id)
print('done', flush=True)
"""
        processes = []
        try:
            for index in range(4):
                processes.append(subprocess.Popen([sys.executable, "-c", child, str(ROOT), str(server.DB_PATH), self.book["id"], str(index)],
                                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            for process in processes:
                self.assertEqual(process.stdout.readline().strip(), "ready")
            for process in processes:
                process.stdin.write("start\n")
                process.stdin.flush()
            for process in processes:
                stdout, stderr = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stdout.strip(), "done")
            row = self.saved()
            self.assertEqual(row["revision"], 13)
            exported = json.loads((self.folder() / "作品.yejian.json").read_text("utf-8"))
            self.assertEqual(exported["book"], json.loads(row["payload"]))
            self.assertEqual(json.loads((self.folder() / server.FOLDER_MANIFEST).read_text("utf-8"))["revision"], row["revision"])
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)


class FolderApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="writer-folder-api-")
        cls.process = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--port", "0", "--data-dir", cls.temporary.name],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        startup = cls.process.stdout.readline().strip()
        if "：http://127.0.0.1:" not in startup:
            cls.process.terminate()
            cls.process.wait(timeout=10)
            raise RuntimeError("Disposable API server could not bind localhost: " + startup)
        cls.url = startup.split("：", 1)[1]

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.temporary.cleanup()

    def request(self, path, method="GET", data=None):
        request = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8"),
                                         method=method, headers={"Content-Type": "application/json", "X-Writer-Client": "1"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_endpoint_exports_saved_state_auto_syncs_and_reports_save_success_on_conflict(self):
        _, created = self.request("/api/books", "POST", {"title": "API文件夹", "kind": "short"})
        book = created["book"]
        book["chapters"] = [server.chapter("短篇正文", "最新一版")]
        path = "/api/books/" + urllib.parse.quote(book["id"], safe="")
        status, saved = self.request(path, "PUT", {"book": book, "revision": 1})
        self.assertEqual(status, 200)
        self.assertNotIn("folderWarning", saved)
        self.assertFalse((Path(self.temporary.name) / "books").exists())
        status, opened = self.request(path + "/folder", "POST", {})
        self.assertEqual(status, 200)
        self.assertEqual(opened["revision"], saved["revision"])
        folder = Path(opened["folder"])
        self.assertTrue(folder.is_absolute())
        self.assertEqual(folder.parent, Path(self.temporary.name) / "books")
        self.assertIn("最新一版", (folder / "正文.txt").read_text("utf-8-sig"))
        book["title"] = "书名已更新"
        book["chapters"][0]["body"] = "自动保存后的正文"
        status, saved = self.request(path, "PUT", {"book": book, "revision": saved["revision"]})
        self.assertEqual(status, 200)
        self.assertNotIn("folderWarning", saved)
        self.assertEqual(json.loads((folder / "作品.yejian.json").read_text("utf-8"))["book"], book)
        self.assertIn("自动保存后的正文", (folder / "正文.txt").read_text("utf-8-sig"))
        (folder / "正文.txt").write_text("外部编辑，必须保留", "utf-8")
        book["chapters"][0]["body"] = "保存成功，导出冲突也不能丢正文"
        status, saved = self.request(path, "PUT", {"book": book, "revision": saved["revision"]})
        self.assertEqual(status, 200)
        self.assertEqual(saved["folderWarning"], server.FOLDER_WARNING)
        self.assertEqual(self.request(path)[1]["book"], book)
        self.assertEqual((folder / "正文.txt").read_text("utf-8"), "外部编辑，必须保留")
        status, error = self.request(path + "/folder", "POST", {})
        self.assertEqual(status, 409)
        self.assertEqual(error, {"code": "FOLDER_CONFLICT", "error": server.FOLDER_CONFLICT})
        self.assertNotIn(str(folder), error["error"])

    def test_folder_endpoint_rejects_paths_and_unknown_books_without_creating_directories(self):
        _, created = self.request("/api/books", "POST", {"title": "安全接口"})
        path = "/api/books/" + created["book"]["id"] + "/folder"
        for data in ({"path": "/tmp/arbitrary"}, {"bookId": created["book"]["id"]}, []):
            status, error = self.request(path, "POST", data)
            self.assertEqual(status, 400)
            self.assertEqual(error, {"code": "FOLDER_REQUEST", "error": server.FOLDER_REQUEST})
        status, error = self.request("/api/books/unknown-book/folder", "POST", {})
        self.assertEqual(status, 404)
        expected = Path(self.temporary.name) / "books" / ("book-" + hashlib.sha256(b"unknown-book").hexdigest())
        self.assertFalse(expected.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
