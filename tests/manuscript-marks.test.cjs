'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const marks = require('../public/manuscript-marks.js');
let sequence = 0;
const book = body => ({id: 'book', kind: 'long', chapters: [{id: 'chapter', title: '一', body, deletedAt: null}], reviewTools: {...marks.defaults(), dictionary: ['林舟']}});
const add = (source, start, end, kind = 'annotations') => marks.createMark(source, kind, 'chapter', start, end, {id: 'mark-' + (++sequence), stamp: '2026-10-15T12:00:00Z'});
const edit = (source, after) => { const before = source.chapters[0].body; source.chapters[0].body = after; marks.reanchorChapter('chapter', before, after, source); };

test('selection and caret create a mark without altering manuscript or dictionary', () => {
  const source = book('第一段。\n\n  第二段。  \n末段。'), body = source.chapters[0].body;
  const annotation = add(source, 10, 10), bookmark = add(source, 0, 4, 'bookmarks');
  assert.equal(annotation.quote, '第二段。'); assert.equal(bookmark.quote, '第一段。'); assert.equal(source.chapters[0].body, body); assert.deepEqual(source.reviewTools.dictionary, ['林舟']);
  assert.throws(() => add(source, 5, 5), /有正文/);
});

test('typing before, inside, and after a passage preserves exact UTF-16 location', () => {
  const source = book('引子。\n目标段落。\n结尾。'), mark = add(source, 4, 9);
  edit(source, '新增😀\n' + source.chapters[0].body); assert.equal(mark.start, 9); assert.equal(mark.quote, '目标段落。');
  edit(source, source.chapters[0].body.replace('目标段落', '目标的新段落')); assert.equal(mark.quote, '目标的新段落。'); assert.equal(mark.status, 'linked');
  edit(source, source.chapters[0].body + '\n尾声。'); assert.equal(mark.status, 'linked'); assert.equal(source.chapters[0].body.slice(mark.start, mark.end), mark.quote);
});

test('global multiple edits preserve a unique unchanged passage by both context sides', () => {
  const source = book('改前。\n' + '甲'.repeat(90) + '\n选中的段落。\n' + '乙'.repeat(90) + '\n改后。');
  const at = source.chapters[0].body.indexOf('选中的段落'), mark = add(source, at, at + 7);
  edit(source, source.chapters[0].body.replace('改前', '前面改变了').replace('改后', '后面也改变了'));
  assert.equal(mark.status, 'linked'); assert.equal(source.chapters[0].body.slice(mark.start, mark.end), mark.quote);
});

test('deleting an original quote never jumps to a repeated copy elsewhere', () => {
  const source = book('一处开头\n同一句话。\n第一处末尾\n\n另一处开头\n同一句话。\n另一处末尾');
  const at = source.chapters[0].body.indexOf('同一句话。'), mark = add(source, at, at + 5); mark.body = '保留我的修改想法';
  edit(source, source.chapters[0].body.slice(0, at) + source.chapters[0].body.slice(at + 5));
  assert.equal(mark.status, 'orphaned'); assert.equal(mark.body, '保留我的修改想法'); assert.equal(mark.quote, '同一句话。'); assert.equal(mark.prefix, '');
});

test('adjacent identical paragraphs have ambiguous deletion alignment and both detach', () => {
  const source = book('开始\n重复段落。\n重复段落。\n结束');
  const first = source.chapters[0].body.indexOf('重复'), second = source.chapters[0].body.indexOf('重复', first + 1);
  const a = add(source, first, first + 5), b = add(source, second, second + 5);
  edit(source, source.chapters[0].body.slice(0, first) + source.chapters[0].body.slice(second));
  assert.equal(a.status, 'orphaned'); assert.equal(b.status, 'orphaned');
});

test('unchanged repeated paragraph outside a definite edit stays at its own occurrence', () => {
  const source = book('引言\n重复句子。\n中段不同\n重复句子。\n结语');
  const second = source.chapters[0].body.lastIndexOf('重复'), mark = add(source, second, second + 5);
  edit(source, '新开头\n' + source.chapters[0].body);
  assert.equal(mark.status, 'linked'); assert.equal(mark.start, second + 4);
});

test('complete replacement detaches and later equal text does not revive automatically', () => {
  const source = book('第一段。\n旧目标。\n末段。'), at = source.chapters[0].body.indexOf('旧目标'), mark = add(source, at, at + 4);
  edit(source, source.chapters[0].body.replace('旧目标。', '完全不同。')); assert.equal(mark.status, 'orphaned');
  edit(source, source.chapters[0].body.replace('完全不同。', '旧目标。')); assert.equal(mark.status, 'orphaned');
});

test('astral selections and context cannot contain split surrogate pairs', () => {
  const source = book('😀'.repeat(40) + '人物。' + '😀'.repeat(40)), mark = add(source, 80, 83);
  assert.equal(mark.prefix.length, 64); assert.equal(mark.suffix.length, 64); assert.equal([...mark.prefix].length, 32);
  assert.throws(() => add(source, 1, 3), /位置不正确/); assert.throws(() => add(book('甲'.repeat(20001)), 0, 20001), /20000/);
  edit(source, '😺'.repeat(40) + '人物。' + '😀'.repeat(40)); assert.equal(mark.status, 'linked'); assert.equal(mark.quote, '人物。');
});

test('explicit normalize detaches stale anchors but reanchor uses the before-body proof', () => {
  const source = book('前文\n需要批注的段落\n后文'), at = source.chapters[0].body.indexOf('需要'), mark = add(source, at, at + 7);
  source.chapters[0].body = '无关正文'; marks.normalize(source); assert.equal(mark.status, 'orphaned');
});

test('short-story merge remaps UTF-16 once and preserves unrelated recycled chapter', () => {
  const source = book('首篇😀\n\n次篇。'), first = add(source, 0, 4); source.kind = 'short';
  source.reviewTools.bookmarks = [{...first, id: 'second', chapterId: 'second', start: 0, end: 3, quote: '次篇。'}, {...first, id: 'old', chapterId: 'recycled'}];
  marks.remapShortLinks(source, new Set(['chapter', 'second', 'unknown']), 'chapter', new Set(['recycled']), {chapter: 0, second: 6});
  assert.equal(source.reviewTools.bookmarks[0].start, 6); assert.equal(source.reviewTools.bookmarks[0].chapterId, 'chapter'); assert.equal(source.reviewTools.bookmarks[1].chapterId, 'recycled');
  marks.remapShortLinks(source, ['chapter', 'second'], 'chapter', [], {second: 6}); assert.equal(source.reviewTools.bookmarks[0].start, 6);
});

test('all 6272 repeated-paragraph deletions either map the actual survivor or detach', () => {
  let cases = 0;
  for (let mask = 0; mask < 128; mask++) {
    const paragraphs = Array.from({length: 7}, (_, index) => mask >> index & 1 ? '同段。' : '另一段。'), before = paragraphs.join('\n');
    const starts = paragraphs.map((_, index) => paragraphs.slice(0, index).join('\n').length + (index ? 1 : 0));
    for (let removed = 0; removed < 7; removed++) for (let target = 0; target < 7; target++) {
      const source = book(before), start = starts[target], end = start + paragraphs[target].length, cutStart = starts[removed], cutEnd = cutStart + paragraphs[removed].length + (removed < 6 ? 1 : 0);
      const item = add(source, start, end), after = before.slice(0, cutStart) + before.slice(cutEnd); edit(source, after);
      if (item.status === 'linked') { assert.notEqual(target, removed); assert.equal(item.start, start >= cutEnd ? start - (cutEnd - cutStart) : start); }
      cases++;
    }
  }
  assert.equal(cases, 6272);
});

test('JSON round-trip and a 101506-character manuscript preserve marks in every chapter', () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/tide-archive.yejian.json'), 'utf8')).book, original = JSON.stringify(source);
  let count = 0; for (const chapter of source.chapters.filter(item => !item.deletedAt)) {
    const start = chapter.body.search(/\S/u), range = marks.paragraphRange(chapter.body, start, start);
    marks.createMark(source, 'annotations', chapter.id, range.start, range.end, {id: 'sample-' + count++, stamp: '2026-10-15T00:00:00Z'});
  }
  assert.equal(count, 36); const restored = JSON.parse(JSON.stringify(source));
  for (const chapter of restored.chapters.filter(item => !item.deletedAt)) {
    const before = chapter.body; chapter.body = '测试插入😀\n' + before; marks.reanchorChapter(chapter.id, before, chapter.body, restored);
  }
  assert.ok(restored.reviewTools.annotations.every(item => item.status === 'linked' && restored.chapters.find(chapter => chapter.id === item.chapterId).body.slice(item.start, item.end) === item.quote));
  assert.ok(!original.includes('sample-')); assert.deepEqual(source.chapters.map(chapter => chapter.body), JSON.parse(original).chapters.map(chapter => chapter.body));
});
