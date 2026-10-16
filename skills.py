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


def _valid_id(value):
    return isinstance(value, str) and (value in SKILL_IDS or re.fullmatch(r"custom-[a-f0-9]{32}", value) is not None)


def _ids(values):
    if not isinstance(values, list) or len(values) > len(SKILL_IDS) + 100 or any(not _valid_id(value) for value in values) or len(set(values)) != len(values):
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
    name, description = FALLBACK_NAMES.get(skill_id, "新写作技能"), ""
    match = re.match(r"\A---\s*\n(.*?)\n---(?:\n|$)", content.replace("\r\n", "\n"), re.S)
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
    """Portable App-owned rules plus explicitly saved local Markdown copies."""
    def __init__(self, data_dir, codex_home=None, bundled_dir=None):
        self.data_dir = Path(os.path.abspath(data_dir))
        self.library = self.data_dir / "writing-skills"
        self.settings_path = self.data_dir / "writing-skills-settings.json"
        self.source = Path(os.path.abspath(codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")) / "skills"
        self.bundled = Path(bundled_dir) if bundled_dir is not None else Path(__file__).resolve().with_name("bundled-skills")

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

    def _builtin(self, skill_id):
        if skill_id not in SKILL_IDS:
            return None
        try:
            return _tree(self.bundled / skill_id)
        except FileNotFoundError:
            return None

    def _resolved(self, skill_id):
        return self._imported(skill_id) or self._builtin(skill_id)

    def _catalog(self):
        if not self.library.exists() and not self.library.is_symlink():
            return list(SKILL_IDS)
        _chain(self.library)
        custom = sorted(file.name for file in self.library.iterdir() if _valid_id(file.name) and file.name not in SKILL_IDS)
        if len(custom) > 100:
            raise SkillError("本机写作技能数量超过限制。")
        return [*SKILL_IDS, *custom]

    def _local_metadata(self, skill_id, files):
        metadata = _metadata(skill_id, files["SKILL.md"])
        file = self.library / skill_id / "metadata.json"
        if file.exists() or file.is_symlink():
            value = json.loads(_read(file))
            if not isinstance(value, dict) or set(value) != {"name", "description"}:
                raise SkillError("写作技能名称格式不正确。")
            metadata.update(self._labels(value))
        return metadata

    def _revision(self, skill_id, files, imported):
        metadata = self._local_metadata(skill_id, files) if imported else _metadata(skill_id, files["SKILL.md"])
        return _digest({**files, "@metadata": json.dumps(metadata, ensure_ascii=False, sort_keys=True)})

    def _summary(self, skill_id, *, include_source=True):
        imported, builtin = self._imported(skill_id), self._builtin(skill_id)
        source = None
        if include_source and skill_id in SKILL_IDS:
            try:
                source = _tree(self.source / skill_id)
            except (OSError, ValueError, UnicodeError, SkillError):
                pass
        files = imported or builtin or source or {}
        metadata = self._local_metadata(skill_id, imported) if imported else _metadata(skill_id, files.get("SKILL.md", ""))
        if not imported and builtin and metadata["name"] == skill_id:
            metadata["name"] = FALLBACK_NAMES[skill_id]
        return {**metadata, "available": source is not None, "imported": imported is not None,
                "builtin": builtin is not None, "usable": bool(imported or builtin),
                "origin": "local" if imported else "builtin" if builtin else "codex" if source else "missing",
                "sourceChanged": bool(source and imported and _digest(source) != _digest(imported)),
                "referenceCount": max(0, len(files) - 1),
                "revision": self._revision(skill_id, files, imported is not None) if files else None}

    @_local_errors
    def list(self):
        with LOCK:
            return {"skills": [self._summary(skill_id) for skill_id in self._catalog()], "defaults": self._settings()}

    def _install(self, skill_id, files, labels=None):
        _chain(self.library, create=True)
        target = self.library / skill_id
        if target.exists() or target.is_symlink():
            _chain(target)
        temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=self.library))
        backup = self.library / (".previous-" + uuid.uuid4().hex)
        moved, cleanup_backup = False, False
        try:
            contents = {**files}
            if labels is not None:
                contents["metadata.json"] = json.dumps(labels, ensure_ascii=False)
            for name, content in contents.items():
                file = temporary / name
                _chain(file.parent, create=True)
                with file.open("xb") as handle:
                    handle.write(content.encode("utf-8"))
                    handle.flush()
                    os.fsync(handle.fileno())
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

    @_local_errors
    def import_skills(self, values):
        values = _ids(values)
        if any(skill_id not in SKILL_IDS for skill_id in values):
            raise SkillError("这里只能导入本机已下载的写作技能。")
        with LOCK:
            prepared = {}
            for skill_id in values:
                try:
                    prepared[skill_id] = _tree(self.source / skill_id)
                except (OSError, ValueError, UnicodeError) as error:
                    raise SkillError("找不到可安全导入的本机写作技能。") from error
            for skill_id, files in prepared.items():
                self._install(skill_id, files)
            return self.list()

    def _write_settings(self, values, mode):
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

    @_local_errors
    def save_settings(self, data):
        if not isinstance(data, dict) or set(data) != set(DEFAULTS):
            raise SkillError("写作技能设置参数不正确。")
        values, mode = _ids(data["skillIds"]), data["skillMode"]
        if not isinstance(mode, str) or mode not in MODES:
            raise SkillError("写作技能模式不正确。")
        with LOCK:
            for skill_id in values:
                if self._resolved(skill_id) is None:
                    raise SkillError("所选写作技能不可用，请重新导入或选择。")
            self._write_settings(values, mode)
            return self.list()

    @_local_errors
    def detail(self, skill_id):
        _ids([skill_id])
        with LOCK:
            files = self._resolved(skill_id)
            if files is None:
                raise SkillError("找不到可用的写作技能。", 404)
            return {**self._summary(skill_id, include_source=False), "content": files["SKILL.md"],
                    "files": [{"path": name, "content": content} for name, content in sorted(files.items()) if name != "SKILL.md"]}

    @staticmethod
    def _labels(data):
        name, description = data.get("name"), data.get("description", "")
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or any(ord(c) < 32 for c in name):
            raise SkillError("请填写不超过 200 字的写作技能名称。")
        if not isinstance(description, str) or len(description) > 2000 or "\x00" in description:
            raise SkillError("写作技能说明不正确。")
        return {"name": name.strip(), "description": description.strip()}

    @classmethod
    def prepare(cls, data):
        if not isinstance(data, dict) or set(data) - {"name", "description", "content", "files", "revision"}:
            raise SkillError("写作技能参数不正确。")
        labels = cls._labels(data)
        content = data.get("content")
        if not isinstance(content, str) or not content.strip() or "\x00" in content or len(content.encode("utf-8")) > MAX_FILE:
            raise SkillError("请填写有效的写作技能内容，单个文件不能超过 256 KB。")
        references = data.get("files", [])
        if not isinstance(references, list) or len(references) >= MAX_FILES:
            raise SkillError("写作技能参考文件参数不正确。")
        files, names = {"SKILL.md": content}, {"skill.md"}
        for item in references:
            if not isinstance(item, dict) or set(item) != {"path", "content"}:
                raise SkillError("写作技能参考文件参数不正确。")
            name, body = item["path"], item["content"]
            if (not isinstance(name, str) or not name.startswith("references/") or not name.lower().endswith(".md")
                    or "\\" in name or "\x00" in name or any(part in ("", ".", "..") for part in name.split("/"))
                    or any(ord(c) < 32 for c in name) or any(part.endswith((".", " ")) or re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part) for part in name.split("/"))
                    or ":" in name or len(name) > 500 or name.casefold() in names):
                raise SkillError("参考文件必须是技能内 references 目录中的 Markdown 文件。")
            if not isinstance(body, str) or "\x00" in body or len(body.encode("utf-8")) > MAX_FILE:
                raise SkillError("写作技能参考文件过大或格式不正确。")
            names.add(name.casefold())
            files[name] = body
        if sum(len(value.encode("utf-8")) for value in files.values()) > MAX_TOTAL:
            raise SkillError("写作技能内容超过大小限制。")
        for name, body in files.items():
            for reference in _references(body):
                _relative_reference(name, reference)
        return labels, files

    @_local_errors
    def create(self, data):
        labels, files = self.prepare(data)
        with LOCK:
            if len(self._catalog()) >= 103:
                raise SkillError("最多保存 100 个自定义写作技能。")
            skill_id = "custom-" + uuid.uuid4().hex
            self._install(skill_id, files, labels)
            return {"skill": self.detail(skill_id), **self.list()}

    def _check_revision(self, skill_id, data):
        current = self.detail(skill_id)
        if "revision" in data and data["revision"] != current["revision"]:
            raise SkillError("这个写作技能已在其他窗口修改，请重新打开后编辑。", 409)
        return current

    @_local_errors
    def update(self, skill_id, data):
        _ids([skill_id])
        labels, files = self.prepare(data)
        with LOCK:
            self._check_revision(skill_id, data)
            self._install(skill_id, files, labels)
            return {"skill": self.detail(skill_id), **self.list()}

    @_local_errors
    def delete(self, skill_id, data):
        _ids([skill_id])
        if not isinstance(data, dict) or set(data) - {"revision"}:
            raise SkillError("写作技能删除参数不正确。")
        with LOCK:
            self._check_revision(skill_id, data)
            local = self._imported(skill_id)
            if local is None:
                raise SkillError("这是 App 内置技能，无需删除；可取消勾选。")
            settings = self._settings()
            if skill_id not in SKILL_IDS and skill_id in settings["skillIds"]:
                self._write_settings([item for item in settings["skillIds"] if item != skill_id], settings["skillMode"])
            target = self.library / skill_id
            _chain(target)
            tombstone = self.library / (".deleted-" + uuid.uuid4().hex)
            target.rename(tombstone)
            shutil.rmtree(tombstone)
            return self.list()

    @_local_errors
    def export(self, skill_id):
        with LOCK:
            detail = self.detail(skill_id)
            return {"format": "writer-desk-skill", "version": 1,
                    **{key: detail[key] for key in ("name", "description", "content", "files")}}

    @_local_errors
    def import_file(self, data):
        if not isinstance(data, dict) or set(data) - {"fileName", "content", "preview"} or type(data.get("preview", False)) is not bool:
            raise SkillError("写作技能文件参数不正确。")
        name, content = data.get("fileName"), data.get("content")
        if (not isinstance(name, str) or not name or len(name) > 200 or any(c in name for c in ("/", "\\", "\x00"))
                or not isinstance(content, str) or len(content.encode("utf-8")) > 4 * MAX_TOTAL):
            raise SkillError("写作技能文件过大或格式不正确。")
        if name.lower().endswith(".md"):
            metadata = _metadata("custom-preview", content)
            if metadata["name"] == "新写作技能":
                title = re.search(r"^# +(.+)$", content, re.M)
                metadata["name"] = (title[1].strip() if title else Path(name).stem)[:200]
            draft = {**{key: metadata[key] for key in ("name", "description")}, "content": content, "files": []}
        elif name.lower().endswith(".json"):
            try:
                package = json.loads(content)
            except (ValueError, TypeError):
                raise SkillError("写作技能包不是有效的 JSON 文件。") from None
            if (not isinstance(package, dict) or set(package) != {"format", "version", "name", "description", "content", "files"}
                    or package["format"] != "writer-desk-skill" or type(package["version"]) is not int or package["version"] != 1):
                raise SkillError("请选择作家工作台导出的写作技能包。")
            draft = {key: package[key] for key in ("name", "description", "content", "files")}
        else:
            raise SkillError("请选择 Markdown 文件或作家工作台写作技能包。")
        self.prepare(draft)
        return {"draft": draft} if data.get("preview", False) else self.create(draft)

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
                files = self._resolved(skill_id)
                if files is None:
                    raise SkillError("所选写作技能不可用，请重新导入或选择。")
                # Custom rules explicitly link their references; legacy skills retain their mode-specific seeds.
                seeds = SEEDS.get(skill_id, {}).get(resolved, [])
                edited = (self.library / skill_id / "metadata.json").exists()
                if skill_id not in SKILL_IDS or edited:
                    seeds = [*seeds, *[target for value in _references(files["SKILL.md"])
                             if (target := _relative_reference("SKILL.md", value)) in files]]
                selected, pending = {"SKILL.md"}, [] if resolved == "custom" and skill_id in SKILL_IDS and not edited else list(seeds)
                while pending:
                    name = pending.pop(0)
                    if name in selected or name not in files:
                        continue
                    selected.add(name)
                    for reference in _references(files[name]):
                        target = _relative_reference(name, reference)
                        if target in files and target.startswith("references/") and (skill_id not in SKILL_IDS or edited or "/flows/" not in target):
                            pending.append(target)
                metadata = self._local_metadata(skill_id, files) if self._imported(skill_id) else _metadata(skill_id, files["SKILL.md"])
                results.append({**metadata, "mode": resolved,
                                "files": [{"path": name, "content": files[name]} for name in sorted(selected)]})
            return results, values, mode
