"""Import an explicit, local-only Markdown writing-skill library; never run skill code."""
import hashlib
from functools import wraps
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import threading
from urllib.parse import unquote, urlsplit
import uuid

SKILL_IDS = ("chinese-novelist", "novelskill", "human-writing")
MODES = ("auto", "chapter", "continue", "polish", "outline", "characters", "check")
DEFAULTS = {"skillIds": [], "skillMode": "auto"}
MAX_FILE = 256 * 1024
MAX_TOTAL = 2 * 1024 * 1024
MAX_FILES = 100
LOCK = threading.RLock()
FALLBACK_NAMES = {"chinese-novelist": "中文小说创作", "novelskill": "小说项目写作", "human-writing": "活人感写作"}
SEEDS = {
    "chinese-novelist": {
        "chapter": ["references/flows/phase3-writing.md"],
        "continue": ["references/flows/phase3-writing.md"],
        "polish": ["references/guides/chapter-guide.md", "references/guides/dialogue-writing.md"],
        "outline": ["references/flows/phase2-planning.md"],
        "characters": ["references/guides/character-building.md", "references/guides/character-template.md"],
        "check": ["references/flows/phase4-validation.md", "references/guides/chapter-guide.md"],
    },
    "novelskill": {mode: ["references/小说-" + title + ".md"] for mode, title in
                  [("chapter", "章节"), ("continue", "续写"), ("polish", "润色"), ("outline", "大纲"), ("characters", "角色"), ("check", "检查")]},
    "human-writing": {mode: ["references/fiction.md"] + (["references/revision.md"] if mode in ("chapter", "continue", "polish", "check") else []) for mode in MODES if mode != "auto"},
}


class SkillError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


def _ids(values):
    if not isinstance(values, list) or len(values) > len(SKILL_IDS) or any(not isinstance(value, str) or value not in SKILL_IDS for value in values) or len(set(values)) != len(values):
        raise SkillError("写作技能选择不正确。")
    return list(values)


def _local_errors(function):
    @wraps(function)
    def checked(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except SkillError:
            raise
        except (OSError, ValueError, TypeError, UnicodeError):
            raise SkillError("无法读取或保存本机写作技能，请检查文件格式和目录权限。", 500) from None
    return checked


def _chain(path, create=False):
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise SkillError("写作技能目录包含不安全的链接或路径。")
    return path


def _read(path):
    _chain(path.parent)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise SkillError("写作技能目录包含不安全的链接或路径。")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
            raise SkillError("写作技能文件过大或格式不正确。")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            raw = handle.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE:
            raise SkillError("写作技能文件过大或格式不正确。")
        return raw.decode("utf-8")
    finally:
        os.close(descriptor)


def _references(content):
    # Both ordinary Markdown links and backtick paths are used by the installed skills.
    result = re.findall(r"\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)", content)
    result += re.findall(r"`([^`\n]+\.md(?:#[^`\n]*)?)`", content)
    return result


def _relative_reference(parent, value):
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or value.startswith("#"):
        return None  # Never fetch URLs, file: URLs or other schemes.
    value = unquote(parsed.path)
    if not value.lower().endswith(".md"):
        return None
    if value.startswith(("/", "\\")) or "\\" in value or "\x00" in value:
        raise SkillError("写作技能参考文件越出技能目录。")
    parts = list(PurePosixPath(parent).parent.parts)
    for part in PurePosixPath(value).parts:
        if part == "..":
            if not parts:
                raise SkillError("写作技能参考文件越出技能目录。")
            parts.pop()
        elif part != ".":
            parts.append(part)
    return "/".join(parts)


def _tree(root):
    _chain(root)
    files = {"SKILL.md": _read(root / "SKILL.md")}
    references = root / "references"
    if references.exists() or references.is_symlink():
        _chain(references)
        for folder, directories, names in os.walk(references, followlinks=False):
            for name in directories:
                _chain(Path(folder) / name)
            for name in names:
                file = Path(folder) / name
                if file.is_symlink():
                    raise SkillError("写作技能目录包含不安全的链接或路径。")
                if file.suffix.lower() == ".md":
                    files[file.relative_to(root).as_posix()] = _read(file)
                if len(files) > MAX_FILES:
                    raise SkillError("写作技能参考文件数量超过限制。")
    if sum(len(value.encode("utf-8")) for value in files.values()) > MAX_TOTAL:
        raise SkillError("写作技能内容超过大小限制。")
    for name, content in files.items():
        for value in _references(content):
            target = _relative_reference(name, value)
            # Project example paths can be absent; existing local references must remain safe.
            if target is not None:
                candidate = root / target
                if candidate.is_symlink():
                    raise SkillError("写作技能目录包含不安全的链接或路径。")
                if candidate.exists():
                    _chain(candidate.parent)
    return files


def _metadata(skill_id, content):
    name, description = FALLBACK_NAMES[skill_id], ""
    match = re.match(r"\A---\s*\n(.*?)\n---(?:\n|$)", content, re.S)
    if match:
        lines = match.group(1).splitlines()
        for index, line in enumerate(lines):
            if line.startswith("name:"):
                name = line[5:].strip().strip("\"'") or name
            if line.startswith("description:"):
                description = line[len("description:"):].strip()
                if description in ("|", ">", "|-", ">-"):
                    block = []
                    for value in lines[index + 1:]:
                        if value and not value.startswith((" ", "\t")):
                            break
                        block.append(value.strip())
                    description = " ".join(block)
                description = description.strip("\"'")
    return {"id": skill_id, "name": name[:200], "description": description[:2000]}


def _digest(files):
    return hashlib.sha256(json.dumps(files, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class SkillsService:
    def __init__(self, data_dir, codex_home=None):
        self.data_dir = Path(os.path.abspath(data_dir))
        self.library = self.data_dir / "writing-skills"
        self.settings_path = self.data_dir / "writing-skills-settings.json"
        self.source = Path(os.path.abspath(codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")) / "skills"

    def _settings(self):
        if not self.settings_path.exists() and not self.settings_path.is_symlink():
            return {"skillIds": [], "skillMode": "auto"}
        value = json.loads(_read(self.settings_path))
        if not isinstance(value, dict) or set(value) != set(DEFAULTS) or value.get("skillMode") not in MODES:
            raise SkillError("写作技能设置格式不正确。")
        return {"skillIds": _ids(value["skillIds"]), "skillMode": value["skillMode"]}

    def _imported(self, skill_id):
        try:
            return _tree(self.library / skill_id)
        except FileNotFoundError:
            return None

    @_local_errors
    def list(self):
        with LOCK:
            result = []
            for skill_id in SKILL_IDS:
                try:
                    source = _tree(self.source / skill_id)
                except (OSError, ValueError, UnicodeError, SkillError):
                    source = None
                imported = self._imported(skill_id)
                content = (imported or source or {}).get("SKILL.md", "")
                result.append({**_metadata(skill_id, content), "available": source is not None,
                               "imported": imported is not None, "sourceChanged": bool(source and imported and _digest(source) != _digest(imported)),
                               "referenceCount": max(0, len(imported or source or {}) - 1)})
            return {"skills": result, "defaults": self._settings()}

    @_local_errors
    def import_skills(self, values):
        values = _ids(values)
        with LOCK:
            # Validate all requested sources before changing the local library.
            prepared = {}
            for skill_id in values:
                try:
                    prepared[skill_id] = _tree(self.source / skill_id)
                except (OSError, ValueError, UnicodeError) as error:
                    raise SkillError("找不到可安全导入的本机写作技能。") from error
            _chain(self.library, create=True)
            for skill_id, files in prepared.items():
                target = self.library / skill_id
                if target.exists() or target.is_symlink():
                    _chain(target)
                temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=self.library))
                backup = self.library / (".previous-" + uuid.uuid4().hex)
                moved, cleanup_backup = False, False
                try:
                    for name, content in files.items():
                        file = temporary / name
                        _chain(file.parent, create=True)
                        with file.open("x", encoding="utf-8") as handle:
                            handle.write(content)
                        file.chmod(0o600)
                    if target.exists():
                        target.rename(backup)
                        moved = True
                    try:
                        temporary.rename(target)
                        cleanup_backup = True
                    except OSError:
                        if moved:
                            backup.rename(target)
                            cleanup_backup = True
                        raise
                finally:
                    shutil.rmtree(temporary, ignore_errors=True)
                    if cleanup_backup:
                        shutil.rmtree(backup, ignore_errors=True)
            return self.list()

    @_local_errors
    def save_settings(self, data):
        if not isinstance(data, dict) or set(data) != set(DEFAULTS):
            raise SkillError("写作技能设置参数不正确。")
        values, mode = _ids(data["skillIds"]), data["skillMode"]
        if mode not in MODES:
            raise SkillError("写作技能模式不正确。")
        with LOCK:
            for skill_id in values:
                if self._imported(skill_id) is None:
                    raise SkillError("请先导入所选写作技能。")
            _chain(self.data_dir, create=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".writing-skills-", dir=self.data_dir)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump({"skillIds": values, "skillMode": mode}, handle)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.settings_path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return self.list()

    @_local_errors
    def detail(self, skill_id):
        _ids([skill_id])
        with LOCK:
            files = self._imported(skill_id)
            if files is None:
                raise SkillError("这个写作技能尚未导入。", 404)
            return {**_metadata(skill_id, files["SKILL.md"]), "content": files["SKILL.md"],
                    "files": [{"path": name, "content": content} for name, content in sorted(files.items()) if name != "SKILL.md"], "imported": True}

    @_local_errors
    def selected(self, action, skill_ids=None, skill_mode=None):
        with LOCK:
            defaults = self._settings()
            values = _ids(defaults["skillIds"] if skill_ids is None else skill_ids)
            mode = defaults["skillMode"] if skill_mode is None else skill_mode
            if not isinstance(mode, str) or mode not in MODES:
                raise SkillError("写作技能模式不正确。")
            resolved = {"relationships": "characters", "consistency": "check", "draft": "chapter", "outline": "outline", "custom": "custom", "book_cover": "custom"}.get(action) if mode == "auto" else mode
            if resolved is None:
                raise SkillError("写作技能操作不正确。")
            results = []
            for skill_id in values:
                files = self._imported(skill_id)
                if files is None:
                    raise SkillError("请先导入所选写作技能。")
                selected, pending = {"SKILL.md"}, [] if resolved == "custom" else list(SEEDS[skill_id][resolved])
                while pending:
                    name = pending.pop(0)
                    if name in selected or name not in files:
                        continue
                    selected.add(name)
                    for reference in _references(files[name]):
                        target = _relative_reference(name, reference)
                        # Stage-to-stage navigation is not relevant to the current action.
                        if target in files and target.startswith("references/") and "/flows/" not in target:
                            pending.append(target)
                results.append({**_metadata(skill_id, files["SKILL.md"]), "mode": resolved,
                                "files": [{"path": name, "content": files[name]} for name in sorted(selected)]})
            return results, values, mode
