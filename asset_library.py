"""Portable, book-scoped source material. Binary data travels in v4 backups."""
import base64
import binascii
import copy
import re
from urllib.parse import urlsplit

MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 15 * 1024 * 1024
MAX_ITEMS = 120
FIELDS = {'id', 'name', 'kind', 'mime', 'data', 'sourceUrl', 'excerpt',
          'chapterIds', 'noteIds', 'createdAt', 'updatedAt'}


def defaults():
    return {'version': 1, 'items': []}


def text(value, limit, label, empty=True):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(label + '格式不正确或过长')
    if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
        raise ValueError(label + '包含无效字符')
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(label + '包含无效字符')
    return value


def validate(book, value=None):
    if value is None:
        return defaults()
    if not isinstance(value, dict) or set(value) != {'version', 'items'} or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('素材库版本不正确')
    items = value['items']
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ValueError('每本书最多保存 120 项素材')
    chapters = {item['id'] for item in book['chapters']}
    notes = {item['id'] for item in book['notes']}
    seen, result, total = set(), [], 0
    for item in items:
        if not isinstance(item, dict) or set(item) - FIELDS:
            raise ValueError('素材格式不正确')
        identity = text(item.get('id'), 100, '素材编号', False)
        if not re.fullmatch(r'[A-Za-z0-9_-]+', identity) or identity in seen:
            raise ValueError('素材编号无效或重复')
        seen.add(identity)
        kind = item.get('kind')
        if kind not in ('image', 'pdf', 'web', 'text'):
            raise ValueError('素材类型不正确')
        clean = {'id': identity, 'name': text(item.get('name'), 200, '素材名称', False),
                 'kind': kind, 'mime': '', 'data': '',
                 'sourceUrl': text(item.get('sourceUrl', ''), 2048, '来源网址'),
                 'excerpt': text(item.get('excerpt', ''), 200000, '素材摘录'),
                 'createdAt': text(item.get('createdAt', ''), 100, '创建时间'),
                 'updatedAt': text(item.get('updatedAt', ''), 100, '修改时间')}
        if clean['sourceUrl']:
            try:
                parsed = urlsplit(clean['sourceUrl'])
                if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError()
            except ValueError:
                raise ValueError('素材来源只接受 HTTP 或 HTTPS 网址') from None
        for key, allowed in [('chapterIds', chapters), ('noteIds', notes)]:
            linked = item.get(key, [])
            if not isinstance(linked, list) or len(linked) > 10000 or any(not isinstance(link, str) or link not in allowed for link in linked):
                raise ValueError('素材只能关联本书的正文和资料')
            clean[key] = list(dict.fromkeys(linked))
        if kind in ('image', 'pdf'):
            encoded, mime = item.get('data'), item.get('mime')
            if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((MAX_FILE + 2) // 3):
                raise ValueError('单个素材文件不能超过 5 MB')
            try:
                content = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError('素材文件编码不正确') from None
            if not content or len(content) > MAX_FILE:
                raise ValueError('单个素材文件不能超过 5 MB')
            if kind == 'image':
                from ai_service import _image_mime
                try:
                    actual = _image_mime(content)
                except ValueError:
                    raise ValueError('请选择有效的 PNG、JPEG 或 WebP 素材') from None
                if mime != actual:
                    raise ValueError('素材图片格式与内容不符')
            elif mime != 'application/pdf' or not content.startswith(b'%PDF-') or b'%%EOF' not in content[-2048:]:
                raise ValueError('请选择有效的 PDF 素材')
            total += len(content)
            if total > MAX_TOTAL:
                raise ValueError('每本书的素材文件总大小不能超过 15 MB')
            clean.update(mime=mime, data=encoded)
        elif item.get('data', '') or item.get('mime', ''):
            raise ValueError('文字摘录不能包含文件数据')
        if kind == 'web' and not clean['sourceUrl']:
            raise ValueError('网页摘录需要来源网址')
        result.append(clean)
    return {'version': 1, 'items': result}


def sanitize(book, removed_chapters, removed_notes=()):
    """Drop exclusively owned assets, rather than retaining a deleted chapter copy."""
    result = copy.deepcopy(book)
    library = result.get('assetLibrary')
    if not isinstance(library, dict) or not isinstance(library.get('items'), list):
        return result
    removed_chapters, removed_notes = set(removed_chapters), set(removed_notes)
    kept = []
    for asset in library['items']:
        old_chapters, old_notes = asset.get('chapterIds', []), asset.get('noteIds', [])
        asset['chapterIds'] = [link for link in old_chapters if link not in removed_chapters]
        asset['noteIds'] = [link for link in old_notes if link not in removed_notes]
        touched = bool(set(old_chapters) & removed_chapters or set(old_notes) & removed_notes)
        if touched and not asset['chapterIds'] and not asset['noteIds']:
            continue
        kept.append(asset)
    library['items'] = kept
    return result
