"""Exercise generated packages without external dependencies or user data."""
import base64
import copy
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from formatted_export import render_book_export, reading_sections

ROOT = Path(__file__).resolve().parents[1]
W = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
OPF = {'o': 'http://www.idpf.org/2007/opf'}
XHTML = {'h': 'http://www.w3.org/1999/xhtml'}


def novel(kind='long'):
    return {'id': 'export-test', 'title': '海边 & <书名> "一" 📘', 'kind': kind,
            'cover': 'data:image/png;base64,' + base64.b64encode((ROOT / 'examples/novel/cover.png').read_bytes()).decode(),
            'volumes': [{'id': 'v2', 'title': '第二卷 <归港>', 'deletedAt': None}, {'id': 'v1', 'title': '第一卷 & 出发', 'deletedAt': None}, {'id': 'trash-v', 'title': '回收卷', 'deletedAt': '2026-01-01'}] if kind == 'long' else [],
            'chapters': [{'id': 'c1', 'title': '第一章', 'volumeId': 'v1' if kind == 'long' else None, 'body': '正文甲 <script>alert("x")</script> &\n\n另起一行。', 'deletedAt': None}, {'id': 'c2', 'title': '第二章', 'volumeId': 'v2' if kind == 'long' else None, 'body': '正文乙 👨‍👩‍👧‍👦。', 'deletedAt': None}, {'id': 'c3', 'title': '已删除章', 'volumeId': 'v1', 'body': '不应导出这段回收正文', 'deletedAt': '2026-01-01'}, {'id': 'c4', 'title': '回收卷中的章', 'volumeId': 'trash-v', 'body': '回收卷中的正文不导出', 'deletedAt': None}],
            'notes': [{'body': '人物私密笔记不导出'}], 'outline': [{'body': '大纲也不在正文导出中'}]}


class FormattedExportTests(unittest.TestCase):
    def test_reading_order_and_recycled_content(self):
        sections = reading_sections(novel())
        self.assertEqual([part['title'] for part in sections], ['第二卷 <归港>', '第二章', '第一卷 & 出发', '第一章'])
        for format_ in ('docx', 'epub', 'html'):
            content, mime, filename = render_book_export(novel(), format_)
            self.assertTrue(content)
            self.assertTrue(mime)
            self.assertTrue(filename.endswith('.' + format_))
            text = content.decode() if format_ == 'html' else '\n'.join(zipfile.ZipFile(io.BytesIO(content)).read(name).decode(errors='replace') for name in zipfile.ZipFile(io.BytesIO(content)).namelist() if name.endswith(('.xml', '.xhtml')))
            for hidden in ('不应导出这段回收正文', '回收卷中的正文不导出', '人物私密笔记不导出', '大纲也不在正文导出中'):
                self.assertNotIn(hidden, text)
            self.assertIn('&lt;script&gt;', text)
            self.assertNotIn('<script>', text)

    def test_docx_xml_styles_bookmarks_and_embedded_cover(self):
        content, mime, _ = render_book_export(novel(), 'docx', {'paper': 'a5', 'font': 14})
        self.assertEqual(mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        archive = zipfile.ZipFile(io.BytesIO(content))
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
        doc = ET.fromstring(archive.read('word/document.xml'))
        texts = [node.text or '' for node in doc.findall('.//w:t', W)]
        self.assertIn(novel()['title'], texts)
        self.assertIn(novel()['chapters'][0]['body'].split('\n')[0], texts)
        self.assertEqual(len(doc.findall('.//w:bookmarkStart', W)), 4)
        self.assertEqual(len(doc.findall('.//w:hyperlink', W)), 4)
        self.assertEqual(doc.find('.//w:pgSz', W).get('{'+W['w']+'}w'), '8391')
        self.assertIn('word/media/cover.png', archive.namelist())
        self.assertNotIn('w:pgBorders', archive.read('word/document.xml').decode())
        styles = ET.fromstring(archive.read('word/styles.xml'))
        self.assertEqual(styles.find('.//w:docDefaults//w:sz', W).get('{'+W['w']+'}val'), '28')

    def test_epub_container_navigation_and_spine(self):
        content, mime, _ = render_book_export(novel(), 'epub')
        self.assertEqual(mime, 'application/epub+zip')
        archive = zipfile.ZipFile(io.BytesIO(content))
        first = archive.infolist()[0]
        self.assertEqual(first.filename, 'mimetype')
        self.assertEqual(first.compress_type, zipfile.ZIP_STORED)
        self.assertEqual(archive.read('mimetype'), b'application/epub+zip')
        for name in archive.namelist():
            if name.endswith(('.xml', '.opf', '.xhtml')):
                ET.fromstring(archive.read(name))
        opf = ET.fromstring(archive.read('OEBPS/content.opf'))
        manifest = {node.get('id'): node for node in opf.findall('o:manifest/o:item', OPF)}
        self.assertEqual(manifest['nav'].get('properties'), 'nav')
        self.assertEqual(manifest['cover-image'].get('properties'), 'cover-image')
        for node in opf.findall('o:spine/o:itemref', OPF):
            self.assertIn(node.get('idref'), manifest)
            self.assertIn('OEBPS/' + manifest[node.get('idref')].get('href'), archive.namelist())
        nav = ET.fromstring(archive.read('OEBPS/nav.xhtml'))
        for link in nav.findall('.//h:a', XHTML):
            self.assertIn('OEBPS/' + link.get('href'), archive.namelist())
        self.assertEqual(len(nav.findall('.//h:a', XHTML)), 4)

    def test_short_manuscript_has_no_chapter_headings_or_toc(self):
        book = novel('short')
        book['chapters'] = book['chapters'][:2]
        self.assertEqual(len(reading_sections(book)), 1)
        for format_ in ('docx', 'epub', 'html'):
            content, _, _ = render_book_export(book, format_, {'cover': False, 'toc': True})
            if format_ == 'docx':
                doc = ET.fromstring(zipfile.ZipFile(io.BytesIO(content)).read('word/document.xml'))
                self.assertEqual(len(doc.findall('.//w:hyperlink', W)), 0)
                for node in doc.findall('.//w:pStyle', W):
                    self.assertNotIn(node.get('{'+W['w']+'}val'), ('Heading1', 'Heading2'))
            elif format_ == 'epub':
                opf = ET.fromstring(zipfile.ZipFile(io.BytesIO(content)).read('OEBPS/content.opf'))
                self.assertEqual([node.get('idref') for node in opf.findall('o:spine/o:itemref', OPF)], ['body'])
            else:
                self.assertNotIn('class="formatted-toc"', content.decode())
            self.assertNotIn('第一章'.encode(), content)

    def test_options_reject_invalid_requests_and_unsafe_cover_sources(self):
        for options in ({'paper': 'letter'}, {'font': True}, {'font': 13}, {'cover': 'yes'}, {'lang': 'unknown'}, {'path': '/tmp/file'}, []):
            with self.subTest(options=options), self.assertRaises(ValueError):
                render_book_export(novel(), 'docx', options)
        for source in ('https://example.com/cover.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA', 'data:image/png;base64,!!!'):
            book = novel();book['cover'] = source
            with self.subTest(source=source), self.assertRaises(ValueError):
                render_book_export(book, 'epub')
        with self.assertRaises(ValueError):
            render_book_export(novel(), 'pdf')
        book = novel();book['deletedAt'] = '2026-01-01'
        with self.assertRaises(ValueError):
            render_book_export(book, 'docx')

    def test_export_does_not_mutate_book_or_include_forbidden_xml_characters(self):
        book = novel();book['chapters'][0]['body'] += '\x00\x01\ud800'
        previous = copy.deepcopy(book)
        for format_ in ('docx', 'epub', 'html'):
            content, _, filename = render_book_export(book, format_, {'cover': False, 'toc': False})
            self.assertNotIn('\x00'.encode(), content if format_ == 'html' else b'')
            self.assertNotIn('<', filename)
        self.assertEqual(book, previous)

    def test_full_demo_exports_every_authored_chapter_once(self):
        book = json.loads((ROOT / 'examples/tide-archive.yejian.json').read_text('utf-8'))['book']
        for format_ in ('docx', 'epub', 'html'):
            content, _, _ = render_book_export(book, format_, {'cover': True, 'toc': True})
            if format_ == 'docx':
                doc = ET.fromstring(zipfile.ZipFile(io.BytesIO(content)).read('word/document.xml'))
                prose = '\n'.join(node.text or '' for node in doc.findall('.//w:t', W))
                self.assertEqual(len(doc.findall('.//w:bookmarkStart', W)), 42)
            elif format_ == 'epub':
                archive = zipfile.ZipFile(io.BytesIO(content))
                self.assertEqual(sum(name.startswith('OEBPS/part-') and name.endswith('.xhtml') for name in archive.namelist()), 42)
                prose = '\n'.join(archive.read(name).decode() for name in archive.namelist() if name.startswith('OEBPS/part-'))
            else:
                prose = content.decode()
            for chapter in book['chapters']:
                self.assertIn(chapter['body'].splitlines()[0], prose)


if __name__ == '__main__':
    unittest.main()
