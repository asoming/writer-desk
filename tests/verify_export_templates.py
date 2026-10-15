"""All three export paths retain the full novel under customized layouts."""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from xml.etree import ElementTree as ET
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from export_templates import ExportTemplateStore, layout_checked, presets
from formatted_export import render_book_export, paragraphs
W={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
X={'h':'http://www.w3.org/1999/xhtml'}
BOOK=json.loads((ROOT/'examples/tide-archive.yejian.json').read_text())['book']
CUSTOM={'paper':'custom','pageWidth':180,'pageHeight':250,'font':13.5,'fontFamily':'Arial','marginTop':18,'marginRight':17,'marginBottom':16,'marginLeft':19,'lineHeight':2.1,'firstLineIndent':2,'paragraphSpace':4,'chapterSize':21,'chapterAlign':'center','chapterBold':False,'chapterPageBreak':False}
class ExportTemplateTests(unittest.TestCase):
    def test_store_reusable_editable_presets_independent_and_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            store=ExportTemplateStore(directory);value=store.get();self.assertEqual(len(value['templates']),3);self.assertFalse(store.path.exists())
            value['templates'][0]['name']='自己的模板';value['templates'][0]['layout']=CUSTOM
            saved=store.save(value);saved['templates'].clear();loaded=store.get();self.assertEqual(len(loaded['templates']),3)
            self.assertEqual(loaded['templates'][0]['layout']['font'],13.5)
            before=store.path.read_bytes()
            with self.assertRaises(ValueError):store.save({'version':1,'templates':[{'id':'x','name':'x','layout':{'fontFamily':'Arial; color:red'}}]})
            self.assertEqual(store.path.read_bytes(),before)
    def test_reject_unsafe_unknown_or_unusable_layout(self):
        for value in ({'fontFamily':'<script>'},{'marginLeft':51},{'lineHeight':float('inf')},{'font':True},{'chapterBold':1},{'paper':'custom','pageWidth':100,'marginLeft':50,'marginRight':50},{'pageWidth':99},{'pageHeight':451},{'css':'body{}'}):
            with self.subTest(value=value),self.assertRaises(ValueError):layout_checked(value)
        for paper in ('a4','a5','letter','custom'):self.assertEqual(layout_checked({'paper':paper})['paper'],paper)
    def test_full_101506_word_novel_integrity_and_all_layout_options_in_docx(self):
        before=copy.deepcopy(BOOK);content,_,_=render_book_export(BOOK,'docx',CUSTOM);archive=zipfile.ZipFile(io.BytesIO(content))
        doc=ET.fromstring(archive.read('word/document.xml'));styles=ET.fromstring(archive.read('word/styles.xml'))
        text=[node.text or '' for node in doc.findall('.//w:t',W)]
        for chapter in BOOK['chapters']:
            for line in paragraphs(chapter['body']):self.assertIn(line,text)
        size=doc.find('.//w:pgSz',W);self.assertEqual(size.get('{'+W['w']+'}w'),str(round(180*1440/25.4)))
        spacing=styles.find('.//w:docDefaults//w:spacing',W);self.assertEqual(spacing.get('{'+W['w']+'}line'),'504');self.assertEqual(spacing.get('{'+W['w']+'}after'),'80')
        self.assertIn(b'w:firstLineChars="200"',archive.read('word/styles.xml'));self.assertIn(b'w:ascii="Arial"',archive.read('word/styles.xml'))
        self.assertIn(b'w:jc w:val="center"',archive.read('word/styles.xml'));self.assertIn(b'w:b w:val="0"',archive.read('word/styles.xml'))
        self.assertEqual(BOOK,before)
    def test_full_epub_and_pdf_html_custom_styles_and_body_order(self):
        content,_,_=render_book_export(BOOK,'epub',CUSTOM);archive=zipfile.ZipFile(io.BytesIO(content));texts=[]
        for name in archive.namelist():
            if name.endswith('.xhtml') and name not in ('OEBPS/nav.xhtml','OEBPS/cover.xhtml'):
                texts.extend(node.text or '' for node in ET.fromstring(archive.read(name)).findall('.//h:p',X))
        expected=[line for chapter in BOOK['chapters'] for line in paragraphs(chapter['body']) if line]
        self.assertEqual([line for line in texts if line and line!='\xa0'],expected)
        css=archive.read('OEBPS/style.css').decode();self.assertIn('font-family:"Arial"',css);self.assertIn('line-height:2.1',css);self.assertIn('text-indent:2em',css);self.assertIn('font-size:21pt',css)
        html,_,_=render_book_export(BOOK,'html',CUSTOM);source=html.decode();self.assertIn('@page{size:180mm 250mm;margin:18mm 17mm 16mm 19mm}',source);self.assertIn('line-height:2.1',source);self.assertIn('font-weight:400',source);self.assertNotIn('formatted-section new-page',source)
        import html as html_module
        for line in expected:self.assertIn(html_module.escape(line,quote=True),source)
    def test_symlink_template_file_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            store=ExportTemplateStore(directory);other=Path(directory)/'other';other.write_text('{}');store.path.symlink_to(other)
            with self.assertRaises(ValueError):store.get()
            with self.assertRaises(ValueError):store.save({'version':1,'templates':presets()})
            self.assertEqual(other.read_text(),'{}')
if __name__=='__main__':unittest.main(verbosity=2)
