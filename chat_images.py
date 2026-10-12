"""Book-scoped local raster attachments; never fetch a provider image URL."""
import base64
import binascii
from contextlib import contextmanager
import hashlib
import safe_fs as os
from pathlib import Path
import re
import stat
import threading
from urllib.parse import quote
import uuid

MAX_IMAGES_PER_MESSAGE = 4
MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024
_IMAGE_LOCK = threading.RLock()
_IMAGE_ID = re.compile(r"([a-f0-9]{64})\.(png|jpg|webp)\Z")
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_MIMES = {value: key for key, value in _EXTENSIONS.items()}


def image_name(value, fallback="image.png"):
    from ai_service import AIError
    if value is None:
        return fallback
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise AIError(400, "图片名称格式不正确或过长。")
    return value


def decode_image(data_url):
    from ai_service import AIError, MAX_IMAGE_BYTES, _image_mime
    try:
        if not isinstance(data_url, str):
            raise ValueError("image data required")
        header, encoded = data_url.split(",", 1)
        if header not in {"data:" + mime + ";base64" for mime in _EXTENSIONS} or not encoded or len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise ValueError("invalid image data")
        content = base64.b64decode(encoded, validate=True)
        if not content or len(content) > MAX_IMAGE_BYTES:
            raise ValueError("image too large")
        mime = _image_mime(content)
        if header != "data:" + mime + ";base64":
            raise ValueError("image MIME mismatch")
        return content, mime
    except (ValueError, TypeError, binascii.Error):
        raise AIError(400, "请选择有效的 PNG、JPEG 或 WebP 图片，每张不超过 8 MB。") from None


class ChatImageStore:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)

    @staticmethod
    def book_key(book_id):
        from ai_service import AIError
        if not isinstance(book_id, str) or not book_id or len(book_id) > 100:
            raise AIError(400, "作品编号不正确。")
        return hashlib.sha256(book_id.encode("utf-8")).hexdigest()

    @staticmethod
    def metadata(book_id, image_id, mime, size, name=None):
        return {"id": image_id, "name": image_name(name, "image." + _EXTENSIONS[mime]),
                "url": "/api/books/" + quote(book_id, safe="!'()*") + "/ai/images/" + image_id,
                "mime": mime, "bytes": size}

    @contextmanager
    def _book_directory(self, book_id, create=False):
        """Walk only owned directory descriptors; symlinks are never followed."""
        from ai_service import AIError
        descriptors = []
        try:
            if create:
                self.data_dir.mkdir(parents=True, exist_ok=True)
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(self.data_dir, flags)
            descriptors.append(descriptor)
            for component in ("ai-chat-images", self.book_key(book_id)):
                if create:
                    try:
                        os.mkdir(component, 0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                descriptor = os.open(component, flags, dir_fd=descriptor)
                if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise OSError("not an image directory")
                descriptors.append(descriptor)
            yield descriptor
        except FileNotFoundError:
            raise AIError(404, "找不到这张对话图片。") from None
        except OSError:
            raise AIError(500, "无法安全读写本机对话图片，请检查磁盘与目录权限。") from None
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    @staticmethod
    def _read(descriptor, image_id):
        from ai_service import AIError, MAX_IMAGE_BYTES, _image_mime
        match = _IMAGE_ID.fullmatch(image_id) if isinstance(image_id, str) else None
        if not match:
            raise AIError(400, "对话图片编号不正确。")
        try:
            fd = os.open(image_id, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0), dir_fd=descriptor)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= MAX_IMAGE_BYTES:
                    raise ValueError("invalid image file")
                content = stream.read(MAX_IMAGE_BYTES + 1)
            mime = _image_mime(content)
            if len(content) != info.st_size or len(content) > MAX_IMAGE_BYTES or hashlib.sha256(content).hexdigest() != match[1] or mime != _MIMES[match[2]]:
                raise ValueError("image changed")
            return content, mime
        except FileNotFoundError:
            raise AIError(404, "找不到这张对话图片。") from None
        except (OSError, ValueError):
            raise AIError(400, "这张本机对话图片无效或已被修改，请重新添加。") from None

    def read(self, book_id, image_id):
        with _IMAGE_LOCK, self._book_directory(book_id) as descriptor:
            return self._read(descriptor, image_id)

    def save(self, book_id, name, data_url):
        content, mime = decode_image(data_url)
        image_id = hashlib.sha256(content).hexdigest() + "." + _EXTENSIONS[mime]
        metadata = self.metadata(book_id, image_id, mime, len(content), name)
        temporary = ".upload-" + uuid.uuid4().hex
        with _IMAGE_LOCK, self._book_directory(book_id, create=True) as descriptor:
            try:
                try:
                    existing, _ = self._read(descriptor, image_id)
                except Exception as error:
                    from ai_service import AIError
                    if not isinstance(error, AIError) or error.status != 404:
                        raise
                else:
                    if existing == content:
                        return metadata
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=descriptor)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                # Linking an already-existing destination never overwrites it.
                os.link(temporary, image_id, src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
                os.unlink(temporary, dir_fd=descriptor)
                os.fsync(descriptor)
                return metadata
            finally:
                try:
                    os.unlink(temporary, dir_fd=descriptor)
                except FileNotFoundError:
                    pass

    def attachments(self, book_id, values):
        from ai_service import AIError
        if values is None:
            return []
        if not isinstance(values, list) or len(values) > MAX_IMAGES_PER_MESSAGE:
            raise AIError(400, "每条对话最多添加 4 张图片。")
        result, seen = [], set()
        for value in values:
            if not isinstance(value, dict) or set(value) - {"id", "name"} or "id" not in value or not isinstance(value["id"], str) or value["id"] in seen:
                raise AIError(400, "对话图片附件参数不正确或重复。")
            if "name" in value and not isinstance(value["name"], str):
                raise AIError(400, "图片名称格式不正确或过长。")
            content, mime = self.read(book_id, value["id"])
            metadata = self.metadata(book_id, value["id"], mime, len(content), value.get("name"))
            result.append((metadata, "data:" + mime + ";base64," + base64.b64encode(content).decode("ascii")))
            seen.add(value["id"])
        return result

    def purge(self, book_id):
        """Remove only this book's image objects, without following any links."""
        from ai_service import AIError
        with _IMAGE_LOCK:
            try:
                with self._book_directory(book_id) as descriptor:
                    for name in os.listdir(descriptor):
                        info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            raise AIError(500, "对话图片目录异常，清理将在后台重试。")
                        os.unlink(name, dir_fd=descriptor)
                    os.fsync(descriptor)
                    # An empty directory contains no personal image data. Keep
                    # it to avoid racing a pathname-based rmdir against a swap.
            except AIError as error:
                if error.status != 404:
                    raise
