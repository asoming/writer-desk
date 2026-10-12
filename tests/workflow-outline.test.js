'use strict';

// Run the actual app/workspace code against a small DOM. No browser, server,
// production storage, or user-authored files are changed by these checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');

function descendants(element) {
  return element.children.flatMap(child => typeof child === 'object' ? [child, ...descendants(child)] : []);
}
function matches(element, selector) {
  if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => (element.className || '').split(/\s+/).includes(name));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  const data = selector.match(/^\[data-([a-z-]+)\]$/);
  if (data) return data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in element.dataset;
  return element.tagName.toLowerCase() === selector.toLowerCase();
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.textContent = '';
    this.hidden = false; this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.style = { setProperty() {} }; this.clientWidth = 1000; this.clientHeight = 500; this.clientTop = 0; this.scrollTop = 0;
    const update = (name, enabled) => {
      const names = new Set((this.className || '').split(/\s+/).filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    };
    this.classList = {
      toggle: (name, force) => update(name, force ?? !(this.className || '').split(/\s+/).includes(name)),
      add: name => update(name, true), remove: name => update(name, false),
    };
  }
  append(...children) { for (const child of children) { this.children.push(child); if (typeof child === 'object') child.parentElement = this; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  contains(node) { return node === this || this.children.some(child => typeof child === 'object' && child.contains(node)); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/), target = parts.pop();
    return descendants(this).filter(element => {
      if (!matches(element, target)) return false;
      let parent = element.parentElement;
      for (let index = parts.length - 1; index >= 0; index--) {
        while (parent && !matches(parent, parts[index])) parent = parent.parentElement;
        if (!parent) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: this.clientHeight }; }
  scrollIntoView(options) {
    this.scrolled = options;
    for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) ancestor.onScrollIntoView?.(this, options);
  }
}

function harness() {
  const elements = new Map();
  const get = id => {
    for (const element of elements.values()) {
      const dynamic = descendants(element).find(child => child.id === id);
      if (dynamic) return dynamic;
    }
    if (id.startsWith('read-')) return null;
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0 };
  function T(value, ...args) {
    if (Array.isArray(value)) return value.reduce((result, part, index) => result + part + (args[index] ?? ''), '');
    return String(value).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  }
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), addEventListener() {}, title: '' },
    addEventListener() {}, crypto: { randomUUID }, sessionStorage: storage, clientStorage: storage, T,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(), structuredClone,
    matchMedia: () => ({ matches: true }), WriterCovers: { templates: [], render: () => '', randomTitle: () => '本地候选书名' },
  });
  context.window = context;
  for (const file of ['public/app.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  // Keep transitions and rendering real; only isolate unrelated surfaces/storage.
  vm.runInContext('markDirty=()=>{state.dirty=true;state.seq++;};renderBacklinks=()=>{};renderShell=()=>renderOutlineWorkspace();', context);
  return { context, get, state: vm.runInContext('state', context), run: expression => vm.runInContext(expression, context) };
}


const samplePath = path.join(root, 'examples/tide-archive.yejian.json');
const sample = () => JSON.parse(fs.readFileSync(samplePath, 'utf8')).book;
function load(h, value = sample()) {
  h.state.book = value; h.state.kind = value.kind; h.state.view = 'outline';
  h.state.outlineId = value.outline[0]?.id || null; h.state.outlineMode = 'edit';
  h.state.outlineFilterBook = value.id; h.state.outlineCategory = 'all';
  h.state.outlineKindFilter = ''; h.state.outlineVolumeFilter = ''; h.state.outlineCollapsed = new Set();
  h.state.dirty = false; h.state.seq = 0; h.run('normalizeWorkspaceBook(state.book)');
}
function plannedVolume(h) {
  const parentId = h.state.book.outline.find(item => item.kind === 'story').id;
  const volume = { id: 'planned-volume', title: '第七卷 新的航线', body: '第七卷策划，保持在大纲里。', kind: 'volume', category: '分卷剧情', parentId, volumeId: null, chapterIds: [], deletedAt: null };
  const chapter = { id: 'planned-chapter', title: '第37章 归来的船', body: '本章规划，正文应为空白。', kind: 'chapter', category: '分卷剧情', parentId: volume.id, volumeId: null, chapterIds: [], deletedAt: null };
  h.state.book.outline.push(volume, chapter); h.context.plannedChapter = chapter;
  return { volume, chapter };
}
function setupDialog(h, saveResult) {
  h.context.dialogState = { closed: 0, saved: 0, messages: [] };
  h.context.saveResult = saveResult;
  h.run('showDialog=(title,...children)=>{dialogState.title=title;dialogState.children=children;$("dialog-body").replaceChildren(...children);$("dialog").open=true;};closeDialog=()=>{dialogState.closed++;$("dialog").open=false;};saveNow=async()=>{dialogState.saved++;return !state.dirty||saveResult;};toast=message=>dialogState.messages.push(message);renderOutline=()=>{};renderChapters=()=>{};renderStats=()=>{};');
}
function dialogAction(h, label) {
  return h.context.dialogState.children.flatMap(item => [item, ...descendants(item)]).find(item => item.textContent === label);
}
const checks = [];
function check(name, test) { checks.push({ name, test }); }

check('the full demo has 6 volumes, 36 chapters, 32 people and over 100,000 characters', () => {
  const book = sample();
  assert.equal(book.volumes.length, 6); assert.equal(book.chapters.length, 36);
  assert.equal(book.notes.filter(note => note.type === '人物').length, 32);
  assert.ok(book.chapters.reduce((total, chapter) => total + chapter.body.replace(/\s/g, '').length, 0) >= 100000);
});

check('creating a single chapter from an unbuilt volume establishes its planned volume, not the first existing volume', () => {
  const h = harness(); load(h); const before = JSON.stringify(h.state.book.chapters); const { volume, chapter } = plannedVolume(h);
  const created = h.run('chapterFromOutline(plannedChapter, false)');
  const manuscriptVolume = h.state.book.volumes.find(item => item.id === created.volumeId);
  assert.equal(manuscriptVolume.title, volume.title);
  assert.equal(manuscriptVolume.summary, volume.body); assert.equal(volume.volumeId, manuscriptVolume.id);
  assert.equal(created.body, ''); assert.equal(chapter.body, '本章规划，正文应为空白。');
  assert.equal(JSON.stringify(h.state.book.chapters.slice(0, 36)), before, 'Existing demo prose must remain unchanged');
  assert.equal(h.run('chapterFromOutline(plannedChapter, false)').id, created.id, 'Retrying must reuse the same chapter');
  assert.equal(h.state.book.volumes.length, 7); assert.equal(h.state.book.chapters.length, 37);
});

check('filling an earlier missing chapter places it before the next linked chapter in that volume', () => {
  const h = harness(); load(h); const item = h.state.book.outline.find(outline => outline.kind === 'chapter');
  const removed = h.state.book.chapters.find(chapter => chapter.id === item.chapterIds[0]);
  const preserved = h.state.book.chapters.filter(chapter => chapter !== removed).map(chapter => [chapter.id, chapter.body]);
  h.state.book.chapters = h.state.book.chapters.filter(chapter => chapter !== removed); item.chapterIds = []; h.context.missingOutline = item;
  const created = h.run('chapterFromOutline(missingOutline, false)');
  const sameVolume = h.state.book.chapters.filter(chapter => chapter.volumeId === removed.volumeId);
  assert.equal(sameVolume[0].id, created.id, 'The first chapter must not become the last chapter of its volume');
  assert.deepEqual(h.state.book.chapters.filter(chapter => chapter !== created).map(chapter => [chapter.id, chapter.body]), preserved);
});

check('rebuilding the final chapter ignores thematic scene links and keeps it at the end of the last volume', () => {
  const h = harness(); load(h); const item = h.state.book.outline.filter(outline => outline.kind === 'chapter').at(-1);
  const removed = h.state.book.chapters.find(chapter => chapter.id === item.chapterIds[0]);
  h.state.book.chapters = h.state.book.chapters.filter(chapter => chapter !== removed); item.chapterIds = []; h.context.missingOutline = item;
  const created = h.run('chapterFromOutline(missingOutline, false)');
  const sameVolume = h.state.book.chapters.filter(chapter => chapter.volumeId === removed.volumeId);
  assert.equal(sameVolume.at(-1).id, created.id, 'The ending-scene links back to chapters 31–36 cannot pull chapter 36 before chapter 31');
});

check('failed bulk generation stays open without a success toast; retry is idempotent', async () => {
  const h = harness(); load(h); plannedVolume(h); setupDialog(h, false); h.run('buildOutlineStructure()');
  const generate = dialogAction(h, '生成目录'); await generate.listeners.click();
  assert.equal(h.context.dialogState.saved, 1); assert.equal(h.context.dialogState.closed, 0);
  assert.deepEqual(h.context.dialogState.messages, ['本页还有未保存的内容，请先重试或下载备份。'], 'A failed save must show a retry hint, not a success toast');
  assert.equal(h.state.book.volumes.length, 7); assert.equal(h.state.book.chapters.length, 37);
  h.context.saveResult = true; await generate.listeners.click();
  assert.equal(h.context.dialogState.closed, 1); assert.equal(h.state.book.volumes.length, 7); assert.equal(h.state.book.chapters.length, 37);
  assert.equal(h.context.dialogState.messages.length, 2); assert.equal(h.context.dialogState.messages[1], '卷章目录已建立。');
});

check('registering candidate people retains the confirmation dialog after save failure and retries without duplicate people', async () => {
  const h = harness(); load(h); setupDialog(h, false); const before = h.state.book.notes.length;
  h.run('analyzeWorkspace=()=>({ambiguous:[],candidates:[{name:"新人物江远",excerpts:[]}]});renderPeople=()=>{};showCandidatePeople()');
  const confirm = dialogAction(h, '确认并建立人物'); await confirm.listeners.click();
  assert.equal(h.context.dialogState.saved, 1); assert.equal(h.context.dialogState.closed, 0);
  assert.deepEqual(h.context.dialogState.messages, ['本页还有未保存的内容，请先重试或下载备份。'], 'Registration must show a retry hint after failure');
  assert.equal(h.state.book.notes.length, before + 1);
  h.context.saveResult = true; await confirm.listeners.click();
  assert.equal(h.context.dialogState.saved, 2); assert.equal(h.context.dialogState.closed, 1);
  assert.equal(h.state.book.notes.length, before + 1); assert.ok(h.context.dialogState.messages[1].includes('1'));
});

check('outline-first creation suggests a volume under a long-story root and a scene under a short-story concept', () => {
  const h = harness(); load(h); setupDialog(h, true);
  h.context.rootId = h.state.book.outline.find(item => item.kind === 'story').id;
  h.run('showNewOutline(rootId)');
  let form = h.context.dialogState.children[0];
  assert.equal(descendants(form).find(element => element.id === 'new-outline-kind').value, 'volume');
  assert.equal(descendants(form).find(element => element.id === 'new-outline-category').value, '分卷剧情');
  h.state.kind = 'short'; h.state.book.kind = 'short'; h.run('showNewOutline(rootId)'); form = h.context.dialogState.children[0];
  const kind = descendants(form).find(element => element.id === 'new-outline-kind');
  assert.equal(kind.value, 'scene');
  assert.deepEqual(kind.options.map(option => option.value), ['story', 'scene']);
  assert.deepEqual(kind.options.map(option => option.textContent), ['全篇构思', '情节 / 设定']);
  assert.ok(!descendants(form).some(element => element.id === 'new-outline-volume'));
});

check('short-story outline templates contain concepts and scenes without manuscript chapters or volumes', () => {
  const h = harness(); load(h, { id: 'short-empty', title: '雨后', kind: 'short', chapters: [], volumes: [], outline: [], notes: [], relations: [], atlasViews: [] });
  h.run('createOutlineTemplate()');
  assert.equal(h.state.book.outline[0].title, '全篇构思');
  assert.equal(h.state.book.chapters.length, 0);
  assert.equal(h.state.book.volumes.length, 0);
  assert.ok(h.state.book.outline.every(item => ['story', 'scene'].includes(item.kind)));
});

check('short-story outlines show no volume or chapter choices while preserving old planning nodes', () => {
  const h = harness(); const value = sample(); value.kind = 'short'; load(h, value);
  const before = JSON.stringify(h.state.book.outline);
  h.state.outlineId = value.outline.find(item => item.kind === 'chapter').id;
  h.run('renderOutlineWorkspace()');
  assert.deepEqual(h.get('outline-kind').options.map(option => option.value), ['story', 'scene']);
  assert.deepEqual(h.get('outline-filter-kind').options.map(option => option.value), ['', 'story', 'scene']);
  assert.equal(h.get('outline-kind').value, 'scene');
  assert.equal(h.get('outline-build').hidden, true);
  assert.equal(h.get('outline-volume-field').hidden, true);
  assert.equal(h.get('outline-create-chapter').textContent, '打开正文');
  assert.ok(!h.get('outline-categories').children.some(element => element.dataset.topic === '分卷剧情'));
  assert.ok(h.get('outline-categories').children.some(element => element.dataset.topic === '情节与设定'));
  assert.equal(JSON.stringify(h.state.book.outline), before, 'Presenting legacy planning as scenes must not rewrite or delete it');
});

check('every short-story plan links to the same manuscript, preserving its prose and keeping planning separate', () => {
  const h = harness(); load(h, { id: 'short-one-body', title: '雨后', kind: 'short', volumes: [], notes: [], relations: [], atlasViews: [],
    chapters: [{ id: 'short-body', title: '正文', body: '这是已经写好的正文。', volumeId: null, deletedAt: null }],
    outline: [{ id: 'short-concept', kind: 'story', title: '全篇构思', body: '计划不能插入正文。', chapterIds: [], parentId: null, deletedAt: null },
      { id: 'short-ending', kind: 'scene', title: '结局', body: '另一份计划也只关联同一篇正文。', chapterIds: [], parentId: 'short-concept', deletedAt: null }] });
  // The app owns manuscript creation and legacy merging. This check covers the
  // workspace contract: every plan reuses that result and adds only its link.
  h.run('ensureShortManuscript=()=>activeChapters()[0]');
  const before = JSON.stringify(h.state.book.chapters);
  h.run('state.book.outline.forEach(item=>chapterFromOutline(item,false));state.book.outline.forEach(item=>chapterFromOutline(item,false))');
  assert.equal(JSON.stringify(h.state.book.chapters), before);
  assert.ok(h.state.book.outline.every(item => JSON.stringify(item.chapterIds) === '["short-body"]'));
  h.state.outlineMode = 'read'; h.run('renderOutlineWorkspace()');
  const links = h.get('outline-reading').querySelectorAll('.outline-manuscript-link');
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.textContent === '正文' && link.dataset.chapter === 'short-body'));
});

check('short-story writing has no chapter directory and switching back restores the long-story controls', () => {
  const h = harness(); load(h); h.context.uiLanguage = 'zh';
  h.run('renderPeople=()=>{};renderStats=()=>{};renderTrashCount=()=>{};selectChapter=id=>{state.chapterId=id;};resizeEditor=()=>{};ensureShortManuscript=()=>activeChapters()[0]');
  h.state.kind = 'short'; h.state.book.kind = 'short'; h.state.view = 'write'; h.run('renderWorkspaceShell();renderVolumeChapters()');
  for (const id of ['sidebar', 'toggle-sidebar', 'add-chapter', 'add-volume']) assert.equal(h.get(id).hidden, true, id);
  assert.equal(h.get('chapter-list').children.length, 0);
  assert.ok(h.get('write-view').className.split(/\s+/).includes('short-manuscript'));
  h.state.kind = 'long'; h.state.book.kind = 'long'; h.run('renderWorkspaceShell();renderVolumeChapters()');
  for (const id of ['sidebar', 'toggle-sidebar', 'add-chapter', 'add-volume']) assert.equal(h.get(id).hidden, false, id);
  assert.ok(h.get('chapter-list').querySelectorAll('.chapter-item').length > 0);
  assert.ok(!h.get('write-view').className.split(/\s+/).includes('short-manuscript'));
});

check('short-story shelf shows word count without a chapter count or latest-chapter line', () => {
  const h = harness(); load(h); h.context.uiLanguage = 'zh';
  h.state.kind = 'short';
  h.state.books = [{ id: 'short-summary', title: '风过檐下', kind: 'short', chapterCount: 1, volumeCount: 0,
    charCount: 5000, latestChapterTitle: '正文', cover: '', updatedAt: '2026-10-12T00:00:00Z' }];
  h.run('svgIcon=()=>"";renderCollection()');
  const card = h.get('shelf-grid').children[0];
  assert.equal(card.querySelector('.shelf-book-progress'), null);
  assert.equal(card.querySelector('.shelf-book-bottom').children[0].textContent, '5,000 字');
  assert.ok(!descendants(card).some(element => /篇章|最近章节|\d+ 章/.test(element.textContent)));
});

check('a new book whose first outline save fails keeps its form and retries the same book instead of creating a duplicate', async () => {
  const h = harness(); load(h); setupDialog(h, false); h.context.createdCount = 0;
  h.run('api=async(endpoint,method,data)=>{if(endpoint!=="/api/books"||method!=="POST")throw new Error("Unexpected API");createdCount++;return{revision:1,book:{id:"new-outline-book",title:data.title,kind:data.kind,cover:"",volumes:[],chapters:[],notes:[],outline:[],relations:[],atlasViews:[]}};};setBook=r=>{state.book=r.book;state.revision=r.revision;state.kind=r.book.kind;state.dirty=false;normalizeWorkspaceBook(state.book);};refreshBooks=async()=>{};showBookSettings(false)');
  const form = h.context.dialogState.children[0], name = descendants(form).find(element => element.id === 'book-title-input');
  name.value = '从大纲开始的新小说'; await form.listeners.submit({ preventDefault() {} });
  assert.equal(h.context.createdCount, 1); assert.equal(h.context.dialogState.closed, 0);
  assert.equal(h.state.book.chapters.length, 0); assert.ok(h.state.book.outline.length > 0); assert.equal(h.state.dirty, true);
  const outlineIds = h.state.book.outline.map(item => item.id); h.context.saveResult = true;
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(h.context.createdCount, 1); assert.equal(h.context.dialogState.closed, 1);
  assert.deepEqual(h.state.book.outline.map(item => item.id), outlineIds); assert.equal(h.state.view, 'outline');
});

check('the full-demo reading link and return button restore the exact outline section and reading mode', async () => {
  const h = harness(); load(h); h.state.outlineMode = 'read';
  const source = h.state.book.outline.filter(item => item.kind === 'chapter')[24];
  h.state.outlineId = source.id; h.state.outlineVolumeFilter = source.volumeId;
  h.context.document.querySelector = () => h.get('chapter-heading');
  h.get('editor').setSelectionRange = (start, end) => { h.get('editor').selectionStart = start; h.get('editor').selectionEnd = end; };
  h.run('selectChapter=id=>{state.chapterId=id;};closeDialog=()=>{};toast=()=>{};bindPlanningEvents();renderOutlineWorkspace()');
  const link = h.get('read-' + source.id).querySelector('.outline-manuscript-link');
  await link.listeners.click({ preventDefault() {} });
  // The link starts the actual asynchronous jump. Settle its save/transition work.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(h.state.view, 'write'); assert.equal(h.state.chapterId, source.chapterIds[0]);
  assert.equal(h.state.trail.outlineId, source.id);
  await h.get('return-source').listeners.click();
  assert.equal(h.state.view, 'outline'); assert.equal(h.state.outlineId, source.id); assert.equal(h.state.outlineMode, 'read');
  assert.equal(h.state.outlineVolumeFilter, source.volumeId); assert.ok(h.get('read-' + source.id).scrolled);
});

check('the full demo can be filtered by every actual volume and the reader/navigation anchors agree', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; const before = JSON.stringify(h.state.book);
  for (const volume of h.state.book.volumes) {
    h.state.outlineVolumeFilter = volume.id; h.state.outlineCategory = '分卷剧情'; h.state.outlineKindFilter = 'chapter';
    h.run('renderOutlineWorkspace()');
    const rows = Array.from(h.run('outlineFilteredRows().matches.map(({o})=>o.id)'));
    const documentIds = descendants(h.get('outline-reading')).filter(element => element.id?.startsWith('read-')).map(element => element.id.slice(5));
    const contentsIds = h.get('outline-tree').querySelectorAll('.outline-node').map(element => element.dataset.outline);
    assert.equal(rows.length, 6); assert.deepEqual(documentIds, rows); assert.deepEqual(contentsIds, rows);
  }
  assert.equal(JSON.stringify(h.state.book), before, 'Reading and filtering cannot rewrite prose or plans');
});

check('switching to a different book resets old filters, folds and search without leaking outline content', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; h.state.outlineCategory = '分卷剧情';
  h.state.outlineKindFilter = 'chapter'; h.state.outlineVolumeFilter = h.state.book.volumes[0].id;
  h.state.outlineCollapsed = new Set(h.state.book.outline.map(item => item.id)); h.get('outline-search').value = '潮汐';
  const other = { id: 'separate-short-story', title: '独立短篇', kind: 'short', chapters: [], notes: [], volumes: [], relations: [], atlasViews: [], outline: [{ id: 'other-story-outline', kind: 'story', title: '新的总纲', body: '独立内容', chapterIds: [], parentId: null, volumeId: null, deletedAt: null }] };
  h.state.book = other; h.state.kind = 'short'; h.run('normalizeWorkspaceBook(state.book);renderOutlineWorkspace()');
  assert.equal(h.state.outlineCategory, 'all'); assert.equal(h.state.outlineKindFilter, ''); assert.equal(h.state.outlineVolumeFilter, '');
  assert.equal(h.get('outline-search').value, ''); assert.equal(h.state.outlineCollapsed.size, 0);
  assert.deepEqual(h.get('outline-tree').querySelectorAll('.outline-node').map(element => element.dataset.outline), ['other-story-outline']);
  assert.equal(h.get('read-other-story-outline').querySelector('.outline-read-body').textContent, '独立内容');
});

(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed++; console.error('FAIL:', name, '\n ', error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
