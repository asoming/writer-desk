'use strict';

// Real recycle-bin actions in a disposable DOM and revisioned API. The actual
// save/draft/transition code runs; no installed data or browser is accessed.
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
  contains(target) { return this === target || this.children.some(child => typeof child === 'object' && child.contains(target)); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}
function descendants(element) { return element.children.flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []); }
function text(element) { return [element.textContent, ...descendants(element).map(child => child.textContent)].filter(Boolean).join(' '); }
function fixture(id, kind = 'long') {
  return { id, title: '作品 ' + id, kind, cover: 'data:image/png;base64,a2VlcC1jb3Zlcg==',
    volumes: kind === 'long' ? [{ id: id + '-volume', title: '第一卷', summary: '卷纲', deletedAt: null }] : [],
    chapters: [{ id: id + '-chapter', title: '正文', body: '这段正文和全部关联应保留。', volumeId: kind === 'long' ? id + '-volume' : null, deletedAt: null }],
    outline: [{ id: id + '-outline', title: '总纲', body: '大纲内容', kind: 'story', chapterIds: [id + '-chapter'], parentId: null, deletedAt: null }],
    notes: [{ id: id + '-person', title: '沈禾', type: '人物', body: '人物履历', chapterIds: [id + '-chapter'], aliases: [], profile: {}, deletedAt: null }],
    relations: [], atlasViews: [{ id: 'atlas', title: '人物脉络', description: '说明', personIds: [id + '-person'] }] };
}
function harness({ kind = 'long', current = true, dirty = false } = {}) {
  const elements = new Map(), storageData = new Map(), removedKeys = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const storage = { getItem: key => storageData.get(key) ?? null, setItem: (key, value) => storageData.set(key, value),
    removeItem: key => { removedKeys.push(key); storageData.delete(key); }, getLength: () => storageData.size,
    key: index => [...storageData.keys()][index] };
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), title: '', body: new Element(), documentElement: new Element(),
      createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] },
    crypto: { randomUUID }, sessionStorage: storage, localStorage: storage, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
  });
  context.window = context;
  for (const file of ['public/i18n.js', 'public/app.js', 'public/chapter-history.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  const run = expression => vm.runInContext(expression, context);
  run(`renderBacklinks=()=>{};renderShell=()=>{if(state.view==='shelf')renderCollection();renderTrashCount();};
    setBook=r=>{state.book=r.book;state.revision=r.revision;state.kind=r.book.kind;state.dirty=false;state.error=null;state.conflict=false;state.seq=0;state.chapterId=r.book.chapters[0]?.id;};`);
  const state = run('state'), records = new Map(), calls = [];
  for (const [id, type, revision] of [['active', 'long', 7], ['long-target', 'long', 31], ['short-target', 'short', 42]]) {
    records.set(id, { book: fixture(id, type), revision, deletedAt: null });
  }
  const active = current ? copy(records.get('active').book) : null;
  if (dirty) active.chapters[0].body += ' 当前未保存的文字。';
  Object.assign(state, { book: active, revision: current ? 7 : 0, dirty, seq: 2, chapterId: active?.chapters[0].id, kind, view: 'shelf' });
  const summary = value => ({ id: value.book.id, title: value.book.title, kind: value.book.kind, cover: value.book.cover,
    volumeCount: value.book.volumes.length, chapterCount: value.book.chapters.filter(chapter => !chapter.deletedAt).length,
    charCount: 30, revision: value.revision, updatedAt: '2026-10-10T00:00:00Z', deletedAt: value.deletedAt, expiresAt: value.deletedAt ? '2026-11-09T01:00:00Z' : null });
  const activeBooks = () => [...records.values()].filter(value => !value.deletedAt).map(summary);
  state.books = activeBooks();
  context.trashApi = async (endpoint, method = 'GET', data) => {
    calls.push({ endpoint, method, data: data === undefined ? undefined : copy(data) });
    if (endpoint === '/api/books' && method === 'GET') return { books: activeBooks(), trashCount: [...records.values()].filter(value => value.deletedAt).length };
    if (endpoint === '/api/trash/books') return { books: [...records.values()].filter(value => value.deletedAt).map(summary) };
    if (endpoint === '/api/import' && method === 'POST') {
      const book = copy(data.book); book.id = randomUUID();
      const result = { book, revision: 1, deletedAt: null }; records.set(book.id, result); return copy(result);
    }
    const match = endpoint.match(/^\/api\/books\/([^/]+)(?:\/(trash|restore|purge))?$/);
    assert.ok(match, 'Unexpected endpoint: ' + endpoint);
    const record = records.get(decodeURIComponent(match[1])); if (!record) throw Object.assign(new Error('原作品已删除。'), { conflict: true, deleted: true, removed: true });
    const deletedError = () => Object.assign(new Error('这部作品已移入回收站。'), { conflict: true, deleted: true });
    if (method === 'GET') { if (record.deletedAt) throw deletedError(); return copy(record); }
    if (method === 'PUT' && record.deletedAt) throw deletedError();
    if (record.revision !== data.revision) throw Object.assign(new Error('另一个窗口修改了作品状态。'), { conflict: true });
    if (match[2] === 'purge') { assert.ok(record.deletedAt); records.delete(record.book.id); return { ok: true, id: record.book.id }; }
    if (method === 'PUT') record.book = copy(data.book);
    else if (match[2] === 'trash') { if (record.deletedAt) throw deletedError(); record.deletedAt = '2026-10-10T01:00:00Z'; }
    else if (match[2] === 'restore') { assert.ok(record.deletedAt); record.deletedAt = null; }
    else throw new Error('Unexpected mutation');
    record.revision++;
    return copy(match[2] === 'trash' ? { bookId: record.book.id, revision: record.revision, deletedAt: record.deletedAt } : record);
  };
  run('api=(...args)=>trashApi(...args)');
  const findButton = (element, label) => {
    const found = descendants(element).find(node => node.tagName === 'BUTTON' && text(node) === label);
    assert.ok(found, 'Missing button: ' + label); return found;
  };
  const click = label => findButton(get('dialog-body'), label).listeners.click();
  async function openTrashConfirm(id) {
    run('renderCollection()');
    const card = get('shelf-grid').children.find(element => descendants(element).some(child => child.className === 'shelf-book-title' && text(child) === records.get(id).book.title));
    assert.ok(card, 'Target must be a shelf card');
    await findButton(card, '移入回收站').listeners.click();
  }
  function recycleExternally(id = 'active') { const record = records.get(id); record.deletedAt = '2026-10-10T01:00:00Z'; record.revision++; }
  return { context, state, records, calls, get, storage, storageData, removedKeys, run, findButton, click, openTrashConfirm, recycleExternally, active };
}

const checks = [];
const check = (name, test) => checks.push({ name, test });

check('long and short shelves confirm whole-book recycling; cancellation does not mutate a book', async () => {
  for (const kind of ['long', 'short']) {
    const h = harness({ kind, current: false }), before = copy(h.records.get(kind + '-target'));
    await h.openTrashConfirm(kind + '-target');
    assert.equal(h.get('dialog-title').textContent, '移入作品回收站');
    assert.ok(text(h.get('dialog-body')).includes('封面、正文、卷章、大纲和人物关联都会保留'));
    await h.click('取消');
    assert.equal(h.get('dialog').open, false); assert.deepEqual(h.records.get(kind + '-target'), before);
    assert.equal(h.calls.filter(call => call.method !== 'GET').length, 0); assert.equal(h.state.book, null);
  }
});

check('current prose saves before confirmation, and queued edits save before trash at the newest revision', async () => {
  const h = harness({ dirty: true });
  const own = h.run("'yejian.draft.active.'+draftOwner"), other = 'yejian.draft.active.other-window';
  h.storageData.set(other, 'retain another writer window');
  for (const key of ['yejian.last-book', 'yejian.last-book.long']) h.storageData.set(key, 'active');
  await h.openTrashConfirm('active');
  assert.equal(h.calls[0].method, 'PUT'); assert.equal(h.calls[1].method, 'GET');
  h.active.chapters[0].body += ' 对话框打开后排队到达的新段落。'; h.run('markDirty()');
  const authored = copy(h.active);
  await h.click('移入回收站');
  const mutations = h.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(mutations.map(call => [call.method, call.data.revision]), [['PUT', 7], ['PUT', 8], ['POST', 9]]);
  assert.deepEqual(h.records.get('active').book, authored); assert.equal(h.records.get('active').revision, 10);
  assert.equal(h.state.book, null); assert.equal(h.state.dirty, false); assert.equal(h.state.error, null);
  assert.equal(h.state.view, 'shelf'); assert.equal(h.state.trashBookCount, 1); assert.equal(h.get('dialog').open, false);
  assert.equal(h.get('long-count').textContent, 1); assert.equal(h.get('short-count').textContent, 1);
  assert.ok(!text(h.get('shelf-grid')).includes('作品 active')); assert.equal(h.get('trash-count').textContent, '(1)');
  assert.ok(!h.storageData.has(own)); assert.equal(h.storageData.get(other), 'retain another writer window');
  assert.ok(!h.storageData.has('yejian.last-book')); assert.ok(!h.storageData.has('yejian.last-book.long'));
});

check('failed saving or a competing target mutation preserves text and confirmation without poisoning another book', async () => {
  const failed = harness({ dirty: true }), before = copy(failed.active);
  failed.context.trashApi = async () => { throw new Error('磁盘写入失败'); };
  await failed.openTrashConfirm('long-target');
  assert.equal(failed.get('dialog').open, false); assert.equal(failed.state.dirty, true); assert.deepEqual(failed.active, before);
  assert.ok([...failed.storageData.values()].some(value => value.includes('当前未保存的文字')));
  const h = harness(); await h.openTrashConfirm('long-target'); h.records.get('long-target').revision++;
  await h.click('移入回收站');
  assert.equal(h.get('dialog').open, true); assert.equal(h.records.get('long-target').deletedAt, null);
  assert.equal(h.state.book, h.active); assert.equal(h.state.conflict, false); assert.equal(h.state.error, null);
  assert.equal(h.findButton(h.get('dialog-body'), '移入回收站').disabled, false);
});

check('global trash works without an open book and restores long and short originals with all associations', async () => {
  const h = harness({ current: false });
  h.recycleExternally('long-target'); h.recycleExternally('short-target');
  await h.run('refreshBooks();'); h.run('renderWorkspaceShell()');
  assert.equal(h.get('open-trash').disabled, false); assert.equal(h.state.trashBookCount, 2);
  for (const id of ['long-target', 'short-target']) {
    const before = copy(h.records.get(id).book), revision = h.records.get(id).revision;
    await h.run('showTrash()');
    const row = descendants(h.get('dialog-body')).find(element => element.className === 'trash-row' && text(element).includes(before.title));
    await h.findButton(row, '恢复到书架').listeners.click();
    assert.deepEqual(h.records.get(id).book, before); assert.equal(h.records.get(id).revision, revision + 1);
    assert.equal(h.state.book, null); assert.ok(h.state.books.some(book => book.id === id));
  }
  assert.equal(h.state.trashBookCount, 0);
  await h.run('showTrash()'); assert.ok(text(h.get('dialog-body')).includes('没有回收的作品。'));
});

check('current-book recycled chapters and their volume still restore alongside the global recycle bin', async () => {
  const h = harness(); h.active.chapters[0].deletedAt = '2026-10-10'; h.active.volumes[0].deletedAt = '2026-10-10';
  h.records.get('active').book = copy(h.active); h.recycleExternally('short-target');
  await h.run('showTrash()');
  assert.ok(text(h.get('dialog-body')).includes('回收的作品')); assert.ok(text(h.get('dialog-body')).includes('当前作品内的回收内容'));
  const row = descendants(h.get('dialog-body')).find(element => element.className === 'trash-row' && text(element).includes('正文'));
  await h.findButton(row, '恢复').listeners.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.active.chapters[0].deletedAt, null); assert.equal(h.active.volumes[0].deletedAt, null);
  assert.equal(h.records.get('active').book.chapters[0].deletedAt, null);
  assert.equal(h.records.get('active').book.volumes[0].deletedAt, null);
  assert.ok(h.records.get('short-target').deletedAt); assert.equal(h.state.trashBookCount, 1);
});

check('late global-trash loads cannot replace a closed dialog or a different book', async () => {
  for (const changed of ['dialog', 'book']) {
    const h = harness(); let release; const api = h.context.trashApi;
    h.context.trashApi = (endpoint, ...args) => endpoint === '/api/trash/books' ? new Promise(resolve => { release = resolve; }) : api(endpoint, ...args);
    const loading = h.run('showTrash()'); await Promise.resolve(); await Promise.resolve();
    if (changed === 'dialog') h.run('closeDialog()'); else h.state.book = copy(h.records.get('long-target').book);
    release({ books: [{ id: 'late', title: '不应出现的旧请求', kind: 'long', revision: 1, chapterCount: 1, charCount: 1, deletedAt: '2026-10-10' }] });
    await loading;
    assert.ok(!text(h.get('dialog-body')).includes('不应出现的旧请求')); assert.equal(h.state.trashBookCount, 0);
  }
});

check('a clean stale window can return to the shelf and open global recovery', async () => {
  const h = harness(); h.state.view = 'write'; h.recycleExternally();
  assert.equal(await h.run("showCollection('shelf')"), true); assert.equal(h.state.book, null); assert.equal(h.state.view, 'shelf');
  await h.run('showTrash()'); assert.ok(text(h.get('dialog-body')).includes('作品 active'));
});

check('a dirty stale window keeps downloadable text and only leaves after the local draft is verified', async () => {
  const h = harness({ dirty: true }); h.state.view = 'write'; h.recycleExternally();
  const before = copy(h.active), saved = [];
  h.context.downloaded = saved; h.run('download=(name,body,type)=>downloaded.push({name,body,type})');
  assert.equal(await h.run("showCollection('shelf')"), false);
  assert.equal(h.state.book, h.active); assert.equal(h.state.dirty, true); assert.equal(h.state.conflict, true);
  assert.equal(h.get('dialog-title').textContent, '原作品无法保存');
  await h.click('下载本页备份');
  assert.equal(saved.length, 1); assert.deepEqual(JSON.parse(saved[0].body).book, before); assert.equal(h.state.book, h.active);
  const own = h.run("'yejian.draft.active.'+draftOwner"); h.storageData.delete(own);
  const setter = h.storage.setItem; h.storage.setItem = () => { throw new Error('quota'); };
  assert.equal(await h.click('保留草稿并返回书架'), false);
  assert.equal(h.state.book, h.active); assert.equal(h.state.dirty, true); assert.equal(h.get('dialog').open, true);
  h.storage.setItem = setter;
  assert.equal(await h.click('保留草稿并返回书架'), true);
  assert.equal(h.state.book, null); assert.equal(h.state.view, 'shelf');
  const draft = JSON.parse(h.storageData.get(own)); assert.deepEqual(draft.book, before); assert.equal(draft.revision, 7);
  const original = h.records.get('active'); original.deletedAt = null; original.revision++;
  h.run('setBook'); h.context.restoredRecord = copy(original); h.run('setBook(restoredRecord)');
  await h.run('recoverDraft()');
  assert.ok(text(h.get('dialog-body')).includes('恢复为新作品')); assert.equal(h.state.dirty, false);
  assert.equal(h.records.get('active').revision, 9); assert.notDeepEqual(h.records.get('active').book, before);
});

check('a dirty recycled book can be rescued into a separate work without reviving the original', async () => {
  const h = harness({ dirty: true }), before = copy(h.active); h.recycleExternally();
  await h.run("showCollection('shelf')"); await h.click('另存为新作品');
  assert.notEqual(h.state.book.id, 'active'); assert.equal(h.state.book.chapters[0].body, before.chapters[0].body);
  assert.ok(h.records.get('active').deletedAt); assert.equal(h.records.get('active').revision, 8);
  assert.equal(h.state.error, null); assert.equal(h.state.dirty, false); assert.equal(h.get('dialog').open, false);
});

check('API errors retain the deleted marker and committed recycling remains visible if shelf refresh fails', async () => {
  const h = harness();
  const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const realApi = source.slice(source.indexOf('async function api('), source.indexOf('\nfunction saveStatus'));
  h.context.fetch = async () => ({ ok: false, json: async () => ({ error: '已回收', conflict: true, deleted: true }) });
  h.run(realApi);
  await assert.rejects(h.run("api('/api/books/active')"), error => error.deleted === true && error.conflict === true);
  h.run('api=(...args)=>trashApi(...args)'); await h.openTrashConfirm('active');
  const api = h.context.trashApi;
  h.context.trashApi = (endpoint, ...args) => { if (endpoint === '/api/books') throw new Error('刷新失败'); return api(endpoint, ...args); };
  await h.click('移入回收站');
  assert.equal(h.state.book, null); assert.ok(!h.state.books.some(book => book.id === 'active')); assert.equal(h.state.trashBookCount, 1);
  assert.ok(!text(h.get('shelf-grid')).includes('作品 active')); assert.equal(h.get('dialog').open, false);
});

check('whole-book trash shows a 30-day expiry and irreversible deletion requires a separate confirmation', async () => {
  const h = harness({ current: false }); h.recycleExternally('short-target'); await h.run('showTrash()');
  assert.ok(text(h.get('dialog-body')).includes('整部作品保留 30 天')); assert.ok(text(h.get('dialog-body')).includes('到期删除：'));
  await h.click('彻底删除'); assert.equal(h.get('dialog-title').textContent, '彻底删除作品');
  assert.ok(text(h.get('dialog-body')).includes('正文、关联、历史和本机备份将无法恢复'));
  assert.ok(!h.calls.some(call => call.endpoint.endsWith('/purge')));
  const staleConfirm = h.findButton(h.get('dialog-body'), '彻底删除');
  await h.click('取消'); await staleConfirm.listeners.click(); assert.ok(!h.calls.some(call => call.endpoint.endsWith('/purge')));
  assert.ok(h.records.has('short-target')); assert.equal(h.get('dialog-title').textContent, '回收站');
  await h.click('彻底删除'); await h.click('彻底删除');
  const post = h.calls.find(call => call.endpoint.endsWith('/purge')); assert.deepEqual(post.data, { revision: 43 });
  assert.equal(h.records.has('short-target'), false); assert.equal(h.state.book, null); assert.equal(h.state.trashBookCount, 0); assert.equal(h.get('dialog').open, false);
});

check('a stale or failed purge preserves the confirmation and never clears another book or recovery draft', async () => {
  const h = harness(), before = copy(h.active); h.recycleExternally('short-target'); await h.run('showTrash()'); await h.click('彻底删除');
  h.records.get('short-target').revision++; await h.click('彻底删除');
  assert.equal(h.records.has('short-target'), true); assert.equal(h.get('dialog').open, true); assert.deepEqual(h.state.book, before);
  assert.equal(h.state.conflict, false); assert.equal(h.state.error, null); assert.equal(h.findButton(h.get('dialog-body'), '彻底删除').disabled, false);
  await h.click('取消'); await h.click('彻底删除'); h.storageData.set('yejian.draft.short-target.other-window', 'retain unsaved recovery');
  let release; const api = h.context.trashApi; h.context.trashApi = (endpoint, ...args) => endpoint.endsWith('/purge') ? new Promise(resolve => { release = () => resolve(api(endpoint, ...args)); }) : api(endpoint, ...args);
  const first = h.click('彻底删除'); await Promise.resolve(); await Promise.resolve(); await h.click('彻底删除'); release(); await first;
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/purge')).length, 2, 'One failed stale request and one successful request, no double submission');
  assert.deepEqual(h.state.book, before); assert.equal(h.storageData.get('yejian.draft.short-target.other-window'), 'retain unsaved recovery');
});

check('a permanently deleted original with unsaved local prose can download, keep a draft and leave without resurrection', async () => {
  const h = harness({ dirty: true }), before = copy(h.active), saved = []; h.records.delete('active');
  h.context.downloaded = saved; h.run('download=(name,body)=>downloaded.push({name,body})');
  assert.equal(await h.run("showCollection('shelf')"), false); assert.ok(text(h.get('dialog-body')).includes('原作品已回收或删除'));
  await h.click('下载本页备份'); assert.deepEqual(JSON.parse(saved[0].body).book, before); assert.equal(h.state.book, h.active);
  await h.click('保留草稿并返回书架'); assert.equal(h.state.book, null); assert.equal(h.state.view, 'shelf');
  assert.equal(h.records.has('active'), false); assert.ok([...h.storageData.values()].some(value => value.includes('当前未保存的文字')));
});

(async () => {
  for (const { name, test } of checks) { await test(); console.log('PASS ' + name); }
  console.log(`${checks.length} whole-book recycle UI checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
