'use strict';

// Run the real shelf entry, metadata form, and persistence code in a small DOM.
// API responses and image decoding are isolated; no user's library is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.textContent = '';
    this.hidden = false; this.open = false; this.inert = false; this.listeners = {}; this.attributes = {};
    this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} };
  }
  append(...children) { for (const child of children) { this.children.push(child); if (typeof child === 'object') child.parentElement = this; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  getContext() { return { fillRect() {}, drawImage() {} }; }
  toDataURL() { return 'data:image/jpeg;base64,dXBsb2FkZWQtY292ZXI='; }
}
function descendants(element) { return element.children.flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []); }
function text(element) { return [element.textContent, ...descendants(element).map(child => child.textContent)].filter(Boolean).join(' '); }
function book(id, kind = 'long') {
  return { id, title: '作品 ' + id, kind, cover: 'data:image/jpeg;base64,b2xkLWNvdmVy',
    volumes: kind === 'long' ? [{ id: id + '-volume', title: '第一卷', summary: '卷纲', deletedAt: null }] : [],
    chapters: [{ id: id + '-chapter', title: '正文', body: id + ' 这段正文和它的关联不得被作品信息覆盖。', volumeId: kind === 'long' ? id + '-volume' : null, deletedAt: null }],
    outline: [{ id: id + '-outline', title: '总纲', body: '大纲内容', kind: 'story', chapterIds: [id + '-chapter'], parentId: null, deletedAt: null }],
    notes: [{ id: id + '-person', title: '张岚', type: '人物', body: '人物履历', chapterIds: [id + '-chapter'], aliases: [], profile: {}, deletedAt: null }],
    relations: [], atlasViews: [] };
}
function harness({ language = 'zh', kind = 'long', current = true, dirty = false } = {}) {
  const elements = new Map(), storageData = new Map([['writer-desk.language', language]]), removedKeys = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const storage = { getItem: key => storageData.get(key) ?? null, setItem: (key, value) => storageData.set(key, value),
    removeItem: key => { removedKeys.push(key); storageData.delete(key); }, getLength: () => storageData.size,
    key: index => [...storageData.keys()][index] };
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), title: '', body: {}, documentElement: {},
      createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] },
    crypto: { randomUUID }, sessionStorage: storage, localStorage: storage, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    createImageBitmap: async () => ({ width: 600, height: 800, close() {} }),
  });
  context.window = context;
  for (const file of ['public/i18n.js', 'public/app.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  vm.runInContext('renderBacklinks=()=>{};openBook=()=>{throw new Error("Metadata editing must not navigate into a book")};setBook=()=>{throw new Error("Metadata editing must not replace the current book")};', context);
  const state = vm.runInContext('state', context), books = new Map();
  for (const [id, type, revision] of [['active', 'long', 7], ['long-target', 'long', 31], ['short-target', 'short', 42]]) books.set(id, { book: book(id, type), revision });
  const active = current ? copy(books.get('active').book) : null;
  if (dirty) active.chapters[0].body += ' 当前未保存的段落。';
  Object.assign(state, { book: active, revision: current ? 7 : 0, dirty, seq: 2, chapterId: active?.chapters[0].id,
    outlineId: 'active-outline', personId: 'active-person', kind, view: 'shelf' });
  const summarize = () => [...books.values()].map(({ book: value }) => ({ id: value.id, title: value.title, kind: value.kind,
    cover: value.cover, volumeCount: value.volumes.length, chapterCount: value.chapters.length, charCount: 30,
    updatedAt: '2026-10-09T00:00:00Z' }));
  state.books = summarize();
  const calls = [];
  context.settingsApi = async (endpoint, method = 'GET', data) => {
    calls.push({ endpoint, method, data: data ? copy(data) : data });
    if (endpoint === '/api/books' && method === 'GET') return { books: summarize() };
    const id = decodeURIComponent(endpoint.replace(/^\/api\/books\//, '')), stored = books.get(id);
    assert.ok(stored, 'Request must address an existing book');
    if (method === 'GET') return copy(stored);
    assert.equal(method, 'PUT'); assert.equal(data.book.id, id); assert.equal(data.revision, stored.revision, 'Use the edited book revision, not the current book revision');
    stored.book = copy(data.book); stored.revision += 1; return { revision: stored.revision };
  };
  vm.runInContext('api=(...args)=>settingsApi(...args)', context);
  const run = expression => vm.runInContext(expression, context);
  function findButton(element, label) { const result = descendants(element).find(node => node.tagName === 'BUTTON' && text(node) === label); assert.ok(result, 'Missing button: ' + label); return result; }
  async function open(target) {
    run('renderCollection()');
    const cards = get('shelf-grid').children.filter(node => node.className === 'shelf-book');
    const card = cards.find(node => descendants(node).some(child => child.className === 'shelf-book-title' && text(child) === books.get(target).book.title));
    assert.ok(card, 'The target must be a visible shelf card');
    await findButton(card, language === 'en' ? 'Cover and title' : '封面与书名').listeners.click();
    return form();
  }
  function form() { const result = descendants(get('dialog-body')).find(node => node.tagName === 'FORM'); assert.ok(result, 'The metadata form should open'); return result; }
  function input() { return descendants(form()).find(node => node.id === 'book-title-input'); }
  async function submit() { await form().listeners.submit({ preventDefault() {} }); }
  return { context, state, get, calls, books, active, storageData, removedKeys, run, open, form, input, submit, findButton };
}

const checks = [];
const check = (name, test) => checks.push({ name, test });

check('long and short shelf metadata opens a dialog and cancellation stays on the shelf in Chinese and English', async () => {
  for (const language of ['zh', 'en']) for (const kind of ['long', 'short']) {
    const h = harness({ language, kind, current: false }), id = kind + '-target';
    const draftKey = 'yejian.draft.' + id + '.another-window', draftValue = JSON.stringify({ book: { title: '可恢复的草稿' } });
    h.storageData.set(draftKey, draftValue);
    await h.open(id);
    assert.equal(h.get('dialog').open, true); assert.equal(text(h.get('dialog-title')), language === 'en' ? 'Cover and title' : '封面与书名');
    assert.equal(h.input().value, h.books.get(id).book.title); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.kind, kind); assert.equal(h.state.book, null);
    h.input().value = '取消时不要保存这个名字';
    await h.findButton(h.form(), language === 'en' ? 'Cancel' : '取消').listeners.click();
    assert.equal(h.get('dialog').open, false); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.book, null);
    assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0); assert.equal(h.books.get(id).book.title, '作品 ' + id);
    assert.equal(h.storageData.get(draftKey), draftValue); assert.deepEqual(h.removedKeys, []);
  }
});

check('editing another long or short book safely saves current text first and uses only the target revision for its metadata', async () => {
  for (const kind of ['long', 'short']) {
    const h = harness({ kind, dirty: true }), id = kind + '-target', targetBefore = copy(h.books.get(id).book), activeBefore = copy(h.active);
    const otherDraft = 'yejian.draft.' + id + '.another-window'; h.storageData.set(otherDraft, 'keep this recovery draft');
    await h.open(id);
    assert.equal(h.calls[0].endpoint, '/api/books/active'); assert.equal(h.calls[0].method, 'PUT');
    assert.deepEqual(h.calls[0].data.book, activeBefore); assert.equal(h.state.dirty, false); assert.equal(h.state.book, h.active);
    h.input().value = '  目标作品改名  ';
    await h.submit();
    const writes = h.calls.filter(call => call.method === 'PUT'); assert.equal(writes.length, 2);
    assert.equal(writes[1].endpoint, '/api/books/' + id); assert.equal(writes[1].data.revision, kind === 'long' ? 31 : 42);
    assert.deepEqual(h.books.get(id).book, { ...targetBefore, title: '目标作品改名' });
    assert.deepEqual(h.books.get('active').book, activeBefore); assert.deepEqual(h.active, activeBefore);
    assert.equal(h.state.book, h.active); assert.equal(h.state.revision, 8); assert.equal(h.state.chapterId, 'active-chapter');
    assert.equal(h.state.view, 'shelf'); assert.equal(h.state.kind, kind); assert.equal(h.get('dialog').open, false);
    assert.equal(h.storageData.get(otherDraft), 'keep this recovery draft');
    assert.ok(h.state.books.some(value => value.id === id && value.title === '目标作品改名'));
    assert.ok(text(h.get('shelf-grid')).includes('目标作品改名'), 'A successful metadata save must refresh the visible shelf');
  }
});

check('a failed current text save blocks opening another metadata form and keeps the original draft', async () => {
  const h = harness({ dirty: true }), before = JSON.stringify(h.active);
  h.context.settingsApi = async (endpoint, method) => { h.calls.push({ endpoint, method }); throw new Error('磁盘写入失败'); };
  h.run('renderCollection()');
  const card = h.get('shelf-grid').children.find(node => text(node).includes('作品 long-target'));
  await h.findButton(card, '封面与书名').listeners.click();
  assert.equal(h.get('dialog').open, false); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].endpoint, '/api/books/active');
  assert.equal(h.state.dirty, true); assert.equal(h.state.book, h.active); assert.equal(JSON.stringify(h.active), before);
  assert.equal(h.state.view, 'shelf'); assert.equal(h.get('workspace').inert, false); assert.equal(h.get('error-banner').hidden, false);
  assert.ok([...h.storageData.values()].some(value => value.includes('当前未保存的段落')), 'Failed saving must retain the actual current draft');
});

check('editing current book metadata keeps its selection and refreshes its saved revision without replacing the book', async () => {
  const h = harness(), before = copy(h.active); await h.open('active');
  h.input().value = '新的当前书名'; await h.submit();
  assert.equal(h.state.book, h.active); assert.equal(h.active.title, '新的当前书名'); assert.equal(h.state.revision, 8);
  assert.equal(h.state.chapterId, 'active-chapter'); assert.equal(h.state.outlineId, 'active-outline'); assert.equal(h.state.personId, 'active-person');
  assert.equal(h.state.view, 'shelf'); assert.equal(h.state.dirty, false); assert.equal(h.get('dialog').open, false);
  assert.deepEqual(h.books.get('active').book, { ...before, title: '新的当前书名' });
  assert.ok(text(h.get('shelf-grid')).includes('新的当前书名'));
});

check('current-book metadata submission saves newer text edits instead of overwriting them with the dialog snapshot', async () => {
  const h = harness(); await h.open('active');
  // A queued editor update can arrive after the metadata GET. The dialog must
  // use the live saved book and revision when submitting its two metadata fields.
  h.active.chapters[0].body += ' 对话框打开后到达的新正文。'; h.run('markDirty()');
  const expected = copy(h.active); h.input().value = '和新正文一起保存的书名';
  await h.submit();
  const writes = h.calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 2); assert.equal(writes[0].data.revision, 7); assert.deepEqual(writes[0].data.book, expected);
  assert.equal(writes[1].data.revision, 8); assert.deepEqual(writes[1].data.book, { ...expected, title: '和新正文一起保存的书名' });
  assert.deepEqual(h.books.get('active').book, { ...expected, title: '和新正文一起保存的书名' });
  assert.equal(h.state.book, h.active); assert.equal(h.state.revision, 9); assert.equal(h.state.dirty, false);
  assert.equal(h.state.view, 'shelf'); assert.equal(h.state.chapterId, 'active-chapter');
});

check('metadata saving failure preserves the form and authored book, and retry saves to the same target', async () => {
  const h = harness(), id = 'long-target', before = copy(h.books.get(id).book), activeBefore = copy(h.active);
  const defaultApi = h.context.settingsApi; let fail = true;
  h.context.settingsApi = async (endpoint, method, data) => {
    if (endpoint === '/api/books/' + id && method === 'PUT' && fail) { h.calls.push({ endpoint, method, data: copy(data) }); throw new Error('作品信息暂时无法保存'); }
    return defaultApi(endpoint, method, data);
  };
  await h.open(id); h.input().value = '保留以便重试'; await h.submit();
  assert.equal(h.get('dialog').open, true); assert.equal(h.input().value, '保留以便重试'); assert.deepEqual(h.books.get(id).book, before);
  assert.deepEqual(h.active, activeBefore); assert.equal(h.state.book, h.active); assert.equal(h.state.revision, 7);
  assert.equal(h.state.view, 'shelf'); assert.equal(h.state.error, null); assert.equal(h.state.conflict, false);
  assert.ok(text(h.get('toast')).includes('作品信息暂时无法保存'));
  const submit = descendants(h.form()).find(node => node.tagName === 'BUTTON' && node.type === 'submit'); assert.equal(submit.disabled, false);
  fail = false; await h.submit();
  assert.equal(h.get('dialog').open, false); assert.equal(h.books.get(id).book.title, '保留以便重试'); assert.equal(h.state.view, 'shelf');
  assert.deepEqual(h.active, activeBefore); assert.equal(h.calls.filter(call => call.method === 'PUT').length, 2);
});

check('a target metadata conflict preserves dialog edits and never marks another current book as conflicted', async () => {
  const h = harness(), id = 'long-target', before = copy(h.books.get(id).book), activeBefore = copy(h.active);
  const defaultApi = h.context.settingsApi;
  h.context.settingsApi = async (endpoint, method, data) => {
    if (endpoint === '/api/books/' + id && method === 'PUT') throw Object.assign(new Error('另一个窗口修改了目标作品'), { conflict: true });
    return defaultApi(endpoint, method, data);
  };
  await h.open(id); h.input().value = '冲突后仍保留的标题'; await h.submit();
  assert.equal(h.get('dialog').open, true); assert.equal(h.input().value, '冲突后仍保留的标题'); assert.deepEqual(h.books.get(id).book, before);
  assert.equal(h.state.conflict, false); assert.equal(h.state.error, null); assert.equal(h.state.revision, 7); assert.equal(h.state.book, h.active);
  assert.deepEqual(h.active, activeBefore); assert.equal(h.state.view, 'shelf'); assert.equal(h.get('dialog').inert, false);
  assert.ok(text(h.get('toast')).includes('另一个窗口修改了目标作品'));
});

check('cover upload and text-cover selection affect only the selected book and do not overwrite its prose or outline', async () => {
  for (const kind of ['long', 'short']) {
    const h = harness({ kind }), id = kind + '-target', before = copy(h.books.get(id).book), activeBefore = copy(h.active);
    await h.open(id);
    const file = descendants(h.form()).find(node => node.tagName === 'INPUT' && node.type === 'file');
    file.files = [{ type: 'image/png', size: 1024 }]; await file.listeners.change();
    await h.submit();
    const expected = { ...before, cover: 'data:image/jpeg;base64,dXBsb2FkZWQtY292ZXI=' };
    assert.deepEqual(h.books.get(id).book, expected); assert.deepEqual(h.active, activeBefore); assert.equal(h.state.view, 'shelf');
    assert.ok(descendants(h.get('shelf-grid')).some(node => node.tagName === 'IMG' && node.src === expected.cover), 'Updated cover must appear on the shelf');
    await h.open(id); await h.findButton(h.form(), '使用文字封面').listeners.click(); await h.submit();
    assert.deepEqual(h.books.get(id).book, { ...before, cover: '' }); assert.deepEqual(h.active, activeBefore); assert.equal(h.state.view, 'shelf');
  }
});

check('metadata load failure and an active IME composition do not change page, book, or selections', async () => {
  const h = harness(), before = copy(h.active);
  h.context.settingsApi = async () => { throw new Error('无法读取目标作品'); };
  h.run('renderCollection()'); const card = h.get('shelf-grid').children.find(node => text(node).includes('作品 long-target'));
  const edit = h.findButton(card, '封面与书名'); await edit.listeners.click();
  assert.equal(h.get('dialog').open, false); assert.ok(text(h.get('toast')).includes('无法读取目标作品'));
  assert.equal(h.state.view, 'shelf'); assert.equal(h.state.book, h.active); assert.deepEqual(h.active, before); assert.equal(h.get('workspace').inert, false);
  h.state.composing = true; let requested = false; h.context.settingsApi = async () => { requested = true; throw new Error('Must not start while composing'); };
  await edit.listeners.click(); assert.equal(requested, false); assert.equal(h.get('dialog').open, false); assert.equal(h.state.view, 'shelf'); assert.deepEqual(h.active, before);
});

(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed += 1; console.error('FAIL:', name, '\n ', error.stack || error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
