"""Book-local proofreading dictionary and durable manuscript anchors.

Offsets are UTF-16 code units, matching textarea selectionStart/selectionEnd.
Recycled chapters keep their marks for recovery. Permanent chapter deletion must
call sanitize with the original book so no quoted text from a purged short-story
section survives in annotations, bookmarks, or their surrounding context.
"""
import copy
from bisect import bisect_left, bisect_right
from datetime import datetime

MAX_MARKS = 5000
MAX_DICTIONARY = 500
MAX_QUOTE_UNITS = 20000
CONTEXT_UNITS = 64
MAX_OFFSET = 50_000_000


def defaults():
    return {"version": 1, "dictionary": [], "annotations": [], "bookmarks": []}


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def utf16_slice(value, start, end):
    try:
        encoded = value if isinstance(value, bytes) else value.encode("utf-16-le")
        return encoded[start * 2:end * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def context_at(body, start, end):
    """Use bounded byte slices; never decode a whole prefix per mark."""
    encoded = body if isinstance(body, bytes) else body.encode("utf-16-le")
    prefix = encoded[max(0, start - CONTEXT_UNITS) * 2:start * 2]
    suffix = encoded[end * 2:(end + CONTEXT_UNITS) * 2]
    try:
        left = prefix.decode("utf-16-le")
    except UnicodeDecodeError:
        left = prefix[2:].decode("utf-16-le")
    try:
        right = suffix.decode("utf-16-le")
    except UnicodeDecodeError:
        right = suffix[:-2].decode("utf-16-le")
    return left, right


def _chapters(book):
    return {item["id"]: item for item in book.get("chapters", []) if isinstance(item, dict) and isinstance(item.get("id"), str)}


def _text(value, label, maximum, allow_empty=True):
    if (not isinstance(value, str) or len(value) > maximum
            or any(0xD800 <= ord(char) <= 0xDFFF for char in value)
            or (not allow_empty and not value.strip())):
        raise ValueError(label + "格式不正确或长度超出限制")
    return value


def _date(value):
    value = _text(value, "批注日期", 100, False)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, OverflowError) as exc:
        raise ValueError("批注日期须含时区") from exc
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("批注日期须含时区")
    return value


def validate(book, source=None):
    """Whitelist extension fields after chapters have been validated/migrated."""
    raw = (book if source is None else source).get("reviewTools", defaults())
    if not isinstance(raw, dict) or type(raw.get("version", 1)) is not int or raw.get("version", 1) != 1:
        raise ValueError("批注与校对数据版本不正确")
    dictionary = raw.get("dictionary", [])
    if not isinstance(dictionary, list) or len(dictionary) > MAX_DICTIONARY:
        raise ValueError("自定义词典最多保存 500 个词")
    clean = defaults()
    for value in dictionary:
        word = _text(value, "词典词语", 100, False).strip()
        if word not in clean["dictionary"]:
            clean["dictionary"].append(word)
    chapters = _chapters(book)
    encoded_chapters = {identity: chapter.get("body", "").encode("utf-16-le") for identity, chapter in chapters.items()}
    seen = set()
    for key in ("annotations", "bookmarks"):
        records = raw.get(key, [])
        if not isinstance(records, list) or len(records) > MAX_MARKS:
            raise ValueError("批注或书签最多保存 5000 条")
        for item in records:
            if not isinstance(item, dict):
                raise ValueError("批注或书签格式不正确")
            identity = _text(item.get("id"), "批注编号", 100, False)
            if identity in seen:
                raise ValueError("批注或书签编号重复")
            seen.add(identity)
            chapter_id = _text(item.get("chapterId"), "关联正文编号", 100, False)
            if chapter_id not in chapters:
                raise ValueError("批注或书签须关联本作品正文")
            start, end = item.get("start"), item.get("end")
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= MAX_OFFSET:
                raise ValueError("批注或书签位置不正确")
            quote = _text(item.get("quote"), "原文", MAX_QUOTE_UNITS, False)
            if utf16_length(quote) > MAX_QUOTE_UNITS:
                raise ValueError("批注原文最多 20000 字符")
            prefix = _text(item.get("prefix", ""), "原文前文", CONTEXT_UNITS)
            suffix = _text(item.get("suffix", ""), "原文后文", CONTEXT_UNITS)
            if utf16_length(prefix) > CONTEXT_UNITS or utf16_length(suffix) > CONTEXT_UNITS:
                raise ValueError("批注定位上下文过长")
            status = item.get("status", "linked")
            if status not in ("linked", "orphaned"):
                raise ValueError("批注定位状态不正确")
            resolved = item.get("resolved", False)
            if type(resolved) is not bool:
                raise ValueError("批注解决状态不正确")
            record = {"id": identity, "chapterId": chapter_id, "start": start, "end": end,
                      "quote": quote, "prefix": prefix, "suffix": suffix,
                      "body": _text(item.get("body", ""), "批注内容", 10000),
                      "label": _text(item.get("label", ""), "书签名称", 200),
                      "resolved": resolved, "status": status,
                      "createdAt": _date(item.get("createdAt")), "updatedAt": _date(item.get("updatedAt"))}
            body = encoded_chapters[chapter_id]
            if status == "linked" and utf16_slice(body, start, end) != quote:
                # Imports/history may contain a stale offset. Do not silently
                # attach to another occurrence of a repeated sentence.
                record.update(status="orphaned", prefix="", suffix="")
            elif status == "linked":
                record["prefix"], record["suffix"] = context_at(body, start, end)
            clean[key].append(record)
    book["reviewTools"] = clean
    return book


def normalize(book):
    """Upgrade trusted saved books; retain recycled marks, hide stale anchors."""
    tools = book.setdefault("reviewTools", defaults())
    if not isinstance(tools, dict):
        return book  # validate reports malformed imported fields separately.
    for key, value in defaults().items():
        tools.setdefault(key, value)
    chapters = _chapters(book)
    encoded_chapters = {identity: chapter.get("body", "").encode("utf-16-le") for identity, chapter in chapters.items()}
    aliases = {item.get("id") for item in book.get("shortSections", [])} if book.get("kind") == "short" else set()
    for key in ("annotations", "bookmarks"):
        if not isinstance(tools.get(key), list):
            continue
        tools[key] = [item for item in tools[key] if isinstance(item, dict) and (item.get("chapterId") in chapters or item.get("chapterId") in aliases)]
        for item in tools[key]:
            if item.get("status", "linked") != "linked" or item.get("chapterId") not in encoded_chapters:
                continue
            start, end = item.get("start"), item.get("end")
            if (type(start) is not int or type(end) is not int or not 0 <= start < end
                    or utf16_slice(encoded_chapters[item["chapterId"]], start, end) != item.get("quote")):
                item.update(status="orphaned", prefix="", suffix="")
    return book


def remap_short_links(book, aliases, manuscript_id, recycled=(), offsets=None):
    """Join old short-story chapter anchors with exact UTF-16 offsets once.

    The caller computes offsets before joining body strings. Alias locations
    can also be read from shortSections. Missing offsets are explicitly invalid.
    The existing manuscript ID already addresses combined offsets on a second
    normalize call and must never be shifted again.
    """
    offsets = offsets or {}
    positions = {item["id"]: item.get("start", 0) for item in book.get("shortSections", [])}
    positions.update(offsets)
    tools = book.get("reviewTools", {})
    if not isinstance(tools, dict):
        return book  # Preserve malformed data so validate can reject it cleanly.
    for key in ("annotations", "bookmarks"):
        records = tools.get(key, [])
        if not isinstance(records, list):
            continue
        for item in records:
            if not isinstance(item, dict):
                continue
            source = item.get("chapterId")
            if not isinstance(source, str) or source == manuscript_id or source not in aliases or source in recycled:
                continue
            item["chapterId"] = manuscript_id
            offset = positions.get(source)
            if type(offset) is int and offset >= 0 and type(item.get("start")) is int and type(item.get("end")) is int:
                item["start"] += offset
                item["end"] += offset
            else:
                item.update(status="orphaned", prefix="", suffix="")
    return book


def _removed_ranges(before, chapter_ids):
    # Match chapter_history._short_ranges exactly, including old aliases whose
    # saved range ended inside an emoji pair. The actual purge rounds outward.
    active = next((item for item in before.get("chapters", []) if not item.get("deletedAt")), None)
    if active is None:
        return []
    boundaries, units = [0], 0
    for char in active.get("body", ""):
        units += 2 if ord(char) > 0xffff else 1
        boundaries.append(units)
    spans = []
    for item in before.get("shortSections", []):
        if item.get("id") not in chapter_ids:
            continue
        start, end = max(0, min(item["start"], units)), max(0, min(item["end"], units))
        start = boundaries[bisect_right(boundaries, start) - 1]
        end = boundaries[bisect_left(boundaries, end)]
        if start < end:
            spans.append((start, end))
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def sanitize(book, chapter_ids, replacements=None, before=None):
    """Remove all quoted material attributable to permanently removed bodies.

    With a combined legacy short story, keep unrelated marks by mapping their
    UTF-16 ranges around the removed section. Overlapping or already detached
    marks in that manuscript are removed because their quote may be private
    removed text. Context for remaining marks is regenerated from clean text.
    """
    result = copy.deepcopy(book)
    replacements = replacements or {}
    before = before or book
    old_chapters = _chapters(before)
    chapters = _chapters(result)
    old_encoded = {identity: chapter.get("body", "").encode("utf-16-le") for identity, chapter in old_chapters.items()}
    new_encoded = {identity: chapter.get("body", "").encode("utf-16-le") for identity, chapter in chapters.items()}
    spans = _removed_ranges(before, chapter_ids) if before.get("kind") == "short" else []
    old_owner = next((item for item in before.get("chapters", []) if not item.get("deletedAt")), None)
    owner_id = old_owner.get("id") if old_owner else None
    def adjusted(offset):
        return offset - sum(max(0, min(offset, end) - start) for start, end in spans if start < offset)
    tools = result.get("reviewTools", {})
    for key in ("annotations", "bookmarks"):
        kept = []
        for item in tools.get(key, []):
            old_id = item.get("chapterId")
            target = replacements.get(old_id, old_id)
            if old_id in chapter_ids and old_id not in replacements or target not in chapters:
                continue
            if spans and old_id == owner_id:
                start, end = item.get("start"), item.get("end")
                if (item.get("status", "linked") != "linked" or type(start) is not int or type(end) is not int
                        or any(start < cut_end and end > cut_start for cut_start, cut_end in spans)
                        or utf16_slice(old_encoded[old_id], start, end) != item.get("quote")):
                    continue
                item.update(start=adjusted(start), end=adjusted(end))
            item["chapterId"] = target
            body = new_encoded[target]
            if item.get("status", "linked") == "linked":
                if utf16_slice(body, item["start"], item["end"]) != item.get("quote"):
                    # Never retain a stale quote from a newly purged short range.
                    if spans and old_id == owner_id:
                        continue
                    item.update(status="orphaned", prefix="", suffix="")
                else:
                    item["prefix"], item["suffix"] = context_at(body, item["start"], item["end"])
            kept.append(item)
        tools[key] = kept
    return result
