'use strict';

// These checks use an editable in-memory copy of the complete demonstration
// novel. No application database, sample file, or running app is modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const sample = JSON.parse(fs.readFileSync(path.join(root, 'examples/tide-archive.yejian.json'), 'utf8')).book;

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.textContent = '';
    this.hidden = false; this.attributes = {}; this.listeners = {}; this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {} }; this.clientWidth = 1000; this.clientHeight = 500;
  }
  append(...children) { children.forEach(child => { this.children.push(child); if (typeof child === 'object') child.parentElement = this; }); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  get options() { return this.children; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  close() { this.open = false; }
}
function find(element, predicate) {
  if (predicate(element)) return element;
  return element.children?.map(child => find(child, predicate)).find(Boolean);
}
function harness() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('people-graph').parentElement = new Element();
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0 };
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
      querySelector: () => new Element(), addEventListener() {} },
    crypto: { randomUUID }, clientStorage: storage, sessionStorage: storage, structuredClone,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(), addEventListener() {},
    T: (text, ...args) => Array.isArray(text) ? text.reduce((out, part, i) => out + part + (args[i] ?? ''), '') : String(text).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? ''),
  });
  context.window = context;
  for (const file of ['public/story-analysis.js', 'public/vendor/dagre.min.js', 'public/atlas-layout.js', 'public/app.js', 'public/atlas-ui.js', 'public/workspace.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  const run = source => vm.runInContext(source, context);
  const state = run('state');
  state.book = structuredClone(sample); state.kind = 'long'; state.view = 'people'; state.personId = sample.notes[0].id;
  state.atlasView = 'all'; state.atlasMode = 'graph'; state.graphVolume = ''; state.graphGroup = '';
  state.graphScope = 'all'; state.graphRelationType = ''; state.showAutomatic = false;
  run('normalizeWorkspaceBook(state.book);markDirty=()=>{state.dirty=true;state.seq++;};renderBacklinks=()=>{};renderNotes=()=>{};saveNow=async()=>true;');
  get('relation-type-filter').value = 'manual'; get('relation-index').open = true;
  context.captureDialog = (...args) => { context.dialog = args; };
  run('showDialog=(...args)=>captureDialog(...args);closeDialog=()=>{};');
  return { get, run, state, context };
}
function tableRows(h) { return h.get('relation-index-list').children[0].children[1].children; }
function pairKey(a, b) { return JSON.stringify([a, b].sort()); }

test('the full novel has stable categorized maps across every theme, group and volume', () => {
  const h = harness(), before = JSON.stringify(h.state.book);
  assert.equal(h.state.book.notes.filter(p => p.type === '人物').length, 32);
  assert.equal(h.state.book.relations.length, 35);
  assert.equal(h.state.book.chapters.length, 36);
  assert.equal(h.state.book.chapters.reduce((n, c) => n + Array.from(c.body).filter(ch => !/\s/u.test(ch)).length, 0), 101506);
  for (const view of h.state.book.atlasViews) {
    h.state.atlasView = 'view:' + view.id;
    assert.deepEqual(Array.from(h.run('filteredGraphPeople().map(p=>p.id)')).sort(), [...view.personIds].sort());
    for (const volume of h.state.book.volumes) {
      h.state.graphVolume = volume.id;
      const visible = Array.from(h.run('filteredGraphPeople().map(p=>p.id)'));
      assert.ok(visible.every(id => view.personIds.includes(id)));
    }
    h.state.graphVolume = '';
  }
  h.state.atlasView = 'all';
  for (const group of new Set(sample.notes.filter(p => p.type === '人物').map(p => p.profile.group))) {
    h.state.graphGroup = group;
    const visible = new Set(h.run('filteredGraphPeople().map(p=>p.id)'));
    const seeds = new Set(sample.notes.filter(p => p.type === '人物' && p.profile.group === group).map(p => p.id));
    const expected = new Set(seeds);
    sample.relations.filter(r => seeds.has(r.fromId) || seeds.has(r.toId)).forEach(r => { expected.add(r.fromId); expected.add(r.toId); });
    assert.deepEqual([...visible].sort(), [...expected].sort());
  }
  assert.equal(JSON.stringify(h.state.book), before, 'Browsing categories and volumes must never rewrite authored links or groups');
});

test('relationship index follows the selected theme and group instead of silently showing the whole book', () => {
  const h = harness(), view = h.state.book.atlasViews[1];
  h.state.atlasMode = 'index'; h.state.atlasView = 'view:' + view.id;
  h.run('renderPeople()');
  let visible = new Set(view.personIds);
  let expected = sample.relations.filter(r => visible.has(r.fromId) && visible.has(r.toId));
  assert.ok(expected.length < 35);
  assert.equal(tableRows(h).length, expected.length);
  h.state.atlasView = 'all'; h.state.graphGroup = '旧案相关'; h.run('renderPeople()');
  visible = new Set(h.run('filteredGraphPeople().map(p=>p.id)'));
  expected = sample.relations.filter(r => visible.has(r.fromId) && visible.has(r.toId));
  assert.equal(tableRows(h).length, expected.length);
  h.state.atlasView = 'view:empty'; h.state.graphGroup = '';
  h.state.book.atlasViews.push({ id: 'empty', title: '空分图', description: '', personIds: [] });
  h.run('renderPeople()'); assert.equal(tableRows(h).length, 0);
});

test('index keeps volume scope, supports its own manual/automatic filters and allows text search', () => {
  const h = harness(), volume = h.state.book.volumes[0];
  h.state.atlasMode = 'index'; h.state.graphVolume = volume.id;
  h.run('renderPeople()');
  const expected = sample.relations.filter(r => r.volumeIds.includes(volume.id));
  assert.equal(tableRows(h).length, expected.length);
  h.get('relation-search').value = '父子'; h.run('renderRelationIndex()');
  assert.equal(tableRows(h).length, expected.filter(r => [r.label, r.stage, r.body].join(' ').includes('父子')).length);
  h.get('relation-search').value = ''; h.get('relation-type-filter').value = 'automatic';
  h.run('renderRelationIndex()');
  assert.ok(tableRows(h).length > 0, 'Choosing automatic evidence in the index must not require the map-only display checkbox');
  const chapterIds = new Set(sample.chapters.filter(c => c.volumeId === volume.id).map(c => c.id));
  const automatic = h.run('analyzeWorkspace().cooccurrences');
  assert.equal(tableRows(h).length, automatic.filter(r => r.chapterIds.some(id => chapterIds.has(id))).length);
});

test('an index person link reveals the full person context without stale relationship filters', () => {
  const h = harness(); h.state.atlasMode = 'index'; h.state.graphRelationType = 'family'; h.run('renderPeople()');
  const first = tableRows(h)[0].children[0].children[0];
  first.listeners.click();
  assert.equal(h.state.atlasMode, 'graph'); assert.equal(h.state.graphRelationType, '');
  assert.equal(h.state.atlasView, 'all'); assert.equal(h.state.graphVolume, '');
  assert.equal(h.state.graphGroup, ''); assert.equal(h.state.graphScope, 'all');
  assert.equal(h.state.atlasFocusId, h.state.personId);
});

test('writing extends automatic appearances, and converting evidence preserves chapters and manual planning', async () => {
  const h = harness(), originalRelations = JSON.stringify(h.state.book.relations);
  const pair = h.run('analyzeWorkspace().cooccurrences[0]');
  const a = h.state.book.notes.find(p => p.id === pair.fromId), b = h.state.book.notes.find(p => p.id === pair.toId);
  const chapter = h.state.book.chapters.find(c => !pair.chapterIds.includes(c.id));
  chapter.body += `\n${a.title}与${b.title}一起核对名册。`;
  h.run('markDirty()');
  assert.ok(h.run('analyzeWorkspace()').appearances[a.id].includes(chapter.id));
  assert.ok(h.run('analyzeWorkspace()').appearances[b.id].includes(chapter.id));
  assert.equal(JSON.stringify(h.state.book.relations), originalRelations);
  const evidence = h.run('combinedRelations().find(r=>r.automatic)');
  h.context.evidence = evidence; h.run('showAutomaticRelation(evidence)');
  const convert = find(h.context.dialog[1], node => node.textContent === '编写他们的关系');
  assert.ok(convert); convert.listeners.click();
  const form = h.context.dialog[1], label = find(form, node => node.id === 'relation-label');
  label.value = '共同核验'; label.listeners.input();
  const added = h.state.book.relations.at(-1);
  assert.deepEqual(Array.from(added.chapterIds), Array.from(evidence.chapterIds));
  const scopes = find(form, node => node.className === 'relation-volume-choices');
  scopes.children[0].children[0].checked = true; scopes.children[0].children[0].listeners.change();
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(added.label, '共同核验'); assert.deepEqual(Array.from(added.volumeIds), [sample.volumes[0].id]);
  assert.equal(JSON.stringify(h.state.book.relations.slice(0, 35)), originalRelations);
  assert.ok(!h.run('analyzeWorkspace().cooccurrences').some(r => pairKey(r.fromId, r.toId) === pairKey(evidence.fromId, evidence.toId)), 'Confirmed manual relation replaces the duplicate automatic edge');
});

test('person-to-chapter round trips retain the selected person and stop safely when saving fails', async () => {
  const h = harness(), person = h.state.book.notes.find(p => p.title === '赵翎');
  h.state.personId = person.id; h.state.atlasView = 'view:' + h.state.book.atlasViews.at(-1).id;
  h.state.graphVolume = h.state.book.volumes[1].id;
  h.run('bindPlanningEvents();renderShell=()=>{};selectChapter=id=>{state.chapterId=id;};');
  const target = person.chapterIds[0], before = JSON.stringify(h.state.book);
  h.context.targetChapterId = target;
  await h.run('jumpToChapter(targetChapterId)');
  assert.equal(h.state.view, 'write'); assert.equal(h.state.chapterId, target);
  assert.equal(h.state.trail.personId, person.id); assert.equal(h.state.trail.view, 'people');
  h.run('saveNow=async()=>false;');
  await h.get('return-source').listeners.click();
  assert.equal(h.state.view, 'write'); assert.ok(h.state.trail, 'A failed save must preserve the return destination and current writing view');
  h.run('saveNow=async()=>true;');
  await h.get('return-source').listeners.click();
  assert.equal(h.state.view, 'people'); assert.equal(h.state.personId, person.id); assert.equal(h.state.trail, null);
  assert.equal(h.state.atlasView, 'view:' + h.state.book.atlasViews.at(-1).id);
  assert.equal(h.state.graphVolume, h.state.book.volumes[1].id);
  assert.equal(JSON.stringify(h.state.book), before, 'Navigation never rewrites manuscript content or relationship links');
});

test('core and neighbor indexes are independent of the hidden map-only automatic checkbox', () => {
  const h = harness(); h.state.atlasMode = 'index'; h.state.atlasView = 'core';
  h.get('relation-type-filter').value = 'automatic';
  h.state.showAutomatic = false; h.run('renderPeople()');
  const coreIds = Array.from(h.run('filteredGraphPeople().map(p=>p.id)'));
  const coreRows = tableRows(h).length;
  assert.equal(coreIds.length, 32); assert.equal(coreRows, 441);
  h.state.showAutomatic = true; h.run('renderPeople()');
  assert.deepEqual(Array.from(h.run('filteredGraphPeople().map(p=>p.id)')), coreIds);
  assert.equal(tableRows(h).length, coreRows);
  assert.equal(h.get('graph-type').hidden, true); assert.equal(h.get('graph-auto-control').hidden, true);

  h.state.atlasView = 'all'; h.state.graphScope = 'neighbors';
  h.state.personId = h.state.book.notes.find(p => p.title === '邵闻').id;
  h.state.showAutomatic = false; h.run('renderPeople()');
  const neighborIds = Array.from(h.run('filteredGraphPeople().map(p=>p.id)'));
  const neighborRows = tableRows(h).length;
  h.state.showAutomatic = true; h.run('renderPeople()');
  assert.deepEqual(Array.from(h.run('filteredGraphPeople().map(p=>p.id)')), neighborIds);
  assert.equal(tableRows(h).length, neighborRows);

  h.state.atlasMode = 'graph'; h.state.atlasView = 'core'; h.state.graphScope = 'all';
  h.state.showAutomatic = false;
  assert.equal(h.run('filteredGraphPeople().length'), 8, 'The visible graph checkbox still controls map-only automatic expansion');
  h.state.showAutomatic = true;
  assert.equal(h.run('filteredGraphPeople().length'), 32);
});

test('retrying a failed new theme save reuses one view and guards concurrent submits', async () => {
  const h = harness(), originalViews = h.state.book.atlasViews.length;
  let finishSave, calls = 0;
  h.context.persistTheme = () => { calls++; return new Promise(resolve => { finishSave = resolve; }); };
  h.context.closedThemes = 0;
  h.run('saveNow=()=>persistTheme();closeDialog=()=>{closedThemes++;};showAtlasViewEditor();');
  const form = h.context.dialog[1], title = find(form, node => node.id === 'atlas-view-name');
  const save = find(form, node => node.type === 'submit');
  title.value = '复核分图';
  const first = form.listeners.submit({ preventDefault() {} });
  const created = h.state.book.atlasViews.at(-1);
  assert.equal(h.state.book.atlasViews.length, originalViews + 1);
  assert.equal(save.disabled, true);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(calls, 1, 'Repeated submit while persistence is pending must not enqueue a second save');
  assert.equal(h.state.book.atlasViews.length, originalViews + 1);
  finishSave(false); await first;
  assert.equal(h.context.closedThemes, 0); assert.equal(save.disabled, false);
  assert.equal(h.state.dirty, true);
  assert.match(h.get('toast').textContent, /未保存/);

  title.value = '复核分图（已调整）';
  h.context.persistTheme = () => { calls++; return true; };
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(calls, 2); assert.equal(h.context.closedThemes, 1);
  assert.equal(h.state.book.atlasViews.length, originalViews + 1);
  assert.equal(h.state.book.atlasViews.at(-1).id, created.id);
  assert.equal(created.title, '复核分图（已调整）');
  assert.equal(h.state.atlasView, 'view:' + created.id);
});

test('the last available theme can be saved again after failure at the 100-view limit', async () => {
  const h = harness();
  while (h.state.book.atlasViews.length < 99) h.state.book.atlasViews.push({ id: 'reserved-' + h.state.book.atlasViews.length, title: '已有分图', description: '', personIds: [] });
  h.run('saveNow=async()=>false;showAtlasViewEditor();');
  const form = h.context.dialog[1]; find(form, node => node.id === 'atlas-view-name').value = '第一百分图';
  await form.listeners.submit({ preventDefault() {} });
  const created = h.state.book.atlasViews.at(-1);
  assert.equal(h.state.book.atlasViews.length, 100);
  h.run('saveNow=async()=>true;');
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(h.state.book.atlasViews.length, 100);
  assert.equal(h.state.atlasView, 'view:' + created.id, 'The failed save retry must be allowed even though its unsaved view already fills the final slot');
});
