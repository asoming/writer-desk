'use strict';
// Actual controller in a disposable DOM/library, including save and book-switch
// races. Native selection/scroll is also exercised by the root browser audit.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), {randomUUID} = require('node:crypto');
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.className = ''; this.value = ''; this.textContent = ''; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; this.scrollTop = 0; this.disabled = false; }
  append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } if (this.tagName === 'SELECT' && !this.value && this.children[0]) this.value = this.children[0].value; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  async dispatch(name, event = {}) { for (const handler of this.listeners[name] || []) await handler({...event, target: event.target || this}); }
  querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); if (selector === '*') return all; return all.filter(element => selector[0] === '.' ? element.className.split(' ').includes(selector.slice(1)) : selector[0] === '#' ? element.id === selector.slice(1) : selector === '[data-mark-id]' ? element.dataset.markId !== undefined : element.tagName === selector.toUpperCase()); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const callback of this.listeners.close || []) callback({target: this}); }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
const sample = () => ({id: 'book', kind: 'long', title: '临时作品', chapters: [{id: 'one', title: '第一章', body: '开头段落。\n\n需要修改的段落。\n末段。', deletedAt: null}, {id: 'two', title: '第二章', body: '另一章正文。', deletedAt: null}, {id: 'old', title: '已回收章', body: '旧稿内容。', deletedAt: '2026-10-15T00:00:00Z'}]});
const deferred = () => { let resolve; return {promise: new Promise(value => { resolve = value; }), resolve: value => resolve(value)}; };
function harness(source = sample()) {
  const document = {activeElement: null, createElement(tag) { const element = new Element(tag); element.document = document; return element; }}; document.body = document.createElement('body');
  const editor = document.createElement('textarea'); editor.value = source.chapters[0].body; editor.setSelectionRange(7, 15);
  const state = {book: source, chapterId: 'one', saved: true, composing: false, transitioning: false, dirty: 0, saves: 0, jumps: [], messages: []};
  const context = vm.createContext({document, crypto: {randomUUID}, console, Date, Map, Set, Number, String, Promise}); context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/manuscript-marks.js'), 'utf8'), context); const module = context.ManuscriptMarks;
  const options = {getBook: () => state.book, getChapterId: () => state.chapterId, getEditor: () => editor, getWritingArea: () => null, isComposing: () => state.composing, isTransitioning: () => state.transitioning,
    markDirty: () => state.dirty++, saveNow: async () => { state.saves++; return state.saved; }, setComposing: value => { state.composing = value; }, toast: text => state.messages.push(text),
    T: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ''), jumpToChapter: async id => { state.jumps.push(id); state.chapterId = id; editor.value = state.book.chapters.find(chapter => chapter.id === id).body; }};
  module.configure(options);
  const all = () => document.body.querySelectorAll('*'), button = label => all().find(element => element.tagName === 'BUTTON' && element.textContent === label), field = label => all().find(element => element.attributes['aria-label'] === label), click = async label => { const control = button(label); assert.ok(control, 'Missing button ' + label); if (!control.disabled) await control.dispatch('click'); };
  return {module, state, options, editor, document, all, button, field, click, dialog: () => document.body.querySelector('dialog')};
}

test('create paragraph annotation, edit its contents, resolve, jump and delete through ordinary saves', async () => {
  const h = harness(), original = h.state.book.chapters[0].body; h.editor.setSelectionRange(9, 9);
  assert.equal(await h.module.add('annotations'), true); const item = h.state.book.reviewTools.annotations[0]; assert.equal(item.quote, '需要修改的段落。'); assert.equal(h.state.dirty, 1);
  const body = h.field('批注内容'); body.value = '这里需要补一段对白'; await body.dispatch('input'); assert.equal(item.body, body.value); assert.equal(h.state.dirty, 2);
  const checkbox = h.all().find(element => element.type === 'checkbox'); checkbox.checked = true; await checkbox.dispatch('change'); assert.equal(item.resolved, true);
  await h.click('跳转原文'); assert.deepEqual(h.state.jumps, ['one']); assert.equal(h.editor.selectionStart, item.start); assert.equal(h.editor.selectionEnd, item.end); assert.equal(h.dialog().open, false);
  await h.module.show(); await h.click('删除'); assert.equal(h.state.book.reviewTools.annotations.length, 0); assert.equal(h.state.book.chapters[0].body, original);
});

test('bookmark selection is separate from annotations and has a reusable optional name', async () => {
  const h = harness(); h.editor.setSelectionRange(0, 5); assert.equal(await h.module.add('bookmarks'), true);
  const item = h.state.book.reviewTools.bookmarks[0]; assert.equal(item.quote, '开头段落。'); assert.equal(h.state.book.reviewTools.annotations.length, 0);
  const label = h.field('书签名称'); label.value = '开篇待回看'; await label.dispatch('input'); assert.equal(item.label, '开篇待回看'); assert.ok(!h.field('批注内容'));
  await h.click('段落批注'); assert.ok(h.all().some(element => element.textContent === '暂无批注'));
});

test('current chapter/all-book filter excludes recycled chapter marks and preserves their recovery data', async () => {
  const h = harness(); await h.module.add(); h.state.book.reviewTools.annotations.push({...h.state.book.reviewTools.annotations[0], id: 'two-mark', chapterId: 'two', start: 0, end: 6, quote: '另一章正文。'}, {...h.state.book.reviewTools.annotations[0], id: 'old-mark', chapterId: 'old', start: 0, end: 5, quote: '旧稿内容。'});
  await h.module.show(); assert.equal(h.all().filter(element => element.dataset.markId).length, 1);
  const filter = h.field('批注查看范围'); filter.value = 'book'; await filter.dispatch('change'); assert.equal(h.all().filter(element => element.dataset.markId).length, 2); assert.equal(h.state.book.reviewTools.annotations.length, 3);
});

test('an orphan retains its note, cannot jump, and can explicitly link to a new selection', async () => {
  const h = harness(); h.editor.setSelectionRange(9, 9); await h.module.add(); const item = h.state.book.reviewTools.annotations[0]; item.body = '重要修改想法';
  const before = h.state.book.chapters[0].body; h.state.book.chapters[0].body = '新的不同段落。'; h.editor.value = h.state.book.chapters[0].body; h.module.reanchorChapter('one', before, h.editor.value, h.state.book);
  await h.module.show(); assert.equal(item.status, 'orphaned'); assert.equal(h.button('跳转原文').disabled, true); await h.click('跳转原文'); assert.equal(h.state.jumps.length, 0);
  await h.click('重新关联'); const preview = h.field('选择新的关联原文'); assert.equal(preview.readOnly, true); preview.setSelectionRange(2, 6); await h.click('关联所选文字'); assert.equal(item.status, 'linked'); assert.equal(item.quote, '不同段落'); assert.equal(item.body, '重要修改想法');
});

test('explicit relink refuses a source changed while the chooser was open', async () => {
  const h = harness(); await h.module.add(); const item = h.state.book.reviewTools.annotations[0]; await h.click('重新关联'); const preview = h.field('选择新的关联原文'); preview.setSelectionRange(0, 5);
  h.state.book.chapters[0].body = '后台更新后的文本。'; await h.click('关联所选文字'); assert.ok(h.state.messages.includes('正文已变化，请重新选择。')); assert.notEqual(item.quote, '开头段落。');
});

test('failed saves, IME composition and active transitions prevent creating new marks', async () => {
  for (const mode of ['saved', 'composing', 'transitioning']) { const h = harness(); h.state[mode] = mode !== 'saved'; assert.equal(await h.module.add(), false); assert.equal(h.state.book.reviewTools?.annotations.length || 0, 0); assert.equal(h.state.dirty, 0); }
});

test('switching books or editing text during the delayed creation save cannot retarget a selection', async () => {
  for (const mode of ['book', 'body', 'deleted']) {
    const h = harness(), gate = deferred(); h.options.saveNow = () => gate.promise; const pending = h.module.add();
    if (mode === 'book') h.state.book = {...sample(), id: 'other'}; if (mode === 'body') h.state.book.chapters[0].body = '新正文'; if (mode === 'deleted') h.state.book.chapters[0].deletedAt = '2026-10-15';
    gate.resolve(true); assert.equal(await pending, false); assert.equal(h.state.dirty, 0); assert.equal(h.state.book.reviewTools?.annotations.length || 0, 0);
  }
});

test('cross-book sync closes the dialog and same-book object reload refreshes closures safely', async () => {
  const h = harness(); await h.module.add(); const original = h.state.book; h.state.book = JSON.parse(JSON.stringify(original)); h.module.sync();
  const body = h.field('批注内容'); body.value = '只修改新的对象'; await body.dispatch('input'); assert.equal(h.state.book.reviewTools.annotations[0].body, body.value); assert.equal(original.reviewTools.annotations[0].body, '');
  h.state.book = {...sample(), id: 'other'}; h.module.sync(); assert.equal(h.dialog().open, false);
});

test('annotation composition informs the autosave gate and tab keyboard navigation is accessible', async () => {
  const h = harness(); await h.module.add(); const input = h.field('批注内容'); await input.dispatch('compositionstart'); assert.equal(h.state.composing, true); await input.dispatch('compositionend'); assert.equal(h.state.composing, false);
  const tab = h.all().find(element => element.id === 'marks-tab-annotations'); let prevented = false; await tab.dispatch('keydown', {key: 'ArrowRight', preventDefault() { prevented = true; }}); assert.equal(prevented, true); assert.equal(h.all().find(element => element.id === 'marks-tab-bookmarks').attributes['aria-selected'], 'true');
});


test('a cancelled central navigation never refocuses or overwrites the user selection', async () => {
  const h = harness(); await h.module.add(); h.options.jumpToChapter = async () => { h.editor.setSelectionRange(1, 1); return false; };
  await h.click('跳转原文'); assert.equal(h.editor.selectionStart, 1); assert.equal(h.editor.selectionEnd, 1);
});
