#!/usr/bin/env python3
"""作家工作台 / Writer's Desk: local writing and SQLite storage."""
import argparse
import base64
import binascii
from contextlib import contextmanager
import errno
import hashlib
import json
import mimetypes
import os
import hmac
import sqlite3
import stat
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "writer.sqlite3"
DB_LOCK = threading.RLock()
MAX_REQUEST = 64 * 1024 * 1024
MAX_BOOK = 25 * 1024 * 1024
MAX_COVER = 2 * 1024 * 1024
DESKTOP_TOKEN = os.environ.get("WRITER_DESKTOP_TOKEN", "")
DEFAULT_EXAMPLE_MIGRATION = "default-tide-archive-v1"
FOLDER_MANIFEST = ".writer-desk-folder.json"
FOLDER_FILES = ("正文.txt", "作品.yejian.json")
FOLDER_WARNING = "作品已保存，但作品文件夹暂未同步。请重新打开文件夹后重试。"
FOLDER_CONFLICT = "作品文件夹中的导出文件已被修改或存在同名文件，未覆盖这些文件。请移走或改名后重试。"
FOLDER_UNSAFE = "作品文件夹路径异常，无法安全同步。请检查目录是否为符号链接。"
FOLDER_FAILURE = "无法同步作品文件夹，请检查磁盘空间和目录权限。作品仍已保存在本机。"
FOLDER_REQUEST = "打开作品文件夹只接受作品编号，不接受文件路径。"
FOLDER_UNSUPPORTED = "当前系统不支持安全打开作品文件夹。作品仍已保存在本机。"


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
    return {"id": book_id, "title": title, "kind": kind, "cover": "",
            "volumes": [first_volume(book_id)] if kind == "long" else [], "chapters": [],
            "notes": [], "outline": [], "relations": []}


def upgrade_book(book):
    """Add new fields without changing existing text, IDs or revisions."""
    book.setdefault("kind", "long")
    book.setdefault("cover", "")
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
    return book


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


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


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
                    conn.execute("CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,book_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,saved_at TEXT NOT NULL)")
                    conn.execute("CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)")
                    if not conn.execute("SELECT 1 FROM books LIMIT 1").fetchone():
                        insert_book(conn, sample_book())
                        insert_book(conn, sample_short())
                    install_default_example(conn)
                return
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


def validate_book(data):
    if not isinstance(data, dict):
        raise ValueError("作品格式不正确")
    result = {"id": checked_string(data.get("id"), "作品编号", 100, False),
              "title": checked_string(data.get("title"), "作品名称", 200, False)}
    result["kind"] = data.get("kind", "long")
    if result["kind"] not in ("long", "short"):
        raise ValueError("作品类型必须是长篇或短篇")
    result["cover"] = checked_cover(data.get("cover", ""))
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
        if not isinstance(items, list) or len(items) > 10000:
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
                     "body": checked_string(item.get("body"), "正文", 5_000_000), "deletedAt": deleted_at}
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
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_BOOK:
        raise ValueError("单部作品超过 25 MB，请拆分为多部作品")
    return result


def book_result(row):
    return {"book": upgrade_book(json.loads(row["payload"])), "revision": row["revision"], "updatedAt": row["updated_at"]}


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


class FolderExportError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status
        self.code = {FOLDER_CONFLICT: "FOLDER_CONFLICT", FOLDER_UNSAFE: "FOLDER_UNSAFE",
                     FOLDER_UNSUPPORTED: "FOLDER_UNSUPPORTED"}.get(message, "FOLDER_FAILURE")


def manuscript_text(book):
    """Follow authored volume/chapter order, excluding every recycled item."""
    volumes = [item for item in book["volumes"] if not item["deletedAt"]]
    deleted_volumes = {item["id"] for item in book["volumes"] if item["deletedAt"]}
    chapters = [item for item in book["chapters"] if not item["deletedAt"] and item["volumeId"] not in deleted_volumes]
    parts = [book["title"]]
    if book["kind"] == "long":
        volume_ids = {item["id"] for item in volumes}
        groups = [(volume["title"], [item for item in chapters if item["volumeId"] == volume["id"]]) for volume in volumes]
        groups.append(("未分卷", [item for item in chapters if item["volumeId"] not in volume_ids]))
    else:
        groups = [("", chapters)]
    for title, items in groups:
        if not items:
            continue
        if title:
            parts.append(title)
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
    backup = {"format": "yejian-backup", "version": 3, "exportedAt": updated_at, "book": book}
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
            if row is None:
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


class Handler(BaseHTTPRequestHandler):
    server_version = "WritersDesk/0.2"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "") not in ("200", "201", "304"):
            super().log_message(fmt, *args)

    def send_bytes(self, content, status=200, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
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
            if path == "/api/examples":
                manifest = ROOT / "examples" / "manifest.json"
                self.send_json({"examples": json.loads(manifest.read_text("utf-8")) if manifest.is_file() else []})
            elif path == "/api/books":
                with connect() as conn:
                    rows = conn.execute("SELECT * FROM books ORDER BY updated_at DESC").fetchall()
                result = []
                for row in rows:
                    book = upgrade_book(json.loads(row["payload"]))
                    chapters = [c for c in book["chapters"] if not c["deletedAt"]]
                    latest = next((c for c in reversed(chapters) if c["body"].strip()), chapters[-1] if chapters else None)
                    result.append({"id": book["id"], "title": book["title"], "kind": book["kind"], "cover": book["cover"],
                                   "volumeCount": sum(not v["deletedAt"] for v in book["volumes"]),
                                   "outlineCount": sum(not o["deletedAt"] for o in book["outline"]),
                                   "personCount": sum(not n["deletedAt"] and n["type"] == "人物" for n in book["notes"]),
                                   "chapterCount": len(chapters), "latestChapterTitle": latest["title"] if latest else "",
                                   "excerpt": next((c["body"][:100] for c in chapters if c["body"].strip()), ""),
                                   "charCount": sum(sum(not ch.isspace() for ch in c["body"]) for c in chapters),
                                   "updatedAt": row["updated_at"]})
                self.send_json({"books": result})
            elif path.startswith("/api/books/"):
                with connect() as conn:
                    row = conn.execute("SELECT * FROM books WHERE id=?", (path[len("/api/books/"):],)).fetchone()
                self.send_json(book_result(row) if row else {"error": "找不到这部作品"}, 200 if row else 404)
            elif path.startswith("/api/"):
                self.send_json({"error": "找不到这个操作"}, 404)
            else:
                files = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/story-analysis.js": "story-analysis.js",
                         "/atlas-layout.js": "atlas-layout.js", "/atlas-ui.js": "atlas-ui.js", "/atlas.css": "atlas.css", "/outline.css": "outline.css",
                         "/vendor/dagre.min.js": "vendor/dagre.min.js",
                         "/workspace.js": "workspace.js", "/i18n.js": "i18n.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg"}
                filename = files.get(path)
                if not filename:
                    self.send_json({"error": "找不到这个页面"}, 404)
                    return
                content = (ROOT / "public" / filename).read_bytes()
                content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                self.send_bytes(content, content_type=content_type + ("; charset=utf-8" if filename.endswith((".html", ".css", ".js", ".svg")) else ""))
        except Exception as exc:
            print(f"读取失败: {exc}", file=sys.stderr)
            self.send_json({"error": "读取失败，原有文件仍保留在本机"}, 500)

    def do_POST(self):
        try:
            data = self.read_json()
            path = unquote(urlparse(self.path).path)
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
            elif path == "/api/import":
                if not isinstance(data, dict) or data.get("format") != "yejian-backup" or type(data.get("version")) is not int or data.get("version") not in (1, 2, 3):
                    raise ValueError("请选择作家工作台导出的完整备份文件（v1、v2 或 v3）")
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
            self.send_json({"book": book, "revision": 1, "updatedAt": now()}, 201)
        except FolderExportError as exc:
            self.send_json({"error": str(exc), "code": exc.code}, exc.status)
        except (ValueError, TypeError, AttributeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, 403)
        except Exception as exc:
            print(f"新建失败: {exc}", file=sys.stderr)
            self.send_json({"error": "无法写入本机，请检查磁盘空间后重试"}, 500)

    def do_PUT(self):
        try:
            data = self.read_json()
            path = unquote(urlparse(self.path).path)
            if not path.startswith("/api/books/"):
                self.send_json({"error": "找不到这个操作"}, 404)
                return
            book_id = path[len("/api/books/"):]
            book = validate_book(data.get("book"))
            if book["id"] != book_id or type(data.get("revision")) is not int:
                raise ValueError("作品编号或保存版本不正确")
            with DB_LOCK, connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
                if not row:
                    self.send_json({"error": "找不到这部作品"}, 404)
                    return
                if row["revision"] != data["revision"]:
                    self.send_json({"error": "另一个窗口修改了这部作品。本页内容已保留，请另存为新作品。", "conflict": True}, 409)
                    return
                stamp = now()
                conn.execute("INSERT INTO history(book_id,revision,payload,saved_at) VALUES(?,?,?,?)", (book_id, row["revision"], row["payload"], stamp))
                conn.execute("DELETE FROM history WHERE book_id=? AND id NOT IN (SELECT id FROM history WHERE book_id=? ORDER BY id DESC LIMIT 30)", (book_id, book_id))
                conn.execute("UPDATE books SET title=?,payload=?,revision=revision+1,updated_at=? WHERE id=?", (book["title"], json.dumps(book, ensure_ascii=False), stamp, book_id))
            result = {"revision": row["revision"] + 1, "updatedAt": stamp}
            try:
                sync_book_folder(book_id)
            except Exception as exc:
                result["folderWarning"] = FOLDER_WARNING
                try:
                    print(f"作品文件夹同步失败: {exc}", file=sys.stderr)
                except (OSError, ValueError):
                    pass  # Logging cannot invalidate an already committed save.
            self.send_json(result)
        except (ValueError, TypeError, AttributeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except PermissionError as exc:
            self.send_json({"error": str(exc)}, 403)
        except Exception as exc:
            print(f"保存失败: {exc}", file=sys.stderr)
            self.send_json({"error": "暂时无法保存，编辑内容仍留在本页。请重试或下载备份。"}, 500)


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
                with sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True) as old:
                    if not old.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='books'").fetchone():
                        continue
                    with sqlite3.connect(temporary) as fresh:
                        old.backup(fresh)
                temporary.replace(DB_PATH)
                print("已复制旧版作品库，原数据库仍保留。", file=sys.stderr, flush=True)
                break
            finally:
                if temporary.exists():
                    temporary.unlink()
    initialize()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
