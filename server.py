#!/usr/bin/env python3
"""作家工作台 / Writer's Desk: local writing and SQLite storage."""
import argparse
import base64
import binascii
import copy
from contextlib import closing, contextmanager
import errno
import hashlib
import json
import mimetypes
import safe_fs as os
import re
import hmac
import sqlite3
import stat
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from types import SimpleNamespace
from urllib.parse import quote, unquote, urlparse
import protection
import chapter_history
import planning
import home_dashboard
import review_tools
import manuscript_import
import story_memory
import ai_stream
import asset_library
import external_backups
import server_extensions
from sync_client import SyncError
from formatted_export import render_book_export
from ai_service import AIService, AIError
from chat_images import ChatImageStore
from skills import SkillsService, SkillError

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "writer.sqlite3"
DB_LOCK = threading.RLock()
MAX_REQUEST = 64 * 1024 * 1024
MAX_BOOK = 25 * 1024 * 1024
MAX_COVER = 2 * 1024 * 1024
COVER_TEMPLATE_IDS = {"ocean", "orbit", "night", "blossom", "neon", "mountain", "paper", "ripple", "garden", "dawn"}
DESKTOP_TOKEN = os.environ.get("WRITER_DESKTOP_TOKEN", "")
DEFAULT_EXAMPLE_MIGRATION = "default-tide-archive-v1"
INITIAL_LIBRARY_MIGRATION = "initial-library-v1"
TRASH_RETENTION = timedelta(days=30)
TRASH_CLEANUP_SECONDS = 60
FOLDER_MANIFEST = ".writer-desk-folder.json"
FOLDER_FILES = ("正文.txt", "作品.yejian.json")
FOLDER_WARNING = "作品已保存，但作品文件夹暂未同步。请重新打开文件夹后重试。"
FOLDER_CONFLICT = "作品文件夹中的导出文件已被修改或存在同名文件，未覆盖这些文件。请移走或改名后重试。"
FOLDER_UNSAFE = "作品文件夹路径异常，无法安全同步。请检查目录是否为符号链接。"
FOLDER_FAILURE = "无法同步作品文件夹，请检查磁盘空间和目录权限。作品仍已保存在本机。"
FOLDER_REQUEST = "打开作品文件夹只接受作品编号，不接受文件路径。"
FOLDER_UNSUPPORTED = "当前系统不支持安全打开作品文件夹。作品仍已保存在本机。"
BOOK_TRASHED = "这部作品已移入回收站。请从回收站恢复，或将本页内容另存为新作品。"
BOOK_STATE_CONFLICT = "作品状态已在另一个窗口变化。请刷新书架或回收站后重试。"


def chapter_history_context():
    # Callers may load this file with importlib without registering its module
    # in sys.modules. Use the live globals instead of assuming registration.
    return SimpleNamespace(**globals())


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def chapter(title="未命名章节", body="", volume_id=None):
    return {"id": uid(), "title": title, "body": body, "volumeId": volume_id, "deletedAt": None}


def first_volume(book_id):
    # A deterministic ID makes repeated reads of a legacy book consistent.
    volume_id = hashlib.sha256(book_id.encode("utf-8")).hexdigest()[:32] + "-volume-1"
    return {"id": volume_id, "title": "第一卷", "summary": "", "deletedAt": None}


def empty_profile():
    return {"group": "", "role": "", "desire": "", "flaw": "", "ending": "", "arcs": []}


def new_book(title="未命名作品", kind="long"):
    book_id = uid()
    book = {"id": book_id, "title": title, "kind": kind, "cover": "", "coverTemplate": "",
            "volumes": [first_volume(book_id)] if kind == "long" else [], "chapters": [],
            "notes": [], "outline": [], "relations": [],
            "storyTools": planning.defaults(), "storyMemory": story_memory.validate_memory(None),
            "reviewTools": review_tools.defaults(), "assetLibrary": asset_library.defaults()}
    return normalize_short_book(book)


def utf16_length(value):
    """Browser text selections count UTF-16 units, including emoji pairs."""
    return len(value.encode("utf-16-le")) // 2


def normalize_short_book(book):
    """Expose one short-story manuscript without rewriting stored revisions.

    Recycled text stays separate. Old active text is joined verbatim, with
    source IDs/titles retained as navigation aliases instead of visible chapters.
    """
    if book.get("kind") != "short":
        return book
    active = [item for item in book["chapters"] if not item.get("deletedAt")]
    if not active:
        item = chapter("正文")
        prefix = book["id"][:70] + "-manuscript"
        item["id"] = prefix
        # A recycled body may already use the default ID. Never reuse its ID.
        occupied = {item["id"] for item in book["chapters"]}
        suffix = 1
        while item["id"] in occupied:
            item["id"] = prefix + "-" + str(suffix)
            suffix += 1
        book["chapters"].append(item)
        active = [item]
    manuscript = active[0]
    original_sections = book.get("shortSections", [])
    section_owner = next((item for item in active if original_sections and item["id"] == original_sections[0]["id"]), manuscript)
    sections, pieces, offset, review_offsets = [], [], 0, {}
    for index, item in enumerate(active):
        if index:
            pieces.append("\n\n")
            offset += 2
        body = item["body"]
        review_offsets[item["id"]] = offset
        length = utf16_length(body)
        if item is section_owner and original_sections:
            for section in original_sections:
                review_offsets.setdefault(section["id"], offset + min(section["start"], length))
                sections.append({**section, "start": offset + min(section["start"], length),
                                 "end": offset + min(section["end"], length)})
        elif len(active) > 1:
            sections.append({"id": item["id"], "title": item["title"], "start": offset, "end": offset + length})
        pieces.append(body)
        offset += length
    manuscript.update(body="".join(pieces), volumeId=None)
    book["chapters"] = [item for item in book["chapters"] if item is manuscript or item.get("deletedAt")]
    if sections:
        # Old backups can contain the same aliases after a recovered body is
        # merged again. Keep the original location once, preserving text above.
        seen = set()
        book["shortSections"] = []
        for item in sections:
            if item["id"] not in seen:
                seen.add(item["id"])
                book["shortSections"].append(item)
    else:
        book.pop("shortSections", None)
    aliases = {item["id"] for item in active} | {item["id"] for item in book.get("shortSections", [])}
    recycled = {item["id"] for item in book["chapters"] if item.get("deletedAt")}
    for item in book.get("notes", []) + book.get("outline", []) + book.get("relations", []) + book.get("assetLibrary", {}).get("items", []):
        item["chapterIds"] = list(dict.fromkeys(manuscript["id"] if value in aliases and value not in recycled else value
                                                for value in item.get("chapterIds", [])))
    planning.remap_short_links(book, aliases, manuscript["id"], recycled)
    review_tools.remap_short_links(book, aliases, manuscript["id"], recycled, review_offsets)
    return book


def short_chapter_ids(book, chapter_ids):
    """Resolve saved AI selections from before short stories became one body."""
    if book.get("kind") != "short" or not isinstance(chapter_ids, list):
        return chapter_ids
    # Do not turn invalid duplicate/oversized input into a valid selection.
    if len(chapter_ids) > 500 or any(not isinstance(value, str) for value in chapter_ids) or len(set(chapter_ids)) != len(chapter_ids):
        return chapter_ids
    manuscript = next((item for item in book["chapters"] if not item.get("deletedAt")), None)
    if manuscript is None:
        return chapter_ids
    aliases = {item["id"] for item in book.get("shortSections", [])}
    recycled = {item["id"] for item in book["chapters"] if item.get("deletedAt")}
    mapped = [manuscript["id"] if value in aliases and value not in recycled else value
              for value in chapter_ids]
    return list(dict.fromkeys(mapped))


def upgrade_book(book):
    """Upgrade the read view without rewriting stored payloads or revisions."""
    book.setdefault("kind", "long")
    book.setdefault("cover", "")
    book.setdefault("coverTemplate", "")
    book.setdefault("assetLibrary", asset_library.defaults())
    book.setdefault("storyMemory", story_memory.validate_memory(None))
    review_tools.normalize(book)
    legacy_volumes = "volumes" not in book
    book.setdefault("volumes", [first_volume(book["id"])] if book["kind"] == "long" else [])
    book.setdefault("outline", [])
    book.setdefault("relations", [])
    for item in book["chapters"]:
        item.setdefault("volumeId", None)
        if legacy_volumes and book["kind"] == "long" and item["volumeId"] is None:
            item["volumeId"] = book["volumes"][0]["id"]
    for note in book["notes"]:
        note.setdefault("chapterIds", [])
        note.setdefault("aliases", [])
        if note["type"] == "人物":
            profile = note.setdefault("profile", {})
            for key, value in empty_profile().items():
                profile.setdefault(key, value)
    for item in book["outline"]:
        item.setdefault("volumeId", None)
        item.setdefault("kind", "scene")
    for item in book["relations"]:
        item.setdefault("type", "other")
        item.setdefault("stage", "")
        item.setdefault("volumeIds", [])
    return planning.normalize(normalize_short_book(book))


def sample_book():
    book = new_book("雾港来信 · 示例")
    book["chapters"] = [
        chapter("第一章  潮声", "林舟回到雾港的那天，渡轮晚了三个小时。\n\n码头上的钟停在六点十七分。他记得十年前离开时，那根细长的分针还会走，现在钟面上结了一层盐，远远看去，像蒙着薄雪。\n\n母亲的信就放在外套口袋里。信封没有邮戳，纸角被海水浸出一圈淡黄色的痕迹。上面只有一句话。\n\n等潮水退了，去看看那间屋子。\n\n林舟抬起头。防波堤尽头，灯塔亮了一下，又熄了。"),
        chapter("第二章  旧屋", "旧屋在山坡的背面，院门半掩着。\n\n林舟推开门，先闻到了木头受潮的气味。桌上有两只杯子，其中一只的杯沿，还留着一道浅浅的茶渍。"),
        chapter("第三章  未寄出的信"),
    ]
    book["notes"] = [
        {"id": uid(), "type": "人物", "title": "林舟", "body": "二十八岁，在外地生活十年。\n收到母亲的信后回到雾港。\n不善于表达，但记得许多细小的事。", "deletedAt": None},
        {"id": uid(), "type": "地点", "title": "雾港", "body": "一座靠渡轮与外界往来的小城。\n码头的钟停在六点十七分。\n防波堤尽头有一座废弃灯塔。", "deletedAt": None},
    ]
    mother = {"id": uid(), "type": "人物", "title": "林母", "body": "寄来一封没有邮戳的信。\n她留下的线索，把林舟带回旧屋。", "deletedAt": None}
    book["notes"].append(mother)
    book["notes"][0]["chapterIds"] = [book["chapters"][0]["id"], book["chapters"][1]["id"]]
    mother["chapterIds"] = [book["chapters"][0]["id"]]
    book["outline"] = [
        {"id": uid(), "title": "归来", "body": "林舟收到母亲的信，回到离开十年的雾港。停摆的钟与闪烁的灯塔，埋下疑问。", "parentId": None, "chapterIds": [book["chapters"][0]["id"]], "deletedAt": None},
        {"id": uid(), "title": "旧屋中的线索", "body": "两只杯子和残留的茶渍，让林舟意识到有人刚刚来过。", "parentId": None, "chapterIds": [book["chapters"][1]["id"]], "deletedAt": None},
        {"id": uid(), "title": "未寄出的信", "body": "留给下一次写作的空白。", "parentId": None, "chapterIds": [book["chapters"][2]["id"]], "deletedAt": None},
    ]
    book["relations"] = [{"id": uid(), "fromId": book["notes"][0]["id"], "toId": mother["id"], "label": "母子 · 一封信", "body": "母亲的信是林舟返乡的起点。", "chapterIds": [book["chapters"][0]["id"]], "deletedAt": None}]
    volume_id = book["volumes"][0]["id"]
    for item in book["chapters"]:
        item["volumeId"] = volume_id
    return upgrade_book(book)


def sample_short():
    book = new_book("雨停之前 · 示例", "short")
    book["chapters"] = [chapter("正文", "书店快打烊时，雨忽然大了。\n\n许宁站在门口，把伞递给最后一位客人。客人说，明天还来。\n\n第二天，门把手上挂着那把已经晾干的伞。伞柄上多了一张纸条。\n\n谢谢。昨晚，我赶上了最后一班车。\n\n许宁把纸条夹进账本，翻到新的一页。")]
    person = {"id": uid(), "type": "人物", "title": "许宁", "body": "书店店主，习惯晚一点关门。", "chapterIds": [book["chapters"][0]["id"]], "deletedAt": None}
    book["notes"] = [person]
    book["outline"] = [{"id": uid(), "title": "一把借出的伞", "body": "用借伞和还伞两件小事，写陌生人之间的善意。", "parentId": None, "chapterIds": [book["chapters"][0]["id"]], "deletedAt": None}]
    return upgrade_book(book)


class StorageConnection(sqlite3.Connection):
    """A request transaction owns its connection until the with block exits."""
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            # sqlite3.Connection's default context manager never closes it.
            # Explicit closure avoids accumulating handles until cyclic GC and
            # releases the database/WAL files immediately on Windows.
            self.close()


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15, factory=StorageConnection)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA secure_delete=ON")
        return conn
    except BaseException:
        conn.close()
        raise


def insert_book(conn, book):
    stamp = now()
    conn.execute("INSERT INTO books(id,title,payload,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                 (book["id"], book["title"], json.dumps(book, ensure_ascii=False), stamp, stamp))


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 30
    with DB_LOCK:
        while True:
            try:
                with connect() as conn:
                    conn.execute("PRAGMA journal_mode=WAL")
                    # Serialize both fresh seeding and upgrades across processes.
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,title TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
                    if "deleted_at" not in {column["name"] for column in conn.execute("PRAGMA table_info(books)")}:
                        conn.execute("ALTER TABLE books ADD COLUMN deleted_at TEXT")
                    conn.execute("CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,saved_at TEXT NOT NULL)")
                    conn.execute("CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)")
                    conn.execute("CREATE TABLE IF NOT EXISTS pending_book_purges(book_id TEXT PRIMARY KEY)")
                    conn.execute("CREATE TABLE IF NOT EXISTS manuscript_import_requests(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,book_id TEXT NOT NULL,created_at TEXT NOT NULL)")
                    protection.initialize(conn)
                    external_backups.initialize(conn)
                    conn.execute("CREATE TABLE IF NOT EXISTS sync_tombstones(book_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL)")
                    chapter_history.initialize(conn)
                    planning.initialize(conn)
                    home_dashboard.initialize(conn)
                    seeded = conn.execute("SELECT 1 FROM app_migrations WHERE name IN (?,?) LIMIT 1", (INITIAL_LIBRARY_MIGRATION, DEFAULT_EXAMPLE_MIGRATION)).fetchone()
                    if not seeded and not conn.execute("SELECT 1 FROM books LIMIT 1").fetchone():
                        insert_book(conn, sample_book())
                        insert_book(conn, sample_short())
                    conn.execute("INSERT OR IGNORE INTO app_migrations(name,applied_at) VALUES(?,?)", (INITIAL_LIBRARY_MIGRATION, now()))
                    install_default_example(conn)
                break
            except sqlite3.OperationalError as exc:
                # Concurrent first connections can race while enabling WAL,
                # before BEGIN IMMEDIATE's regular busy timeout takes effect.
                code = getattr(exc, "sqlite_errorcode", None)
                # sqlite_errorcode and named codes are unavailable on Python 3.9/3.10.
                busy = ((code & 255) in (5, 6) if isinstance(code, int)
                        else any(message in str(exc).lower() for message in ("locked", "busy")))
                if not busy or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
    # Sync cleanup may hold its own lock and call into this DB. Never keep the
    # initialization lock while waiting for that cleanup.
    cleanup_expired_books()


def install_default_example(conn):
    """Add the complete demo once, preserving all existing works and edits."""
    if conn.execute("SELECT 1 FROM app_migrations WHERE name=?", (DEFAULT_EXAMPLE_MIGRATION,)).fetchone():
        return
    source = ROOT / "examples" / "tide-archive.yejian.json"
    if not source.is_file():
        return  # A later installation that includes the asset can still apply it.
    example = validate_book(json.loads(source.read_text("utf-8"))["book"])
    chapter_ids = {item["id"] for item in example["chapters"]}
    present = False
    for row in conn.execute("SELECT id,payload FROM books"):
        if row["id"] == example["id"]:
            present = True
            break
        try:
            existing = json.loads(row["payload"])
        except (ValueError, TypeError):
            continue  # A damaged existing row must remain untouched.
        if isinstance(existing, dict) and isinstance(existing.get("chapters"), list) and any(
                isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] in chapter_ids for item in existing["chapters"]):
            present = True
            break
    if not present:
        insert_book(conn, restore_book(example))
    # This also records an existing editable copy, so later removal is respected.
    conn.execute("INSERT INTO app_migrations(name,applied_at) VALUES(?,?)", (DEFAULT_EXAMPLE_MIGRATION, now()))


def checked_string(value, label, max_length, allow_empty=True):
    if not isinstance(value, str) or len(value) > max_length or (not allow_empty and not value.strip()):
        raise ValueError(f"{label}格式不正确或长度超出限制")
    return value


def checked_cover(value):
    value = checked_string(value, "封面（最多 2 MB）", MAX_COVER)
    if not value:
        return value
    prefixes = {"data:image/png;base64,": "png", "data:image/jpeg;base64,": "jpeg",
                "data:image/webp;base64,": "webp"}
    prefix = next((p for p in prefixes if value.startswith(p)), None)
    if prefix is None:
        raise ValueError("封面仅支持 PNG、JPEG 或 WebP 图片")
    try:
        content = base64.b64decode(value[len(prefix):], validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("封面图片编码不正确") from None
    kind = prefixes[prefix]
    valid = False
    if kind == "png":
        valid = (len(content) >= 45 and content.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
                 and int.from_bytes(content[16:20], "big") > 0
                 and int.from_bytes(content[20:24], "big") > 0
                 and content[-12:] == b"\x00\x00\x00\x00IEND\xaeB`\x82")
    elif kind == "jpeg":
        valid = len(content) >= 12 and content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9")
    elif kind == "webp":
        valid = (len(content) >= 20 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
                 and int.from_bytes(content[4:8], "little") == len(content) - 8
                 and content[12:16] in (b"VP8 ", b"VP8L", b"VP8X"))
    if not valid:
        raise ValueError("封面内容与图片格式不符或图片已损坏")
    return value


def checked_cover_template(value):
    if not isinstance(value, str) or value and value not in COVER_TEMPLATE_IDS:
        raise ValueError("封面模板不正确")
    return value


def validate_book(data):
    if not isinstance(data, dict):
        raise ValueError("作品格式不正确")
    result = {"id": checked_string(data.get("id"), "作品编号", 100, False),
              "title": checked_string(data.get("title"), "作品名称", 200, False)}
    result["kind"] = data.get("kind", "long")
    if result["kind"] not in ("long", "short"):
        raise ValueError("作品类型必须是长篇或短篇")
    result["cover"] = checked_cover(data.get("cover", ""))
    result["coverTemplate"] = checked_cover_template(data.get("coverTemplate", ""))
    legacy_volumes = "volumes" not in data
    volumes = data.get("volumes", [first_volume(result["id"])] if result["kind"] == "long" else [])
    if not isinstance(volumes, list) or len(volumes) > 10000:
        raise ValueError("卷列表格式不正确")
    if result["kind"] == "short" and volumes:
        raise ValueError("短篇作品不能设置分卷")
    result["volumes"], volume_ids = [], set()
    for item in volumes:
        if not isinstance(item, dict):
            raise ValueError("卷格式不正确")
        volume_id = checked_string(item.get("id"), "卷编号", 100, False)
        if volume_id in volume_ids:
            raise ValueError("卷编号重复")
        volume_ids.add(volume_id)
        deleted_at = item.get("deletedAt")
        if deleted_at is not None:
            checked_string(deleted_at, "回收时间", 100, False)
        result["volumes"].append({"id": volume_id, "title": checked_string(item.get("title", ""), "卷标题", 200),
                                  "summary": checked_string(item.get("summary", ""), "卷梗概", 5_000_000),
                                  "deletedAt": deleted_at})
    deleted_volume_ids = {v["id"] for v in result["volumes"] if v["deletedAt"]}

    def checked_volume(value):
        if value is not None and (not isinstance(value, str) or value not in volume_ids):
            raise ValueError("所属卷必须指向本作品的卷")
        return value

    def checked_volumes(value):
        if not isinstance(value, list) or len(value) > 10000 or any(v is None for v in value):
            raise ValueError("关联卷列表格式不正确")
        return list(dict.fromkeys(checked_volume(v) for v in value))

    for key in ("chapters", "notes"):
        items = data.get(key)
        limit = 10001 if key == "chapters" and result["kind"] == "short" else 10000
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError("章节或资料列表格式不正确")
        result[key] = []
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("章节或资料格式不正确")
            item_id = checked_string(item.get("id"), "条目编号", 100, False)
            if item_id in seen:
                raise ValueError("条目编号重复")
            seen.add(item_id)
            deleted_at = item.get("deletedAt")
            if deleted_at is not None:
                checked_string(deleted_at, "回收时间", 100, False)
            clean = {"id": item_id, "title": checked_string(item.get("title"), "标题", 200),
                     "body": checked_string(item.get("body"), "正文", MAX_BOOK if key == "chapters" and result["kind"] == "short" else 5_000_000), "deletedAt": deleted_at}
            if key == "notes":
                if item.get("type") not in ("人物", "地点", "世界观", "灵感"):
                    raise ValueError("资料类型不正确")
                clean["type"] = item["type"]
                clean["chapterIds"] = item.get("chapterIds", [])
                aliases = item.get("aliases", [])
                if not isinstance(aliases, list) or len(aliases) > 100:
                    raise ValueError("人物别名列表格式不正确")
                clean["aliases"] = list(dict.fromkeys(checked_string(a, "人物别名", 200, False) for a in aliases))
                if clean["type"] == "人物":
                    profile = item.get("profile", {})
                    if not isinstance(profile, dict):
                        raise ValueError("人物设定格式不正确")
                    clean["profile"] = {key: checked_string(profile.get(key, ""), "人物设定", 200 if key in ("group", "role") else 5_000_000)
                                        for key in ("group", "role", "desire", "flaw", "ending")}
                    arcs = profile.get("arcs", [])
                    if not isinstance(arcs, list) or len(arcs) > 10000:
                        raise ValueError("人物分卷成长线格式不正确")
                    clean["profile"]["arcs"] = []
                    for arc in arcs:
                        if not isinstance(arc, dict) or arc.get("volumeId") is None:
                            raise ValueError("人物成长线必须关联本作品的卷")
                        clean["profile"]["arcs"].append({"volumeId": checked_volume(arc.get("volumeId")),
                                                         "body": checked_string(arc.get("body", ""), "人物成长线", 5_000_000)})
            else:
                volume_id = item.get("volumeId")
                if legacy_volumes and result["kind"] == "long" and volume_id is None:
                    volume_id = result["volumes"][0]["id"]
                clean["volumeId"] = checked_volume(volume_id)
                if not deleted_at and volume_id in deleted_volume_ids:
                    raise ValueError("活动章节不能归入已回收的卷")
            result[key].append(clean)
    chapter_ids = {c["id"] for c in result["chapters"]}
    if "shortSections" in data:
        sections = data["shortSections"]
        if result["kind"] != "short" or not isinstance(sections, list) or len(sections) > 10000:
            raise ValueError("短篇正文定位格式不正确")
        result["shortSections"], section_ids = [], set()
        for section in sections:
            if not isinstance(section, dict):
                raise ValueError("短篇正文定位格式不正确")
            section_id = checked_string(section.get("id"), "正文定位编号", 100, False)
            start, end = section.get("start"), section.get("end")
            if (section_id in section_ids or type(start) is not int or type(end) is not int
                    or not 0 <= start <= end <= MAX_BOOK * 2):
                raise ValueError("短篇正文定位格式不正确")
            section_ids.add(section_id)
            result["shortSections"].append({"id": section_id, "title": checked_string(section.get("title"), "原正文标题", 200),
                                             "start": start, "end": end})
        chapter_ids.update(section_ids)
    def checked_links(value):
        if not isinstance(value, list) or len(value) > 10000 or any(not isinstance(v, str) or v not in chapter_ids for v in value):
            raise ValueError("关联正文必须指向本作品的章节")
        return list(dict.fromkeys(value))
    for note in result["notes"]:
        note["chapterIds"] = checked_links(note["chapterIds"])
    if "atlasViews" in data:
        views = data["atlasViews"]
        if not isinstance(views, list) or len(views) > 100:
            raise ValueError("人物分图列表格式不正确或超过 100 个")
        person_ids = {note["id"] for note in result["notes"] if note["type"] == "人物"}
        result["atlasViews"], view_ids = [], set()
        for view in views:
            if not isinstance(view, dict):
                raise ValueError("人物分图格式不正确")
            view_id = checked_string(view.get("id"), "人物分图编号", 100, False)
            if view_id in view_ids:
                raise ValueError("人物分图编号重复")
            view_ids.add(view_id)
            members = view.get("personIds")
            if (not isinstance(members, list) or len(members) > 10000
                    or any(not isinstance(person_id, str) or person_id not in person_ids for person_id in members)):
                raise ValueError("人物分图必须指向本作品的人物")
            if len(set(members)) != len(members):
                raise ValueError("人物分图中的人物编号重复")
            result["atlasViews"].append({
                "id": view_id, "title": checked_string(view.get("title"), "人物分图标题", 200, False),
                "description": checked_string(view.get("description", ""), "人物分图说明", 50000),
                "personIds": list(members),
            })
    for key in ("outline", "relations"):
        items = data.get(key, [])
        if not isinstance(items, list) or len(items) > 10000:
            raise ValueError("大纲或人物关系列表格式不正确")
        result[key], seen = [], set()
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("大纲或人物关系格式不正确")
            item_id = checked_string(item.get("id"), "条目编号", 100, False)
            if item_id in seen:
                raise ValueError("条目编号重复")
            seen.add(item_id)
            clean = {"id": item_id, "body": checked_string(item.get("body", ""), "内容", 5_000_000),
                     "chapterIds": checked_links(item.get("chapterIds", [])), "deletedAt": item.get("deletedAt")}
            if clean["deletedAt"] is not None:
                checked_string(clean["deletedAt"], "回收时间", 100, False)
            if key == "outline":
                clean["title"] = checked_string(item.get("title", ""), "大纲标题", 200)
                if "category" in item:
                    clean["category"] = checked_string(item["category"], "大纲分类", 200)
                clean["parentId"] = item.get("parentId")
                clean["volumeId"] = checked_volume(item.get("volumeId"))
                clean["kind"] = item.get("kind", "scene")
                if clean["kind"] not in ("story", "volume", "chapter", "scene"):
                    raise ValueError("大纲类型必须是故事、卷、章或场景")
            else:
                clean["label"] = checked_string(item.get("label", ""), "关系名称", 200)
                clean["type"] = item.get("type", "other")
                if clean["type"] not in ("friend", "mentor", "family", "conflict", "cooperate", "fate", "other"):
                    raise ValueError("人物关系类型不正确")
                clean["stage"] = checked_string(item.get("stage", ""), "关系阶段", 200)
                clean["volumeIds"] = checked_volumes(item.get("volumeIds", []))
                person_ids = {n["id"] for n in result["notes"] if n["type"] == "人物"}
                if item.get("fromId") not in person_ids or item.get("toId") not in person_ids or item["fromId"] == item["toId"]:
                    raise ValueError("人物关系需要连接本作品中两个不同的人物")
                clean.update(fromId=item["fromId"], toId=item["toId"])
            result[key].append(clean)
    parents = {o["id"]: o["parentId"] for o in result["outline"]}
    for item_id, parent_id in parents.items():
        seen = {item_id}
        while parent_id is not None:
            if not isinstance(parent_id, str) or parent_id not in parents or parent_id in seen:
                raise ValueError("大纲层级不能循环或指向其他作品")
            seen.add(parent_id)
            parent_id = parents[parent_id]
    planning.validate(result, data)
    result["storyMemory"] = story_memory.validate_memory(data.get("storyMemory"), result)
    # Migrate aliases and UTF-16 offsets together with old short manuscripts
    # before validating anchors against their final continuous body.
    result["reviewTools"] = copy.deepcopy(data.get("reviewTools", review_tools.defaults()))
    result["assetLibrary"] = copy.deepcopy(data.get("assetLibrary", asset_library.defaults()))
    normalize_short_book(result)
    review_tools.validate(result)
    result["assetLibrary"] = asset_library.validate(result, result.get("assetLibrary"))
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_BOOK:
        raise ValueError("单部作品超过 25 MB，请拆分为多部作品")
    return result


def book_result(row):
    return {"book": upgrade_book(json.loads(row["payload"])), "revision": row["revision"], "updatedAt": row["updated_at"]}


def require_active_book(row):
    if row["deleted_at"] is not None:
        error = protection.ProtectionError(BOOK_TRASHED, 409, True)
        error.deleted = True
        raise error


def book_summary(row):
    book = upgrade_book(json.loads(row["payload"]))
    chapters = [chapter for _, group in manuscript_groups(book) for chapter in group]
    latest = next((chapter for chapter in reversed(chapters) if chapter["body"].strip()), chapters[-1] if chapters else None)
    return {"id": book["id"], "title": book["title"], "kind": book["kind"], "cover": book["cover"], "coverTemplate": book["coverTemplate"],
            "volumeCount": sum(not volume["deletedAt"] for volume in book["volumes"]),
            "outlineCount": sum(not item["deletedAt"] for item in book["outline"]),
            "personCount": sum(not note["deletedAt"] and note["type"] == "人物" for note in book["notes"]),
            "chapterCount": len(chapters), "latestChapterTitle": latest["title"] if latest else "",
            "excerpt": next((chapter["body"][:100] for chapter in chapters if chapter["body"].strip()), ""),
            "charCount": sum(sum(not character.isspace() for character in chapter["body"]) for chapter in chapters),
            "updatedAt": row["updated_at"], "revision": row["revision"]}


def change_book_trash(path, data):
    match = re.fullmatch(r"/api/books/([^/]+)/(trash|restore|purge)", path)
    if not match:
        return None
    if not isinstance(data, dict) or set(data) != {"revision"} or type(data["revision"]) is not int or data["revision"] < 1:
        raise protection.ProtectionError("彻底删除作品时需要当前保存版本。" if match[2] == "purge" else "移入回收站或恢复作品时需要当前保存版本。")
    book_id, operation = match.groups()
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = saved_book_row(conn, book_id)
        if row["revision"] != data["revision"]:
            raise protection.ProtectionError(BOOK_STATE_CONFLICT, 409, True)
        if operation == "trash":
            require_active_book(row)
        elif row["deleted_at"] is None:
            raise protection.ProtectionError("这部作品不在回收站中，请刷新列表后重试。", 409, True)
        if operation == "purge":
            purge_book_rows(conn, row["id"])
            result = {"ok": True, "id": book_id}
        else:
            stamp = now()
            deleted_at = stamp if operation == "trash" else None
            changed = conn.execute("UPDATE books SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
                                   (deleted_at, stamp, book_id, row["revision"]))
            if changed.rowcount != 1:
                raise protection.ProtectionError(BOOK_STATE_CONFLICT, 409, True)
            # Soft deletion changes metadata only; recovery keeps the authored payload.
            if operation == "trash":
                return {"bookId": book_id, "revision": row["revision"] + 1, "deletedAt": deleted_at, "updatedAt": stamp}
            result = {**book_result(row), "revision": row["revision"] + 1, "updatedAt": stamp}
    if operation == "purge":
        if cleanup_pending_book_purges(book_id):
            result["cleanupPending"] = True
        return result
    try:
        sync_book_folder(book_id)
    except Exception:
        result["folderWarning"] = FOLDER_WARNING
    return result


def trash_expiry(deleted_at):
    """Unknown or timezone-less legacy dates never authorize destructive cleanup."""
    if not isinstance(deleted_at, str) or not deleted_at or len(deleted_at) > 100:
        return None
    try:
        stamp = datetime.fromisoformat(deleted_at.replace("Z", "+00:00"))
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            return None
        return stamp.astimezone(timezone.utc) + TRASH_RETENTION
    except (ValueError, OverflowError):
        return None


def purge_book_rows(conn, book_id, deleted_at=None):
    conn.execute("INSERT OR IGNORE INTO sync_tombstones(book_id,deleted_at) VALUES(?,?)", (book_id, deleted_at or now()))
    # The durable job survives crashes or filesystem failures after SQL commits.
    conn.execute("INSERT OR IGNORE INTO pending_book_purges(book_id) VALUES(?)", (book_id,))
    conn.execute("DELETE FROM history WHERE book_id=?", (book_id,))
    conn.execute("DELETE FROM backup_runs WHERE book_id=?", (book_id,))
    planning.purge_book(conn, book_id)
    conn.execute("DELETE FROM books WHERE id=?", (book_id,))
    conn.execute("DELETE FROM pending_chapter_purges WHERE book_id=?", (book_id,))


def cleanup_pending_book_purges(book_id=None):
    completed = []
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute("SELECT book_id FROM pending_book_purges" + (" WHERE book_id=?" if book_id is not None else ""), (book_id,) if book_id is not None else ()).fetchall()
        for row in rows:
            if conn.execute("SELECT 1 FROM books WHERE id=?", (row[0],)).fetchone():
                continue
            try:
                protection.purge_snapshots(DB_PATH, row[0], validate_book)
                ChatImageStore(DB_PATH.parent).purge(row[0])
                if not external_backups.clean_book(conn, row[0], validate_book):
                    continue
                AIService(DB_PATH.parent).clear_usage(row[0])
            except (protection.ProtectionError, OSError, AIError):
                continue
            removed = conn.execute("SELECT deleted_at FROM sync_tombstones WHERE book_id=?", (row[0],)).fetchone()
            completed.append((row[0], removed[0] if removed else now()))
        conn.commit()
        try:
            busy = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        except Exception:
            busy = 1
    synced = []
    if not busy:
        for identity, stamp in completed:
            try:
                if server_extensions.forget_book(chapter_history_context(), identity, stamp):
                    synced.append(identity)
            except Exception:
                pass
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for identity in synced:
            if not conn.execute("SELECT 1 FROM books WHERE id=?", (identity,)).fetchone():
                conn.execute("DELETE FROM pending_book_purges WHERE book_id=?", (identity,))
        return bool(conn.execute("SELECT 1 FROM pending_book_purges" + (" WHERE book_id=?" if book_id is not None else "") + " LIMIT 1", (book_id,) if book_id is not None else ()).fetchone())


def cleanup_expired_books(moment=None):
    moment = moment or datetime.now(timezone.utc)
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("cleanup time must include a timezone")
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute("SELECT id,deleted_at FROM books WHERE deleted_at IS NOT NULL").fetchall()
        expired = [row["id"] for row in rows if (expiry := trash_expiry(row["deleted_at"])) is not None and expiry <= moment]
        for book_id in expired:
            purge_book_rows(conn, book_id)
    cleanup_pending_book_purges()
    chapter_history.cleanup(chapter_history_context())
    return expired


def start_trash_cleanup(interval=TRASH_CLEANUP_SECONDS):
    stop = threading.Event()
    def sweep():
        while not stop.wait(interval):
            try:
                cleanup_expired_books()
            except Exception:
                # Retain the durable jobs and retry; never log a book's contents.
                print("回收站自动清理暂未完成，将在后台重试。", file=sys.stderr, flush=True)
    worker = threading.Thread(target=sweep, name="writer-trash-cleanup", daemon=True)
    worker.start()
    return stop, worker


def restore_book(data):
    book = validate_book(data)
    book["id"] = uid()
    volume_map = {volume["id"]: uid() for volume in book["volumes"]}
    for volume in book["volumes"]:
        volume["id"] = volume_map[volume["id"]]
    for item in book["chapters"] + book["outline"]:
        if item["volumeId"] is not None:
            item["volumeId"] = volume_map[item["volumeId"]]
    for note in book["notes"]:
        if note["type"] == "人物":
            for arc in note["profile"]["arcs"]:
                arc["volumeId"] = volume_map[arc["volumeId"]]
    for relation in book["relations"]:
        relation["volumeIds"] = [volume_map[v] for v in relation["volumeIds"]]
    return validate_book(book)


def prepare_manuscript_request(data, commit=False):
    """Parse a chosen file locally; paths and external resources are never read."""
    allowed = {"filename", "content", "kind", "title", "options", "edits", "sourceHash", "requestId"}
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError("稿件导入参数不正确。")
    encoded = data.get("content")
    limit = manuscript_import.MAX_FILE_BYTES
    if not isinstance(encoded, str) or not encoded or len(encoded) > ((limit + 2) // 3) * 4:
        raise ValueError("稿件文件为空或过大。")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("稿件文件编码不正确，请重新选择。") from exc
    if not content or len(content) > limit:
        raise ValueError("稿件文件为空或过大。")
    preview = manuscript_import.prepare_import(content, data.get("filename"), data.get("kind", "long"),
                                                data.get("title"), data.get("options"), data.get("edits"))
    fingerprint = data.get("sourceHash")
    if (commit or fingerprint is not None) and fingerprint != preview["sourceHash"]:
        raise ValueError("稿件已变化，请重新预览。")
    if commit and (not isinstance(data.get("requestId"), str) or not re.fullmatch(r"[A-Za-z0-9-]{16,80}", data["requestId"])):
        raise ValueError("导入确认已失效，请重新预览。")
    return preview


def commit_manuscript(data, preview):
    # Bind retries to the complete validated plan, including renamed chapters.
    # The row stores identifiers and a digest, never the uploaded manuscript.
    digest = hashlib.sha256(json.dumps(preview, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute("SELECT * FROM manuscript_import_requests WHERE request_id=?", (data["requestId"],)).fetchone()
        if previous:
            if previous["request_hash"] != digest:
                raise protection.ProtectionError("导入确认内容已变化，请重新预览。", 409)
            row = conn.execute("SELECT * FROM books WHERE id=?", (previous["book_id"],)).fetchone()
            if row is None:
                raise protection.ProtectionError("这次导入的作品已删除，请重新预览。", 410)
            require_active_book(row)
            return book_result(row), False
        book = validate_book(manuscript_import.make_book(preview))
        insert_book(conn, book)
        stamp = now()
        conn.execute("INSERT INTO manuscript_import_requests VALUES(?,?,?,?)", (data["requestId"], digest, book["id"], stamp))
    result = {"book": book, "revision": 1, "updatedAt": stamp}
    try:
        checkpoint_book(book["id"])
    except Exception:
        result["protectionWarning"] = protection.WARNING
    return result, True


def preserve_history(conn, row, stamp):
    removed = chapter_history.purged_ids(conn, row["id"])
    payload = (json.dumps(validate_book(chapter_history.sanitize(json.loads(row["payload"]), removed)), ensure_ascii=False)
               if removed else row["payload"])
    conn.execute("INSERT INTO history(book_id,revision,payload,saved_at) VALUES(?,?,?,?)",
                 (row["id"], row["revision"], payload, stamp))
    conn.execute("DELETE FROM history WHERE book_id=? AND id NOT IN (SELECT id FROM history WHERE book_id=? ORDER BY id DESC LIMIT 30)",
                 (row["id"], row["id"]))


def saved_book_row(conn, book_id):
    row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
    if row is None:
        raise protection.ProtectionError("找不到这部作品", 404)
    return row


def checkpoint_book(book_id, force=False):
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = saved_book_row(conn, book_id)
        require_active_book(row)
        result = protection.checkpoint(conn, DB_PATH, row, validate_book, force=force, reason="manual" if force else "automatic")
        try:
            external_backups.checkpoint(conn, row, book_result(row)["book"], validate_book, force=force)
        except (OSError, ValueError, protection.ProtectionError):
            # Commit the successful local checkpoint before surfacing the warning.
            conn.commit()
            raise protection.ProtectionError(external_backups.WARNING, 503)
        return result


def protection_route(path):
    return re.fullmatch(r"/api/books/(.+)/(history|backups|checkpoint)(?:/([^/]+)(/restore)?)?", path)


def read_protection(path):
    if path == "/api/protection/settings":
        with connect() as conn:
            return {"settings": protection.settings(conn)}
    match = protection_route(path)
    if not match:
        return None
    book_id, kind, token, restore = match.groups()
    if restore or kind == "checkpoint":
        raise protection.ProtectionError("找不到这个操作", 404)
    with connect() as conn:
        current = saved_book_row(conn, book_id)
        removed = chapter_history.purged_ids(conn, book_id)
        clean = lambda value: validate_book(chapter_history.sanitize(value, removed))
        if kind == "history":
            if token:
                if not token.isdecimal() or int(token) < 1:
                    raise protection.ProtectionError("历史版本编号不正确")
                row = conn.execute("SELECT * FROM history WHERE book_id=? AND revision=? ORDER BY id DESC LIMIT 1", (book_id, int(token))).fetchone()
                if row is None:
                    raise protection.ProtectionError("这个历史版本已不存在，请刷新列表", 404)
                book = clean(json.loads(row["payload"]))
                return {"book": book, **protection.summary(book, row["revision"], row["saved_at"]), "currentRevision": current["revision"]}
            rows = conn.execute("SELECT * FROM history WHERE book_id=? ORDER BY id DESC LIMIT 30", (book_id,)).fetchall()
            versions = [protection.summary(clean(json.loads(row["payload"])), row["revision"], row["saved_at"]) for row in rows]
            return {"versions": versions, "currentRevision": current["revision"]}
        result = (protection.get_snapshot(DB_PATH, book_id, token, clean) if token
                  else {"backups": protection.list_snapshots(DB_PATH, book_id, clean)})
        return {**result, "currentRevision": current["revision"]}


def write_protection(path, data):
    match = protection_route(path)
    if not match:
        return None
    book_id, kind, token, restore = match.groups()
    if kind == "checkpoint" and not token:
        if not isinstance(data, dict) or data:
            raise protection.ProtectionError("立即备份不接受文件路径")
        return {"backup": checkpoint_book(book_id, force=True)}
    if not restore or not token or kind not in ("history", "backups"):
        raise protection.ProtectionError("找不到这个操作", 404)
    if not isinstance(data, dict) or set(data) != {"revision"} or type(data["revision"]) is not int:
        raise protection.ProtectionError("恢复时需要当前保存版本")
    with DB_LOCK, connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = saved_book_row(conn, book_id)
        require_active_book(current)
        if current["revision"] != data["revision"]:
            raise protection.ProtectionError("作品已在另一个窗口更新，请重新查看版本后恢复", 409, True)
        removed = chapter_history.purged_ids(conn, book_id)
        clean = lambda value: validate_book(chapter_history.sanitize(value, removed))
        if kind == "history":
            if not token.isdecimal() or int(token) < 1:
                raise protection.ProtectionError("历史版本编号不正确")
            source = conn.execute("SELECT payload FROM history WHERE book_id=? AND revision=? ORDER BY id DESC LIMIT 1", (book_id, int(token))).fetchone()
            if source is None:
                raise protection.ProtectionError("这个历史版本已不存在，请刷新列表", 404)
            book = clean(json.loads(source["payload"]))
        else:
            book = protection.get_snapshot(DB_PATH, book_id, token, clean)["book"]
        if book["id"] != book_id:
            raise protection.ProtectionError("版本与当前作品不一致")
        # If preserving the current book fails, do not start the restoration.
        protection.checkpoint(conn, DB_PATH, current, validate_book, force=True, reason="before-restore")
        stamp = now()
        preserve_history(conn, current, stamp)
        conn.execute("UPDATE books SET title=?,payload=?,revision=revision+1,updated_at=? WHERE id=?",
                     (book["title"], json.dumps(book, ensure_ascii=False), stamp, book_id))
        result = {"book": book, "revision": current["revision"] + 1, "updatedAt": stamp}
    try:
        sync_book_folder(book_id)
    except Exception:
        result["folderWarning"] = FOLDER_WARNING
    return result


class FolderExportError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status
        self.code = {FOLDER_CONFLICT: "FOLDER_CONFLICT", FOLDER_UNSAFE: "FOLDER_UNSAFE",
                     FOLDER_UNSUPPORTED: "FOLDER_UNSUPPORTED"}.get(message, "FOLDER_FAILURE")


def manuscript_groups(book):
    """Use the same authored reading order in the shelf and text export."""
    volumes = [item for item in book["volumes"] if not item["deletedAt"]]
    deleted_volumes = {item["id"] for item in book["volumes"] if item["deletedAt"]}
    chapters = [item for item in book["chapters"] if not item["deletedAt"] and item["volumeId"] not in deleted_volumes]
    if book["kind"] == "long":
        volume_ids = {item["id"] for item in volumes}
        groups = [(volume["title"], [item for item in chapters if item["volumeId"] == volume["id"]]) for volume in volumes]
        groups.append(("未分卷", [item for item in chapters if item["volumeId"] not in volume_ids]))
    else:
        groups = [("", chapters)]
    return [(title, items) for title, items in groups if items]


def manuscript_text(book):
    """Follow authored volume/chapter order, excluding every recycled item."""
    parts = [book["title"]]
    for title, items in manuscript_groups(book):
        if title:
            parts.append(title)
        if book["kind"] == "short":
            parts.extend(item["body"] for item in items)
        else:
            parts.extend((item["title"] or "未命名章节") + "\n\n" + item["body"] for item in items)
    return "\ufeff" + "\n\n".join(parts) + "\n"


@contextmanager
def book_folder_directory(book_id, create):
    """Walk directory descriptors without following links, including ancestors."""
    folder = book_folder_path(book_id)
    root, name = folder.parent.parent, folder.name
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        raise FolderExportError(FOLDER_UNSUPPORTED)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptors = []
    try:
        current = os.open(root.anchor, flags)
        descriptors.append(current)
        for part in root.parts[1:]:
            current = os.open(part, flags, dir_fd=current)
            descriptors.append(current)
        for part in ("books", name):
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
            try:
                current = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    yield None, folder
                    return
                raise
            descriptors.append(current)
        yield current, folder
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def folder_file(folder_fd, name, digest_only=False):
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder_fd)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > (MAX_REQUEST if digest_only else 65536):
            raise FolderExportError(FOLDER_CONFLICT)
        if not digest_only:
            return stream.read(65537)
        digest = hashlib.sha256()
        size = 0
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            if size > MAX_REQUEST:
                raise FolderExportError(FOLDER_CONFLICT)
            digest.update(chunk)
        return digest.hexdigest()


def write_folder_temp(folder_fd, content, temporary):
    name = ".writer-desk-" + uid() + ".tmp"
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder_fd)
    temporary.add(name)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return name


def sync_folder_files(folder_fd, book_id, book, revision, updated_at, create):
    raw_manifest = folder_file(folder_fd, FOLDER_MANIFEST)
    if raw_manifest is None:
        if not create:
            return False
        manifest = {"format": "writer-desk-folder", "bookId": book_id, "revision": 0,
                    "files": {name: None for name in FOLDER_FILES}}
    else:
        try:
            manifest = json.loads(raw_manifest)
            valid = (isinstance(manifest, dict) and manifest.get("format") == "writer-desk-folder" and manifest.get("bookId") == book_id
                     and isinstance(manifest.get("files"), dict) and set(manifest["files"]) == set(FOLDER_FILES)
                     and ("pending" not in manifest or isinstance(manifest["pending"], dict) and set(manifest["pending"]) == set(FOLDER_FILES)))
            if not valid:
                raise ValueError("invalid manifest")
            for values in (manifest["files"], manifest.get("pending", {})):
                if not all(value is None or isinstance(value, str) and len(value) == 64 and all(ch in "0123456789abcdef" for ch in value) for value in values.values()):
                    raise ValueError("invalid file digest")
        except (ValueError, TypeError):
            raise FolderExportError(FOLDER_CONFLICT) from None
    allowed = {name: {manifest["files"][name], manifest.get("pending", {}).get(name)} for name in FOLDER_FILES}

    def check_owned(name):
        digest = folder_file(folder_fd, name, digest_only=True)
        if digest is not None and digest not in allowed[name]:
            raise FolderExportError(FOLDER_CONFLICT)
        return digest

    previous = {name: check_owned(name) for name in FOLDER_FILES}
    backup = {"format": "yejian-backup", "version": 4, "exportedAt": updated_at, "book": book}
    contents = {FOLDER_FILES[0]: manuscript_text(book).encode("utf-8"),
                FOLDER_FILES[1]: json.dumps(backup, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"}
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in contents.items()}
    completed = {"format": "writer-desk-folder", "bookId": book_id, "revision": revision, "files": hashes}
    if "pending" not in manifest and manifest == completed and previous == hashes:
        return True
    pending = {**manifest, "files": previous, "pending": hashes}
    temporary = set()
    try:
        staged = {name: write_folder_temp(folder_fd, content, temporary) for name, content in contents.items() if previous[name] != hashes[name]}
        pending_temp = write_folder_temp(folder_fd, json.dumps(pending, ensure_ascii=False).encode("utf-8"), temporary)
        completed_temp = write_folder_temp(folder_fd, json.dumps(completed, ensure_ascii=False).encode("utf-8"), temporary)
        # Recheck after staging, then record both allowed generations before any
        # replacement. Interrupted multi-file updates can safely resume later.
        for name in FOLDER_FILES:
            check_owned(name)
        if folder_file(folder_fd, FOLDER_MANIFEST) != raw_manifest:
            raise FolderExportError(FOLDER_CONFLICT)
        os.replace(pending_temp, FOLDER_MANIFEST, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
        os.fsync(folder_fd)
        for name, temporary_name in staged.items():
            check_owned(name)
            os.replace(temporary_name, name, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
        os.fsync(folder_fd)
        os.replace(completed_temp, FOLDER_MANIFEST, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
        os.fsync(folder_fd)
        return True
    finally:
        for name in temporary:
            try:
                os.unlink(name, dir_fd=folder_fd)
            except FileNotFoundError:
                pass


def book_folder_path(book_id):
    return Path(os.path.abspath(DB_PATH.parent)) / "books" / ("book-" + hashlib.sha256(book_id.encode("utf-8")).hexdigest())


def sync_book_folder(book_id, create=False):
    """Read the latest committed revision under a cross-process SQLite lock."""
    if not create and not os.path.lexists(book_folder_path(book_id)):
        return None  # Ordinary saving does not opt in to filesystem exports.
    try:
        with DB_LOCK, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
            if row is None or row["deleted_at"] is not None:
                return None
            with book_folder_directory(book_id, create) as (folder_fd, folder):
                if folder_fd is None:
                    return None
                book = upgrade_book(json.loads(row["payload"]))
                if not sync_folder_files(folder_fd, book_id, book, row["revision"], row["updated_at"], create):
                    return None
                return {"folder": str(folder), "revision": row["revision"]}
    except FolderExportError:
        raise
    except OSError as exc:
        raise FolderExportError(FOLDER_UNSAFE if exc.errno in (errno.ELOOP, errno.ENOTDIR) else FOLDER_FAILURE,
                                409 if exc.errno in (errno.ELOOP, errno.ENOTDIR) else 500) from exc
    except Exception as exc:
        raise FolderExportError(FOLDER_FAILURE, 500) from exc


def handle_ai_request(path, data):
    service = AIService(DB_PATH.parent)
    if path == "/api/ai/models":
        if not isinstance(data, dict):
            raise AIError(400, "模型读取参数不正确。")
        return service.list_models(data)
    if path == "/api/ai/cover-image":
        if not isinstance(data, dict) or set(data) != {"prompt"}:
            raise AIError(400, "封面图片请求只接受文字提示词。")
        return service.cover_image(data["prompt"])
    if path == "/api/ai/book-cover":
        if not isinstance(data, dict) or not {"title", "kind", "prompt"} <= set(data) or set(data) - {"title", "kind", "prompt", "skillIds", "skillMode", "preview"}:
            raise AIError(400, "新书封面方案参数不正确。")
        if not isinstance(data["title"], str) or len(data["title"]) > 200 or not isinstance(data["kind"], str) or data["kind"] not in ("long", "short") or not isinstance(data["prompt"], str) or len(data["prompt"]) > 10000 or type(data.get("preview", False)) is not bool:
            raise AIError(400, "新书封面方案参数不正确。")
        if "skillIds" in data and data["skillIds"] is None or "skillMode" in data and data["skillMode"] is None:
            raise AIError(400, "AI 写作技能参数不正确。")
        book = {"id": "unsaved-book", "title": data["title"], "kind": data["kind"], "chapters": [], "outline": [], "notes": [], "relations": []}
        operation = service.preview if data.get("preview", False) else service.run
        result = operation(book, "book_cover", [], data["prompt"], data.get("skillIds"), data.get("skillMode"))
        result.pop("bookId", None)
        return result
    if path == "/api/ai/test":
        if not isinstance(data, dict) or data:
            raise AIError(400, "连接测试不接受作品内容或额外参数。")
        return service.test_connection()
    upload = re.fullmatch(r"/api/books/([^/]+)/ai/images", path)
    if upload:
        if not isinstance(data, dict) or set(data) != {"name", "dataUrl"} or not isinstance(data["name"], str):
            raise AIError(400, "对话图片上传参数不正确。")
        with DB_LOCK, connect() as conn:
            row = conn.execute("SELECT * FROM books WHERE id=?", (upload[1],)).fetchone()
            if not row:
                raise AIError(404, "找不到这部作品")
            require_active_book(row)
            if chapter_history.image_cleanup_pending(conn, row["id"]):
                raise AIError(409, "本机副本清理尚未完成，请在历史记录中重试清理后再添加图片。")
            return ChatImageStore(DB_PATH.parent).save(row["id"], data["name"], data["dataUrl"])
    match = re.fullmatch(r"/api/books/([^/]+)/ai(/preview)?", path)
    if not match:
        return None
    if not isinstance(data, dict) or set(data) - {"action", "chapterIds", "instruction", "skillIds", "skillMode", "chat", "history", "model", "attachments", "profileId"}:
        raise AIError(400, "AI 请求参数不正确。")
    if "model" in data and (not isinstance(data["model"], str) or not data["model"].strip()):
        raise AIError(400, "模型名称格式不正确或过长。")
    if "skillIds" in data and data["skillIds"] is None or "skillMode" in data and data["skillMode"] is None:
        raise AIError(400, "AI 写作技能参数不正确。")
    if type(data.get("chat", False)) is not bool or "history" in data and (not data.get("chat", False) or not isinstance(data["history"], list)):
        raise AIError(400, "AI 对话参数不正确。")
    if "attachments" in data and (not data.get("chat", False) or not isinstance(data["attachments"], list)):
        raise AIError(400, "图片附件只能用于 AI 对话。")
    with connect() as conn:
        row = conn.execute("SELECT * FROM books WHERE id=?", (match.group(1),)).fetchone()
        purge_generation = chapter_history.purged_ids(conn, match.group(1))
        if chapter_history.image_cleanup_pending(conn, match.group(1)):
            raise AIError(409, "本机副本清理尚未完成，请在历史记录中重试清理后再使用 AI。")
    if not row:
        raise AIError(404, "找不到这部作品")
    require_active_book(row)
    book = book_result(row)["book"]
    @contextmanager
    def guard_chat_images(book_id):
        with DB_LOCK, connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute("SELECT 1 FROM books WHERE id=?", (book_id,)).fetchone():
                raise AIError(404, "找不到这部作品")
            if chapter_history.purged_ids(conn, book_id) != purge_generation:
                raise AIError(409, "作品内容已被彻底删除，请重新发起对话。")
            if chapter_history.image_cleanup_pending(conn, book_id):
                raise AIError(409, "本机副本清理尚未完成，请在历史记录中重试清理。")
            yield
    service.chat_image_guard = guard_chat_images
    operation = service.preview if match.group(2) else service.run
    # Never hold a database transaction while waiting for an external service.
    result = operation(book, data.get("action"), short_chapter_ids(book, data.get("chapterIds")), data.get("instruction", ""), data.get("skillIds"), data.get("skillMode"), chat=data.get("chat", False), history=data.get("history"), model=data.get("model"), attachments=data.get("attachments"), profile_id=data.get("profileId"))
    if result.get("images"):
        # A book can be purged while a provider is responding. Never leave the
        # late response's pictures behind after its durable cleanup has run.
        with DB_LOCK, connect() as conn:
            if not conn.execute("SELECT 1 FROM books WHERE id=?", (book["id"],)).fetchone():
                ChatImageStore(DB_PATH.parent).purge(book["id"])
                raise AIError(404, "找不到这部作品")
    with DB_LOCK, connect() as conn:
        if not conn.execute("SELECT 1 FROM books WHERE id=?", (book["id"],)).fetchone():
            raise AIError(404, "找不到这部作品")
        if chapter_history.purged_ids(conn, book["id"]) != purge_generation:
            raise AIError(409, "作品内容已被彻底删除，请重新发起对话。")
    return result


def read_chat_image(path):
    match = re.fullmatch(r"/api/books/([^/]+)/ai/images/([^/]+)", path)
    if not match:
        return None
    with DB_LOCK, connect() as conn:
        row = conn.execute("SELECT id FROM books WHERE id=?", (match[1],)).fetchone()
        if not row:
            raise AIError(404, "找不到这部作品")
        # Recycled books keep their read-only conversations until final purge.
        return ChatImageStore(DB_PATH.parent).read(row["id"], match[2])


class Handler(BaseHTTPRequestHandler):
    server_version = "WritersDesk/0.2"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "") not in ("200", "201", "304"):
            super().log_message(fmt, *args)

    def send_bytes(self, content, status=200, content_type="application/json; charset=utf-8", filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if filename is not None:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(filename, safe=""))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data, status=200):
        self.send_bytes(json.dumps(data, ensure_ascii=False).encode(), status)

    def allowed_host(self):
        return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def allowed_client(self):
        return not DESKTOP_TOKEN or hmac.compare_digest(self.headers.get("X-Writer-Desktop", ""), DESKTOP_TOKEN)

    def read_json(self):
        if not self.allowed_host() or not self.allowed_client() or self.headers.get("X-Writer-Client") != "1":
            raise PermissionError("请从本机写作页面进行操作")
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"):
            raise PermissionError("不接受来自其他网站的保存请求")
        if self.headers.get_content_type() != "application/json":
            raise ValueError("需要 JSON 格式")
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0 or size > MAX_REQUEST:
            raise ValueError("请求为空或超过 64 MB")
        return json.loads(self.rfile.read(size))

    def do_GET(self):
        if not self.allowed_host() or not self.allowed_client():
            self.send_json({"error": "请使用本机地址访问"}, 403)
            return
        path = unquote(urlparse(self.path).path)
        try:
            extension = server_extensions.handle(chapter_history_context(), "GET", self.path)
            if extension is not None:
                self.send_json(extension)
                return
            image = read_chat_image(path)
            if image is not None:
                self.send_bytes(image[0], content_type=image[1])
                return
            chapter_result = chapter_history.read(chapter_history_context(), path)
            if chapter_result is not None:
                self.send_json(chapter_result)
                return
            planned = planning.read(chapter_history_context(), path)
            if planned is not None:
                self.send_json(planned)
                return
            if path == "/api/home":
                with DB_LOCK, connect() as conn:
                    conn.execute("BEGIN")
                    result = home_dashboard.statistics(conn, book_summary)
                self.send_json(result)
                return
            memory_match = re.fullmatch(r"/api/books/([^/]+)/memory", path)
            if memory_match:
                with connect() as conn:
                    row = conn.execute("SELECT * FROM books WHERE id=?", (memory_match[1],)).fetchone()
                if row is None:
                    self.send_json({"error": "找不到这部作品"}, 404)
                    return
                require_active_book(row)
                self.send_json(story_memory.memory_index(book_result(row)["book"]))
                return
            protected = read_protection(path)
            if protected is not None:
                self.send_json(protected)
            elif path == "/api/ai/settings":
                self.send_json(AIService(DB_PATH.parent).get_settings())
            elif path == "/api/ai/models":
                self.send_json(AIService(DB_PATH.parent).list_models())
            elif path == "/api/skills":
                self.send_json(SkillsService(DB_PATH.parent).list())
            elif path.startswith("/api/skills/"):
                self.send_json(SkillsService(DB_PATH.parent).detail(path[len("/api/skills/"):]))
            elif path == "/api/examples":
                manifest = ROOT / "examples" / "manifest.json"
                self.send_json({"examples": json.loads(manifest.read_text("utf-8")) if manifest.is_file() else []})
            elif path == "/api/books":
                with connect() as conn:
                    rows = conn.execute("SELECT * FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC").fetchall()
                    trash_count = conn.execute("SELECT COUNT(*) FROM books WHERE deleted_at IS NOT NULL").fetchone()[0]
                self.send_json({"books": [book_summary(row) for row in rows], "trashCount": trash_count})
            elif path == "/api/trash/books":
                with connect() as conn:
                    rows = conn.execute("SELECT * FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").fetchall()
                self.send_json({"books": [{**book_summary(row), "deletedAt": row["deleted_at"], "expiresAt": expiry.isoformat() if (expiry := trash_expiry(row["deleted_at"])) else None} for row in rows]})
            elif path.startswith("/api/books/"):
                with connect() as conn:
                    row = conn.execute("SELECT * FROM books WHERE id=?", (path[len("/api/books/"):],)).fetchone()
                if row:
                    require_active_book(row)
                self.send_json(book_result(row) if row else {"error": "找不到这部作品"}, 200 if row else 404)
            elif path.startswith("/api/"):
                self.send_json({"error": "找不到这个操作"}, 404)
            else:
                files = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/story-analysis.js": "story-analysis.js",
                         "/atlas-layout.js": "atlas-layout.js", "/atlas-ui.js": "atlas-ui.js", "/atlas.css": "atlas.css", "/outline.css": "outline.css",
                         "/vendor/dagre.min.js": "vendor/dagre.min.js",
                         "/workspace.js": "workspace.js", "/i18n.js": "i18n.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg",
                         "/protection.js": "protection.js", "/protection.css": "protection.css",
                         "/continuation.js": "continuation.js", "/ai.js": "ai.js", "/ai.css": "ai.css",
                         "/ai-chat.js": "ai-chat.js", "/ai-chat.css": "ai-chat.css"}
                files["/book-covers.js"] = "book-covers.js"
                files["/gestures.js"] = "gestures.js"
                files["/gestures.css"] = "gestures.css"
                files["/panel-resize.js"] = "panel-resize.js"
                files["/panel-resize.css"] = "panel-resize.css"
                files["/settings.js"] = "settings.js"
                files["/settings.css"] = "settings.css"
                files["/theme.js"] = "theme.js"
                files["/theme.css"] = "theme.css"
                files["/textarea-autosize.js"] = "textarea-autosize.js"
                files["/editor-layout.js"] = "editor-layout.js"
                files["/chat-images.js"] = "chat-images.js"
                files["/interface-polish.js"] = "interface-polish.js"
                files["/interface-polish.css"] = "interface-polish.css"
                files["/work-plan.js"] = "work-plan.js"
                files["/work-plan.css"] = "work-plan.css"
                files["/chapter-history.js"] = "chapter-history.js"
                files["/chapter-history.css"] = "chapter-history.css"
                files["/content-cleanup.js"] = "content-cleanup.js"
                for resource in ("workspace-expansion.js", "home-dashboard.js", "home-dashboard.css", "editor-tools.js", "editor-tools.css", "asset-library.js", "asset-library.css", "external-backups.js", "external-backups.css", "sync-panel.js", "sync-panel.css", "network-updater.js", "network-updater.css", "story-tools.js", "story-tools.css", "story-memory.js", "ai-stream.js", "formatted-export.js", "formatted-export.css", "book-search.js", "version-diff.js", "revision-tools.css", "manuscript-import.js", "manuscript-import.css", "local-proofreading-model.js", "local-proofreading.js", "local-proofreading.css", "manuscript-marks.js", "manuscript-marks.css", "review-entry.js"):
                    files["/" + resource] = resource
                files['/purge-model.js'] = '../mobile/purge-model.js'
                files['/live-sync.js'] = 'live-sync.js'
                filename = files.get(path)
                if not filename:
                    self.send_json({"error": "找不到这个页面"}, 404)
                    return
                content = (ROOT / "public" / filename).read_bytes()
                content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                self.send_bytes(content, content_type=content_type + ("; charset=utf-8" if filename.endswith((".html", ".css", ".js", ".svg")) else ""))
        except (AIError, SkillError, SyncError) as exc:
            self.send_json({"error": exc.message}, exc.status)
        except protection.ProtectionError as exc:
            self.send_json({"error": str(exc), "conflict": exc.conflict, **({"deleted": True} if getattr(exc, "deleted", False) else {})}, exc.status)
        except (ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            print(f"读取失败: {exc}", file=sys.stderr)
            self.send_json({"error": "读取失败，原有文件仍保留在本机"}, 500)

    def do_POST(self):
        try:
            data = self.read_json()
            path = unquote(urlparse(self.path).path)
            extension = server_extensions.handle(chapter_history_context(), "POST", self.path, data)
            if extension is not None:
                self.send_json(extension)
                return
            if path in ("/api/manuscript-import/preview", "/api/manuscript-import/commit"):
                committing = path.endswith("/commit")
                preview = prepare_manuscript_request(data, committing)
                if committing:
                    result, created = commit_manuscript(data, preview)
                    self.send_json(result, 201 if created else 200)
                else:
                    self.send_json(preview)
                return
            chapter_result = chapter_history.write(chapter_history_context(), path, data)
            if chapter_result is not None:
                self.send_json(chapter_result)
                return
            if path == "/api/skills/import":
                if not isinstance(data, dict) or set(data) != {"skillIds"}:
                    raise SkillError("写作技能导入参数不正确。")
                self.send_json(SkillsService(DB_PATH.parent).import_skills(data["skillIds"]))
                return
            lifecycle = change_book_trash(path, data)
            if lifecycle is not None:
                self.send_json(lifecycle)
                return
            protected = write_protection(path, data)
            if protected is not None:
                self.send_json(protected)
                return
            if ai_stream.serve(self, path, data, chapter_history_context()):
                return
            export_match = re.fullmatch(r"/api/books/([^/]+)/export-formatted", path)
            if export_match:
                if not isinstance(data, dict):
                    raise ValueError("排版导出参数不正确。")
                with connect() as conn:
                    row = conn.execute("SELECT * FROM books WHERE id=?", (export_match[1],)).fetchone()
                if row is None:
                    self.send_json({"error": "找不到这部作品"}, 404)
                    return
                require_active_book(row)
                content, mime, filename = render_book_export(book_result(row)["book"], data.get("format"), data)
                self.send_bytes(content, content_type=mime, filename=filename)
                return
            ai_result = handle_ai_request(path, data)
            if ai_result is not None:
                self.send_json(ai_result)
                return
            if path.startswith("/api/books/") and path.endswith("/folder"):
                if not isinstance(data, dict) or data:
                    self.send_json({"error": FOLDER_REQUEST, "code": "FOLDER_REQUEST"}, 400)
                    return
                book_id = path[len("/api/books/"):-len("/folder")]
                result = sync_book_folder(book_id, create=True)
                self.send_json(result if result else {"error": "找不到这部作品"}, 200 if result else 404)
                return
            if path == "/api/books":
                title = checked_string(data.get("title", "未命名作品"), "作品名称", 200, False)
                kind = data.get("kind", "long")
                if kind not in ("long", "short"):
                    raise ValueError("作品类型必须是长篇或短篇")
                book = new_book(title, kind)
                book["cover"] = checked_cover(data.get("cover", ""))
                book["coverTemplate"] = checked_cover_template(data.get("coverTemplate", ""))
            elif path == "/api/import":
                if not isinstance(data, dict) or data.get("format") != "yejian-backup" or type(data.get("version")) is not int or data.get("version") not in (1, 2, 3, 4):
                    raise ValueError("请选择作家工作台导出的完整备份文件（v1 至 v4）")
                book = restore_book(data.get("book"))
            elif path == "/api/examples/tide-archive":
                example = ROOT / "examples" / "tide-archive.yejian.json"
                if not example.is_file():
                    self.send_json({"error": "示例小说尚未安装"}, 404)
                    return
                book = restore_book(json.loads(example.read_text("utf-8"))["book"])
            else:
                self.send_json({"error": "找不到这个操作"}, 404)
                return
            with DB_LOCK, connect() as conn:
                if path.startswith("/api/examples/"):
                    titles = {json.loads(row["payload"])["title"] for row in conn.execute("SELECT payload FROM books")}
                    original_title, number = book["title"], 2
                    while book["title"] in titles:
                        book["title"] = f"{original_title} ({number})"
                        number += 1
                insert_book(conn, book)
            result = {"book": book, "revision": 1, "updatedAt": now()}
            try:
                checkpoint_book(book["id"])
            except Exception as exc:
                result["protectionWarning"] = external_backups.WARNING if str(exc) == external_backups.WARNING else protection.WARNING
            self.send_json(result, 201)
        except (AIError, SkillError, SyncError) as exc:
            self.send_json({"error": exc.message}, exc.status)
        except protection.ProtectionError as exc:
            self.send_json({"error": str(exc), "conflict": exc.conflict, **({"deleted": True} if getattr(exc, "deleted", False) else {})}, exc.status)
        except FolderExportError as exc:
            self.send_json({"error": str(exc), "code": exc.code}, exc.status)
        except (ValueError, TypeError, AttributeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, 403)
        except Exception as exc:
            print(f"新建失败: {exc}", file=sys.stderr)
            self.send_json({"error": "无法写入本机，请检查磁盘空间后重试"}, 500)

    def do_DELETE(self):
        try:
            data = self.read_json()
            result = server_extensions.handle(chapter_history_context(), "DELETE", self.path, data)
            self.send_json(result if result is not None else {"error": "找不到这个操作"}, 200 if result is not None else 404)
        except (AIError, SkillError, SyncError) as exc:
            self.send_json({"error": exc.message}, exc.status)
        except protection.ProtectionError as exc:
            self.send_json({"error": str(exc)}, exc.status)
        except (ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, 403)
        except Exception:
            self.send_json({"error": "无法完成删除，请重试。"}, 500)

    def do_PUT(self):
        try:
            data = self.read_json()
            path = unquote(urlparse(self.path).path)
            extension = server_extensions.handle(chapter_history_context(), "PUT", self.path, data)
            if extension is not None:
                self.send_json(extension)
                return
            if path == "/api/skills/settings":
                self.send_json(SkillsService(DB_PATH.parent).save_settings(data))
                return
            if path == "/api/ai/settings":
                self.send_json(AIService(DB_PATH.parent).save_settings(data))
                return
            if path == "/api/protection/settings":
                with DB_LOCK, connect() as conn:
                    result = protection.update_settings(conn, data)
                self.send_json({"settings": result})
                return
            if path == "/api/home/settings":
                with DB_LOCK, connect() as conn:
                    result = home_dashboard.update_settings(conn, data)
                self.send_json({"settings": result})
                return
            if not path.startswith("/api/books/"):
                self.send_json({"error": "找不到这个操作"}, 404)
                return
            book_id = path[len("/api/books/"):]
            if data.get("saveReason", "edit") not in ("edit", "restore", "structure"):
                raise ValueError("保存类型不正确")
            book = validate_book(data.get("book"))
            if book["id"] != book_id or type(data.get("revision")) is not int:
                raise ValueError("作品编号或保存版本不正确")
            with DB_LOCK, connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
                if not row:
                    self.send_json({"error": "找不到这部作品", "conflict": True, "deleted": True, "removed": True}, 404)
                    return
                require_active_book(row)
                if row["revision"] != data["revision"]:
                    self.send_json({"error": "另一个窗口修改了这部作品。本页内容已保留，请另存为新作品。", "conflict": True}, 409)
                    return
                if chapter_history.contains(data["book"], chapter_history.purged_ids(conn, book_id)):
                    self.send_json({"error": "本页包含已彻底删除的章节，请重新打开作品后编辑。", "conflict": True}, 409)
                    return
                stamp = now()
                preserve_history(conn, row, stamp)
                before = json.loads(row["payload"])
                def words(value):
                    return sum(sum(not c.isspace() for c in item["body"]) for item in value["chapters"] if not item.get("deletedAt"))
                relocated = data.get("saveReason") == "structure" and words(before) == words(book)
                if data.get("saveReason") != "restore" and not relocated:
                    planning.record_save(conn, before, book, stamp)
                conn.execute("UPDATE books SET title=?,payload=?,revision=revision+1,updated_at=? WHERE id=?", (book["title"], json.dumps(book, ensure_ascii=False), stamp, book_id))
            result = {"revision": row["revision"] + 1, "updatedAt": stamp}
            try:
                checkpoint_book(book_id)
            except Exception as exc:
                result["protectionWarning"] = external_backups.WARNING if str(exc) == external_backups.WARNING else protection.WARNING
            try:
                sync_book_folder(book_id)
            except Exception as exc:
                result["folderWarning"] = FOLDER_WARNING
                try:
                    print(f"作品文件夹同步失败: {exc}", file=sys.stderr)
                except (OSError, ValueError):
                    pass  # Logging cannot invalidate an already committed save.
            self.send_json(result)
        except (AIError, SkillError, SyncError) as exc:
            self.send_json({"error": exc.message}, exc.status)
        except protection.ProtectionError as exc:
            self.send_json({"error": str(exc), "conflict": exc.conflict, **({"deleted": True} if getattr(exc, "deleted", False) else {})}, exc.status)
        except (ValueError, TypeError, AttributeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, 403)
        except Exception as exc:
            print(f"保存失败: {exc}", file=sys.stderr)
            self.send_json({"error": "暂时无法保存，编辑内容仍留在本页。请重试或下载备份。"}, 500)


class LocalHTTPServer(ThreadingHTTPServer):
    """The loopback-only service must not wait for reverse DNS at startup."""
    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def main():
    global DB_PATH
    parser = argparse.ArgumentParser(description="启动作家工作台 / Writer's Desk")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--open", action="store_true", help="自动打开浏览器")
    parser.add_argument("--desktop", action="store_true", help="输出桌面进程就绪消息")
    parser.add_argument("--legacy-data-dir", type=Path, action="append", default=[], help="首次启动时复制旧数据库，保留原文件")
    args = parser.parse_args()
    DB_PATH = args.data_dir.resolve() / "writer.sqlite3"
    if not DB_PATH.exists():
        for legacy in args.legacy_data_dir:
            source = legacy.resolve() / "writer.sqlite3"
            if not source.is_file() or source == DB_PATH:
                continue
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary = DB_PATH.with_suffix(".migration.sqlite3")
            try:
                with closing(sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)) as old:
                    if not old.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='books'").fetchone():
                        continue
                    with closing(sqlite3.connect(temporary)) as fresh:
                        old.backup(fresh)
                temporary.replace(DB_PATH)
                print("已复制旧版作品库，原数据库仍保留。", file=sys.stderr, flush=True)
                break
            finally:
                if temporary.exists():
                    temporary.unlink()
    initialize()
    try:
        server = LocalHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"无法启动: {exc}\n可使用 --port 8766 指定其他端口。", file=sys.stderr)
        sys.exit(1)
    url = f"http://127.0.0.1:{server.server_port}"
    if args.desktop:
        print("WRITER_READY " + json.dumps({"url": url, "pid": os.getpid()}), flush=True)
        def watch_parent():
            # Electron keeps this pipe open. EOF also cleans up after a crashed
            # or force-killed desktop process, without a fixed PID or timer.
            try:
                sys.stdin.buffer.read()
            except (OSError, ValueError):
                pass
            server.shutdown()
        threading.Thread(target=watch_parent, daemon=True).start()
    else:
        print(f"作家工作台已启动：{url}\n作品保存在：{DB_PATH}\n按 Ctrl+C 关闭。", flush=True)
    if args.open:
        import webbrowser
        webbrowser.open(url)
    cleanup_stop, cleanup_worker = start_trash_cleanup()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup_stop.set()
        cleanup_worker.join(timeout=1)
        server.server_close()
        server_extensions.close()


if __name__ == "__main__":
    main()
