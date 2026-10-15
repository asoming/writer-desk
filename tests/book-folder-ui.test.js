'use strict';

// Exercise the actual folder action and shelf cards. All persistence, native
// opening, and filesystem paths are stubs; no real user directory is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.textContent = '';
    this.hidden = false; this.open = false; this.inert = false; this.listeners = {}; this.attributes = {};
    this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} };
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
}
function descendants(element) { return element.children.flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []); }
function text(element) { return [element.textContent, element.value, ...descendants(element).flatMap(child => [child.textContent, child.value])].filter(Boolean).join(' '); }
function harness(desktop, language) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const storage = { getItem: key => key === 'writer-desk.language' ? language : null, setItem() {}, removeItem() {} };
  function T(value, ...args) {
    if (Array.isArray(value)) return value.reduce((result, part, index) => result + part + (args[index] ?? ''), '');
    return String(value).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  }
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), title: '', body: {}, documentElement: {},
      createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] },
    crypto: { randomUUID }, sessionStorage: storage, clientStorage: storage, T, uiLanguage: 'zh',
    localStorage: storage, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    WriterDesktop: desktop,
    open: () => { throw new Error('Web fallback must not navigate to or open a local file URL'); },
    location: { assign: () => { throw new Error('Web fallback must not navigate away'); } },
  });
  context.window = context;
  if (language) vm.runInContext(fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8'), context, { filename: 'public/i18n.js' });
  for (const file of ['public/app.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  vm.runInContext('renderBacklinks=()=>{};', context);
  const state = vm.runInContext('state', context);
  state.book = { id: 'current-book', title: 'Current work', kind: 'long',
    chapters: [{ id: 'chapter-current', title: 'Draft', body: '当前正在编辑的正文，不得切换或丢失。', volumeId: null, deletedAt: null }],
    notes: [], volumes: [], outline: [], relations: [] };
  state.chapterId = 'chapter-current'; state.kind = 'long'; state.view = 'write'; state.revision = 7;
  state.dirty = true; state.seq = 2;
  const calls = [];
  context.folderApi = async (endpoint, method, data) => {
    calls.push({ endpoint, method, data });
    if (method === 'PUT' && endpoint === '/api/books/current-book') return { revision: 8 };
    if (method === 'POST' && endpoint.endsWith('/folder')) return { folder: '/tmp/Folder test/正文 <literal>.txt' };
    throw new Error('Unexpected API request: ' + endpoint);
  };
  vm.runInContext('api=(...args)=>folderApi(...args)', context);
  return { context, state, get, calls, run: expression => vm.runInContext(expression, context) };
}

const checks = [];
const check = (name, test) => checks.push({ name, test });

check('desktop action saves current edits before opening only the target book, without switching work or view', async () => {
  const opened = [], h = harness({ openBookFolder: async id => {
    assert.equal(h.calls.length, 1, 'The current book must save before the native folder request');
    assert.equal(h.calls[0].endpoint, '/api/books/current-book');
    assert.equal(h.calls[0].data.book.chapters[0].body, h.state.book.chapters[0].body);
    assert.equal(h.state.dirty, false); assert.equal(h.get('workspace').inert, true);
    opened.push(id); return { opened: true };
  } });
  const current = h.state.book, before = JSON.stringify(current), view = h.state.view;
  h.run('openBook=()=>{throw new Error("Folder opening must not load a book")};setBook=()=>{throw new Error("Folder opening must not replace current state")};');
  await h.run("openBookFolder('target-short-book')");
  assert.deepEqual(opened, ['target-short-book']); assert.equal(h.state.book, current);
  assert.equal(JSON.stringify(h.state.book), before); assert.equal(h.state.view, view); assert.equal(h.state.kind, 'long');
  assert.equal(h.state.revision, 8); assert.equal(h.state.dirty, false);
  assert.equal(h.get('workspace').inert, false); assert.equal(h.get('dialog').inert, false);
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/folder')).length, 0, 'Native bridge owns the folder operation; UI must not duplicate it');
});

check('a failed save blocks native folder opening and preserves the edited work', async () => {
  const opened = [], h = harness({ openBookFolder: async id => opened.push(id) });
  h.context.folderApi = async () => { throw new Error('Save failed for test'); };
  const current = h.state.book, before = JSON.stringify(current);
  await h.run("openBookFolder('other-book')");
  assert.deepEqual(opened, []); assert.equal(h.state.book, current); assert.equal(JSON.stringify(current), before);
  assert.equal(h.state.dirty, true); assert.equal(h.state.view, 'write');
  assert.equal(h.get('error-banner').hidden, false); assert.equal(h.get('workspace').inert, false);
});

check('native folder errors are visible and do not fall through to a second web export', async () => {
  const h = harness({ openBookFolder: async () => { throw new Error('Native folder unavailable'); } });
  h.state.dirty = false;
  await h.run("openBookFolder('target-book')");
  assert.ok(text(h.get('toast')).includes('Native folder unavailable'), 'A native failure must be shown to the writer');
  assert.equal(h.get('toast').hidden, false); assert.equal(h.calls.length, 0);
  assert.equal(h.state.book.id, 'current-book'); assert.equal(h.state.view, 'write');
  assert.equal(h.get('workspace').inert, false);
});

check('web fallback saves first, requests only the target ID, and presents the literal path without navigation', async () => {
  for (const desktop of [undefined, { isDesktop: true }]) {
    const h = harness(desktop), before = JSON.stringify(h.state.book);
    await h.run("openBookFolder('target-book')");
    assert.deepEqual(h.calls.map(call => [call.endpoint, call.method]), [['/api/books/current-book', 'PUT'], ['/api/books/target-book/folder', 'POST']]);
    assert.equal(h.get('dialog').open, true); assert.ok(text(h.get('dialog-body')).includes('/tmp/Folder test/正文 <literal>.txt'));
    assert.equal(JSON.stringify(h.state.book), before); assert.equal(h.state.view, 'write'); assert.equal(h.state.kind, 'long');
    assert.equal(h.get('workspace').inert, false); assert.equal(h.get('dialog').inert, false);
  }
});

check('web folder errors are shown and leave current selection intact', async () => {
  const h = harness(); h.state.dirty = false;
  h.context.folderApi = async () => { throw new Error('Folder export failed'); };
  await h.run("openBookFolder('target-book')");
  assert.ok(text(h.get('toast')).includes('Folder export failed'));
  assert.equal(h.state.book.id, 'current-book'); assert.equal(h.state.view, 'write'); assert.equal(h.get('workspace').inert, false);
});

check('web path is read-only and copying uses the literal path, with a manual-copy fallback', async () => {
  const h = harness(); h.state.dirty = false;
  const copied = [];
  h.context.navigator = { clipboard: { writeText: async value => copied.push(value) } };
  await h.run("openBookFolder('target-book')");
  const input = descendants(h.get('dialog-body')).find(element => element.tagName === 'INPUT');
  const copy = descendants(h.get('dialog-body')).find(element => element.tagName === 'BUTTON' && text(element) === '复制路径');
  assert.ok(input); assert.equal(input.readOnly, true);
  assert.equal(input.value, '/tmp/Folder test/正文 <literal>.txt');
  await copy.listeners.click(); assert.deepEqual(copied, [input.value]);
  assert.equal(text(h.get('toast')), '路径已复制。');
  h.context.navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
  await copy.listeners.click(); assert.equal(input.focused, true); assert.equal(input.selected, true);
  assert.equal(text(h.get('toast')), '请按 Ctrl+C 复制选中的路径。');
  assert.equal(h.get('dialog').open, true); assert.equal(h.state.book.id, 'current-book');
});

check('the real Chinese and English interfaces localize folder cards and the web path dialog', async () => {
  for (const [language, title, copyLabel, description, entry] of [
    ['zh', '作品文件夹', '复制路径', '浏览器中请复制路径，在文件管理器中打开。', '打开文件夹'],
    ['en', 'Book folder', 'Copy path', 'Copy this path and open it in your file manager.', 'Open folder'],
  ]) {
    const h = harness(undefined, language); h.state.dirty = false;
    h.state.books = [{ id: 'literal-book', title: '未翻译书名 {2}', kind: 'long', chapterCount: 1, charCount: 30, updatedAt: '2026-10-09T00:00:00Z' }];
    h.run('renderCollection()');
    const folder = descendants(h.get('shelf-grid')).find(element => element.tagName === 'BUTTON' && text(element) === entry);
    assert.ok(folder); assert.ok(folder.attributes['aria-label'].includes('未翻译书名 {2}'));
    await folder.listeners.click();
    assert.equal(text(h.get('dialog-title')), title); assert.ok(text(h.get('dialog-body')).includes(description));
    assert.ok(descendants(h.get('dialog-body')).some(element => element.tagName === 'BUTTON' && text(element) === copyLabel));
    assert.equal(h.state.book.title, 'Current work', 'Localizing folder UI must not alter authored book data');
  }
});

check('a folder sync warning preserves a successful database save and is shown only when it changes', async () => {
  const warning = '作品已保存，但作品文件夹暂未同步。请重新打开文件夹后重试。';
  for (const [language, translated] of [['zh', warning], ['en', 'Your book is saved, but its folder could not be updated. Try opening the folder again.']]) {
    const opened = [], h = harness({ openBookFolder: async id => opened.push(id) }, language);
    h.context.folderApi = async (endpoint, method, data) => {
      h.calls.push({ endpoint, method, data });
      return { revision: 8, folderWarning: warning };
    };
    await h.run("openBookFolder('other-book')");
    assert.deepEqual(opened, ['other-book']); assert.equal(h.state.dirty, false); assert.equal(h.state.error, null);
    assert.equal(h.state.folderWarning, warning); assert.equal(text(h.get('toast')), translated);
    h.get('toast').textContent = 'Do not replace a newer message'; h.state.dirty = true; h.state.seq += 1;
    assert.equal(await h.run('saveNow()'), true); assert.equal(text(h.get('toast')), 'Do not replace a newer message');
    h.context.folderApi = async () => ({ revision: 9 }); h.state.dirty = true; h.state.seq += 1;
    assert.equal(await h.run('saveNow()'), true); assert.equal(h.state.folderWarning, null);
  }
});

check('a shelf-only session can open a book folder without selecting any book', async () => {
  const opened = [], h = harness({ openBookFolder: async id => opened.push(id) });
  h.state.book = null; h.state.dirty = false; h.state.view = 'shelf'; h.state.kind = 'short';
  await h.run("openBookFolder('short-on-shelf')");
  assert.deepEqual(opened, ['short-on-shelf']); assert.equal(h.calls.length, 0);
  assert.equal(h.state.book, null); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.kind, 'short');
});

check('IME composition and an already active folder transition do not start another operation', async () => {
  let finish, opened = 0;
  const h = harness({ openBookFolder: async () => { opened += 1; await new Promise(resolve => { finish = resolve; }); } });
  h.state.dirty = false; h.state.composing = true;
  await h.run("openBookFolder('book-one')"); assert.equal(opened, 0);
  h.state.composing = false; const first = h.run("openBookFolder('book-one')");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1);
  await h.run("openBookFolder('book-two')"); assert.equal(opened, 1, 'The transition lock must reject concurrent folder actions');
  assert.equal(h.get('workspace').inert, true); finish(); await first;
  assert.equal(h.get('workspace').inert, false);
});

check('every long and short shelf card has a folder action wired to its own stable book ID', async () => {
  const h = harness(); h.state.dirty = false;
  h.state.books = [
    { id: 'long-one', title: 'Same title', kind: 'long' }, { id: 'long-two', title: 'Same title', kind: 'long' },
    { id: 'short-one', title: 'A short story', kind: 'short' },
  ].map(book => ({ ...book, chapterCount: 1, charCount: 30, volumeCount: book.kind === 'long' ? 1 : 0, updatedAt: '2026-10-09T00:00:00Z' }));
  h.context.folderTargets = []; h.run('openBookFolder=id=>folderTargets.push(id)');
  for (const kind of ['long', 'short']) {
    h.state.kind = kind; h.run('renderCollection()');
    const cards = h.get('shelf-grid').children.filter(element => element.className === 'shelf-book');
    const expected = h.state.books.filter(book => book.kind === kind).map(book => book.id);
    assert.equal(cards.length, expected.length); assert.equal(h.context.folderTargets.length, kind === 'long' ? 0 : 2, 'Rendering cards must not open a folder');
    for (const [index, card] of cards.entries()) {
      const actions = descendants(card).filter(element => element.tagName === 'BUTTON' && text(element).includes('打开文件夹'));
      assert.equal(actions.length, 1, 'Each book card must expose exactly one folder entry');
      await actions[0].listeners.click(); assert.equal(h.context.folderTargets.at(-1), expected[index]);
    }
  }
  assert.deepEqual(h.context.folderTargets, ['long-one', 'long-two', 'short-one']);
});

(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed += 1; console.error('FAIL:', name, '\n ', error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
