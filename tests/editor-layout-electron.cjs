'use strict';

// Run with Electron (and xvfb-run on headless Linux). All text and Chromium
// profile files are disposable; this harness never starts the app backend.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-editor-layout-'));
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
const results = { passed: false, electron: process.versions.electron, cases: {} };
app.setName('WriterEditorLayoutTest');
app.setPath('userData', path.join(temporary, 'profile'));
let window;
const timeout = setTimeout(() => finish(new Error('Editor layout regression timed out')), 30000);

function finish(error) {
  clearTimeout(timeout);
  if (error) results.error = error.stack || String(error);
  const report = JSON.stringify(results, null, 2) + '\n';
  if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, report); }
  (error ? console.error : console.log)(report.trim());
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}
app.on('quit', () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* Disposable Chromium cache may still be releasing handles. */ } });

app.whenReady().then(async () => {
  try {
    const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
    const page = path.join(temporary, 'fixture.html');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style><style>body{display:block;padding:20px}#test-area{height:420px;width:660px;overflow:auto;scroll-behavior:smooth}#test-area .manuscript{min-height:100%}</style></head><body><div id="test-area"><article class="manuscript"><input class="chapter-title" value="布局验收"><textarea class="prose" id="editor" spellcheck="false"></textarea></article></div></body></html>');
    window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadFile(page);
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'public/editor-layout.js'), 'utf8'));
    const run = (fn, arg = null) => window.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')');
    const tick = () => run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await run(() => {
      window.fixtureLines = Array.from({ length: 600 }, (_, index) => '第' + index + '行 海风吹过港口，船票还在抽屉里。🌊');
      window.fixtureOriginal = fixtureLines.join('\n');
      window.fixtureEvents = [];
      const editor = document.getElementById('editor'), area = document.getElementById('test-area');
      editor.addEventListener('input', event => { fixtureEvents.push({ type: 'input', composing: event.isComposing }); WriterEditorLayout.resize(editor, area); });
      for (const type of ['compositionstart', 'compositionend']) editor.addEventListener(type, () => fixtureEvents.push({ type }));
      window.fixtureReset = (bottom = false) => {
        area.style.width = '660px'; area.style.scrollBehavior = 'auto'; editor.style.fontSize = '19px'; editor.value = fixtureOriginal; WriterEditorLayout.resize(editor, area); editor.focus({ preventScroll: true });
        const position = bottom ? editor.value.length : fixtureLines.slice(0, 100).join('\n').length + 1;
        editor.setSelectionRange(position, position);
        const top = editor.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
        area.scrollTop = bottom ? area.scrollHeight : top + 100 * parseFloat(getComputedStyle(editor).lineHeight) - 140;
        return { scroll: area.scrollTop, height: editor.clientHeight, position, length: editor.value.length };
      };
    });

    const middle = await run(() => fixtureReset());
    window.webContents.sendInputEvent({ type: 'char', keyCode: '测' });
    await tick();
    const typed = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); return { scroll: a.scrollTop, position: e.selectionStart, length: e.value.length, inserted: e.value[e.selectionStart - 1] }; });
    assert.equal(typed.inserted, '测'); assert.equal(typed.position, middle.position + 1); assert.equal(typed.length, middle.length + 1); assert.ok(Math.abs(typed.scroll - middle.scroll) < 80, 'Typing in the middle jumped the scroll position');
    window.webContents.undo(); await tick();
    assert.equal(await run(() => document.getElementById('editor').value === fixtureOriginal), true, 'Native undo history was lost');
    results.cases.middleTyping = { scrollBefore: middle.scroll, scrollAfter: typed.scroll, selectionPreserved: true, nativeUndoPreserved: true };

    const bottom = await run(() => fixtureReset(true));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await tick();
    const entered = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); return { scroll: a.scrollTop, height: e.clientHeight, position: e.selectionStart, length: e.value.length, last: e.value.slice(-1), maximum: a.scrollHeight - a.clientHeight }; });
    assert.equal(entered.last, '\n'); assert.equal(entered.position, bottom.position + 1); assert.ok(entered.height > bottom.height); assert.ok(entered.scroll >= bottom.scroll - 80); assert.ok(entered.scroll <= entered.maximum); assert.ok(entered.scroll > 1000);
    results.cases.bottomNewline = { heightBefore: bottom.height, heightAfter: entered.height, scrollBefore: bottom.scroll, scrollAfter: entered.scroll, selectionPreserved: true };

    const deletion = await run(() => { const before = fixtureReset(true), e = document.getElementById('editor'); const position = fixtureLines.slice(0, 400).join('\n').length; e.setSelectionRange(position, e.value.length); return { ...before, position }; });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); await tick();
    const shortened = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); return { height: e.clientHeight, scroll: a.scrollTop, maximum: a.scrollHeight - a.clientHeight, position: e.selectionStart, length: e.value.length }; });
    assert.equal(shortened.length, deletion.position); assert.equal(shortened.position, deletion.position); assert.ok(shortened.height < deletion.height); assert.ok(shortened.scroll > 1000); assert.ok(shortened.scroll <= shortened.maximum + 1);
    results.cases.deleteShortening = { heightBefore: deletion.height, heightAfter: shortened.height, scrollAfter: shortened.scroll, selectionPreserved: true };

    await run(() => fixtureReset());
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 }); await tick();
    const composition = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); return { position: e.selectionStart, end: e.selectionEnd, scroll: a.scrollTop, value: e.value }; });
    const resized = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); a.style.width = '380px'; e.style.fontSize = '25px'; WriterEditorLayout.resize(e, a); return { position: e.selectionStart, end: e.selectionEnd, scroll: a.scrollTop, value: e.value }; });
    assert.equal(resized.position, composition.position); assert.equal(resized.end, composition.end); assert.equal(resized.value, composition.value); assert.equal(resized.scroll, composition.scroll);
    await window.webContents.debugger.sendCommand('Input.insertText', { text: '中' }); await tick();
    const committed = await run(() => { const e = document.getElementById('editor'), a = document.getElementById('test-area'); return { position: e.selectionStart, scroll: a.scrollTop, length: e.value.length, containsCommit: e.value[e.selectionStart - 1] === '中', events: fixtureEvents.slice(-8) }; });
    assert.equal(committed.containsCommit, true); assert.equal(committed.length, middle.length + 1); assert.ok(committed.events.some(e => e.type === 'compositionstart')); assert.ok(committed.events.some(e => e.type === 'input' && e.composing)); assert.ok(committed.events.some(e => e.type === 'compositionend')); assert.ok(committed.scroll > 1000);
    window.webContents.debugger.detach();
    results.cases.imeAndResize = { nativeCompositionEvents: true, selectionDuringResizePreserved: true, textDuringResizePreserved: true, scrollDuringResizePreserved: true, committedChineseCharacter: true };
    results.passed = true;
    finish();
  } catch (error) { finish(error); }
});
