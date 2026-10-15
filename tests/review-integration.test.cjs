'use strict';
// Run the real application save/cache hooks and real mark model together. Only
// unrelated rendering, geometry, HTTP persistence and the DOM are substituted.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.textContent = ''; this.open = false; this.hidden = false; this.disabled = false; this.scrollTop = 0;
    const classes = new Set(); this.classList = {add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, enabled = !classes.has(name)) => { enabled ? classes.add(name) : classes.delete(name); return enabled; }};
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); }
  async dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) await callback({target: this, ...event}); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() { if (this.document) this.document.activeElement = this; } scrollIntoView() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function manuscript(id = 'book') {
  return {id, kind: 'long', title: '缓存集成临时小说', volumes: [], outline: [], notes: [], relations: [], chapters: [
    {id: 'one', title: '第一章', body: '开场。\n需要批注的段落。\n结尾。', volumeId: null, deletedAt: null},
    {id: 'two', title: '第二章', body: '另一个开场。\n第二章的目标段落。\n另一处结尾。', volumeId: null, deletedAt: null}
  ]};
}
function harness(source = manuscript()) {
  const elements = new Map(), stored = new Map(), timers = new Map(), documentEvents = new Map(), windowEvents = new Map(); let nextTimer = 0, apiRevision = 1;
  const element = id => { if (!elements.has(id)) { const node = new Element(id === 'editor' ? 'textarea' : 'div'); node.document = document; elements.set(id, node); } return elements.get(id); };
  const storage = {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key), key: index => [...stored.keys()][index], getLength: () => stored.size};
  const document = {title: '', body: new Element('body'), getElementById: element, createElement: tag => new Element(tag), querySelectorAll: () => [], querySelector: () => new Element('h2'), addEventListener(name, callback) { if (!documentEvents.has(name)) documentEvents.set(name, []); documentEvents.get(name).push(callback); }};
  const requests = [], moves = [], context = vm.createContext({document, console, TextEncoder, crypto: {randomUUID}, sessionStorage: storage, clientStorage: storage,
    T: (text, ...args) => Array.isArray(text) ? text.reduce((value, part, index) => value + part + (args[index] ?? ''), '') : String(text).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ''),
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay}); return id; }, clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => callback(),
    addEventListener(name, callback) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(callback); }, WriterEditorLayout: {resize() {}},
    fetch: async (url, request) => { assert.equal(request.method, 'PUT'); const data = JSON.parse(request.body); requests.push({url, ...plain(data)}); return {ok: true, json: async () => ({revision: ++apiRevision})}; }
  }); context.window = context;
  for (const file of ['public/manuscript-marks.js', 'public/app.js', 'public/workspace.js', 'public/book-search.js', 'public/version-diff.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\ninitialize\(\);\s*$/, '\n'), context, {filename: file});
  // Keep setBook/selectChapter, binding, markDirty/saveDraft/saveNow, and both
  // cache hooks real; expensive unrelated outlines/atlas rendering is omitted.
  const run = expression => vm.runInContext(expression, context);
  run('renderShell=()=>{};renderChapters=()=>{};renderStats=()=>{};renderBacklinks=()=>{};renderNotes=()=>{};renderChapterVolumeSelect=()=>{};');
  const actual = context.ManuscriptMarks.reanchorChapter;
  context.ManuscriptMarks.reanchorChapter = (chapterId, before, after, book) => { moves.push({bookId: book.id, chapterId, before, after}); return actual(chapterId, before, after, book); };
  const state = run('state'); state.view = 'write'; context.incoming = source; run('setBook({book:incoming,revision:1});bindEvents();');
  const add = (chapterId, quote, kind = 'annotations') => { const chapter = state.book.chapters.find(item => item.id === chapterId); const start = chapter.body.indexOf(quote); assert.ok(start >= 0); return context.ManuscriptMarks.createMark(state.book, kind, chapterId, start, start + quote.length, {id: randomUUID(), stamp: '2026-10-15T00:00:00Z'}); };
  const input = async body => { element('editor').value = body; await element('editor').dispatch('input'); };
  const compose = async type => { for (const callback of documentEvents.get(type) || []) await callback({target: element('editor')}); };
  const draft = () => { const entry = [...stored.entries()].filter(([key]) => key.startsWith('yejian.draft.' + state.book?.id + '.')).at(-1); return entry ? JSON.parse(entry[1]) : null; };
  const setBook = (book, revision = 1) => { context.incoming = book; context.incomingRevision = revision; run('setBook({book:incoming,revision:incomingRevision})'); };
  return {context, state, run, element, requests, moves, timers, add, input, compose, draft, setBook};
}
const assertLinked = (book, mark) => { assert.equal(mark.status, 'linked'); assert.equal(book.chapters.find(chapter => chapter.id === mark.chapterId).body.slice(mark.start, mark.end), mark.quote); };

test('ordinary editor input relocates marks before draft/save and repeated save never migrates twice', async () => {
  const h = harness(), item = h.add('one', '需要批注的段落。'), originalStart = item.start;
  await h.input('插入😀\n' + h.state.book.chapters[0].body);
  assert.equal(item.start, originalStart + 5); assertLinked(h.state.book, item); assert.equal(h.moves.length, 1);
  assert.equal(h.draft().book.reviewTools.annotations[0].start, item.start); assert.equal(h.state.dirty, true);
  assert.equal(await h.run('saveNow()'), true); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].saveReason, 'edit'); assertLinked(h.requests[0].book, h.requests[0].book.reviewTools.annotations[0]);
  await h.run('saveNow()'); h.run('syncReviewAnchors();syncReviewAnchors();'); assert.equal(h.moves.length, 1); assert.equal(h.requests.length, 1); assert.equal(item.start, originalStart + 5);
});

test('AI-style append and actual full-book replacement synchronize every changed chapter through one markDirty', async () => {
  const h = harness(), first = h.add('one', '需要批注的段落。'), second = h.add('two', '第二章的目标段落。'), oldFirstStart = first.start, oldSecondStart = second.start;
  h.state.book.chapters[0].body += '\n\nAI追加的后续段落。'; h.run('markDirty()');
  assert.equal(first.start, oldFirstStart); assertLinked(h.state.book, first); assert.equal(h.moves.length, 1);
  const plan = h.context.WriterBookSearch.preview(h.state.book, '开场', '新开场😀'), total = h.context.WriterBookSearch.apply(h.state.book, plan, plan.groups.map(group => group.id));
  assert.equal(total, 2); h.run('markDirty()'); assert.equal(h.moves.length, 3); assert.equal(first.start, oldFirstStart + 3); assert.equal(second.start, oldSecondStart + 3);
  assertLinked(h.state.book, first); assertLinked(h.state.book, second); assert.equal(h.draft().book.reviewTools.annotations[1].start, second.start);
  await h.run('saveNow()'); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].saveReason, 'edit'); assert.equal(h.moves.length, 3);
});

test('saveNow catches a second body change made after markDirty before cloning the successful payload', async () => {
  const h = harness(), item = h.add('one', '需要批注的段落。'), originalStart = item.start;
  await h.input('先插入\n' + h.state.book.chapters[0].body); assert.equal(h.moves.length, 1);
  h.state.book.chapters[0].body = '后来😀\n' + h.state.book.chapters[0].body;
  await h.run('saveNow()'); assert.equal(h.moves.length, 2); assert.equal(item.start, originalStart + 9); assertLinked(h.state.book, item); assertLinked(h.requests[0].book, h.requests[0].book.reviewTools.annotations[0]);
});

test('actual paragraph diff restoration keeps other passages anchored and saves restore classification', async () => {
  const h = harness(), item = h.add('one', '需要批注的段落。'), originalStart = item.start, current = h.state.book.chapters[0].body;
  const hunks = h.context.WriterVersionDiff.diff(current.replace('开场。', '较长的旧开场。'), current), selected = hunks.filter(hunk => hunk.equal === undefined).map(hunk => hunk.id);
  h.state.book.chapters[0].body = h.context.WriterVersionDiff.restore(hunks, selected); h.run("markDirty('restore')");
  assertLinked(h.state.book, item); assert.equal(item.start, originalStart + 4); assert.equal(h.state.saveReason, 'restore');
  // Metadata edits in the same dirty restoration batch retain exclusion from
  // daily new-writing statistics until the restore batch is successfully saved.
  h.state.book.title = '恢复后的临时作品'; h.run('markDirty()'); await h.run('saveNow()');
  assert.equal(h.requests[0].saveReason, 'restore'); assert.equal(h.moves.length, 1); assertLinked(h.requests[0].book, h.requests[0].book.reviewTools.annotations[0]);
  h.state.book.title = '下一次正常编辑'; h.run('markDirty()'); await h.run('saveNow()'); assert.equal(h.requests[1].saveReason, 'edit');
});

test('IME intermediate values cannot detach marks and compositionend migrates once from the pre-composition body', async () => {
  const h = harness(), item = h.add('one', '需要批注的段落。'), initialBody = h.state.book.chapters[0].body, originalStart = item.start;
  await h.compose('compositionstart'); assert.equal(h.state.composing, true);
  await h.input('临时输入法候选完全不同'); assert.equal(item.status, 'linked'); assert.equal(item.start, originalStart); assert.equal(h.moves.length, 0);
  assert.equal(await h.run('saveNow()'), false); assert.equal(h.requests.length, 0);
  await h.input('中文😀\n' + initialBody); assert.equal(item.start, originalStart); assert.equal(h.moves.length, 0);
  await h.compose('compositionend'); assert.equal(h.state.composing, false); assert.equal(h.moves.length, 1); assert.equal(item.start, originalStart + 5); assertLinked(h.state.book, item);
  assert.equal(h.draft().book.reviewTools.annotations[0].start, item.start); await h.run('saveNow()'); assert.equal(h.moves.length, 1); assertLinked(h.requests[0].book, h.requests[0].book.reviewTools.annotations[0]);
});

test('setBook resets same-ID historical offsets and clearBook prevents cross-book same-chapter-ID relocation', async () => {
  const h = harness(), item = h.add('one', '需要批注的段落。'), originalStart = item.start, historical = plain(h.state.book), oldBook = h.state.book;
  await h.input('新段😀\n' + oldBook.chapters[0].body); await h.run('saveNow()'); assert.equal(item.start, originalStart + 5);
  h.setBook(historical, 99); const restored = h.state.book.reviewTools.annotations[0]; assert.equal(restored.start, originalStart); assert.equal(h.run('reviewAnchorBook===state.book'), true);
  h.run('markDirty();syncReviewAnchors()'); assert.equal(h.moves.length, 1); assert.equal(restored.start, originalStart);
  await h.input('旧\n' + h.state.book.chapters[0].body); assert.equal(restored.start, originalStart + 2); assert.equal(h.moves.length, 2);
  h.run('clearBook()'); assert.equal(h.state.book, null); assert.equal(h.run('reviewAnchorBodies.size'), 0); assert.equal(h.run('reviewAnchorBook'), null);
  const other = manuscript('other'); other.chapters[0].body = '他书开头。\n需要批注的段落。\n他书结尾。'; h.setBook(other); const otherMark = h.add('one', '需要批注的段落。'), otherStart = otherMark.start;
  oldBook.chapters[0].body += '\n旧对象后台变化'; h.run('markDirty()'); assert.equal(otherMark.start, otherStart); assert.equal(h.moves.length, 2);
  await h.input('新书😀\n' + h.state.book.chapters[0].body); assert.equal(otherMark.start, otherStart + 5); assert.equal(h.moves.at(-1).bookId, 'other'); assert.equal(item.start, originalStart + 5); assertLinked(h.state.book, otherMark);
});

test('real short normalization keeps restored prefix offset 5..6 and repeated normalization/save are idempotent', async () => {
  const source = manuscript('legacy-short'); source.kind = 'short'; source.chapters = [
    {id: 'restored', title: '恢复前置段', body: 'R', volumeId: null, deletedAt: null},
    {id: 'old-owner', title: '剩余正文', body: '\n\nB', volumeId: null, deletedAt: null}
  ]; source.shortSections = [{id: 'old-owner', title: '剩余片段', start: 2, end: 3}];
  source.reviewTools = {version: 1, dictionary: [], annotations: [], bookmarks: [{id: 'legacy-mark', chapterId: 'old-owner', start: 2, end: 3, quote: 'B', prefix: '\n\n', suffix: '', status: 'linked', body: '', label: '保留B', resolved: false, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z'}]};
  const h = harness(source), item = h.state.book.reviewTools.bookmarks[0]; assert.equal(h.state.book.chapters[0].body, 'R\n\n\n\nB'); assert.equal(item.chapterId, 'restored'); assert.equal(item.start, 5); assert.equal(item.end, 6); assertLinked(h.state.book, item);
  h.run('normalizeShortManuscript(state.book);normalizeShortManuscript(state.book);markDirty();'); await h.run('saveNow()'); assert.equal(item.start, 5); assert.equal(item.end, 6); assert.equal(h.moves.length, 0); assertLinked(h.requests[0].book, h.requests[0].book.reviewTools.bookmarks[0]);
  const snapshot = plain(h.state.book); h.setBook(snapshot, 8); h.run('syncReviewAnchors();markDirty()'); assert.equal(h.state.book.reviewTools.bookmarks[0].start, 5); assert.equal(h.moves.length, 0);
});

async function pendingFocus(h, expression = "jumpToChapter('one')") {
  const pending = h.run(expression);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  const timer = [...h.timers.entries()].find(([, value]) => value.delay === 100);
  assert.ok(timer, 'The actual central jump must wait for the native focus reset');
  return {pending, settle() { h.timers.delete(timer[0]); timer[1].callback(); }};
}

test('central jump waits with an empty caret, then returns explicit success without modifying the manuscript', async () => {
  const h = harness(), body = h.state.book.chapters[0].body;
  const jump = await pendingFocus(h); assert.equal(h.element('editor').selectionStart, 0); assert.equal(h.element('editor').selectionEnd, 0);
  assert.equal(h.context.document.activeElement, h.element('editor')); jump.settle(); assert.equal(await jump.pending, true); assert.equal(h.state.book.chapters[0].body, body); assert.equal(h.element('editor').value, body);
});

test('central pending focus cannot override a user caret, typing, composition, replacement snapshot, or switched book', async () => {
  for (const mode of ['caret', 'typing', 'composition', 'snapshot', 'book']) {
    const h = harness(), jump = await pendingFocus(h), editor = h.element('editor');
    if (mode === 'caret') { await editor.dispatch('keydown', {key: 'ArrowRight'}); editor.setSelectionRange(3, 3); }
    if (mode === 'typing') { await h.input('用户新增\n' + editor.value); editor.setSelectionRange(5, 5); }
    if (mode === 'composition') { await h.compose('compositionstart'); editor.setSelectionRange(2, 2); }
    if (mode === 'snapshot') { h.setBook(plain(h.state.book), 8); editor.setSelectionRange(4, 4); }
    if (mode === 'book') { h.setBook(manuscript('other')); editor.setSelectionRange(6, 6); }
    const start = editor.selectionStart, end = editor.selectionEnd, currentBody = editor.value; jump.settle();
    assert.equal(await jump.pending, false, mode); assert.equal(editor.selectionStart, start, mode); assert.equal(editor.selectionEnd, end, mode); assert.equal(editor.value, currentBody, mode);
  }
});

test('central jump returns false immediately after a failed save instead of authorizing downstream selection', async () => {
  const h = harness(); h.state.dirty = true; h.context.fetch = async () => { throw new Error('Disposable save failure'); };
  assert.equal(await h.run("jumpToChapter('one')"), false); assert.ok(h.state.error); assert.equal([...h.timers.values()].some(value => value.delay === 100), false);
});
