'use strict';

// Exercise the actual settings, focus restoration, language, and editor code
// against a small DOM built from index.html. No personal library is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function makeDOM() {
  const ids = new Map(); let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.readOnly = false; this.open = false; this.inert = false; this.value = ''; this.isConnected = true;
      this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 500;
      this.style = { setProperty() {} }; const classes = new Set();let id='',className='';
      Object.defineProperty(this,'id',{get:()=>id,set:value=>{id=String(value);ids.set(id,this);}});
      Object.defineProperty(this,'className',{get:()=>className,set:value=>{className=String(value);classes.clear();for(const name of className.split(/\s+/))if(name)classes.add(name);}});
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } };
    }
    append(...children) { for (const child of children) { if(typeof child==='object'&&child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);this.children.push(child); if (typeof child === 'object') child.parentElement = this; } }
    insertBefore(child,before){if(!before){this.append(child);return;}if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);const index=this.children.indexOf(before);assert.ok(index>=0);this.children.splice(index,0,child);child.parentElement=this;}
    get previousElementSibling(){if(!this.parentElement)return null;const siblings=this.parentElement.children.filter(child=>typeof child==='object');return siblings[siblings.indexOf(this)-1]||null;}
    contains(target){return this===target||this.children.some(child=>typeof child==='object'&&child.contains(target));}
    replaceChildren(...children) { this.children = []; this.append(...children); }
    set textContent(value) { this.children = [String(value)]; }
    get textContent() { return this.children.map(value => typeof value === 'string' ? value : value.textContent).join(''); }
    setAttribute(key, value = '') {
      this.attributes[key] = String(value);
      if (key === 'id') { this.id = value; ids.set(value, this); }
      if (key === 'type') this.type = value;
      if (key === 'class') { this.className = value; for (const name of value.split(/\s+/)) this.classList.add(name); }
      if (key === 'hidden') this.hidden = true;
      if (key === 'disabled') this.disabled = true;
      if (key === 'readonly') this.readOnly = true;
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    getAttribute(key) { return this.attributes[key] ?? null; }
    hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
    matches(selector) {
      return selector.split(',').some(part => {
        const query = part.trim();
        if (query.startsWith('#')) return this.id === query.slice(1);
        if (query.startsWith('.')) return this.classList.contains(query.slice(1));
        if (query === '[hidden]') return this.hidden;
        const match = query.match(/^([a-z]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/i);
        return !!match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => typeof child === 'object' ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
    addEventListener(type, callback, options = {}) { const list = this.listeners.get(type) || []; list.push({ callback, once: !!options.once }); this.listeners.set(type, list); }
    async emit(type, value = {}) { for (const listener of [...(this.listeners.get(type) || [])]) { if (listener.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== listener)); await listener.callback({ target: this, preventDefault() { this.prevented = true; }, ...value }); } }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    focus() { document.activeElement = this; this.focused = true; }
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  }
  const tree = new Element('root'), stack = [tree], voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (match[3]) { stack.at(-1).append(match[3]); continue; }
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) { while (stack.length > 1 && stack.pop().tagName !== tag.toUpperCase()) {} continue; }
    const element = new Element(tag);
    for (const attr of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    stack.at(-1).append(element); if (!voidTags.has(tag)) stack.push(element);
  }
  document = new Element('document'); document.append(tree);
  document.getElementById = id => { assert.ok(ids.has(id), 'The real interface must contain #' + id); return ids.get(id); };
  document.createElement = tag => new Element(tag); document.createTreeWalker = () => ({ nextNode: () => null });
  document.body = tree.querySelector('body'); document.documentElement = tree.querySelector('html'); document.fullscreenEnabled = true; document.fullscreenElement = null;
  document.documentElement.requestFullscreen = async () => { document.fullscreenElement = document.documentElement; };
  document.exitFullscreen = async () => { document.fullscreenElement = null; };
  return document;
}

function harness({ desktop = true, language = 'zh', view = 'write', fullscreenEnabled = true } = {}) {
  const document = makeDOM(), get = id => document.getElementById(id), values = new Map([['writer-desk.language', language]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), getLength: () => values.size, key: index => [...values.keys()][index] };
  const nativeCalls = [], nativeState = { version: '0.3.5', dataPath: '/isolated/data', zoomFactor: 1, fullscreen: false, maximized: false };
  let windowListener, subscriptions = 0, unsubscriptions = 0, reloads = 0;
  const native = {
    storage, getAppSettings: async () => copy(nativeState),
    performAppAction: async command => { nativeCalls.push(command); return native.actionHook ? native.actionHook(command) : copy(nativeState); },
    onWindowState: callback => { windowListener = callback; subscriptions++; return () => { unsubscriptions++; windowListener = null; }; },
    setLanguage: async next => { nativeCalls.push('language:' + next); }, onBeforeClose() {}
  };
  const windowEvents = new Map();
  const context = vm.createContext({ document, crypto: { randomUUID }, sessionStorage: storage, localStorage: storage, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(), location: { reload: () => reloads++ },
    addEventListener: (type, callback, options = {}) => { const list = windowEvents.get(type) || []; list.push({ callback, once: !!options.once }); windowEvents.set(type, list); }
  });
  context.window = context; if (desktop) context.WriterDesktop = native;
  document.fullscreenEnabled = fullscreenEnabled;
  for (const file of ['public/i18n.js', 'public/app.js', 'public/workspace.js','public/settings.js']) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('workspace.js')) source = source.replace(/\ninitialize\(\);\s*$/, '\n');
    vm.runInContext(source, context, { filename: file });
  }
  const run = expression => vm.runInContext(expression, context), state = run('state');
  const book = { id: 'fixture-book', title: '保存中的作品', kind: 'long', chapters: [{ id: 'chapter-1', title: '第一章', body: '第一段正文选择文字保持不变。', deletedAt: null }, { id: 'chapter-2', title: '第二章', body: '下一章不能被编辑命令改写。', deletedAt: null }], notes: [], outline: [], relations: [], volumes: [], atlasViews: [] };
  Object.assign(state, { book, revision: 7, chapterId: 'chapter-1', outlineId: 'outline-selection', personId: 'person-selection', view, dirty: false });
  get('write-view').hidden = view !== 'write'; get('shelf-view').hidden = view !== 'shelf';
  get('editor').disabled = false; get('editor').value = book.chapters[0].body; get('editor').setSelectionRange(3, 9, 'backward'); get('editor').scrollTop = 81; get('editor').scrollLeft = 7; get('editor').focus();
  run('renderBacklinks=()=>{};bindPlanningEvents=()=>{};bindEvents();bindAppSettingsEvents()');
  return { document, get, context, run, state, book, native, nativeCalls, values,
    windowState: info => windowListener?.(info), subscriptions: () => subscriptions, unsubscriptions: () => unsubscriptions, reloads: () => reloads,
    emitWindow: async type => { for (const entry of [...(windowEvents.get(type) || [])]) { await entry.callback(); if (entry.once) windowEvents.set(type, windowEvents.get(type).filter(item => item !== entry)); } }
  };
}

const checks = [], check = (name, test) => checks.push({ name, test });
check('settings opens and closes without switching book, page, or selections; the rail keeps trash and exports stay with books', async () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  for (const language of ['zh', 'en']) for (const view of ['shelf', 'outline', 'write']) {
    const h = harness({ language, view }), before = copy(h.book);
    await h.run('showAppSettings()');
    assert.equal(h.get('settings-dialog').open, true); assert.equal(h.state.view, view); assert.equal(h.state.book, h.book); assert.deepEqual(h.book, before);
    assert.equal(h.get('settings-version').textContent, language === 'en' ? 'Version 0.3.5' : '版本 0.3.5'); assert.equal(h.get('settings-data-path').value, '/isolated/data');
    assert.equal(h.get('language-select').closest('#settings-dialog'), h.get('settings-dialog'));
    assert.equal(h.get('open-settings').parentElement, h.get('open-trash').parentElement); assert.ok(!html.includes('id="open-backup"')); assert.ok(html.includes('id="import-backup"'));
    h.run('closeAppSettings()'); assert.equal(h.get('settings-dialog').open, false);
    assert.equal(h.state.chapterId, 'chapter-1'); assert.equal(h.state.outlineId, 'outline-selection'); assert.equal(h.state.personId, 'person-selection'); assert.equal(h.state.dirty, false);
    if (view === 'write') { assert.equal(h.document.activeElement, h.get('editor')); assert.equal(h.get('editor').selectionStart, 3); assert.equal(h.get('editor').selectionEnd, 9); }
  }
});

check('editing restores the actual editor focus, selection and scroll before native cut and preserves the normal input/save path', async () => {
  const h = harness(), original = copy(h.book);
  await h.run('showAppSettings()');
  h.get('editor').setSelectionRange(0, 0, 'none'); h.get('editor').scrollTop = 0; h.get('settings-data-path').focus();
  h.native.actionHook = async command => {
    assert.equal(command, 'cut'); assert.equal(h.get('settings-dialog').open, false); assert.equal(h.document.activeElement, h.get('editor'));
    assert.equal(h.get('editor').selectionStart, 3); assert.equal(h.get('editor').selectionEnd, 9); assert.equal(h.get('editor').selectionDirection, 'backward');
    assert.equal(h.get('editor').scrollTop, 81); assert.equal(h.get('editor').scrollLeft, 7);
    h.get('editor').value = original.chapters[0].body.slice(0, 3) + original.chapters[0].body.slice(9); await h.get('editor').emit('input'); return {};
  };
  assert.equal(await h.run("performSettingsAction('cut')"), true);
  assert.equal(h.book.chapters[0].body, h.get('editor').value); assert.equal(h.book.chapters[1].body, original.chapters[1].body); assert.equal(h.state.dirty, true);
  assert.equal(h.state.view, 'write'); assert.equal(h.state.book, h.book); assert.equal(h.state.chapterId, 'chapter-1');
  assert.ok([...h.values.values()].some(value => value.includes(h.get('editor').value)), 'The edit must remain recoverable through the existing draft writer');
});

check('stale chapters, read-only inputs and IME composition prevent unintended editing', async () => {
  const h = harness(), before = copy(h.book); await h.run('showAppSettings()');
  h.state.chapterId = 'chapter-2'; assert.equal(await h.run("performSettingsAction('paste')"), false); assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.book, before);
  h.state.chapterId = 'chapter-1'; h.state.composing = true;
  assert.equal(await h.run("performSettingsAction('cut')"), false); assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.book, before);
  h.run('closeAppSettings()'); await h.run('showAppSettings()'); assert.equal(h.get('settings-dialog').open, false);
  h.state.composing = false; h.get('editor').readOnly = true; await h.run('showAppSettings()');
  for (const button of h.get('settings-edit-actions').querySelectorAll('[data-settings-edit]')) assert.equal(button.disabled, !['copy', 'selectAll'].includes(button.dataset.settingsEdit));
});

check('native failures and a pending settings action preserve the authored book and block repeated commands', async () => {
  const h = harness(), before = copy(h.book); await h.run('showAppSettings()');
  const pending = deferred(); h.native.actionHook = () => pending.promise;
  const first = h.run("performSettingsAction('zoomIn')");
  assert.equal(await h.run("performSettingsAction('zoomIn')"), false); assert.deepEqual(h.nativeCalls, ['zoomIn']);
  pending.reject(new Error('系统暂时无法打开文件夹')); assert.equal(await first, false); assert.ok(h.get('toast').textContent.includes('系统暂时无法打开文件夹'));
  assert.equal(h.get('settings-dialog').open, true); assert.equal(h.state.error, null); assert.equal(h.state.conflict, false); assert.equal(h.state.revision, 7); assert.equal(h.state.dirty, false); assert.deepEqual(h.book, before);
  h.native.actionHook = async () => { throw new Error('编辑操作失败'); };
  assert.equal(await h.run("performSettingsAction('copy')"), false); assert.equal(h.get('settings-dialog').open, false); assert.equal(h.document.activeElement, h.get('editor')); assert.deepEqual(h.book, before);
});

check('desktop-only controls stay out of web mode while supported browser full screen remains usable', async () => {
  const native = harness(); await tick();
  assert.equal(native.get('window-controls').hidden, false); assert.equal(native.document.body.classList.contains('desktop-app'), true);
  assert.ok(native.document.querySelectorAll('[data-desktop-only]').every(element => !element.hidden));
  const web = harness({ desktop: false }); await web.run('showAppSettings()');
  assert.equal(web.get('window-controls').hidden, true); assert.ok(web.document.querySelectorAll('[data-desktop-only]').every(element => element.hidden));
  assert.equal(web.get('settings-display').hidden, false); assert.equal(await web.run("performSettingsAction('openDataFolder')"), false);
  assert.equal(await web.run("performSettingsAction('toggleFullscreen')"), true); assert.equal(web.get('settings-fullscreen').getAttribute('aria-pressed'), 'true');
  assert.equal(await web.run("performSettingsAction('toggleFullscreen')"), true); assert.equal(web.get('settings-fullscreen').getAttribute('aria-pressed'), 'false');
  const noFullScreen = harness({ desktop: false, fullscreenEnabled: false }); assert.equal(noFullScreen.get('settings-display').hidden, true);
});

check('browser select all selects the complete focused field without execCommand or changing its value or book', async () => {
  for (const [field, readOnly] of [['editor', false], ['editor', true], ['chapter-title', false]]) {
    const h = harness({ desktop: false }), target = h.get(field), before = copy(h.book);
    target.disabled = false; target.readOnly = readOnly;
    if (field === 'chapter-title') target.value = h.book.chapters[0].title;
    target.setSelectionRange(1, 3, 'backward'); target.focus();
    const originalValue = target.value; let execCalls = 0;
    h.document.execCommand = () => { execCalls++; throw new Error('Select all must use the field selection API'); };
    await h.run('showAppSettings()');
    h.get('settings-data-path').focus(); target.setSelectionRange(0, 0, 'none');
    assert.equal(await h.run("performSettingsAction('selectAll')"), true);
    assert.equal(execCalls, 0); assert.equal(h.get('settings-dialog').open, false); assert.equal(h.document.activeElement, target);
    assert.equal(target.value, originalValue); assert.equal(target.selectionStart, 0); assert.equal(target.selectionEnd, originalValue.length);
    assert.deepEqual(h.book, before); assert.equal(h.state.book, h.book); assert.equal(h.state.chapterId, 'chapter-1'); assert.equal(h.state.view, 'write');
    assert.equal(h.state.dirty, false); assert.equal(h.state.revision, 7);
  }
});

check('native state changes update labels and limits; settings binding and lifecycle subscriptions are idempotent', async () => {
  const h = harness(); await tick(); h.run('bindAppSettingsEvents();bindAppSettingsEvents()');
  assert.equal(h.subscriptions(), 1); assert.equal(h.get('open-settings').listeners.get('click').length, 1);
  h.windowState({ fullscreen: true, maximized: true });
  assert.equal(h.get('settings-fullscreen').textContent, '退出全屏'); assert.equal(h.get('window-maximize').getAttribute('aria-label'), '还原窗口');
  h.run('updateAppSettings({zoomFactor:2})'); assert.equal(h.get('settings-zoom-in').disabled, true); assert.equal(h.get('settings-zoom-out').disabled, false);
  h.run('updateAppSettings({zoomFactor:.5})'); assert.equal(h.get('settings-zoom-in').disabled, false); assert.equal(h.get('settings-zoom-out').disabled, true);
  await h.get('window-minimize').emit('click'); assert.deepEqual(h.nativeCalls, ['minimize']);
  await h.emitWindow('pagehide'); await h.emitWindow('pagehide'); assert.equal(h.unsubscriptions(), 1);
});

check('language switching holds the settings dialog inert while saving and native preference are pending', async () => {
  const h = harness(), original = copy(h.book); h.run('bindLanguageEvents()'); await tick(); h.nativeCalls.length = 0;
  await h.run('showAppSettings()'); h.state.dirty = true;
  const save = deferred(), preference = deferred(), writes = [];
  h.context.saveApi = async (endpoint, method, payload) => { writes.push({ endpoint, method, payload: copy(payload) }); return save.promise; };
  h.run('api=(...args)=>saveApi(...args)'); h.native.setLanguage = next => { h.nativeCalls.push('language:' + next); return preference.promise; };
  h.get('language-select').value = 'en'; const switching = h.get('language-select').emit('change');
  assert.equal(h.get('settings-dialog').inert, true); assert.equal(h.get('workspace').inert, true); assert.equal(h.state.transitioning, true);
  assert.equal(await h.run("performSettingsAction('quit')"), false); assert.equal(h.run('closeAppSettings()'), false); assert.equal(h.get('settings-dialog').open, true);
  assert.equal(writes.length, 1); assert.equal(writes[0].payload.revision, 7); assert.deepEqual(writes[0].payload.book, original);
  save.resolve({ revision: 8 }); await tick(); assert.equal(h.get('settings-dialog').inert, true); assert.deepEqual(h.nativeCalls, ['language:en']); assert.equal(h.reloads(), 0);
  preference.resolve(true); await switching;
  assert.equal(h.get('settings-dialog').inert, false); assert.equal(h.get('workspace').inert, false); assert.equal(h.state.transitioning, false); assert.equal(h.reloads(), 1);
  assert.equal(h.values.get('writer-desk.language'), 'en'); assert.equal(h.state.revision, 8); assert.equal(h.state.chapterId, 'chapter-1'); assert.deepEqual(h.book, original);
});

if(require.main===module)(async () => {
  let failed = 0;
  for (const { name, test } of checks) {
    try { await test(); console.log('PASS:', name); }
    catch (error) { failed++; console.error('FAIL:', name, '\n ', error.stack || error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
module.exports={harness,makeDOM,tick,deferred};
