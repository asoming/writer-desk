'use strict';

// Exercise the actual writing helpers with the small DOM used by the outline
// workflow checks. No browser profile, local server or personal library is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);

function matches(node, selector) {
  if (selector.startsWith('.')) return (node.className || '').split(/\s+/).includes(selector.slice(1));
  const attribute = selector.match(/^\[data-([a-z-]+)\]$/);
  if (attribute) return attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in node.dataset;
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

class Element {
  constructor(tag = 'div') {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], value: '', textContent: '', dataset: {},
      attributes: {}, listeners: {}, hidden: false, open: false, scrollTop: 0, style: {} });
    const update = (name, enabled) => {
      const names = new Set((this.className || '').split(/\s+/).filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    };
    this.classList = { add: name => update(name, true), remove: name => update(name, false),
      toggle: (name, force) => update(name, force ?? !(this.className || '').split(/\s+/).includes(name)) };
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  contains(node) { return node === this || descendants(this).includes(node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  scrollIntoView() {}
}

function harness(book) {
  const elements = new Map();
  const get = id => {
    for (const node of elements.values()) {
      const child = descendants(node).find(element => element.id === id);
      if (child) return child;
    }
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0 };
  const T = (value, ...args) => Array.isArray(value)
    ? value.reduce((text, part, index) => text + part + (args[index] ?? ''), '')
    : String(value).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), addEventListener() {} },
    addEventListener() {}, crypto: { randomUUID }, sessionStorage: storage, clientStorage: storage, T,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
  });
  context.window = context;
  for (const file of ['public/app.js', 'public/workspace.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  // Keep manuscript selection, directory rendering, stats, forms and saving
  // guards real; unrelated atlas/outline surfaces are outside these tests.
  vm.runInContext('renderBacklinks=()=>{};renderShell=()=>{};', context);
  const run = expression => vm.runInContext(expression, context);
  const state = run('state');
  state.book = book; state.kind = book.kind; state.view = 'write';
  state.chapterId = book.chapters.find(chapter => !chapter.deletedAt)?.id || null;
  state.collapsedVolumes = new Set();
  run('normalizeWorkspaceBook(state.book)');
  return { context, state, get, run };
}

function shortBook() {
  return { id: 'short-book', kind: 'short', title: '雨停之前', volumes: [], notes: [], outline: [], relations: [],
    chapters: [{ id: 'body', title: '正文', body: '许宁开门。', volumeId: null, deletedAt: null }] };
}

function legacyBook() {
  const book = shortBook();
  book.chapters = [
    { id: 'recycled', title: '回收旧稿', body: '还没用的开场', volumeId: null, deletedAt: '2026-10-10' },
    { id: 'first', title: '原来的开头', body: '  许宁🌧\n', volumeId: null, deletedAt: null },
    { id: 'second', title: '原来的结尾', body: '\n来客还伞。  ', volumeId: null, deletedAt: null },
    { id: 'empty', title: '待写', body: '', volumeId: null, deletedAt: null },
  ];
  book.notes = [{ id: 'person', type: '人物', title: '许宁', body: '', chapterIds: ['second', 'first', 'recycled'] }];
  book.outline = [{ id: 'plan', title: '相遇', body: '', chapterIds: ['second', 'empty'] }];
  book.relations = [{ id: 'relation', chapterIds: ['second'] }];
  return book;
}

function longBook() {
  return { id: 'long-book', kind: 'long', title: '潮汐之间',
    volumes: [{ id: 'volume', title: '第一卷', summary: '', deletedAt: null },
      { id: 'archived-volume', title: '回收卷', summary: '', deletedAt: '2026-10-10' }],
    chapters: [
      { id: 'first', title: '第一章 开门', body: '甲乙\n\n A🌧', volumeId: 'volume', deletedAt: null },
      { id: 'second', title: '第二章 还伞', body: '丙丁戊', volumeId: 'volume', deletedAt: null },
      { id: 'recycled', title: '回收章', body: '这些字不应计数', volumeId: 'volume', deletedAt: '2026-10-10' },
      { id: 'archived-volume-body', title: '回收卷正文', body: '这些也不计数', volumeId: 'archived-volume', deletedAt: '2026-10-10' },
    ], notes: [], outline: [{ id: 'plan', title: '计划', body: '', chapterIds: ['second'] }], relations: [] };
}

const checks = [];
const check = (name, test) => checks.push({ name, test });

check('legacy short text merges verbatim with UTF-16 locations and stable links', () => {
  const h = harness(legacyBook()), recycled = plain(h.state.book.chapters[0]);
  const result = h.run('normalizeShortManuscript(state.book)');
  assert.equal(result.changed, true);
  assert.equal(result.manuscript.id, 'first');
  assert.equal(result.manuscript.title, '原来的开头');
  assert.equal(result.manuscript.body, '  许宁🌧\n\n\n\n来客还伞。  \n\n');
  assert.deepEqual(plain(h.state.book.shortSections), [
    { id: 'first', title: '原来的开头', start: 0, end: 7 },
    { id: 'second', title: '原来的结尾', start: 9, end: 17 },
    { id: 'empty', title: '待写', start: 19, end: 19 },
  ]);
  assert.deepEqual(plain(h.state.book.chapters[0]), recycled);
  assert.deepEqual(plain(h.state.book.notes[0].chapterIds), ['first', 'recycled']);
  assert.deepEqual(plain(h.state.book.outline[0].chapterIds), ['first']);
  assert.deepEqual(plain(h.state.book.relations[0].chapterIds), ['first']);
  const snapshot = JSON.stringify(h.state.book);
  assert.equal(h.run('normalizeShortManuscript(state.book).changed'), false);
  assert.equal(JSON.stringify(h.state.book), snapshot);
});

check('single-body aliases clamp after editing, deduplicate, and preserve actual recycled IDs', () => {
  const book = shortBook();
  book.chapters.push({ id: 'recycled', title: '旧稿', body: '保留的内容', volumeId: null, deletedAt: '2026-10-10' });
  book.shortSections = [
    { id: 'body', title: '第一段', start: 0, end: 10 },
    { id: 'former', title: '第二段', start: 12, end: 20 },
    { id: 'former', title: '重复定位', start: 12, end: 20 },
    { id: 'recycled', title: '旧定位', start: 0, end: 3 },
  ];
  book.outline = [{ id: 'plan', title: '计划', chapterIds: ['former', 'body', 'recycled'] }];
  const h = harness(book); h.run('normalizeShortManuscript(state.book)');
  assert.deepEqual(plain(book.outline[0].chapterIds), ['body', 'recycled']);
  assert.deepEqual(plain(book.shortSections).map(section => [section.id, section.start, section.end]),
    [['body', 0, 5], ['former', 5, 5], ['recycled', 0, 3]]);
  assert.equal(h.run('resolveShortManuscriptId("former")'), 'body');
  assert.equal(h.run('resolveShortManuscriptId("recycled")'), 'recycled');
  assert.equal(h.run('resolveShortManuscriptId("unknown")'), 'unknown');
  assert.equal(h.run('normalizeShortManuscript(state.book).changed'), false);
});

check('restoring an earlier recycled body keeps former locations at their new offsets', () => {
  const h = harness(legacyBook()); h.run('normalizeShortManuscript(state.book)');
  const before = plain(h.state.book.shortSections), body = h.state.book.chapters[1].body;
  h.state.book.chapters[0].deletedAt = null;
  h.run('normalizeShortManuscript(state.book)');
  const manuscript = h.state.book.chapters[0];
  assert.equal(manuscript.id, 'recycled');
  assert.equal(manuscript.body, '还没用的开场\n\n' + body);
  assert.deepEqual(plain(h.state.book.shortSections), [
    { id: 'recycled', title: '回收旧稿', start: 0, end: 6 },
    ...before.map(section => ({ ...section, start: section.start + 8, end: section.end + 8 })),
  ]);
  assert.equal(h.run('normalizeShortManuscript(state.book).changed'), false);
});

check('an all-recycled story gets a deterministic nonconflicting empty body', () => {
  const book = shortBook(); book.id = 's'.repeat(90);
  const prefix = 's'.repeat(70) + '-manuscript';
  book.chapters = [prefix, prefix + '-1'].map(id => ({ id, title: '回收正文', body: '保留', volumeId: null, deletedAt: '2026-10-10' }));
  const preserved = plain(book.chapters), h = harness(book);
  const result = h.run('normalizeShortManuscript(state.book)');
  assert.equal(result.manuscript.id, prefix + '-2');
  assert.equal(result.manuscript.body, '');
  assert.deepEqual(plain(book.chapters.slice(0, 2)), preserved);
  assert.equal(h.run('normalizeShortManuscript(state.book).changed'), false);
});

check('short writing always reuses its body and exposes no chapter title or tools', () => {
  const book = shortBook(), h = harness(book), before = JSON.stringify(book.chapters);
  h.context.requestedTitle = '不应新建的章节';
  const created = h.run('addChapter(requestedTitle)');
  assert.equal(created.id, 'body');
  assert.equal(JSON.stringify(book.chapters), before);
  h.run('moveChapter(1);confirmTrash("chapter");renameChapter("body");renderWorkspaceShell()');
  assert.equal(JSON.stringify(book.chapters), before);
  assert.equal(h.get('dialog').open, false);
  for (const id of ['sidebar', 'toggle-sidebar', 'add-chapter', 'add-volume', 'chapter-title', 'chapter-number', 'chapter-tools']) {
    assert.equal(h.get(id).hidden, true, id + ' must be hidden for short stories');
  }
  assert.equal(h.get('short-story-title').textContent, '雨停之前');
  assert.equal(h.get('editor').getAttribute('aria-label'), '正文');
  assert.equal(h.get('editor').value, '许宁开门。');
});

check('long directories expose a separate rename icon without changing chapter selection', () => {
  const h = harness(longBook()); h.context.renamed = [];
  h.run('renameChapter=id=>renamed.push(id);renderChapters()');
  const rows = h.get('chapter-list').querySelectorAll('.chapter-row');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const select = row.querySelector('.chapter-item'), rename = row.querySelector('.chapter-rename');
    assert.ok(rename && rename !== select);
    assert.equal(rename.getAttribute('aria-label'), '重命名章节：' + select.querySelector('.chapter-item-title').textContent);
    rename.listeners.click();
  }
  assert.deepEqual(plain(h.context.renamed), ['first', 'second']);
  assert.equal(h.state.chapterId, 'first');
});

async function rename(h, id, title) {
  h.context.targetId = id; h.run('renameChapter(targetId)');
  h.get('rename-chapter-title').value = title;
  const form = h.get('dialog-body').querySelector('form');
  assert.ok(form, 'The rename form must remain available');
  await form.listeners.submit({ preventDefault() {} });
}

check('renaming the selected chapter synchronizes its heading and preserves IDs, body and links', async () => {
  const h = harness(longBook()), before = plain(h.state.book);
  h.run('selectChapter("first");saveNow=async()=>{state.dirty=false;return true;}');
  await rename(h, 'first', '  第一章 雨后的门  ');
  assert.equal(h.state.book.chapters[0].title, '第一章 雨后的门');
  assert.equal(h.get('chapter-title').value, '第一章 雨后的门');
  assert.equal(h.state.chapterId, 'first');
  assert.equal(h.state.book.chapters[0].body, before.chapters[0].body);
  assert.deepEqual(plain(h.state.book.outline), before.outline);
  assert.equal(h.get('dialog').open, false);
  assert.equal(h.state.dirty, false);
});

check('renaming an unselected chapter retains the editor while updating its directory entry', async () => {
  const h = harness(longBook());
  h.run('selectChapter("first");saveNow=async()=>{state.dirty=false;return true;}');
  const beforeEditor = h.get('editor').value;
  await rename(h, 'second', '第二章 来客');
  assert.equal(h.state.chapterId, 'first');
  assert.equal(h.get('chapter-title').value, '第一章 开门');
  assert.equal(h.get('editor').value, beforeEditor);
  const target = h.get('chapter-list').querySelectorAll('[data-chapter]').find(node => node.dataset.chapter === 'second');
  assert.equal(target.querySelector('.chapter-item-title').textContent, '第二章 来客');
  assert.deepEqual(plain(h.state.book.outline[0].chapterIds), ['second']);
});

check('rename failure keeps the dialog and changed title available for retry', async () => {
  const h = harness(longBook()); h.run('selectChapter("first");saveNow=async()=>false;');
  await rename(h, 'second', '保存失败仍保留');
  assert.equal(h.get('dialog').open, true);
  assert.equal(h.state.book.chapters[1].title, '保存失败仍保留');
  assert.equal(h.get('rename-chapter-title').value, '保存失败仍保留');
  assert.equal(h.state.dirty, true);
  assert.equal(h.state.transitioning, false);
  h.run('saveNow=async()=>{state.dirty=false;return true;}');
  await h.get('dialog-body').querySelector('form').listeners.submit({ preventDefault() {} });
  assert.equal(h.get('dialog').open, false);
  assert.equal(h.state.book.chapters.length, 4);
});

check('directory total counts the entire active book regardless of search or folded volumes', () => {
  const h = harness(longBook()); h.run('selectChapter("first")');
  assert.equal(h.get('book-total-words').textContent, '总字数 7 字');
  h.get('chapter-search').value = '还伞'; h.run('renderChapters();renderStats()');
  assert.equal(h.get('chapter-list').querySelectorAll('[data-chapter]').length, 1);
  assert.equal(h.get('book-total-words').textContent, '总字数 7 字');
  h.get('chapter-search').value = '不会命中任何标题'; h.run('renderChapters();renderStats()');
  assert.equal(h.get('chapter-list').querySelectorAll('[data-chapter]').length, 0);
  assert.equal(h.get('book-total-words').textContent, '总字数 7 字');
  h.get('chapter-search').value = ''; h.state.collapsedVolumes.add('volume'); h.run('renderChapters();renderStats()');
  assert.equal(h.get('chapter-list').querySelectorAll('[data-chapter]').length, 0);
  assert.equal(h.get('book-total-words').textContent, '总字数 7 字');
  assert.equal(h.get('chapter-stats').textContent, '4 字');
});

(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed++; console.error('FAIL:', name, '\n ', error.stack); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
