"""Local image objects use disposable directories and never load user files."""
import base64
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai_service import AIError
from chat_images import ChatImageStore, decode_image
from verify_ai_cover import PNG, JPEG, WEBP


class ChatImageStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="writer-images-")
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "data"
        self.store = ChatImageStore(self.data)
        self.png = "data:image/png;base64," + PNG

    def test_raster_metadata_read_dedup_and_names_are_book_scoped(self):
        for encoded, mime, extension in [(PNG, "image/png", "png"), (JPEG, "image/jpeg", "jpg"), (WEBP, "image/webp", "webp")]:
            content = base64.b64decode(encoded)
            value = self.store.save("book-one", "参考 " + extension, "data:" + mime + ";base64," + encoded)
            self.assertEqual(value, {"id": hashlib.sha256(content).hexdigest() + "." + extension,
                                    "name": "参考 " + extension, "url": "/api/books/book-one/ai/images/" + value["id"],
                                    "mime": mime, "bytes": len(content)})
            self.assertEqual(self.store.read("book-one", value["id"]), (content, mime))
            self.assertEqual(self.store.save("book-one", "第二个名字", "data:" + mime + ";base64," + encoded)["id"], value["id"])
            with self.assertRaises(AIError) as error:
                self.store.read("another-book", value["id"])
            self.assertEqual(error.exception.status, 404)
            refs = self.store.attachments("book-one", [{"id": value["id"], "name": "不同名字"}])
            self.assertEqual(refs[0][0]["name"], "不同名字")
            self.assertEqual(refs[0][1], "data:" + mime + ";base64," + encoded)
        folder = self.data / "ai-chat-images" / self.store.book_key("book-one")
        self.assertEqual(len(list(folder.iterdir())), 3)
        self.assertTrue(all(path.stat().st_mode & 0o077 == 0 for path in folder.iterdir()))

    def test_invalid_image_data_names_refs_and_byte_limit_fail_without_writing(self):
        for value in [None, "", "file:///tmp/photo.png", "https://example.invalid/image.png", "data:image/svg+xml;base64,PHN2Zz4=",
                      "data:image/jpeg;base64," + PNG, "data:image/png;base64,broken!", "data:image/png;base64," + base64.b64encode(b"<html>").decode(),
                      "data:image/png;base64," + PNG + "\n"]:
            with self.subTest(value=repr(value)[:50]), self.assertRaises(AIError):
                self.store.save("book-one", "image", value)
        for name in ["", "  ", 1, "x" * 201, "bad\nname"]:
            with self.assertRaises(AIError):
                self.store.save("book-one", name, self.png)
        with patch("ai_service.MAX_IMAGE_BYTES", 8), self.assertRaises(AIError):
            decode_image(self.png)
        self.assertFalse((self.data / "ai-chat-images").exists())
        value = self.store.save("book-one", "image", self.png)
        ref = {"id": value["id"]}
        for refs in [{}, "image", [ref] * 5, [ref, ref], [{"id": "../../secret"}], [{"id": value["id"], "url": value["url"]}], [{"id": value["id"], "name": ""}]]:
            with self.assertRaises(AIError):
                self.store.attachments("book-one", refs)

    def test_path_components_symlinks_hardlinks_and_modified_files_are_not_followed(self):
        outside = Path(self.directory.name) / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("untouched", "utf-8")
        self.data.mkdir()
        (self.data / "ai-chat-images").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(AIError):
            self.store.save("../outside", "image", self.png)
        self.assertEqual(list(outside.iterdir()), [sentinel])
        (self.data / "ai-chat-images").unlink()
        value = self.store.save("book-one", "image", self.png)
        folder = self.data / "ai-chat-images" / self.store.book_key("book-one")
        path = folder / value["id"]
        content = path.read_bytes()
        path.unlink()
        path.symlink_to(sentinel)
        with self.assertRaises(AIError):
            self.store.read("book-one", value["id"])
        with self.assertRaises(AIError):
            self.store.save("book-one", "image", self.png)
        path.unlink()
        other = outside / "other.png"
        other.write_bytes(content)
        os.link(other, path)
        with self.assertRaises(AIError):
            self.store.read("book-one", value["id"])
        path.unlink()
        path.write_bytes(content[:-3] + b"bad")
        with self.assertRaises(AIError):
            self.store.read("book-one", value["id"])
        path.unlink()
        folder.rmdir()
        folder.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(AIError):
            self.store.purge("book-one")
        self.assertEqual(sentinel.read_text("utf-8"), "untouched")
        self.assertEqual(other.read_bytes(), content)

    def test_purge_removes_only_that_books_images_and_never_follows_file_links(self):
        first = self.store.save("book-one", "image", self.png)
        second = self.store.save("book-two", "image", self.png)
        folder = self.data / "ai-chat-images" / self.store.book_key("book-one")
        outside = Path(self.directory.name) / "outside.png"
        outside.write_text("keep", "utf-8")
        (folder / "external-link").symlink_to(outside)
        self.store.purge("book-one")
        with self.assertRaises(AIError):
            self.store.read("book-one", first["id"])
        self.assertTrue(self.store.read("book-two", second["id"])[0])
        self.assertEqual(outside.read_text("utf-8"), "keep")
        self.store.purge("book-missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
