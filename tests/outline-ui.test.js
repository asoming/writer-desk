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
    matchMedia: () => ({ matches: true }),
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

function outline(id, title, kind, parentId = null, volumeId = null, category) {
  return { id, title, kind, parentId, volumeId, body: '构思\n\n正文片段 ' + title + ' <b>原样保留</b>',
    chapterIds: ['manuscript-' + id], deletedAt: null, ...(category ? { category } : {}) };
}
function book() {
  const items = [
    outline('story', '故事主线', 'story'), outline('world', '世界观与规则', 'scene'),
    outline('volume-one', '第一卷', 'volume', 'story', 'v1'),
    outline('chapter-one', '开端', 'chapter', 'volume-one'),
    outline('scene-one', '对峙', 'scene', 'chapter-one'),
    outline('foreshadow', '伏笔与回收', 'scene', 'volume-one'),
    outline('custom', '特殊检查', 'scene', null, null, '我的分类'),
    outline('volume-two', '第二卷', 'volume', 'story', 'v2'),
    outline('chapter-two', '收束', 'chapter', 'volume-two'),
    { ...outline('archived', '回收大纲', 'scene'), deletedAt: '2026-10-09' },
  ];
  return { id: 'outline-book', title: '大纲测试作品', kind: 'long', cover: '', notes: [], relations: [], atlasViews: [],
    volumes: [{ id: 'v1', title: '第一卷', summary: '起点', deletedAt: null }, { id: 'v2', title: '第二卷', summary: '终点', deletedAt: null }],
    chapters: items.map(item => ({ id: item.chapterIds[0], title: item.title, body: '正文', volumeId: item.volumeId, deletedAt: item.deletedAt })),
    outline: items };
}
function load(h, value = book()) {
  h.state.book = value; h.state.kind = value.kind; h.state.view = 'outline';
  h.state.outlineId = 'story'; h.state.outlineMode = 'edit'; h.state.outlineFilterBook = value.id;
  h.state.outlineCategory = 'all'; h.state.outlineKindFilter = ''; h.state.outlineVolumeFilter = '';
  h.state.outlineCollapsed = new Set(); h.state.dirty = false; h.state.seq = 0;
  h.run('normalizeWorkspaceBook(state.book)');
}
const expectedTopics = {
  story: '故事主线', world: '世界设定', 'volume-one': '分卷剧情', 'chapter-one': '分卷剧情', 'scene-one': '分卷剧情',
  foreshadow: '伏笔回收', custom: '我的分类', 'volume-two': '分卷剧情', 'chapter-two': '分卷剧情',
};
function filteredIds(h) { return Array.from(h.run('outlineFilteredRows().matches.map(({o})=>o.id)')); }
function readingIds(h) { return descendants(h.get('outline-reading')).filter(element => element.id?.startsWith('read-')).map(element => element.id.slice(5)); }
function navigationIds(h) { return h.get('outline-tree').querySelectorAll('.outline-node').map(element => element.dataset.outline); }
function sameIds(actual, expected, message) { assert.deepEqual([...actual].sort(), [...expected].sort(), message); }

const checks = [];
function check(name, test) { checks.push({ name, test }); }

check('legacy topics use title and hierarchy while explicit custom categories take priority', () => {
  const h = harness(); load(h); const before = JSON.stringify(h.state.book);
  const inferred = JSON.parse(h.run('JSON.stringify(Object.fromEntries(activeOutline().map(o=>[o.id,outlineTopic(o)])))'));
  assert.deepEqual(inferred, expectedTopics);
  assert.equal(JSON.stringify(h.state.book), before, 'Inferring old categories must not enter or alter the saved model');
  assert.ok(h.run('outlineTopicGroups().includes("我的分类")'));
});

for (const category of ['all', '世界设定', '分卷剧情', '伏笔回收', '我的分类']) {
  for (const kind of ['', 'volume', 'chapter', 'scene']) {
    check(`reading preserves exactly one stable anchor per match: topic=${category}, level=${kind || 'all'}`, () => {
      const h = harness(); load(h); const before = JSON.stringify(h.state.book);
      h.state.outlineCategory = category; h.state.outlineKindFilter = kind;
      const expected = h.state.book.outline.filter(item => !item.deletedAt && (category === 'all' || expectedTopics[item.id] === category) && (!kind || item.kind === kind)).map(item => item.id);
      sameIds(filteredIds(h), expected, 'Theme and structural level are independent filters');
      h.run('renderOutlineReading()'); const anchors = readingIds(h);
      sameIds(anchors, expected, 'Every matched section must remain readable, including scene children of volumes');
      assert.equal(new Set(anchors).size, anchors.length, 'Nested volume rendering cannot duplicate chapter or scene anchors');
      assert.equal(JSON.stringify(h.state.book), before, 'Reading does not write inferred categories or rearrange records');
    });
  }
}

check('volume filtering inherits the parent chain and combines with topic, level and full-text search', () => {
  const h = harness(); load(h); h.state.outlineVolumeFilter = 'v1';
  sameIds(filteredIds(h), ['volume-one', 'chapter-one', 'scene-one', 'foreshadow']);
  h.state.outlineCategory = '分卷剧情'; sameIds(filteredIds(h), ['volume-one', 'chapter-one', 'scene-one']);
  h.state.outlineKindFilter = 'scene'; sameIds(filteredIds(h), ['scene-one']);
  h.get('outline-search').value = '原样保留'; sameIds(filteredIds(h), ['scene-one'], 'Search must include the body');
  h.get('outline-search').value = '没有这样的词'; assert.deepEqual(filteredIds(h), []);
  h.run('renderOutlineReading()'); assert.deepEqual(readingIds(h), []);
});

check('continuous reader preserves paragraphs and literal markup; text links retain stable chapter IDs', () => {
  const h = harness(); load(h); h.run('renderOutlineReading()');
  const section = h.get('read-scene-one'),body = section.querySelector('.outline-read-body');
  assert.equal(body.textContent, h.state.book.outline.find(item => item.id === 'scene-one').body);
  assert.ok(body.textContent.includes('\n\n')); assert.ok(body.textContent.includes('<b>原样保留</b>'));
  const original = h.state.book.chapters.find(item => item.id === 'manuscript-scene-one');
  original.title = '重新命名后的正文'; h.state.book.chapters.reverse(); h.context.opened = [];
  h.run('jumpToChapter=id=>opened.push(id);renderOutlineReading()');
  const links = h.get('read-scene-one').querySelectorAll('.outline-manuscript-link');
  assert.equal(links.length, 1); assert.equal(links[0].tagName, 'A'); assert.equal(links[0].href, '#manuscript');
  assert.equal(links[0].textContent, original.title); assert.equal(links[0].dataset.chapter, original.id); links[0].listeners.click();
  assert.deepEqual(h.context.opened, ['manuscript-scene-one']);
  assert.equal(h.state.outlineId, 'scene-one', 'Returning from the linked manuscript must preserve its actual outline source');
});

check('reading is a continuous document without overview cards, duplicate category headings or per-section controls', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; const before = JSON.stringify(h.state.book);
  h.run('renderOutlineWorkspace()'); const reader = h.get('outline-reading');
  assert.equal(reader.children[0].tagName, 'HEADER'); assert.equal(reader.children[0].children.length, 1);
  assert.equal(reader.children[0].children[0].tagName, 'H1'); assert.equal(reader.children[0].children[0].textContent, h.state.book.title);
  assert.ok(reader.children.slice(1).every(element => (element.className || '').includes('outline-read-section')), 'The authored sections follow each other directly');
  for (const selector of ['.outline-volume-card', '.outline-volume-overview', '.outline-reader-category', '.outline-reader-category-heading', '.outline-read-section-top', '.outline-read-kind', '.chapter-link']) assert.equal(reader.querySelectorAll(selector).length, 0, selector);
  assert.deepEqual(readingIds(h).filter(id => expectedTopics[id] === '分卷剧情'), ['volume-one', 'chapter-one', 'scene-one', 'volume-two', 'chapter-two']);
  assert.equal(h.get('read-volume-one').children[0].tagName, 'H2'); assert.equal(h.get('read-chapter-one').children[0].tagName, 'H3');
  assert.equal(JSON.stringify(h.state.book), before);
});

check('reading contents use real text anchors and expose all sections without edit-tree subtitles or folds', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; h.state.outlineCollapsed = new Set(['volume-one', 'chapter-one']);
  h.run('renderOutlineWorkspace()'); const tree = h.get('outline-tree'), links = tree.querySelectorAll('.outline-node');
  sameIds(navigationIds(h), readingIds(h), 'Every document section has exactly one contents link, even if its editing tree is folded');
  for (const link of links) {
    assert.equal(link.tagName, 'A'); assert.equal(link.href, '#read-' + link.dataset.outline);
    assert.ok(h.get(link.href.slice(1))); assert.equal(link.querySelectorAll('small').length, 0); assert.equal(link.children.length, 1);
  }
  assert.equal(tree.querySelectorAll('.outline-fold').length, 0); assert.equal(h.get('outline-tree-tools').children.length, 0);
  assert.ok(tree.querySelectorAll('.outline-toc-group-heading').every(heading => heading.children.length === 1), 'Theme headings have no counts');
  let prevented = false; links.find(link => link.dataset.outline === 'scene-one').listeners.click({ preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.equal(h.state.outlineId, 'scene-one'); assert.ok(h.get('read-scene-one').scrolled);
});

check('filtered reading contents never link to contextual ancestors that are absent from the document', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; h.state.outlineCategory = '分卷剧情'; h.state.outlineKindFilter = 'scene'; h.state.outlineVolumeFilter = 'v1';
  h.run('renderOutlineWorkspace()'); assert.deepEqual(navigationIds(h), ['scene-one']); assert.deepEqual(readingIds(h), ['scene-one']);
  const link = h.get('outline-tree').querySelector('.outline-node'); assert.equal(link.href, '#read-scene-one');
  h.get('outline-search').value = '没有匹配内容'; h.run('filterOutlineTree()'); assert.deepEqual(navigationIds(h), []); assert.deepEqual(readingIds(h), []);
});

check('reading classification, structural level and volume filters are available in a closed disclosure', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; h.run('renderOutlineWorkspace()');
  const details = h.get('outline-filter-controls').querySelector('details'); assert.equal(details.open, false);
  assert.ok(h.get('outline-filter-topic')); assert.ok(h.get('outline-filter-kind')); assert.ok(h.get('outline-filter-volume'));
  details.open = true; details.listeners.toggle(); const topic = h.get('outline-filter-topic'); topic.value = '我的分类'; topic.listeners.change();
  assert.equal(h.state.outlineCategory, '我的分类'); assert.equal(h.get('outline-filter-controls').querySelector('details').open, true);
  assert.deepEqual(readingIds(h), ['custom']); assert.ok(h.get('outline-filter-controls').querySelector('summary').textContent.includes('我的分类'));
});

check('clicking a document heading edits that section and reveals only its ancestor path', () => {
  const h = harness(); load(h); h.state.outlineMode = 'read'; h.state.outlineCollapsed = new Set(['volume-one', 'chapter-one', 'volume-two']);
  const before = JSON.stringify(h.state.book); h.run('renderOutlineWorkspace()');
  const title = h.get('read-scene-one').querySelector('.outline-heading-link'); assert.equal(title.textContent, '对峙'); title.listeners.click();
  assert.equal(h.state.outlineMode, 'edit'); assert.equal(h.state.outlineId, 'scene-one'); assert.equal(h.get('outline-title').value, '对峙');
  assert.ok(!h.state.outlineCollapsed.has('volume-one')); assert.ok(!h.state.outlineCollapsed.has('chapter-one')); assert.ok(h.state.outlineCollapsed.has('volume-two'));
  assert.equal(JSON.stringify(h.state.book), before, 'Opening the editor must not rewrite authored sections');
});

check('folds hide descendants, but search reveals matched paths without deleting fold preferences', () => {
  const h = harness(); load(h); h.state.outlineCollapsed = new Set(['volume-one']);
  h.run('renderOutlineNavigation()'); assert.ok(!navigationIds(h).includes('chapter-one'));
  h.get('outline-search').value = '对峙'; h.run('filterOutlineTree()');
  assert.ok(navigationIds(h).includes('scene-one')); assert.ok(navigationIds(h).includes('chapter-one'));
  assert.ok(h.state.outlineCollapsed.has('volume-one'), 'Temporary search expansion must preserve the user’s fold preference');
});

check('editing a custom topic updates the model before blur and then refreshes its category chip', () => {
  const h = harness(); load(h); h.state.outlineId = 'world'; h.run('renderOutlineWorkspace()');
  const input = h.get('outline-category-input'); input.value = '自定义魔法设定'; input.oninput();
  assert.equal(h.state.book.outline.find(item => item.id === 'world').category, '自定义魔法设定');
  assert.equal(h.state.dirty, true, 'Ctrl+S before blur must see the category in the model');
  input.onchange(); assert.ok(h.get('outline-categories').children.some(button => button.dataset.topic === '自定义魔法设定'));
});

check('new outline templates assign explicit topics without creating manuscript chapters', () => {
  const h = harness(), value = book(); value.outline = []; value.chapters = []; load(h, value);
  h.run('createOutlineTemplate()'); assert.equal(h.state.book.chapters.length, 0);
  assert.ok(h.state.book.outline.length > 0); assert.ok(h.state.book.outline.every(item => typeof item.category === 'string' && item.category));
});

check('revealing a selected node expands only its ancestor path', () => {
  const h = harness(); load(h); h.state.outlineCollapsed = new Set(['story', 'volume-one', 'chapter-one', 'volume-two']);
  h.run("revealOutlinePath('scene-one');renderOutlineNavigation()");
  assert.ok(navigationIds(h).includes('scene-one')); assert.ok(h.state.outlineCollapsed.has('volume-two'), 'Unrelated branches stay folded');
  assert.ok(!h.state.outlineCollapsed.has('volume-one')); assert.ok(!h.state.outlineCollapsed.has('chapter-one'));
});

check('real outline backlinks clear restrictive filters, reveal the folded target and scroll its reading section', async () => {
  const h = harness(); load(h); h.state.view = 'write'; h.state.outlineMode = 'read';
  h.state.outlineCategory = '世界设定'; h.state.outlineKindFilter = 'volume'; h.state.outlineVolumeFilter = 'v2';
  h.state.outlineCollapsed = new Set(['volume-one', 'chapter-one', 'volume-two']); h.get('outline-search').value = '不匹配';
  h.context.owner = { type: 'outline', item: h.state.book.outline.find(item => item.id === 'scene-one') };
  await h.run('jumpToOwner(owner)');
  assert.equal(h.state.view, 'outline'); assert.equal(h.state.outlineId, 'scene-one');
  assert.equal(h.state.outlineCategory, 'all'); assert.equal(h.state.outlineKindFilter, ''); assert.equal(h.state.outlineVolumeFilter, ''); assert.equal(h.get('outline-search').value, '');
  assert.ok(navigationIds(h).includes('scene-one'), 'The selected target cannot remain hidden under an old fold');
  assert.ok(h.state.outlineCollapsed.has('volume-two'), 'Backlinks should not unfold unrelated volumes');
  assert.ok(h.get('read-scene-one')?.scrolled, 'Reading mode must scroll to the selected section, not just change the state ID');
  assert.equal(h.get('workspace').inert, false); assert.equal(h.get('dialog').inert, false);
});

for (const reducedMotion of [true, false]) {
  for (const position of ['above', 'below']) {
    check(`reading scroll keeps the document position while revealing the contents locally: reduce=${reducedMotion}, link=${position}`, () => {
      const h = harness(); load(h); h.state.outlineMode = 'read'; h.run('renderOutlineWorkspace()');
      const outer = h.get('outline-layout'), nav = new Element('nav'), tree = h.get('outline-tree'), reader = h.get('outline-reading');
      nav.className = 'outline-tree'; nav.rect = { top: -650, bottom: -418 }; nav.clientTop = 2; nav.clientHeight = 230; nav.scrollTop = 200;
      nav.append(tree); outer.append(nav, reader);
      // On mobile the nav and document share this outer scroller. A descendant
      // scrollIntoView in the nav would undo the manuscript's requested position.
      nav.onScrollIntoView = () => { outer.scrollTop = 0; };
      const target = h.get('read-scene-one'); target.onScrollIntoView = () => { outer.scrollTop = 1234; };
      h.context.matchMedia = () => ({ matches: reducedMotion });
      let selected;
      h.context.requestAnimationFrame = callback => {
        selected = tree.querySelector('.outline-node.active');
        selected.rect = position === 'above' ? { top: -700, bottom: -670 } : { top: -300, bottom: -260 };
        callback();
      };
      const before = JSON.stringify(h.state.book); h.run("selectOutlineNode('scene-one')");
      assert.equal(target.scrolled.behavior, reducedMotion ? 'instant' : 'smooth'); assert.equal(target.scrolled.block, 'start');
      assert.equal(outer.scrollTop, 1234, 'Revealing the selected contents link cannot pull the shared mobile scroller back to the nav');
      assert.equal(selected.scrolled, undefined, 'Reading contents must never use scrollIntoView on their ancestors');
      assert.equal(nav.scrollTop, position === 'above' ? 148 : 358, 'Only the nav scrollTop changes, in the direction needed to reveal its selected link');
      assert.equal(JSON.stringify(h.state.book), before);
    });
  }
}

check('editing selection can still reveal its active tree node', () => {
  const h = harness(); load(h); h.run("selectOutlineNode('scene-one')");
  assert.equal(h.get('outline-tree').querySelector('.outline-node.active').scrolled.block, 'nearest');
});

(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed += 1; console.error('FAIL:', name, '\n ', error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
