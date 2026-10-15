"""Local, source-linked writing memory; no provider calls or disk writes.

Automatic memories are extracts, not invented facts. Author overrides live in
the book, are fingerprinted to their source, and become visibly stale on edits.
The request retrieves additional memories without truncating selected sources.
"""
import hashlib
import re


def source_hash(chapter):
    return hashlib.sha256((chapter.get("title", "") + "\n" + chapter.get("body", "")).encode("utf-8")).hexdigest()


def validate_memory(value, book=None):
    if value is None:
        return {"version": 1, "enabled": True, "entries": []}
    if not isinstance(value, dict) or set(value) - {"version", "enabled", "entries"} or type(value.get("version")) is not int or value.get("version") != 1 or type(value.get("enabled")) is not bool:
        raise ValueError("长篇记忆格式不正确")
    entries = value.get("entries", [])
    if not isinstance(entries, list) or len(entries) > 10000:
        raise ValueError("长篇记忆数量不正确")
    known = {chapter["id"] for chapter in book.get("chapters", [])} if book else None
    clean, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"chapterId", "sourceHash", "summary", "characterStates", "settingNotes"}:
            raise ValueError("章节记忆格式不正确")
        chapter_id = entry["chapterId"]
        if not isinstance(chapter_id, str) or not 1 <= len(chapter_id) <= 100 or chapter_id in seen or known is not None and chapter_id not in known:
            raise ValueError("章节记忆来源不正确")
        if not isinstance(entry["sourceHash"], str) or not re.fullmatch(r"[a-f0-9]{64}", entry["sourceHash"]):
            raise ValueError("章节记忆指纹不正确")
        if any(not isinstance(entry[field], str) or len(entry[field]) > 4000 for field in ("summary", "characterStates", "settingNotes")):
            raise ValueError("章节记忆内容过长或格式不正确")
        clean.append(dict(entry))
        seen.add(chapter_id)
    return {"version": 1, "enabled": value["enabled"], "entries": clean}


def _sentences(body):
    # Keep whole short quotations where possible; long lines are excerpted.
    return [line.strip() for line in re.split(r"(?<=[。！？.!?])\s*|[\r\n]+", body) if line.strip()]


def _extract(lines, budget):
    chosen, count = [], 0
    for line in lines:
        take = line[:max(0, budget - count)]
        if take:
            chosen.append(take)
            count += len(take) + 1
        if count >= budget:
            break
    return "\n".join(chosen)


def memory_index(book):
    configuration = validate_memory(book.get("storyMemory"), book)
    overrides = {entry["chapterId"]: entry for entry in configuration["entries"]}
    people = [person for person in book.get("notes", []) if person.get("type") == "人物" and not person.get("deletedAt")]
    settings = [item for item in book.get("outline", []) if not item.get("deletedAt") and (item.get("category") == "世界设定" or item.get("kind") == "setting")]
    entries = []
    for chapter in book.get("chapters", []):
        if chapter.get("deletedAt"):
            continue
        sentences = _sentences(chapter.get("body", ""))
        # Opening and ending preserve plot setup and the latest recorded state.
        summary = _extract(sentences[:3], 360)
        ending = _extract(sentences[-3:], 360)
        if ending and ending not in summary:
            summary = summary + ("\n…\n" if summary else "") + ending
        states = []
        for person in people:
            names = [person.get("title", ""), *person.get("aliases", [])]
            relevant = [line for line in reversed(sentences) if any(name and name in line for name in names)]
            if relevant:
                states.append(person.get("title", "") + "：" + relevant[0][:160])
        setting_quotes = [line for line in sentences if any(word in line for word in ("规则", "只有", "必须", "不能", "禁止", "每隔"))]
        digest = source_hash(chapter)
        override = overrides.get(chapter["id"])
        stale = bool(override and override["sourceHash"] != digest)
        automatic = {"summary": summary, "characterStates": _extract(states, 1800), "settingNotes": _extract(setting_quotes, 720)}
        entries.append({"chapterId": chapter["id"], "title": "正文" if book.get("kind") == "short" else chapter.get("title", ""),
                        "sourceHash": digest, "source": "author" if override and not stale else "local-extract", "stale": stale,
                        **({field: override[field] for field in automatic} if override and not stale else automatic),
                        "automatic": automatic, "saved": override})
    return {"bookId": book["id"], "enabled": configuration["enabled"], "entries": entries,
            "settings": [{"id": item["id"], "title": item.get("title", ""), "body": item.get("body", "")} for item in settings]}


def _terms(value):
    words = set(re.findall(r"[A-Za-z0-9_]{2,}", value.lower()))
    for run in re.findall(r"[\u3400-\u9fff]{2,}", value):
        words.update(run[index:index + 2] for index in range(len(run) - 1))
    return words


def select_memory(book, chapter_ids, instruction):
    index = memory_index(book)
    if not index["enabled"]:
        return []
    selected = set(chapter_ids)
    entries = index["entries"]
    positions = {entry["chapterId"]: position for position, entry in enumerate(entries)}
    boundary = max((positions[item] for item in selected if item in positions), default=len(entries))
    source = instruction + "\n" + "\n".join(entry["summary"] for entry in entries if entry["chapterId"] in selected)
    query = _terms(source)
    ranked = []
    for position, entry in enumerate(entries):
        if entry["chapterId"] in selected or position > boundary:
            continue
        searchable = entry["title"] + "\n" + entry["summary"] + "\n" + entry["characterStates"] + "\n" + entry["settingNotes"]
        score = len(query.intersection(_terms(searchable))) + (4 if boundary - position <= 3 else 0)
        ranked.append((score, position, entry))
    ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
    chosen = sorted(ranked[:6], key=lambda row: row[1])
    return [{key: entry[key] for key in ("chapterId", "title", "sourceHash", "source", "summary", "characterStates", "settingNotes")} for _, _, entry in chosen]
