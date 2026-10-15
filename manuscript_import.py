"""Offline manuscript import. Parsing is pure: preview never writes a library.

Only document text and heading styles are read from DOCX. ZIP members are never
extracted, relationships are never fetched, and macros/embedded objects are not
executed. Callers reparse the original bytes on confirmation before inserting a
new book; preview dictionaries must not be accepted as authoritative manuscripts.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import uuid
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

MAX_FILE = 12 * 1024 * 1024
MAX_FILE_BYTES = MAX_FILE
MAX_TEXT = 7 * 1024 * 1024
MAX_XML = 24 * 1024 * 1024
MAX_TOTAL = 48 * 1024 * 1024
MAX_ITEMS = 10000
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NUM = r"[零〇一二两三四五六七八九十百千万亿0-9０-９]+"
HEADING_TAIL = r"(?:[^。！？!?；;\r\n]{0,100})"
VOLUME = re.compile(r"^第\s*" + NUM + r"\s*卷" + HEADING_TAIL + r"$")
CHAPTER = re.compile(r"^第\s*" + NUM + r"\s*[章节回]" + HEADING_TAIL + r"$")


def _title(value, label="标题"):
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(char) < 32 for char in value):
        raise ValueError(label + "不能为空、包含控制字符或超过 200 字")
    return value.strip()


def checked_options(options=None):
    options = {} if options is None else options
    if not isinstance(options, dict) or set(options) - {"strategy", "encoding"}:
        raise ValueError("稿件导入选项不正确")
    result = {"strategy": options.get("strategy", "auto"), "encoding": options.get("encoding", "auto")}
    if result["strategy"] not in ("auto", "chinese", "headings", "single") or result["encoding"] not in ("auto", "utf-8", "utf-16", "gb18030"):
        raise ValueError("不支持这个分章策略或文字编码")
    return result


def _decode(content, requested):
    if requested != "auto":
        candidates = ["utf-8-sig" if requested == "utf-8" else requested]
    elif content.startswith((b"\xff\xfe", b"\xfe\xff")):
        candidates = ["utf-16"]
    else:
        candidates = ["utf-8-sig", "gb18030"]
    for encoding in candidates:
        try:
            text = content.decode(encoding)
            if any(ord(char) < 32 and char not in "\t\n\r\f" for char in text):
                continue
            return text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n"), encoding
        except UnicodeError:
            continue
    raise ValueError("无法识别稿件文字编码，请选择 UTF-8、UTF-16 或 GB18030 后重新预览")


def _xml(content):
    if len(content) > MAX_XML:
        raise ValueError("Word 正文 XML 过大")
    # Decode XML before checking declarations, covering UTF-16 as well as UTF-8.
    try:
        text = content.decode("utf-16" if content.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
        if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
            raise ValueError("Word 文件包含不支持的 XML 声明")
        return ET.fromstring(text)
    except (UnicodeError, ET.ParseError):
        raise ValueError("Word 文件正文 XML 已损坏") from None


def _paragraph(node):
    parts = []
    for item in node.iter():
        if item.tag == W + "t":
            parts.append(item.text or "")
        elif item.tag == W + "tab":
            parts.append("\t")
        elif item.tag in (W + "br", W + "cr"):
            parts.append("\n")
    return "".join(parts)


def _docx(content):
    warnings = ["Word 中的图片、批注和排版不导入，仅保留正文、表格文字与分卷分章。"]
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries, names, total = archive.infolist(), set(), 0
            if len(entries) > 2000:
                raise ValueError("Word 文件包含过多内部文件")
            for entry in entries:
                name = entry.filename
                if name in names or "\\" in name or name.startswith("/") or ".." in PurePosixPath(name).parts or entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Word 文件内部路径或压缩格式不安全")
                names.add(name)
                total += entry.file_size
                if total > MAX_TOTAL or entry.file_size > MAX_XML or entry.file_size > max(1, entry.compress_size) * 1000:
                    raise ValueError("Word 解压后的内容过大")
                if name.lower().endswith("vbaproject.bin"):
                    raise ValueError("请另存为不含宏的 .docx 文件后导入")
            if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                raise ValueError("请选择有效的 Word .docx 文件")
            document = _xml(archive.read("word/document.xml"))
            style_levels = {}
            if "word/styles.xml" in names:
                for style in _xml(archive.read("word/styles.xml")).findall(W + "style"):
                    style_id = style.get(W + "styleId", "")
                    name = style.find(W + "name")
                    label = name.get(W + "val", "") if name is not None else ""
                    level = style.find(".//" + W + "outlineLvl")
                    match = re.fullmatch(r"(?:heading|标题)\s*([1-9])", label, re.I)
                    if level is not None and level.get(W + "val", "").isdigit() and int(level.get(W + "val")) < 9:
                        style_levels[style_id] = int(level.get(W + "val")) + 1
                    elif match:
                        style_levels[style_id] = int(match[1])
            body = document.find(W + "body")
            if body is None:
                raise ValueError("Word 文件没有正文")
            rows, detected_title, in_toc = [], None, False
            for node in body:
                # A content control explicitly marked as a Word TOC is metadata.
                if node.tag == W + "sdt":
                    gallery = node.find(".//" + W + "docPartGallery")
                    if gallery is not None and gallery.get(W + "val", "").lower() in ("table of contents", "目录"):
                        continue
                    paragraphs = node.findall(".//" + W + "p")
                elif node.tag == W + "tbl":
                    for row in node.findall(W + "tr"):
                        cells = ["\n".join(_paragraph(p) for p in cell.findall(".//" + W + "p")) for cell in row.findall(W + "tc")]
                        rows.append({"text": "\t".join(cells), "level": None})
                    continue
                elif node.tag == W + "p":
                    paragraphs = [node]
                else:
                    continue
                for paragraph in paragraphs:
                    style_node = paragraph.find("./" + W + "pPr/" + W + "pStyle")
                    style = style_node.get(W + "val", "") if style_node is not None else ""
                    text = _paragraph(paragraph)
                    level = style_levels.get(style)
                    if level is None:
                        match = re.fullmatch(r"Heading([1-9])", style, re.I)
                        level = int(match[1]) if match else None
                    direct_level = paragraph.find("./" + W + "pPr/" + W + "outlineLvl")
                    if direct_level is not None and direct_level.get(W + "val", "").isdigit() and int(direct_level.get(W + "val")) < 9:
                        level = int(direct_level.get(W + "val")) + 1
                    if style.lower() in ("toctitle", "contentsheading"):
                        in_toc = True
                        continue
                    if re.fullmatch(r"toc\s*[1-9]", style, re.I):
                        continue
                    if in_toc and paragraph.findall(W + "hyperlink") and not level:
                        continue
                    if text.strip():
                        in_toc = False
                    if style.lower() == "title" and detected_title is None and not any(row["text"].strip() for row in rows) and text.strip():
                        detected_title = text.strip()
                        continue
                    rows.append({"text": text, "level": level})
            return rows, detected_title, warnings
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, NotImplementedError, OSError, EOFError):
        raise ValueError("Word 文件已损坏或使用了不支持的压缩格式") from None


def _text_rows(text, markdown):
    rows, fence = [], None
    for line in text.split("\n"):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line) if markdown else None
        if marker:
            if fence is None:
                fence = marker[1][0]
            elif fence == marker[1][0]:
                fence = None
            rows.append({"text": line, "level": None})
            continue
        match = re.match(r"^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$", line) if markdown and fence is None else None
        rows.append({"text": line, "heading": match[2] if match else None, "level": len(match[1]) if match else None, "literal": fence is not None or bool(marker)})
    # Setext headings are deliberately limited to a nonempty preceding line.
    if markdown:
        for index in range(1, len(rows)):
            if not rows[index].get("literal") and re.fullmatch(r" {0,3}(?:={3,}|-{3,})[ \t]*", rows[index]["text"]) and rows[index-1]["text"].strip() and not rows[index-1].get("literal") and not rows[index-1]["level"]:
                rows[index-1]["heading"] = rows[index-1]["text"].strip()
                rows[index-1]["level"] = 1 if rows[index]["text"].strip().startswith("=") else 2
                rows[index]["setext"] = index - 1
    return rows


def _words(text):
    return sum(not char.isspace() for char in text)


def prepare_import(content, filename, kind="long", title=None, options=None, edits=None):
    """Return deterministic preview keys, source digest and editable structure."""
    if not isinstance(content, bytes) or not content or len(content) > MAX_FILE:
        raise ValueError("请选择不超过 12 MB 的非空稿件")
    if not isinstance(filename, str) or not filename or len(filename) > 250 or any(char in filename for char in "\\/\x00"):
        raise ValueError("稿件文件名不正确")
    extension = PurePosixPath(filename).suffix.lower()
    if extension not in (".docx", ".txt", ".md", ".markdown"):
        raise ValueError("仅支持 Word .docx、TXT 或 Markdown 稿件")
    if kind not in ("long", "short"):
        raise ValueError("作品类型必须是长篇或短篇")
    if title is not None and not isinstance(title, str):
        raise ValueError("作品名称格式不正确")
    options = checked_options(options)
    if extension == ".docx":
        rows, detected_title, warnings = _docx(content)
        encoding = "docx"
    else:
        text, encoding = _decode(content, options["encoding"])
        rows, detected_title, warnings = _text_rows(text, extension != ".txt"), None, []
    if sum(len(row["text"]) for row in rows) > MAX_TEXT:
        raise ValueError("稿件正文过长，请拆分后导入")
    fallback_title = PurePosixPath(filename).stem[:200] or "导入作品"
    heading_rows = [(index, row) for index, row in enumerate(rows) if row.get("level")]
    # A sole leading top-level Markdown heading is the book title, while
    # repeated top-level headings remain authored volume/chapter headings.
    if extension in (".md", ".markdown") and detected_title is None and heading_rows:
        index, first = heading_rows[0]
        if first["level"] == 1 and not any(row["text"].strip() for row in rows[:index]) and all(row["level"] > 1 for _, row in heading_rows[1:]) and (len(heading_rows) > 1 or kind == "short"):
            detected_title = first.get("heading") or first["text"].strip()
            first["bookTitle"] = True
            if index + 1 < len(rows) and "setext" in rows[index+1]:
                rows[index+1]["bookTitle"] = True
    title = _title(title.strip() if isinstance(title, str) and title.strip() else detected_title or fallback_title, "作品名称")
    # The app's TXT export begins with its exact title, not an inferred short
    # paragraph. Everything else before a structural heading is kept as preface.
    first_nonempty = next((row for row in rows if row["text"].strip()), None)
    if extension == ".txt" and first_nonempty and first_nonempty["text"].strip() in (title, fallback_title):
        first_nonempty["bookTitle"] = True
    if not any(row["text"].strip() for row in rows if not row.get("bookTitle")):
        raise ValueError("稿件没有可导入的正文")
    if kind == "short":
        body = "\n".join(row["text"] for row in rows if not row.get("bookTitle")).strip("\n")
        chapters, volumes = [{"key": "c0", "title": "正文", "volumeKey": None, "body": body}], []
    else:
        structural_rows = [row for row in rows if row.get("level") and not row.get("bookTitle")]
        has_chinese_structure = options["strategy"] in ("auto", "chinese") and any(not row.get("literal") and (VOLUME.fullmatch((row.get("heading") or row["text"]).strip()) or CHAPTER.fullmatch((row.get("heading") or row["text"]).strip())) for row in rows)
        levels = sorted({row["level"] for row in structural_rows})
        has_hierarchy = len(levels) > 1
        chapters, volumes, current, volume_key, pending = [], [], None, None, []

        def flush():
            nonlocal current, pending
            body = "\n".join(pending).strip("\n")
            if current is not None or body.strip():
                chapters.append({"key": "c" + str(len(chapters)), "title": current or ("前言" if chapters or structural_rows or has_chinese_structure else "正文"), "volumeKey": volume_key, "body": body})
                if len(chapters) > MAX_ITEMS:
                    raise ValueError("稿件章节超过 10000 个")
            current, pending = None, []

        for row in rows:
            if row.get("bookTitle"):
                continue
            raw, level = row["text"], row.get("level")
            heading = (row.get("heading") or raw).strip()
            structural = None
            if options["strategy"] != "single" and not row.get("literal") and len(heading) <= 200:
                if options["strategy"] in ("auto", "chinese"):
                    structural = "volume" if VOLUME.fullmatch(heading) else "chapter" if CHAPTER.fullmatch(heading) else None
                if structural is None and level and options["strategy"] in ("auto", "headings"):
                    structural = "volume" if has_hierarchy and level == levels[0] else "chapter"
            if structural:
                row["recognized"] = True
                flush()
                if structural == "volume":
                    volume_key = "v" + str(len(volumes))
                    volumes.append({"key": volume_key, "title": _title(heading)})
                    if len(volumes) > MAX_ITEMS:
                        raise ValueError("稿件分卷超过 10000 个")
                else:
                    current = _title(heading)
            elif "setext" not in row or not rows[row["setext"]].get("recognized"):
                pending.append(raw)
        flush()
        if not chapters:
            raise ValueError("稿件没有可导入的正文")
        if options["strategy"] != "single" and len(chapters) == 1 and chapters[0]["title"] == "正文":
            warnings.append("未识别到分章标题，稿件将作为一章导入。")
    edits = {} if edits is None else edits
    if not isinstance(edits, dict) or set(edits) - {"volumes", "chapters"}:
        raise ValueError("导入标题修改格式不正确")
    for label, items in (("volumes", volumes), ("chapters", chapters)):
        changes = edits.get(label, {})
        if not isinstance(changes, dict) or set(changes) - {item["key"] for item in items} or kind == "short" and changes:
            raise ValueError("导入结构已经变化，请重新预览")
        for item in items:
            if item["key"] in changes:
                item["title"] = _title(changes[item["key"]])
    for chapter in chapters:
        if kind == "long" and len(chapter["body"]) > 5_000_000:
            raise ValueError("单章正文超过 500 万字，请调整分章策略")
        chapter["words"] = _words(chapter["body"])
    preview = {"sourceHash": hashlib.sha256(content).hexdigest(), "filename": filename, "format": extension[1:], "encoding": encoding, "kind": kind, "title": title, "options": options, "volumes": volumes, "chapters": chapters, "words": sum(chapter["words"] for chapter in chapters), "warnings": warnings}
    if len(json.dumps(preview, ensure_ascii=False).encode("utf-8")) > 24 * 1024 * 1024:
        raise ValueError("导入后的作品超过可保存大小，请拆分稿件")
    return preview


def make_book(preview):
    """Build a fresh book from a trusted server-generated preview only."""
    volume_ids = {item["key"]: uuid.uuid4().hex for item in preview["volumes"]}
    return {"id": uuid.uuid4().hex, "title": preview["title"], "kind": preview["kind"], "cover": "", "coverTemplate": "", "notes": [], "outline": [], "relations": [],
            "volumes": [{"id": volume_ids[item["key"]], "title": item["title"], "summary": "", "deletedAt": None} for item in preview["volumes"]],
            "chapters": [{"id": uuid.uuid4().hex, "title": item["title"], "body": item["body"], "volumeId": volume_ids.get(item["volumeKey"]), "deletedAt": None} for item in preview["chapters"]]}
