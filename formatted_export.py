"""Dependency-free, book-scoped DOCX/EPUB and printable HTML exports.

The caller must load a current, active book from storage. Export functions never
write to the library or include recycled chapters, notes, history or AI chats.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import html
import io
import math
import re
import struct
import zipfile
from datetime import datetime, timezone
from xml.sax.saxutils import escape
from export_templates import LAYOUT_DEFAULTS, layout_checked

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
EPUB_MIME = "application/epub+zip"
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_R = "http://schemas.openxmlformats.org/package/2006/relationships"
MAX_COVER = 2 * 1024 * 1024


def options_checked(options=None):
    options = {} if options is None else options
    if not isinstance(options, dict):
        raise ValueError("排版选项格式不正确")
    if set(options) - set(LAYOUT_DEFAULTS) - {"cover", "toc", "lang", "coverData", "format"}:
        raise ValueError("不支持这个排版选项")
    result = {"cover": options.get("cover", True), "toc": options.get("toc", True),
              "lang": options.get("lang", "zh"), "coverData": options.get("coverData"),
              **layout_checked({key: options[key] for key in LAYOUT_DEFAULTS if key in options})}
    if type(result["cover"]) is not bool or type(result["toc"]) is not bool:
        raise ValueError("封面和目录选项必须是布尔值")
    if result["lang"] not in ("zh", "en"):
        raise ValueError("不支持这个语言")
    return result


def clean_xml(value):
    """Preserve prose while removing characters forbidden by XML 1.0."""
    return "".join(char for char in str(value or "") if char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF)


def x(value):
    return escape(clean_xml(value), {'"': '&quot;'})


def safe_filename(title, extension):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", str(title)).strip(" .")[:100] or "WriterDesk"
    return name + extension


def reading_sections(book, lang="zh"):
    """Stable authored order, identical to the existing plain-text export."""
    if not isinstance(book, dict) or book.get("kind") not in ("long", "short"):
        raise ValueError("作品格式不正确")
    volumes = [volume for volume in book.get("volumes", []) if not volume.get("deletedAt")]
    deleted_volumes = {volume["id"] for volume in book.get("volumes", []) if volume.get("deletedAt")}
    chapters = [chapter for chapter in book.get("chapters", []) if not chapter.get("deletedAt") and chapter.get("volumeId") not in deleted_volumes]
    if book["kind"] == "short":
        return [{"id": "body", "title": "", "level": 0, "body": "\n\n".join(chapter.get("body", "") for chapter in chapters)}]
    sections = []
    volume_ids = {volume["id"] for volume in volumes}
    groups = [(volume, [chapter for chapter in chapters if chapter.get("volumeId") == volume["id"]]) for volume in volumes]
    groups.append(({"title": "Unassigned" if lang == "en" else "未分卷"}, [chapter for chapter in chapters if chapter.get("volumeId") not in volume_ids]))
    for volume, items in groups:
        if not items:
            continue
        sections.append({"id": f"part-{len(sections)}", "title": volume.get("title", ""), "level": 1, "body": ""})
        for chapter in items:
            sections.append({"id": f"part-{len(sections)}", "title": chapter.get("title") or ("Untitled chapter" if lang == "en" else "未命名章节"), "level": 2, "body": chapter.get("body", "")})
    return sections


def cover_image(book, options):
    if not options["cover"]:
        return None
    value = options.get("coverData") or book.get("cover", "")
    if not value:
        return None
    if not isinstance(value, str) or len(value) > MAX_COVER * 2:
        raise ValueError("封面图片过大")
    match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        raise ValueError("封面仅支持内联 PNG、JPEG 或 WebP 图片")
    try:
        content = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("封面图片编码不正确") from None
    if len(content) > MAX_COVER:
        raise ValueError("封面图片超过 2 MB")
    kind, width, height = match[1], 600, 800
    if kind == "png":
        if len(content) < 45 or not content.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") or content[-12:] != b"\x00\x00\x00\x00IEND\xaeB`\x82":
            raise ValueError("封面 PNG 已损坏")
        width, height = struct.unpack(">II", content[16:24])
    elif kind == "jpeg":
        if len(content) < 12 or not content.startswith(b"\xff\xd8\xff") or not content.endswith(b"\xff\xd9"):
            raise ValueError("封面 JPEG 已损坏")
        offset = 2
        while offset + 4 < len(content):
            if content[offset] != 0xFF:
                break
            marker = content[offset + 1]
            offset += 2
            if marker in (0xD8, 0xD9):
                continue
            size = int.from_bytes(content[offset:offset + 2], "big")
            if size < 2:
                break
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and offset + 7 <= len(content):
                height, width = struct.unpack(">HH", content[offset + 3:offset + 7])
                break
            offset += size
    elif len(content) < 20 or content[:4] != b"RIFF" or content[8:12] != b"WEBP" or int.from_bytes(content[4:8], "little") != len(content) - 8 or content[12:16] not in (b"VP8 ", b"VP8L", b"VP8X"):
        raise ValueError("封面 WebP 已损坏")
    if not width or not height or width * height > 100_000_000:
        raise ValueError("封面图片尺寸不正确")
    return {"data": content, "kind": kind, "mime": "image/" + kind, "width": width, "height": height, "dataURL": value}


def paragraphs(body):
    # Newlines are authored structure: even deliberate blank paragraphs survive.
    return str(body).replace("\r\n", "\n").replace("\r", "\n").split("\n")


def export_docx(book, options):
    sections = reading_sections(book, options["lang"])
    image = cover_image(book, options)
    if image and image["kind"] == "webp":
        raise ValueError("Word 封面需转换为 PNG 或 JPEG，请从应用导出")
    font = round(options["font"] * 2)
    a5 = options["paper"] == "a5"
    width, height = round(options["pageWidth"] * 1440 / 25.4), round(options["pageHeight"] * 1440 / 25.4)
    margins = {side: round(options["margin" + side.title()] * 1440 / 25.4) for side in ('top', 'right', 'bottom', 'left')}
    available_width = width - margins['left'] - margins['right']
    available_height = height - margins['top'] - margins['bottom']
    margin = max(margins.values())
    def paragraph(text="", style=None, before=False, bookmark=None, center=False, size=None):
        props = (f'<w:pStyle w:val="{style}"/><w:ind w:firstLineChars="0" w:firstLine="0"/>' if style else "") + ('<w:pageBreakBefore/>' if before else "") + ('<w:jc w:val="center"/>' if center else "")
        mark = f'<w:bookmarkStart w:id="{bookmark[0]}" w:name="{bookmark[1]}"/>' if bookmark else ""
        end = f'<w:bookmarkEnd w:id="{bookmark[0]}"/>' if bookmark else ""
        run_props = f'<w:rPr><w:sz w:val="{size * 2}"/></w:rPr>' if size else ''
        return f'<w:p><w:pPr>{props}</w:pPr>{mark}<w:r>{run_props}<w:t xml:space="preserve">{x(text)}</w:t></w:r>{end}</w:p>'
    title_text = book.get("title", "")
    title_size = 16 if len(title_text) > 120 else 20 if len(title_text) > 60 else 24
    body = [paragraph(title_text, "Title", center=options["cover"], size=title_size)]
    if image:
        max_w, max_h = (3.3, 4.2) if a5 else (4.7, 6.3)
        title_rows = math.ceil(sum(0.6 if ord(char) < 128 else 1 for char in title_text) * title_size / (available_width / 20))
        # Leave room for wrapped long titles instead of pushing the cover
        # artwork onto a second page in Word's pagination engine.
        max_h = min(max_h, max(1, available_height / 1440 - (title_rows * title_size * 1.5 + 50) / 72))
        scale = min(max_w / image["width"], max_h / image["height"])
        cx, cy = round(image["width"] * scale * 914400), round(image["height"] * scale * 914400)
        body.append(f'<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="1" name="Book cover" descr="{x(book.get("title", ""))}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="cover"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdCover"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
    headings = [section for section in sections if section["level"]]
    if options["toc"] and headings:
        body.append(paragraph("Contents" if options["lang"] == "en" else "目录", "TOCTitle", before=options["cover"]))
        for section in headings:
            indent = ' w:left="360"' if section["level"] == 2 else ' w:left="0"'
            body.append(f'<w:p><w:pPr><w:ind{indent} w:firstLineChars="0" w:firstLine="0"/><w:spacing w:after="100"/></w:pPr><w:hyperlink w:anchor="{section["id"]}"><w:r><w:t>{x(section["title"])}</w:t></w:r></w:hyperlink></w:p>')
    first = True
    previous_level = None
    for index, section in enumerate(sections):
        if section["level"]:
            start_page = (first and (options["cover"] or options["toc"] and headings)) or (not first and options["chapterPageBreak"] and (section["level"] == 1 or previous_level == 2))
            body.append(paragraph(section["title"], f'Heading{section["level"]}', before=start_page, bookmark=(index + 1, section["id"])))
        elif options["cover"] and section["body"]:
            body.append('<w:p><w:pPr><w:spacing w:after="0" w:before="0"/><w:pageBreakBefore/></w:pPr></w:p>')
        body.extend(paragraph(line) for line in paragraphs(section["body"]) if section["body"])
        first = False
        previous_level = section["level"]
    body.append(f'<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="{width}" w:h="{height}"/><w:pgMar w:top="{margins["top"]}" w:right="{margins["right"]}" w:bottom="{margins["bottom"]}" w:left="{margins["left"]}" w:header="360" w:footer="360"/><w:cols w:space="720"/></w:sectPr>')
    document = XML + f'<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{"".join(body)}</w:body></w:document>'
    heading_bold = '<w:b/>' if options["chapterBold"] else '<w:b w:val="0"/>'
    styles = XML + f'<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{x(options["fontFamily"])}" w:hAnsi="{x(options["fontFamily"])}" w:eastAsia="{x(options["fontFamily"])}"/><w:sz w:val="{font}"/><w:color w:val="000000"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="{round(options["paragraphSpace"] * 20)}" w:line="{round(options["lineHeight"] * 240)}" w:lineRule="auto"/><w:ind w:firstLineChars="{round(options["firstLineIndent"] * 100)}"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="480"/><w:keepNext/></w:pPr><w:rPr><w:sz w:val="48"/><w:b/><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TOCTitle"><w:name w:val="Contents Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="360"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>' + ''.join(f'<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="{options["chapterAlign"]}"/><w:outlineLvl w:val="{level-1}"/><w:spacing w:before="280" w:after="240"/></w:pPr><w:rPr>{heading_bold}<w:sz w:val="{round((options["chapterSize"] + (4 if level == 1 else 0)) * 2)}"/><w:color w:val="000000"/></w:rPr></w:style>' for level in (1, 2)) + '</w:styles>'
    relationships = [('rIdStyles', 'styles', 'styles.xml'), ('rIdFooter', 'footer', 'footer1.xml')]
    if image:
        relationships.append(('rIdCover', 'image', 'media/cover.' + image["kind"]))
    rels = XML + f'<Relationships xmlns="{PACKAGE_R}">' + ''.join(f'<Relationship Id="{id_}" Type="{R}/{kind}" Target="{target}"/>' for id_, kind, target in relationships) + '</Relationships>'
    types = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (f'<Default Extension="{image["kind"]}" ContentType="{image["mime"]}"/>' if image else '') + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
    files = {'[Content_Types].xml': types, '_rels/.rels': XML + f'<Relationships xmlns="{PACKAGE_R}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>', 'word/document.xml': document, 'word/styles.xml': styles, 'word/_rels/document.xml.rels': rels, 'word/footer1.xml': XML + f'<w:ftr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>', 'docProps/core.xml': XML + f'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{x(book.get("title", ""))}</dc:title></cp:coreProperties>'}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content.encode("utf-8"))
        if image:
            archive.writestr('word/media/cover.' + image["kind"], image["data"])
    return output.getvalue()


def export_epub(book, options):
    sections, image = reading_sections(book, options["lang"]), cover_image(book, options)
    if image and image["kind"] == "webp":
        raise ValueError("EPUB 封面需转换为 PNG 或 JPEG，请从应用导出")
    title = x(book.get("title", ""))
    language = "en" if options["lang"] == "en" else "zh-CN"
    def page(name, content):
        return f'<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{language}"><head><title>{name}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>{content}</body></html>'
    documents, spine = [], []
    if options["cover"]:
        artwork = f'<img class="cover" src="cover.{image["kind"]}" alt="{title}"/>' if image else ''
        documents.append(('cover-page', 'cover.xhtml', page(title, f'<section epub:type="cover"><h1>{title}</h1>{artwork}</section>')))
        spine.append('cover-page')
    elif not sections or not any(section["body"] for section in sections):
        documents.append(('title-page', 'title.xhtml', page(title, f'<h1>{title}</h1>')))
        spine.append('title-page')
    entries = []
    for section in sections:
        heading = f'<h{section["level"]}>{x(section["title"])}</h{section["level"]}>' if section["level"] else f'<h1>{title}</h1>'
        body = ''.join('<p>' + x(line) + '</p>' if line else '<p class="blank">&#160;</p>' for line in paragraphs(section["body"])) if section["body"] else ''
        name = section['id'] + '.xhtml'
        documents.append((section['id'], name, page(x(section["title"]) or title, f'<section>{heading}{body}</section>')))
        spine.append(section['id'])
        entries.append((section["level"], name, section["title"] or book.get("title", "")))
    # Flat HTML lists retain visual hierarchy without requiring readers to infer
    # nesting from chapter numbers. Every active section has a stable target.
    links = ''.join(f'<li class="level-{level}"><a href="{name}">{x(label)}</a></li>' for level, name, label in entries)
    nav_label = "Contents" if options["lang"] == "en" else "目录"
    nav = page(nav_label, f'<nav epub:type="toc" id="toc"><h1>{nav_label}</h1><ol>{links}</ol></nav>')
    if options['toc'] and book['kind'] == 'long':
        spine.insert(1 if options['cover'] else 0, 'nav')
    manifest = ''.join(f'<item id="{id_}" href="{name}" media-type="application/xhtml+xml"/>' for id_, name, _ in documents)
    manifest += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>'
    if image:
        manifest += f'<item id="cover-image" href="cover.{image["kind"]}" media-type="{image["mime"]}" properties="cover-image"/>'
    identifier = "urn:sha256:" + hashlib.sha256(str(book.get("id", "")).encode("utf-8")).hexdigest()
    modified = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    opf = f'<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="{language}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">{identifier}</dc:identifier><dc:title>{title}</dc:title><dc:language>{language}</dc:language><meta property="dcterms:modified">{modified}</meta></metadata><manifest>{manifest}</manifest><spine>' + ''.join(f'<itemref idref="{id_}"/>' for id_ in spine) + '</spine></package>'
    css = f'body{{font-family:"{options["fontFamily"]}",serif;line-height:{options["lineHeight"]};margin:1em;font-size:{options["font"]}pt;color:#111;background:#fff}}h1,h2{{line-height:1.5;page-break-after:avoid}}h1{{font-size:{options["chapterSize"] + 4}pt}}h2{{font-size:{options["chapterSize"]}pt}}h1,h2{{text-align:{options["chapterAlign"]};font-weight:{700 if options["chapterBold"] else 400}}}p{{margin:0 0 {options["paragraphSpace"]}pt;text-indent:{options["firstLineIndent"]}em;white-space:pre-wrap;overflow-wrap:anywhere}}img.cover{{display:block;max-width:100%;max-height:85vh;margin:1em auto}}ol{{list-style:none;padding:0}}li{{margin:.5em 0}}li.level-2{{margin-left:1.4em}}.blank{{min-height:1em}}'
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        archive.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        archive.writestr('OEBPS/content.opf', opf)
        archive.writestr('OEBPS/nav.xhtml', nav)
        archive.writestr('OEBPS/style.css', css)
        for _, name, content in documents:
            archive.writestr('OEBPS/' + name, content)
        if image:
            archive.writestr('OEBPS/cover.' + image['kind'], image['data'])
    return output.getvalue()


def export_html(book, options):
    sections, image = reading_sections(book, options['lang']), cover_image(book, options)
    esc = lambda value: html.escape(clean_xml(value), quote=True)
    title = esc(book.get('title', ''))
    content = []
    if options['cover']:
        artwork = f'<img src="{image["dataURL"]}" alt="{title}">' if image else ''
        content.append(f'<section class="formatted-cover"><h1>{title}</h1>{artwork}</section>')
    else:
        content.append(f'<h1 class="formatted-title">{title}</h1>')
    headings = [section for section in sections if section['level']]
    if options['toc'] and headings:
        links = ''.join(f'<li class="level-{section["level"]}"><a href="#{section["id"]}">{esc(section["title"])}</a></li>' for section in headings)
        content.append(f'<nav class="formatted-toc"><h1>{"Contents" if options["lang"] == "en" else "目录"}</h1><ol>{links}</ol></nav>')
    previous_level = None
    for section in sections:
        level = section['level']
        heading = f'<h{level} id="{section["id"]}">{esc(section["title"])}</h{level}>' if level else ''
        body = ''.join('<p>' + esc(line) + '</p>' if line else '<p class="blank">&#160;</p>' for line in paragraphs(section['body'])) if section['body'] else ''
        page = ' new-page' if previous_level is not None and options['chapterPageBreak'] and (level == 1 or previous_level == 2) else ''
        content.append(f'<section class="formatted-section{page}">{heading}{body}</section>')
        previous_level = level
    paper = options['paper'].upper()
    page_size = f"{options['pageWidth']}mm {options['pageHeight']}mm"
    page_margins = ' '.join(str(options['margin' + side]) + 'mm' for side in ('Top', 'Right', 'Bottom', 'Left'))
    title_size = 14 if len(book.get('title', '')) > 120 else 18 if len(book.get('title', '')) > 60 else 22
    available_height = options['pageHeight'] - options['marginTop'] - options['marginBottom']
    available_width = options['pageWidth'] - options['marginLeft'] - options['marginRight']
    title_rows = max(1, math.ceil(sum(0.6 if ord(char) < 128 else 1 for char in book.get('title', '')) * title_size / (available_width * 72 / 25.4)))
    image_height = str(max(20, min(140 if paper == 'A5' else 210, available_height - title_rows * title_size * 1.5 * 25.4 / 72 - 16))) + 'mm'
    css = f'''@page{{size:{page_size};margin:{page_margins}}}#formatted-print-root{{color:#111;background:#fff;font-family:"{options['fontFamily']}","Noto Serif CJK SC","Songti SC",Georgia,serif;font-size:{options['font']}pt;line-height:{options['lineHeight']}}}#formatted-print-root h1,#formatted-print-root h2{{color:#000;line-height:1.5;break-after:avoid;text-align:{options['chapterAlign']};font-weight:{700 if options['chapterBold'] else 400}}}#formatted-print-root h1{{font-size:{options['chapterSize'] + 4}pt;margin:0 0 1.2em}}#formatted-print-root h2{{font-size:{options['chapterSize']}pt;margin:0 0 1.3em}}#formatted-print-root p{{margin:0 0 {options['paragraphSpace']}pt;text-indent:{options['firstLineIndent']}em;white-space:pre-wrap;overflow-wrap:anywhere;orphans:2;widows:2}}#formatted-print-root .blank{{min-height:1em}}#formatted-print-root .formatted-cover{{text-align:center;break-after:page}}#formatted-print-root .formatted-cover h1{{overflow-wrap:anywhere;max-width:100%;font-size:{title_size}pt;margin:0 0 8mm}}#formatted-print-root .formatted-cover img{{display:block;max-width:100%;max-height:{image_height};width:auto;height:auto;margin:0 auto;object-fit:contain}}#formatted-print-root .formatted-toc{{break-after:page}}#formatted-print-root .formatted-toc ol{{list-style:none;padding:0}}#formatted-print-root .formatted-toc li{{margin:.4em 0}}#formatted-print-root .formatted-toc li.level-2{{margin-left:1.4em}}#formatted-print-root a{{color:#111;text-decoration:none}}#formatted-print-root .new-page{{break-before:page}}'''
    return f'<!doctype html><html lang="{options["lang"]}"><head><meta charset="utf-8"><title>{title}</title><style id="formatted-book-styles">{css}</style></head><body><main class="formatted-book">{"".join(content)}</main></body></html>'.encode('utf-8')


def render_book_export(book, format_, options=None):
    """Return content, MIME, download name; no library/filesystem side effects."""
    if format_ not in ('docx', 'epub', 'html'):
        raise ValueError('不支持这个导出格式')
    checked = options_checked(options)
    if book.get('deletedAt'):
        raise ValueError('请先恢复这部作品，再导出正文')
    content = {'docx': export_docx, 'epub': export_epub, 'html': export_html}[format_](book, checked)
    mime = {'docx': DOCX_MIME, 'epub': EPUB_MIME, 'html': 'text/html; charset=utf-8'}[format_]
    return content, mime, safe_filename(book.get('title', ''), '.' + format_)
