"""Validated local reusable export layouts; no markup, CSS, paths or scripts."""
import copy
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import uuid

FONTS = ('Noto Serif CJK SC', 'Noto Sans CJK SC', 'Songti SC', 'SimSun', 'Georgia', 'Arial', 'Times New Roman')
LAYOUT_DEFAULTS = {'paper': 'a4', 'pageWidth': 210, 'pageHeight': 297, 'font': 12, 'fontFamily': 'Noto Serif CJK SC',
                   'marginTop': 20, 'marginRight': 20, 'marginBottom': 20, 'marginLeft': 20,
                   'lineHeight': 1.8, 'firstLineIndent': 0, 'paragraphSpace': 6,
                   'chapterSize': 18, 'chapterAlign': 'left', 'chapterBold': True, 'chapterPageBreak': True}
_LOCK = threading.RLock()


def layout_checked(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict) or set(value) - set(LAYOUT_DEFAULTS):
        raise ValueError('排版模板选项不正确。')
    result = {**LAYOUT_DEFAULTS, **value}
    if result['paper'] not in ('a4', 'a5', 'letter', 'custom') or result['fontFamily'] not in FONTS or result['chapterAlign'] not in ('left', 'center'):
        raise ValueError('纸张、字体或标题对齐方式不正确。')
    bounds = {'pageWidth': (100, 320), 'pageHeight': (140, 450), 'font': (8, 36), 'marginTop': (5, 50), 'marginRight': (5, 50), 'marginBottom': (5, 50), 'marginLeft': (5, 50), 'lineHeight': (1, 3), 'firstLineIndent': (0, 4), 'paragraphSpace': (0, 24), 'chapterSize': (12, 40)}
    for key, (low, high) in bounds.items():
        number = result[key]
        if type(number) not in (int, float) or not math.isfinite(number) or not low <= number <= high:
            raise ValueError('排版数值超出允许范围。')
        result[key] = round(number, 2)
    if type(result['chapterBold']) is not bool or type(result['chapterPageBreak']) is not bool:
        raise ValueError('标题选项必须是布尔值。')
    if result['paper'] != 'custom':
        result['pageWidth'], result['pageHeight'] = {'a4': (210, 297), 'a5': (148, 210), 'letter': (215.9, 279.4)}[result['paper']]
    if result['pageWidth'] - result['marginLeft'] - result['marginRight'] < 50 or result['pageHeight'] - result['marginTop'] - result['marginBottom'] < 80:
        raise ValueError('页边距过大，请保留足够的正文空间。')
    return result


def presets():
    return [{'id': 'reading', 'name': '舒适阅读', 'layout': layout_checked()},
            {'id': 'submission', 'name': '投稿稿件', 'layout': layout_checked({'fontFamily': 'SimSun', 'font': 12, 'lineHeight': 2, 'firstLineIndent': 2, 'paragraphSpace': 0, 'marginLeft': 25, 'marginRight': 25, 'chapterAlign': 'center'})},
            {'id': 'pocket', 'name': '口袋书', 'layout': layout_checked({'paper': 'a5', 'font': 11, 'lineHeight': 1.6, 'firstLineIndent': 2, 'marginTop': 15, 'marginBottom': 15, 'marginLeft': 15, 'marginRight': 15, 'chapterSize': 16})}]


class ExportTemplateStore:
    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'export-templates.json'

    def get(self):
        with _LOCK:
            if not self.path.exists() and not self.path.is_symlink():
                return {'version': 1, 'templates': presets()}
            try:
                fd = os.open(self.path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                with os.fdopen(fd, encoding='utf-8') as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
                        raise ValueError('invalid file')
                    value = json.load(handle)
                return self.checked(value)
            except (OSError, ValueError, TypeError):
                raise ValueError('无法读取本机排版模板。') from None

    @staticmethod
    def checked(value):
        if not isinstance(value, dict) or set(value) != {'version', 'templates'} or type(value['version']) is not int or value['version'] != 1 or not isinstance(value['templates'], list) or len(value['templates']) > 50:
            raise ValueError('排版模板格式不正确。')
        templates, ids = [], set()
        for item in value['templates']:
            if not isinstance(item, dict) or set(item) != {'id', 'name', 'layout'} or not isinstance(item['id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', item['id']) or item['id'] in ids or not isinstance(item['name'], str) or not 1 <= len(item['name'].strip()) <= 100:
                raise ValueError('排版模板名称或标识不正确。')
            templates.append({'id': item['id'], 'name': item['name'].strip(), 'layout': layout_checked(item['layout'])})
            ids.add(item['id'])
        return {'version': 1, 'templates': templates}

    def save(self, value):
        checked = self.checked(value)
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.is_symlink():
                raise ValueError('排版模板文件不可为符号链接。')
            fd, temporary = tempfile.mkstemp(prefix='.export-templates-', dir=self.path.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    if os.name != 'nt':
                        os.fchmod(handle.fileno(), 0o600)
                    json.dump(checked, handle, ensure_ascii=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return copy.deepcopy(checked)
