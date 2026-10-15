"""Pure offline import checks. No real library, provider, or user files."""
import io
import json
from pathlib import Path
import sys
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from manuscript_import import MAX_FILE_BYTES, make_book, prepare_import
from formatted_export import render_book_export, reading_sections

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def docx(xml, extras=None, compression=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression) as archive:
        archive.writestr('[Content_Types].xml', '<Types/>')
        archive.writestr('word/document.xml', xml)
        for name, value in (extras or {}).items():
            archive.writestr(name, value)
    return out.getvalue()


def text_export(book, markdown=False):
    result = ('# ' if markdown else '') + book['title'] + '\n\n'
    for section in reading_sections(book):
        result += ('#' * (section['level'] + 1) + ' ' if markdown else '') + section['title'] + '\n\n'
        if section['body']:
            result += section['body'] + '\n\n\n'
    return result


class ManuscriptImportTests(unittest.TestCase):
    def test_full_101506_character_sample_txt_md_docx_round_trips(self):
        original = json.loads((ROOT / 'examples/tide-archive.yejian.json').read_text('utf-8'))['book']
        expected = [c for c in original['chapters'] if not c['deletedAt']]
        inputs = [('潮汐档案馆.txt', ('\ufeff' + text_export(original)).encode()),
                  ('潮汐档案馆.md', text_export(original, True).encode())]
        for toc in (True, False):
            content, _, name = render_book_export(original, 'docx', {'toc': toc, 'cover': False})
            inputs.append((name, content))
        for name, content in inputs:
            with self.subTest(name=name, size=len(content)):
                preview = prepare_import(content, name)
                self.assertEqual(preview['words'], 101506)
                self.assertEqual(len(preview['volumes']), 6)
                self.assertEqual(len(preview['chapters']), 36)
                self.assertEqual([c['title'] for c in preview['chapters']], [c['title'] for c in expected])
                self.assertEqual([c['body'] for c in preview['chapters']], [c['body'] for c in expected])
                self.assertEqual(preview['title'], original['title'])
                created = make_book(preview)
                self.assertNotEqual(created['id'], original['id'])
                self.assertTrue(set(c['id'] for c in created['chapters']).isdisjoint(c['id'] for c in expected))

    def test_encodings_crlf_unicode_and_explicit_failure(self):
        text = '第一卷 出发\r\n\r\n第一章 船票\r\n\r\n旧船票。\r\n第二段。'
        for encoding in ('utf-8-sig', 'utf-16', 'gb18030'):
            with self.subTest(encoding=encoding):
                result = prepare_import(text.encode(encoding), '稿件.txt')
                self.assertEqual(result['chapters'][0]['body'], '旧船票。\n第二段。')
                self.assertEqual(result['encoding'], encoding)
        result = prepare_import('第一章 🦋\n正文𠮷。'.encode(), 'unicode.txt')
        self.assertEqual(result['chapters'][0]['body'], '正文𠮷。')
        with self.assertRaises(ValueError):
            prepare_import(text.encode('gb18030'), '稿件.txt', options={'encoding': 'utf-8'})

    def test_preface_repeated_titles_volume_prose_and_empty_chapters_survive(self):
        text = '献给港口的人。\n\n第一卷 潮声\n\n卷前说明。\n\n第一章 来信\n\n正文甲。\n\n第一章 来信\n\n正文乙。\n\n第二章 空章\n'
        result = prepare_import(text.encode(), '小说.txt')
        self.assertEqual([c['title'] for c in result['chapters']], ['前言', '前言', '第一章 来信', '第一章 来信', '第二章 空章'])
        self.assertEqual([c['body'] for c in result['chapters']], ['献给港口的人。', '卷前说明。', '正文甲。', '正文乙。', ''])
        self.assertIsNone(result['chapters'][0]['volumeKey'])
        self.assertEqual(result['chapters'][1]['volumeKey'], 'v0')

    def test_plain_short_paragraphs_are_not_invented_as_titles(self):
        text = '码头\n\n潮水已经退去。\n第一个人抬起手。\n第一章的故事还没讲完。'
        result = prepare_import(text.encode(), '小说.txt')
        self.assertEqual(len(result['chapters']), 1)
        self.assertEqual(result['chapters'][0]['body'], text)
        self.assertFalse(result['volumes'])

    def test_titles_without_separating_spaces_and_docx_single_volume(self):
        result = prepare_import('献词。\n第一卷潮声\n第一章未拆的船票\n正文甲。\n第01章夜归\n正文乙。\n第二章空章'.encode(), '小说.txt')
        self.assertEqual([v['title'] for v in result['volumes']], ['第一卷潮声'])
        self.assertEqual([c['title'] for c in result['chapters']], ['前言', '第一章未拆的船票', '第01章夜归', '第二章空章'])
        self.assertEqual(result['chapters'][-1]['body'], '')
        xml = f'<w:document xmlns:w="{W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>卷一潮声</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>旧船票</w:t></w:r></w:p><w:p><w:r><w:t>正文。</w:t></w:r></w:p></w:body></w:document>'
        result = prepare_import(docx(xml), '小说.docx')
        self.assertEqual(result['volumes'][0]['title'], '卷一潮声')
        self.assertEqual(result['chapters'][0]['title'], '旧船票')

    def test_markdown_fences_setext_hierarchy_and_single_strategy(self):
        text = '# 海边来信\n\n## 出发\n\n### 旧船票\n\n正文。\n```txt\n# 这不是标题\n第一章 也不是标题\n```\n\n### 归来\n第二段。'
        result = prepare_import(text.encode(), '小说.md')
        self.assertEqual(result['title'], '海边来信')
        self.assertEqual([v['title'] for v in result['volumes']], ['出发'])
        self.assertEqual([c['title'] for c in result['chapters']], ['旧船票', '归来'])
        self.assertIn('第一章 也不是标题', result['chapters'][0]['body'])
        text = '书名\n===\n\n旧船票\n---\n正文。\n\n归来\n---\n尾声。'
        result = prepare_import(text.encode(), '小说.md')
        self.assertEqual(result['title'], '书名')
        self.assertEqual([c['title'] for c in result['chapters']], ['旧船票', '归来'])
        self.assertNotIn('===', result['chapters'][0]['body'])
        result = prepare_import('第一章 来信\n正文。\n第二章 归来\n尾声。'.encode(), '小说.txt', options={'strategy': 'single'})
        self.assertEqual(len(result['chapters']), 1)
        self.assertIn('第二章 归来', result['chapters'][0]['body'])

    def test_short_story_always_keeps_one_continuous_manuscript(self):
        text = '# 海边来信\n\n## 第一章 旧船票\n\n正文。\n\n## 第二章 归来\n\n尾声。'
        for strategy in ('auto', 'chinese', 'headings', 'single'):
            result = prepare_import(text.encode(), '短篇.md', 'short', options={'strategy': strategy})
            self.assertFalse(result['volumes'])
            self.assertEqual(len(result['chapters']), 1)
            self.assertIsNone(result['chapters'][0]['volumeKey'])
            self.assertIn('## 第一章 旧船票', result['chapters'][0]['body'])
            self.assertIn('尾声。', result['chapters'][0]['body'])
            self.assertFalse(make_book(result)['volumes'])

    def test_edits_have_stable_keys_validate_titles_and_new_ids_each_time(self):
        raw = '第一卷 出发\n第一章 旧船票\n正文。'.encode()
        before = prepare_import(raw, '小说.txt')
        after = prepare_import(raw, '小说.txt', title='重命名作品', edits={'volumes': {'v0': '归港'}, 'chapters': {'c0': '收信'}})
        self.assertEqual(before['sourceHash'], after['sourceHash'])
        self.assertEqual(after['volumes'][0]['title'], '归港')
        self.assertEqual(after['chapters'][0]['title'], '收信')
        self.assertEqual(after['chapters'][0]['body'], before['chapters'][0]['body'])
        self.assertNotEqual(make_book(after)['chapters'][0]['id'], make_book(after)['chapters'][0]['id'])
        for edits in ({'chapters': {'other': 'x'}}, {'chapters': {'c0': ''}}, {'volumes': {'v0': 'x'*201}}, {'chapterIds': []}):
            with self.subTest(edits=edits), self.assertRaises(ValueError):
                prepare_import(raw, '小说.txt', edits=edits)
        with self.assertRaises(ValueError):
            prepare_import(raw, '小说.txt', 'short', edits={'chapters': {'c0': '新章'}})

    def test_docx_custom_heading_styles_tables_tabs_breaks_and_toc(self):
        xml = f'<w:document xmlns:w="{W}"><w:body><w:p><w:pPr><w:pStyle w:val="MyHeading"/></w:pPr><w:r><w:t>旧船票</w:t></w:r></w:p><w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>人名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>沈砚</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        styles = f'<w:styles xmlns:w="{W}"><w:style w:styleId="MyHeading"><w:name w:val="heading 1"/></w:style></w:styles>'
        result = prepare_import(docx(xml, {'word/styles.xml': styles, 'word/_rels/document.xml.rels': '<external href="https://invalid.test/"/>'}), '小说.docx')
        self.assertEqual(result['chapters'][0]['title'], '旧船票')
        self.assertEqual(result['chapters'][0]['body'], '甲\t乙\n丙\n人名\t沈砚')

    def test_reject_bad_zip_paths_macros_entities_bombs_and_excess_entries(self):
        normal = f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>正文。</w:t></w:r></w:p></w:body></w:document>'
        cases = [b'not zip', docx('<bad'), docx(normal, {'../outside': 'x'}), docx(normal, {'word/vbaProject.bin': 'x'}), docx('<!DOCTYPE x [<!ENTITY secret "bad">]>'+normal), docx(normal, {'huge': b'a'*(25*1024*1024)}), docx(normal, {f'p{i}': '' for i in range(2001)})]
        for content in cases:
            with self.subTest(size=len(content)), self.assertRaises(ValueError):
                prepare_import(content, '稿件.docx')
        with self.assertRaises(ValueError):
            prepare_import(docx(('<!DOCTYPE x>'+normal).encode('utf-16')), '稿件.docx')

    def test_invalid_inputs_and_budgets_rejected_before_book_creation(self):
        cases = [(b'', 'a.txt', 'long', None), (b'x'*(MAX_FILE_BYTES+1), 'a.txt', 'long', None), (b'\x00\x01', 'a.txt', 'long', None), (b'x', '../a.txt', 'long', None), (b'x', 'a.doc', 'long', None), (b'x', 'a.txt', 'medium', None), (b'x', 'a.txt', 'long', {'strategy': 'guess'}), (b'x', 'a.txt', 'long', {'encoding': 'latin1'}), (b'x', 'a.txt', 'long', {'unknown': True})]
        for content, filename, kind, options in cases:
            with self.subTest(filename=filename, options=options), self.assertRaises(ValueError):
                prepare_import(content, filename, kind, options=options)
        with self.assertRaises(ValueError):
            prepare_import(('第一章 过长\n'+'甲'*5_000_001).encode('gb18030'), '小说.txt')


if __name__ == '__main__':
    unittest.main(verbosity=2)
