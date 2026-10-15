'use strict';
// Run the actual planning UI against isolated books and a small DOM harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname, '..');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {};
    this.className = ''; this.value = ''; this.textContent = ''; this.open = false;
    this.classList = {add: (...keys) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...keys])].join(' '); }};
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  replaceWith(element) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1, element); element.parentElement = parent; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  async dispatch(name, event = {}) { for (const handler of this.listeners[name] || []) await handler({...event, target: event.target || this}); }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return all;
    return all.filter(element => selector[0] === '.' ? element.className.split(' ').includes(selector.slice(1))
      : selector[0] === '#' ? element.id === selector.slice(1)
      : selector === '[data-story-id]' ? element.dataset.storyId !== undefined : element.tagName === selector.toUpperCase());
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get childElementCount() { return this.children.length; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const handler of this.listeners.close || []) handler({target: this}); }
  focus() { this.document.activeElement = this; }
}
function book(id = 'one', kind = 'long') {
  return {id, kind, title: 'Book ' + id, chapters: [{id: id + '-chapter', title: 'First chapter', body: 'Manuscript stays unchanged.', deletedAt: null}],
    notes: [{id: id + '-person', type: '人物', title: '林舟', deletedAt: null}], storyTools: {dailyGoal: 2000, foreshadows: [], timeline: []}};
}
const copy = value => JSON.parse(JSON.stringify(value));
const ticks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function harness(initial = book(), custom = {}) {
  const document = {activeElement: null, createElement(tag) { const node = new Element(tag); node.document = document; return node; }};
  document.body = document.createElement('body');
  const state = {book: initial, dirty: 0, saves: 0, composing: false, saved: true, calls: [], jumps: [], confirmed: true};
  const context = vm.createContext({document, crypto: {randomUUID}, console, Date, Map, Set, Number, String, Promise}); context.window = context;
  context.confirm = () => state.confirmed;
  vm.runInContext(fs.readFileSync(path.join(root, 'public/story-tools.js'), 'utf8'), context);
  const module = context.WriterStoryTools;
  const statistics = {bookId: initial.id, today: '2026-10-15', todayChars: 456, totalChars: 101506,
    days: Array.from({length: 90}, (_, index) => { const date = new Date(Date.UTC(2026, 6, 18 + index)); return {date: date.toISOString().slice(0, 10), addedChars: index === 89 ? 456 : 0}; })};
  module.configure({getBook: () => state.book, markDirty: () => state.dirty++, saveNow: async () => { state.saves++; return state.saved; },
    T: (value, ...values) => value.replace(/\{(\d+)\}/g, (_, index) => values[index]),
    setComposing: value => { state.composing = value; }, jumpToChapter: id => state.jumps.push(['chapter', id]), jumpToPerson: id => state.jumps.push(['person', id]),
    api: async url => { state.calls.push(url); return copy(statistics); }, ...custom});
  const all = () => document.body.querySelectorAll('*');
  const find = label => all().find(element => element.tagName === 'BUTTON' && element.textContent === label);
  const select = label => all().find(element => element.tagName === 'SELECT' && element.attributes['aria-label'] === label);
  const field = label => { const wrapper = all().find(element => element.tagName === 'LABEL' && element.children[0]?.textContent === label); return wrapper?.children[1]; };
  const click = async label => { const target = find(label); assert.ok(target, 'Missing button: ' + label); await target.dispatch('click'); await ticks(); };
  const type = async (label, value) => { const target = field(label); assert.ok(target, 'Missing field: ' + label); target.value = value; await target.dispatch('input'); };
  return {module, state, all, find, select, field, click, type, document, dialog: () => document.body.querySelector('dialog')};
}
const tests = []; const check = (name, run) => tests.push({name, run});
check('opening only reads planning and does not touch manuscript or mark dirty', async () => {
  const h = harness(), before = copy(h.state.book);
  assert.equal(await h.module.open(), true);
  assert.equal(h.dialog().open, true); assert.deepEqual(h.state.book, before); assert.equal(h.state.dirty, 0);
  assert.equal(h.all().filter(item => item.attributes.role === 'tab').length, 3);
});
check('failed save blocks opening a tool on unsaved content', async () => {
  const h = harness(); h.state.saved = false;
  assert.equal(await h.module.open(), false); assert.equal(h.dialog(), null); assert.equal(h.state.dirty, 0);
});
check('new foreshadow accepts title, explanation and phase without modifying text', async () => {
  const h = harness(), body = h.state.book.chapters[0].body;
  await h.module.open(); await h.click('+ 新建伏笔'); await h.type('标题', '没有邮戳的信'); await h.type('说明', '第六章揭示寄件人。');
  const record = h.state.book.storyTools.foreshadows[0]; assert.equal(record.status, 'planted'); assert.equal(record.title, '没有邮戳的信');
  assert.equal(record.body, '第六章揭示寄件人。'); assert.equal(h.state.book.chapters[0].body, body); assert.equal(h.state.dirty, 3);
  const status = h.field('伏笔状态'); status.value = 'developing'; await status.dispatch('change'); assert.equal(record.status, 'developing');
  assert.ok(h.all().some(item => item.className === 'story-tools-item-meta' && item.textContent === '推进'));
});
check('unresolved is the default filter and recovered hints are explicitly available', async () => {
  const h = harness(); h.state.book.storyTools.foreshadows = [
    {id: 'unresolved', title: '未收回的信', body: '', status: 'developing', chapterIds: [], personIds: []},
    {id: 'resolved', title: '已说明的信', body: '', status: 'resolved', chapterIds: [], personIds: []}];
  await h.module.open(); assert.equal(h.all().filter(item => item.dataset.storyId).length, 1);
  const filter = h.select('伏笔状态'); assert.equal(filter.value, 'unresolved'); filter.value = 'resolved'; await filter.dispatch('change');
  assert.equal(h.all().find(item => item.dataset.storyId).dataset.storyId, 'resolved');
});
check('recovering a foreshadow removes it from the unresolved list', async () => {
  const h = harness(); await h.module.open(); await h.click('+ 新建伏笔');
  const status = h.field('伏笔状态'); status.value = 'resolved'; await status.dispatch('change');
  assert.equal(h.state.book.storyTools.foreshadows[0].status, 'resolved'); assert.equal(h.all().filter(item => item.dataset.storyId).length, 0);
});
check('composition signals the shared save gate', async () => {
  const h = harness(); await h.module.open(); await h.click('+ 新建伏笔');
  const title = h.field('标题'); await title.dispatch('compositionstart'); assert.equal(h.state.composing, true);
  await h.type('标题', '潮汐'); await title.dispatch('compositionend'); assert.equal(h.state.composing, false);
});
check('links can be selected and navigate after successful save', async () => {
  const h = harness(); await h.module.open(); await h.click('+ 新建伏笔');
  let checks = h.all().filter(item => item.tagName === 'INPUT' && item.type === 'checkbox');
  checks[0].checked = true; await checks[0].dispatch('change');
  checks = h.all().filter(item => item.tagName === 'INPUT' && item.type === 'checkbox'); checks[1].checked = true; await checks[1].dispatch('change');
  const record = h.state.book.storyTools.foreshadows[0];
  assert.deepEqual([...record.chapterIds], ['one-chapter']); assert.deepEqual([...record.personIds], ['one-person']);
  await h.click('First chapter ↗'); assert.deepEqual(h.state.jumps, [['chapter', 'one-chapter']]); assert.equal(h.dialog().open, false);
});
check('failed save preserves planning dialog instead of navigating', async () => {
  const h = harness(); h.state.book.storyTools.timeline.push({id: 'event', title: '返港', storyTime: '第一日', body: '', chapterIds: ['one-chapter'], personIds: []});
  await h.module.open('timeline'); h.state.saved = false; await h.click('First chapter ↗'); assert.equal(h.dialog().open, true); assert.equal(h.state.jumps.length, 0);
});
check('short-story chapter links are presented as one manuscript', async () => {
  const h = harness(book('short-one', 'short')); h.state.book.storyTools.timeline.push({id: 'event', title: '返港', storyTime: '', body: '', chapterIds: ['short-one-chapter'], personIds: []});
  await h.module.open('timeline'); assert.ok(h.find('正文 ↗')); await h.click('正文 ↗'); assert.deepEqual(h.state.jumps, [['chapter', 'short-one-chapter']]);
});
check('timeline accepts non-calendar time and has explicit stable ordering', async () => {
  const h = harness(); await h.module.open('timeline'); await h.click('+ 新建事件'); await h.type('标题', '雨季'); await h.type('故事时间', '帝国历一百二十年·雨季');
  const first = h.state.book.storyTools.timeline[0]; await h.click('+ 新建事件'); await h.type('标题', '往事'); const second = h.state.book.storyTools.timeline[1];
  await h.click('上移'); assert.equal(h.state.book.storyTools.timeline[0], second); assert.equal(h.state.book.storyTools.timeline[1], first);
  assert.equal(first.storyTime, '帝国历一百二十年·雨季'); await h.click('下移'); assert.equal(h.state.book.storyTools.timeline[0], first);
});
check('planning deletion respects cancel and only deletes its selected record', async () => {
  const h = harness(); await h.module.open('timeline'); await h.click('+ 新建事件'); await h.click('+ 新建事件');
  h.state.confirmed = false; await h.click('删除'); assert.equal(h.state.book.storyTools.timeline.length, 2);
  const preserved = h.state.book.storyTools.timeline[0]; h.state.confirmed = true; await h.click('删除'); assert.equal(h.state.book.storyTools.timeline.length, 1); assert.equal(h.state.book.storyTools.timeline[0], preserved);
});
check('statistics save first, then show activity, trends and calendar', async () => {
  const h = harness(); await h.module.open('stats'); await ticks();
  assert.deepEqual(h.state.calls, ['/api/books/one/writing-stats']); assert.ok(h.state.saves >= 2);
  assert.ok(h.all().some(item => item.tagName === 'STRONG' && item.textContent === '456 字'));
  assert.ok(h.all().some(item => item.tagName === 'STRONG' && item.textContent === '101,506 字'));
  assert.equal(h.all().filter(item => item.className === 'story-tools-chart-column').length, 7);
  await h.click('30 天'); assert.equal(h.all().filter(item => item.className === 'story-tools-chart-column').length, 30);
  assert.equal(h.all().filter(item => item.className.split(' ').includes('story-tools-calendar-day')).length, 31);
  assert.ok(h.all().some(item => item.className.split(' ').includes('is-today') && item.children[0].textContent === '15'));
});
check('daily goal updates book metadata and rejects invalid targets', async () => {
  const h = harness(); await h.module.open('stats'); await ticks();
  const target = h.field('每日目标'); target.value = '3000'; await target.dispatch('change'); assert.equal(h.state.book.storyTools.dailyGoal, 3000); assert.equal(h.state.dirty, 1);
  target.value = '-1'; await target.dispatch('change'); assert.equal(h.state.book.storyTools.dailyGoal, 3000); assert.equal(target.value, '3000');
  target.value = '0'; await target.dispatch('change'); assert.equal(h.state.book.storyTools.dailyGoal, 0); assert.equal(h.all().find(item => item.tagName === 'PROGRESS').hidden, true);
});
check('late statistics response cannot replace another book or tab', async () => {
  let resolve; const pending = new Promise(yes => { resolve = yes; }); const h = harness(book(), {api: () => pending});
  await h.module.open('stats'); await ticks(); await h.click('故事时间线'); resolve({bookId: 'one', days: [], today: '2026-10-15'}); await ticks();
  assert.ok(h.find('+ 新建事件')); assert.equal(h.all().some(item => item.className === 'story-tools-stat-cards'), false);
  h.state.book = book('two'); h.module.sync(); assert.equal(h.dialog().open, false);
});
check('book-switch synchronization closes a tool rather than writing to a new book', async () => {
  const h = harness(); await h.module.open(); await h.click('+ 新建伏笔'); const title = h.field('标题'); const old = h.state.book;
  h.state.book = book('new'); h.module.sync(); title.value = 'stale'; await title.dispatch('input');
  assert.equal(h.dialog().open, false); assert.equal(old.storyTools.foreshadows[0].title, ''); assert.equal(h.state.book.storyTools.foreshadows.length, 0);
});
check('keyboard tab navigation exposes a single selected tab', async () => {
  const h = harness(); await h.module.open(); const tab = h.find('伏笔追踪'); await tab.dispatch('keydown', {key: 'ArrowRight', preventDefault() {}});
  assert.ok(h.find('+ 新建事件')); const selected = h.all().filter(item => item.attributes['aria-selected'] === 'true'); assert.equal(selected.length, 1); assert.equal(selected[0].textContent, '故事时间线');
});
check('editing visible links retains recycled chapter and character associations for later restore', async () => {
  const initial = book(); initial.chapters.push({id:'recycled-chapter',title:'旧章',body:'旧正文',deletedAt:'2026-10-15T00:00:00Z'});initial.notes.push({id:'recycled-person',type:'人物',title:'旧人物',deletedAt:'2026-10-15T00:00:00Z'});
  initial.storyTools.foreshadows.push({id:'retained-hint',title:'保留关联',body:'原说明',status:'planted',chapterIds:['recycled-chapter'],personIds:['recycled-person']});const h=harness(initial);await h.module.open();
  assert.ok(!h.find('旧章 ↗'));assert.ok(!h.find('旧人物 ↗'));let checks=h.all().filter(item=>item.tagName==='INPUT'&&item.type==='checkbox');checks[0].checked=true;await checks[0].dispatch('change');checks=h.all().filter(item=>item.tagName==='INPUT'&&item.type==='checkbox');checks[1].checked=true;await checks[1].dispatch('change');
  const record=initial.storyTools.foreshadows[0];assert.deepEqual([...record.chapterIds],['recycled-chapter','one-chapter']);assert.deepEqual([...record.personIds],['recycled-person','one-person']);assert.equal(initial.chapters[1].deletedAt,'2026-10-15T00:00:00Z');assert.equal(record.body,'原说明');
});
(async () => { for (const test of tests) { await test.run(); console.log('PASS ' + test.name); } console.log(tests.length + ' story tool groups passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
