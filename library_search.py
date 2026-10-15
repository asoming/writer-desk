"""Bounded, read-only literal search across active works in the local library."""
import json
import re
from urllib.parse import parse_qs, urlparse

MAX_RESULTS = 200
MAX_QUERY = 200
MAX_SCAN_UNITS = 64 * 1024 * 1024


def _fields(book):
    yield "book", book, "title", book.get("title", "")
    for key, category in (("chapters", "chapter"), ("outline", "outline"),
                          ("notes", "note"), ("relations", "relation")):
        for item in book.get(key, []):
            if item.get("deletedAt"):
                continue
            kind = "person" if category == "note" and item.get("type") == "人物" else category
            for field in ("title", "label", "body", "stage"):
                value = item.get(field)
                if isinstance(value, str):
                    yield kind, item, field, value
            for field in ("aliases",):
                for value in item.get(field, []):
                    if isinstance(value, str):
                        yield kind, item, field, value
            profile = item.get("profile", {})
            if isinstance(profile, dict):
                for field, value in profile.items():
                    if isinstance(value, str):
                        yield kind, item, "profile." + field, value
    for kind, key in (("foreshadow", "foreshadows"), ("timeline", "timeline")):
        for item in book.get("storyTools", {}).get(key, []):
            if item.get("deletedAt"):
                continue
            for field in ("title", "body", "storyTime"):
                value = item.get(field)
                if isinstance(value, str):
                    yield kind, item, field, value
    for item in book.get("assetLibrary", {}).get("items", []):
        if item.get("deletedAt"):
            continue
        for field in ("name", "excerpt"):
            value = item.get(field)
            if isinstance(value, str):
                yield "asset", item, field, value


def search_books(books, query, *, limit=MAX_RESULTS, case_sensitive=False):
    """Books may be a generator. No regex syntax or replacement is accepted.

    Only bounded excerpts leave this helper; offsets are textarea UTF-16 units.
    Each field yields at most five matches so one chapter cannot bury the rest
    of the library. A budget exhaustion is explicit rather than a false empty.
    """
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY:
        raise ValueError("查找文字须为 1 至 200 字。")
    if type(limit) is not int or not 1 <= limit <= MAX_RESULTS:
        raise ValueError("搜索结果数量不正确。")
    expression = re.compile(re.escape(query), 0 if case_sensitive else re.IGNORECASE)
    result, scanned, truncated = [], 0, False
    for book in books:
        if book.get("deletedAt"):
            continue
        for kind, item, field, text in _fields(book):
            scanned += len(text)
            if scanned > MAX_SCAN_UNITS:
                truncated = True
                break
            matches = expression.finditer(text)
            for index, match in enumerate(matches):
                if index >= 5:
                    truncated = True
                    break
                if len(result) >= limit:
                    return {"query": query, "results": result, "truncated": True, "limit": limit}
                start, end = match.span()
                result.append({"bookId": book["id"], "bookTitle": book.get("title", ""),
                               "bookKind": book.get("kind", "long"), "type": kind,
                               "id": item["id"], "title": item.get("title", item.get("label", item.get("name", ""))),
                               "field": field,
                               "start": len(text[:start].encode("utf-16-le")) // 2,
                               "end": len(text[:end].encode("utf-16-le")) // 2,
                               "before": text[max(0, start - 50):start],
                               "text": match.group(), "after": text[end:end + 70]})
        if scanned > MAX_SCAN_UNITS:
            break
    return {"query": query, "results": result, "truncated": truncated, "limit": limit}


def read(srv, path):
    """Call from authenticated GET dispatch with the *full* request path."""
    parsed = urlparse(path)
    if parsed.path != "/api/library-search":
        return None
    parameters = parse_qs(parsed.query, keep_blank_values=True)
    if set(parameters) - {"q", "caseSensitive"} or any(len(values) != 1 for values in parameters.values()):
        raise ValueError("搜索参数不正确。")
    case = parameters.get("caseSensitive", ["0"])[0]
    if case not in {"0", "1"}:
        raise ValueError("搜索参数不正确。")
    with srv.DB_LOCK, srv.connect() as conn:
        rows = conn.execute("SELECT payload FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC")
        return search_books((srv.upgrade_book(json.loads(row[0])) for row in rows),
                            parameters.get("q", [""])[0], case_sensitive=case == "1")
