'use strict';

// Exercise actual workspace transitions and graph rendering with a small DOM stub.
// No browser, production storage, or server is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.textContent = '';
    this.hidden = false; this.attributes = {}; this.listeners = {};
    this.style = { setProperty() {} }; this.clientWidth = 1000; this.clientHeight = 500;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  append(...children) { for (const child of children) { this.children.push(child); if (typeof child === 'object') child.parentElement = this; } }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  get options() { return this.children; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  select() {}
  scrollIntoView() {}
  close() { this.open = false; }
}

function harness({ strictIds = false } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const htmlIds = new Set([...fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const documentGet = id => !strictIds || htmlIds.has(id) ? get(id) : null;
  const graphPanel = new Element(); get('people-graph').parentElement = graphPanel;
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0 };
  function T(value, ...args) {
    if (Array.isArray(value)) return value.reduce((result, part, index) => result + part + (args[index] ?? ''), '');
    return String(value).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  }
  const context = vm.createContext({
    document: { getElementById: documentGet, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), addEventListener() {}, title: '' },
    addEventListener() {},
    crypto: { randomUUID }, sessionStorage: storage, clientStorage: storage, T,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(), structuredClone,
    WriterAnalysis: { analyzeBook: () => ({ appearances: {}, cooccurrences: [], candidates: [], ambiguous: [] }) },
  });
  // Geometry is exercised in editor-layout-electron.cjs; this DOM has no layout.
  context.WriterEditorLayout={resize(){}};
  context.window = context;
  for (const file of ['public/vendor/dagre.min.js', 'public/atlas-layout.js', 'public/app.js', 'public/atlas-ui.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  vm.runInContext("markDirty=()=>{state.dirty=true;state.seq++;};renderNotes=()=>{};", context);
  const state = vm.runInContext('state', context);
  return { context, state, get, htmlIds, run: expression => vm.runInContext(expression, context) };
}

function person(id, group = '', chapterIds = []) {
  return { id, type: '人物', title: id, body: '', chapterIds, aliases: [], deletedAt: null,
    profile: { group, role: id === 'A' ? '主角' : '', desire: '', flaw: '', ending: '', arcs: [] } };
}
function relation(id, fromId, toId, volumeIds = []) {
  return { id, fromId, toId, label: id, type: 'friend', stage: '', body: '', volumeIds, chapterIds: [], deletedAt: null };
}
function book() {
  return { id: 'book-one', title: 'Book one', kind: 'long', cover: '',
    volumes: [{ id: 'v1', title: 'First', summary: '', deletedAt: null }, { id: 'v2', title: 'Second', summary: '', deletedAt: null }],
    chapters: [{ id: 'c1', title: 'One', body: '', volumeId: 'v1', deletedAt: null }, { id: 'c2', title: 'Two', body: '', volumeId: 'v2', deletedAt: null }],
    notes: [person('A', 'Archive', ['c1']), person('B', 'Harbor', ['c2']), person('C', 'Harbor', ['c2']), person('D', 'Elsewhere')],
    outline: [], relations: [relation('AB', 'A', 'B', ['v1']), relation('BC', 'B', 'C', ['v2']), relation('CD', 'C', 'D')],
    atlasViews: [{ id: 'old-case', title: 'Old case', description: 'Authored theme', personIds: ['A', 'B'] }] };
}
function load(h, value = book()) {
  h.state.book = value; h.state.kind = value.kind; h.state.personId = value.notes[0]?.id;
  h.state.atlasView = 'all'; h.state.graphScope = 'all'; h.state.graphVolume = '';
  h.state.graphGroup = ''; h.state.graphRelationType = ''; h.state.graphZoom = null; h.state.atlasMode = 'graph';
  h.run('normalizeWorkspaceBook(state.book)');
}
function ids(h) { return Array.from(h.run('filteredGraphPeople().map(p=>p.id)')); }
let failed = 0;
function check(name, test) {
  try { test(); console.log('PASS:', name); } catch (error) { failed += 1; console.error('FAIL:', name, '\n ', error.message); }
}

check('authored theme members stay scoped; group expands only one manual hop independent of relation order', () => {
  const h = harness(); load(h); h.state.atlasView = 'view:old-case';
  assert.deepEqual(ids(h), ['A', 'B']);
  h.state.atlasView = 'all'; h.state.graphGroup = 'Archive';
  assert.deepEqual(ids(h), ['A', 'B'], 'A → B → C must not recursively pull the entire cast into A’s group');
  h.state.book.relations.reverse();
  assert.deepEqual(ids(h), ['A', 'B'], 'Relation record order must not change classification membership');
  h.state.atlasView = 'view:old-case'; h.state.graphGroup = 'Harbor';
  assert.deepEqual(ids(h), ['A', 'B'], 'Combining theme and group must retain the authored theme boundary');
});

check('legacy books and empty themed filters render without inventing people or changing authored categories', () => {
  const h = harness(), old = book(); delete old.atlasViews; load(h, old);
  assert.equal(h.state.book.atlasViews.length, 0);
  h.state.book.atlasViews.push({ id: 'empty', title: 'No people yet', description: '', personIds: [] });
  h.state.atlasView = 'view:empty';
  h.run('renderPersonWorkspace()');
  assert.deepEqual(ids(h), []); assert.equal(h.get('graph-empty').hidden, false);
  assert.equal(h.state.book.atlasViews[0].title, 'No people yet');
});

check('short-story people use manuscript labels and ignore legacy volume filters without changing stored profiles', () => {
  const h = harness(), value = book(); value.kind = 'short';
  value.notes[0].profile.arcs.push({ volumeId: 'v1', body: '以前的分卷人物规划保留。' });
  load(h, value); h.state.graphVolume = 'v2'; h.state.showAutomatic = true;
  h.context.WriterAnalysis.analyzeBook = () => ({ appearances: { A: ['c1'], B: ['c1'] },
    cooccurrences: [{ fromId: 'A', toId: 'B', chapterIds: ['c1'], volumeIds: [] }], candidates: [], ambiguous: [] });
  const before = JSON.stringify(h.state.book);
  const checkbox = h.get('graph-auto'); checkbox.marker = 'original-checkbox';
  const summaryCount = h.get('person-link-count'); summaryCount.marker = 'original-count';
  h.run('renderPersonWorkspace()');
  assert.deepEqual(ids(h), ['A', 'B', 'C', 'D'], 'An invisible old volume selection must not hide people');
  assert.equal(h.state.graphVolume, '');
  assert.equal(h.get('graph-volume').hidden, true);
  assert.equal(h.get('character-arcs').hidden, true);
  assert.equal(h.get('atlas-timeline-section').hidden, true);
  assert.equal(h.get('atlas-timeline').children.length, 0);
  assert.equal(h.get('graph-auto-label').textContent, '显示正文共同提及');
  assert.equal(h.get('relation-automatic-option').textContent, '正文共同提及');
  assert.equal(h.get('person-link-label').textContent, '手动关联正文');
  assert.equal(h.get('person-link').textContent, '＋ 关联正文');
  assert.equal(h.get('graph-auto'), checkbox);
  assert.equal(h.get('graph-auto').checked, true);
  assert.equal(h.get('person-link-count'), summaryCount);
  assert.match(h.get('graph-count').textContent, /正文共同提及/);
  assert.match(h.get('relation-index-count').textContent, /正文共同提及/);
  const prose = node => [node.textContent, ...node.children.map(prose)].join(' ');
  assert.ok(!prose(h.get('person-overview')).includes('分卷人物变化'));
  assert.equal(JSON.stringify(h.state.book), before, 'Display changes cannot remove previous planning or profile content');
  h.state.kind = 'long'; h.state.book.kind = 'long'; h.run('renderPersonWorkspace()');
  assert.equal(h.get('graph-volume').hidden, false);
  assert.equal(h.get('graph-auto-label').textContent, '显示同章提及');
  assert.equal(h.get('person-link-label').textContent, '手动关联章节');
  assert.equal(h.get('person-link').textContent, '＋ 关联章节');
  assert.equal(h.get('relation-automatic-option').textContent, '同章提及');
  assert.equal(h.get('graph-auto'), checkbox, 'Switching work types must retain event-bound inputs');
});

check('new people escape restrictive themes and enter editable profile mode', () => {
  const h = harness(); load(h); h.state.atlasView = 'view:old-case'; h.state.graphVolume = 'v2'; h.state.graphGroup = 'Harbor';
  h.run('addPerson()');
  const added = h.state.book.notes.at(-1);
  assert.equal(h.state.personId, added.id); assert.ok(ids(h).includes(added.id));
  assert.equal(h.state.personEditing, true); assert.equal(h.state.atlasMode, 'graph');
  assert.equal(h.get('person-editor-fields').hidden, false); assert.equal(h.get('person-title').focused, true);
});

check('backlink reset reveals a person hidden by a theme, volume and relation-type filter', () => {
  const h = harness(); load(h); h.state.atlasView = 'view:old-case'; h.state.graphVolume = 'v1'; h.state.graphGroup = 'Archive'; h.state.graphRelationType = 'family';
  h.state.personId = 'D'; h.run('resetAtlasForPerson();renderPeople()');
  assert.equal(h.state.personId, 'D'); assert.ok(ids(h).includes('D'));
  assert.equal(h.state.graphRelationType, ''); assert.equal(h.state.atlasFocusId, 'D');
});

check('changing volume cannot leave the whole visible graph dimmed by an invisible old focus', () => {
  const h = harness(); load(h); h.run("selectAtlasPerson('A')"); h.state.graphVolume = 'v2'; h.run('renderPeople()');
  const visible = ids(h); assert.deepEqual(visible, ['B', 'C']); assert.ok(visible.includes(h.state.personId));
  const nodes = h.get('people-graph').children.filter(node => node.className?.split(' ').includes('graph-node'));
  assert.ok(nodes.some(node => !node.className.split(' ').includes('dimmed')), 'Visible B and C must not both be dimmed because excluded A remains the focus');
  assert.ok(!h.state.atlasFocusId || visible.includes(h.state.atlasFocusId), 'Highlight focus must refer to a visible person or be cleared');
});

check('parallel relationships in the default core map have distinct visible routes and labels', () => {
  const h = harness(), value = book(); value.notes = value.notes.slice(0, 2);
  value.relations = [relation('Trust', 'A', 'B'), relation('Family', 'A', 'B')]; load(h, value); h.state.atlasView = 'core';
  h.run('renderPeople()');
  const edges = Array.from(h.state.atlasLayout.edges);
  assert.equal(edges.length, 2);
  assert.notEqual(JSON.stringify(edges[0].points), JSON.stringify(edges[1].points), 'Two authored relationships must not draw directly on top of each other');
  assert.ok(edges[0].labelX !== edges[1].labelX || edges[0].labelY !== edges[1].labelY, 'Both relationship labels must remain separately readable');
});

check('opening another book resets graph state and leaves each book’s authored themes intact', () => {
  const h = harness(); load(h); const first = h.state.book, preserved = JSON.stringify(first.atlasViews);
  h.state.atlasView = 'view:old-case'; h.state.graphVolume = 'v2'; h.state.graphGroup = 'Archive'; h.state.atlasFocusId = 'A';
  h.state.atlasMode = 'index'; h.state.graphRelationType = 'family'; h.state.atlasLayoutKey = 'old'; h.state.showAutomatic = true;
  const second = book(); second.id = 'book-two'; second.title = 'Book two'; second.notes = [person('Second-book-person')]; second.relations = []; delete second.atlasViews;
  h.context.nextBook = second;
  h.run('selectChapter=()=>{};renderShell=()=>{};saveStatus=()=>{};setBook({book:nextBook,revision:1})');
  assert.equal(h.state.book.id, 'book-two'); assert.equal(h.state.atlasView, 'core'); assert.equal(h.state.atlasMode, 'graph');
  assert.equal(h.state.graphVolume, ''); assert.equal(h.state.graphGroup, ''); assert.equal(h.state.graphRelationType, '');
  assert.equal(h.state.atlasFocusId, null); assert.equal(h.state.atlasLayoutKey, null); assert.equal(h.state.showAutomatic, false);
  assert.equal(h.state.book.atlasViews.length, 0); assert.equal(JSON.stringify(first.atlasViews), preserved);
});

check('the real note-type change listener protects theme references and archived relations but permits unlinked conversions', () => {
  for (const linkage of ['theme-only', 'archived-relation', 'unlinked']) {
    const h = harness(), value = book();
    value.relations = linkage === 'archived-relation' ? [{ ...relation('Old relation', 'A', 'B'), deletedAt: '2026-10-09' }] : [];
    if (linkage !== 'theme-only') value.atlasViews = [];
    load(h, value); h.state.noteId = 'A'; h.state.dirty = false; h.state.seq = 0;
    h.run('renderBacklinks=()=>{};bindEvents()');
    const selector = h.get('note-type'); selector.value = '地点';
    assert.equal(typeof selector.listeners.change, 'function');
    selector.listeners.change();
    if (linkage === 'unlinked') {
      assert.equal(h.state.book.notes[0].type, '地点', 'An unlinked person may be recategorized as a place');
      assert.equal(h.state.dirty, true); assert.equal(h.state.seq, 1);
    } else {
      assert.equal(h.state.book.notes[0].type, '人物', `${linkage} must retain the person required by the saved schema`);
      assert.equal(selector.value, '人物', 'The selector must visibly revert after blocking the conversion');
      assert.equal(h.state.dirty, false, 'A rejected conversion must not enter autosave');
      assert.equal(h.state.seq, 0); assert.equal(h.get('toast').hidden, false);
    }
  }
});

async function checkAsync(name, test) {
  try { await test(); console.log('PASS:', name); } catch (error) { failed += 1; console.error('FAIL:', name, '\n ', error.message); }
}

function navigationHarness() {
  const h = harness({ strictIds: true }); load(h);
  h.context.navRequests = [];
  h.context.navBooks = [{ id: 'book-one', title: 'Book one', kind: 'long' }, { id: 'book-short', title: 'A short story', kind: 'short' }];
  h.run("api=async path=>{navRequests.push(path);if(path==='/api/books')return{books:navBooks};throw new Error('Unexpected implicit book load: '+path);};renderShell=()=>{};bindEvents();bindWorkspaceEvents();");
  return h;
}

(async () => {
  await checkAsync('removed book switcher IDs are absent and all navigation listeners bind against the real HTML IDs', async () => {
    const h = navigationHarness();
    for (const id of ['open-library', 'book-context', 'context-book', 'context-outline', 'context-people', 'context-write', 'context-count', 'book-kind', 'book-meta', 'breadcrumb', 'mobile-context', 'page-kicker', 'nav-write-long', 'nav-write-short']) {
      assert.equal(h.htmlIds.has(id), false, `Removed switcher/header element ${id} must not remain in the real UI`);
    }
    assert.ok(h.htmlIds.has('nav-write'), 'There is one writing entry for the selected book');
    assert.equal(typeof h.get('nav-write').listeners.click, 'function');
    assert.ok(h.htmlIds.has('book-name'));
    assert.ok(h.htmlIds.has('outline-breadcrumbs'), 'Outline node navigation is independent of the removed book switcher');
    h.run("renderOutline=()=>{};renderPeople=()=>{};renderShelf=()=>{};selectChapter=()=>{};renderBacklinks=()=>{};state.view='outline';renderWorkspaceShell();state.view='shelf';renderWorkspaceShell();");
  });

  await checkAsync('left workspace navigation keeps the current book; shelf and legacy library action share one book selection surface', async () => {
    const h = navigationHarness(); h.state.view = 'write';
    for (const [id, view] of [['nav-outline', 'outline'], ['nav-people', 'people'], ['nav-write', 'write'], ['nav-shelf', 'shelf']]) {
      await h.get(id).listeners.click();
      assert.equal(h.state.view, view, id); assert.equal(h.state.book.id, 'book-one', `${id} must not open another book`);
    }
    assert.equal(h.state.collection, null);
    h.state.view = 'people'; await h.run('showLibrary()');
    assert.equal(h.state.view, 'shelf'); assert.equal(h.state.collection, null);
    assert.ok(h.context.navRequests.every(request => request === '/api/books'), 'Navigation may refresh shelf summaries but must not fetch an implicit book');
  });

  await checkAsync('one writing entry keeps both long and short selections without fetching another book', async () => {
    for (const kind of ['long', 'short']) {
      const h = navigationHarness(); h.state.kind = kind; h.state.book.kind = kind;
      h.state.book.id = kind === 'long' ? 'book-one' : 'book-short'; h.state.view = 'outline';
      const selected = h.state.book, before = JSON.stringify(selected);
      await h.get('nav-write').listeners.click();
      assert.equal(h.state.view, 'write'); assert.equal(h.state.kind, kind); assert.equal(h.state.book, selected);
      assert.equal(JSON.stringify(h.state.book), before, 'Entering writing must preserve all existing prose and planning');
      assert.equal(h.context.navRequests.length, 0, 'The common writing entry acts on the selected book');
      h.run('renderStats=()=>{};renderOutline=()=>{};renderBacklinks=()=>{};selectChapter=()=>{};ensureShortManuscript=()=>activeChapters()[0];renderWorkspaceShell()');
      assert.equal(h.get('nav-write').attributes['aria-current'], 'page');
      assert.equal(h.get('nav-outline').attributes['aria-current'], 'false');
      assert.equal(h.get('page-title').textContent, '写作', 'The writing header is shared across book kinds');
      h.state.view='outline';h.run('renderWorkspaceShell()');
      assert.equal(h.get('nav-write').attributes['aria-current'], 'false');
      assert.equal(h.get('nav-outline').attributes['aria-current'], 'page');
    }
  });

  await checkAsync('shelf kind tabs clear the previous selection and writing waits for explicit cover selection', async () => {
    const h = navigationHarness(); h.state.view = 'write';
    await h.get('shelf-short').listeners.click();
    assert.equal(h.state.kind, 'short'); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.book, null);
    assert.equal(h.state.collection, null);
    for (const entry of ['nav-write', 'nav-people']) {
      await h.get(entry).listeners.click();
      assert.equal(h.state.view, 'shelf'); assert.equal(h.state.kind, 'short'); assert.equal(h.state.book, null);
    }
    await h.get('shelf-long').listeners.click();
    assert.equal(h.state.kind, 'long'); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.book, null);
    await h.get('nav-write').listeners.click();
    assert.equal(h.state.kind, 'long'); assert.equal(h.state.view, 'shelf'); assert.equal(h.state.book, null);
    assert.ok(h.context.navRequests.every(request => request === '/api/books'), 'Available last/first books cannot be opened by a kind tab');
  });

  await checkAsync('failed saving blocks the common writing entry and shelf kind switches while retaining dirty text', async () => {
    const h = navigationHarness(); h.state.view = 'outline'; h.state.dirty = true;
    h.state.book.chapters[0].body = '这段未保存的正文必须保留。';
    const selected = h.state.book, before = JSON.stringify(selected), seq = h.state.seq;
    h.run('requireSaved=async()=>false');
    for (const entry of ['nav-write', 'shelf-short']) {
      await h.get(entry).listeners.click();
      assert.equal(h.state.book, selected); assert.equal(h.state.kind, 'long'); assert.equal(h.state.view, 'outline');
      assert.equal(h.state.dirty, true); assert.equal(JSON.stringify(h.state.book), before); assert.equal(h.state.seq, seq);
    }
    assert.equal(h.context.navRequests.length, 0, 'A failed save must stop navigation before any state changes');
    assert.equal(h.get('workspace').inert, false); assert.equal(h.get('dialog').inert, false);
  });

  await checkAsync('startup recovery with a missing last book opens the shelf instead of another book', async () => {
    const h = navigationHarness(); h.state.book = null; h.state.view = 'write'; h.state.kind = 'short';
    h.state.books = h.context.navBooks;
    h.run("preference=key=>key==='yejian.last-book.short'?'removed-book':null");
    await h.run("loadKind('short')");
    assert.equal(h.state.book, null); assert.equal(h.state.kind, 'short'); assert.equal(h.state.view, 'shelf');
    assert.equal(h.context.navRequests.length, 0, 'Missing recovery targets must not fall back to the first available book');
  });
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
