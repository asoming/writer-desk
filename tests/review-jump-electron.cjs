'use strict';

// Real Electron/CDP mouse regression for modal-to-manuscript selection. The
// fixtures, Chromium profile and saved books are disposable/in-memory; this
// never starts the application backend or opens a user's writing library.
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-review-jump-'));
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
const results = {passed: false, diagnostics: {}, electron: process.versions.electron, platform: process.platform, inputMethod: {gtk: process.env.GTK_IM_MODULE || null, qt: process.env.QT_IM_MODULE || null, modifiers: process.env.XMODIFIERS || null}, cases: {}};
app.setName('WriterReviewJumpTest');
app.setPath('userData', path.join(temporary, 'profile'));
let window, finished = false;
const timeout = setTimeout(() => finish(new Error('Review jump regression timed out')), 30000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  if (error) results.error = error.stack || String(error);
  const report = JSON.stringify(results, null, 2) + '\n';
  if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), {recursive: true}); fs.writeFileSync(reportPath, report); }
  (error ? console.error : console.log)(report.trim());
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}
app.on('quit', () => { try { fs.rmSync(temporary, {recursive: true, force: true}); } catch { /* Chromium can still be releasing disposable cache handles. */ } });

app.whenReady().then(async () => {
  try {
    const page = path.join(temporary, 'fixture.html'), css = fs.readFileSync(path.join(ROOT, 'public/manuscript-marks.css'), 'utf8');
    fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px;font:15px system-ui,sans-serif;color:#233047;background:#f8faff}button,input,textarea,select{font:inherit}button{cursor:pointer}#writing-area{height:500px;overflow:auto}#editor{display:block;width:90%;min-height:440px;line-height:1.8;font-size:18px;padding:16px;box-sizing:border-box}dialog:not(.manuscript-marks-dialog){padding:24px;border:1px solid #dbe1ed;border-radius:12px}.primary-button,.secondary-button,.text-button,.icon-button{border-radius:7px;padding:9px 13px;border:1px solid #dce3ef;background:#fff;color:#233047}.primary-button{background:#4965dc;color:#fff;border-color:#4965dc}.text-button,.icon-button{border-color:transparent;background:transparent}button:disabled{opacity:.4;cursor:default}</style><style>' + css + '</style></head><body><div id="workspace"><div id="writing-area"><h2 class="chapter-heading">临时章节</h2><textarea id="editor" spellcheck="false">ABCDEFGHIJ</textarea></div></div><dialog id="baseline"><button id="baseline-jump" type="button">Jump</button></dialog></body></html>');
    window = new BrowserWindow({show: false, width: 1060, height: 850, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
    await window.loadFile(page);
    window.show(); window.focus();
    const run = (fn, argument = null) => window.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(argument) + ')');
    const tick = () => run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 160)))));
    const waitForRootJump = () => run(() => new Promise((resolve, reject) => {
      const start = performance.now(); const poll = () => {
        if (window.fixturePendingJumpState === 'complete') return requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (performance.now() - start > 3000) return reject(new Error('The actual root jump did not complete'));
        requestAnimationFrame(poll);
      }; poll();
    }));
    window.webContents.debugger.attach('1.3');
    const nativeClick = async (selector, afterClick = null) => {
      window.focus(); window.webContents.focus(); await tick();
      const point = await run(selector => {
        const control = document.querySelector(selector); if (!control || control.disabled) throw new Error('Missing/enabled native click target: ' + selector);
        control.scrollIntoView({block: 'nearest'}); const box = control.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) throw new Error('Native click target has no geometry: ' + selector);
        return {x: box.left + box.width / 2, y: box.top + box.height / 2};
      }, selector);
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, button: 'none'});
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1});
      if (afterClick) await afterClick();
      await tick();
    };
    const markButton = async (label, afterClick = null) => {
      const id = await run(label => {
        const controls = [...document.querySelectorAll('#manuscript-marks-dialog button')], control = controls.find(item => item.textContent === label);
        if (!control) throw new Error('Missing manuscript mark button: ' + label);
        control.id ||= 'native-mark-target-' + controls.indexOf(control); return control.id;
      }, label);
      await nativeClick('#' + id, afterClick);
    };
    const snapshot = () => run(() => {
      const editor = document.getElementById('editor'); return {body: editor.value, selectionStart: editor.selectionStart, selectionEnd: editor.selectionEnd, selected: editor.value.slice(editor.selectionStart, editor.selectionEnd), activeEditor: document.activeElement === editor, events: fixtureEvents.slice(), dialogOpen: !!document.getElementById('manuscript-marks-dialog')?.open, modelBody: window.fixtureBook?.chapters[0].body};
    });
    const assertNoDelete = value => assert.equal(value.events.filter(event => ['beforeinput', 'input'].includes(event.type) && event.inputType?.startsWith('delete')).length, 0, 'A native jump unexpectedly deleted manuscript text');

    // Control case: browser-native dialog.close/focus/setSelectionRange only.
    // There is deliberately no application/module code loaded for this case.
    await run(() => {
      window.fixtureEvents = [];
      for (const type of ['beforeinput', 'input']) document.getElementById('editor').addEventListener(type, event => fixtureEvents.push({type, inputType: event.inputType, trusted: event.isTrusted}));
      document.getElementById('baseline-jump').addEventListener('click', event => { fixtureEvents.push({type: 'click', trusted: event.isTrusted}); });
      document.getElementById('baseline-jump').addEventListener('click', () => { document.getElementById('baseline').close(); const editor = document.getElementById('editor'); editor.focus(); editor.setSelectionRange(2, 5); });
      document.getElementById('baseline').showModal();
    });
    await nativeClick('#baseline-jump'); const baseline = await snapshot();
    // This intentionally unprotected HTML is diagnostic, not an application
    // acceptance gate: IBus can reproduce the focus-reset race without any app.
    assert.ok(baseline.events.some(event => event.type === 'click' && event.trusted), 'The native baseline click was not received');
    results.diagnostics.nativeImmediateDialogSelection = {...baseline, bodyUnchanged: baseline.body === 'ABCDEFGHIJ'};

    await window.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'public/manuscript-marks.js'), 'utf8'));
    await run(() => {
      const editor = document.getElementById('editor');
      window.fixtureOriginal = '林舟在门前等候。\n\n沈砚把船票交给林舟🌊。\n\n潮声渐渐平息。';
      window.fixtureQuote = '沈砚把船票交给林舟🌊。';
      window.fixtureBook = {id: 'disposable-review-book', kind: 'long', title: '临时跳转验收', chapters: [{id: 'chapter', title: '正文', body: fixtureOriginal, deletedAt: null}]};
      window.fixtureSaved = []; window.fixtureDirty = 0; editor.value = fixtureOriginal;
      window.fixtureMark = ManuscriptMarks.createMark(fixtureBook, 'annotations', 'chapter', fixtureOriginal.indexOf(fixtureQuote), fixtureOriginal.indexOf(fixtureQuote) + fixtureQuote.length, {id: 'annotation', stamp: '2026-10-15T00:00:00Z'});
      fixtureMark.body = '重新检查人物动机';
      editor.addEventListener('input', () => { const chapter = fixtureBook.chapters[0], before = chapter.body; chapter.body = editor.value; ManuscriptMarks.reanchorChapter(chapter.id, before, chapter.body, fixtureBook); fixtureDirty++; });
      const saveNow = async () => { fixtureSaved.push(JSON.parse(JSON.stringify(fixtureBook))); return true; };
      window.state = {book: fixtureBook, kind: 'long', chapterId: 'chapter', view: 'write', composing: false, transitioning: false};
      window.$ = id => document.getElementById(id === 'dialog' ? 'baseline' : id);
      window.requireSaved = saveNow; window.closeDialog = () => document.getElementById('baseline').close();
      window.renderShell = () => {}; window.selectChapter = id => { state.chapterId = id; editor.value = state.book.chapters.find(chapter => chapter.id === id).body; };
      window.resolveShortManuscriptId = id => id;
      window.T = (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ''); window.toast = () => {};
      window.fixturePendingJumpState = 'none';
      ManuscriptMarks.configure({getBook: () => fixtureBook, getChapterId: () => 'chapter', getEditor: () => editor, getWritingArea: () => document.getElementById('writing-area'),
        T: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? ''), markDirty: () => fixtureDirty++, saveNow,
        isComposing: () => false, isTransitioning: () => false, toast: () => {}, setComposing: () => {},
        // Invoke the extracted production navigation below. This wrapper only
        // records completion for a bounded native test wait, not a second delay.
        jumpToChapter: async id => { fixturePendingJumpState = 'pending'; try { const pending = window.jumpToChapter(id); if (window.fixtureJumpInterrupt) setTimeout(fixtureJumpInterrupt, 20); const result = await pending; window.fixturePendingJumpResult = result; return result; } finally { fixturePendingJumpState = 'complete'; } }
      });
    });
    const application = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const extracted = (start, end) => {
      const from = application.indexOf(start), to = application.indexOf(end, from);
      if (from < 0 || to < 0) throw new Error('Could not extract actual application navigation');
      return application.slice(from, to);
    };
    await window.webContents.executeJavaScript(extracted('async function transition(', '\nasync function api(') + '\n' + extracted('async function jumpToChapter(', '\nfunction renderBacklinks'));
    results.productionNavigationExtracted = true;
    await run(async () => { await ManuscriptMarks.show('annotations'); fixtureEvents = []; }); await tick();
    await markButton('跳转原文'); await waitForRootJump(); const chinese = await snapshot();
    assert.equal(chinese.body, await run(() => fixtureOriginal)); assert.equal(chinese.modelBody, chinese.body); assert.equal(chinese.selected, await run(() => fixtureQuote)); assert.equal(chinese.dialogOpen, false); assert.equal(chinese.activeEditor, true); assertNoDelete(chinese);
    results.cases.chineseEmojiAnnotationJump = {bodyUnchanged: true, quoteSelectedExactly: true, dialogClosed: true, deleteInputs: 0};

    // A real native insertion before the mark must move its UTF-16 range, after
    // which closing the annotation modal must still preserve the whole draft.
    const beforeInsert = await run(() => { const editor = document.getElementById('editor'); editor.focus(); editor.setSelectionRange(0, 0); return fixtureMark.start; });
    await window.webContents.debugger.sendCommand('Input.insertText', {text: '新增😀\n'}); await tick();
    const inserted = await run(() => ({start: fixtureMark.start, status: fixtureMark.status, body: fixtureBook.chapters[0].body}));
    assert.equal(inserted.start, beforeInsert + 5); assert.equal(inserted.status, 'linked'); assert.equal(inserted.body, '新增😀\n' + await run(() => fixtureOriginal));
    await run(async () => { await ManuscriptMarks.show('annotations'); fixtureEvents = []; }); await tick(); await markButton('跳转原文'); await waitForRootJump(); const relocated = await snapshot();
    assert.equal(relocated.body, inserted.body); assert.equal(relocated.modelBody, inserted.body); assert.equal(relocated.selected, await run(() => fixtureQuote)); assert.equal(relocated.selectionStart, beforeInsert + 5); assertNoDelete(relocated);
    results.cases.nativePrefixEditRelocation = {nativeInsertPreserved: true, utf16Shift: 5, quoteSelectedExactly: true, bodyUnchangedByJump: true, deleteInputs: 0};

    // Delete the selected passage intentionally with a native Backspace, then
    // explicitly choose a replacement in the module's read-only relink view.
    window.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Backspace'});
    window.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Backspace'}); await tick();
    const orphan = await run(() => ({status: fixtureMark.status, quote: fixtureMark.quote, body: fixtureBook.chapters[0].body, note: fixtureMark.body}));
    assert.equal(orphan.status, 'orphaned'); assert.equal(orphan.body.includes(orphan.quote), false); assert.equal(orphan.note, '重新检查人物动机');
    await run(async () => { await ManuscriptMarks.show('annotations'); }); await tick();
    assert.equal(await run(() => [...document.querySelectorAll('#manuscript-marks-dialog button')].find(button => button.textContent === '跳转原文').disabled), true);
    await markButton('重新关联');
    const newQuote = '林舟在门前等候。';
    await run(quote => { const preview = document.querySelector('#manuscript-marks-dialog .marks-source'); if (!preview.readOnly) throw new Error('Relink source must be read-only'); const start = preview.value.indexOf(quote); if (start < 0) throw new Error('Missing replacement passage'); preview.focus(); preview.setSelectionRange(start, start + quote.length); }, newQuote);
    await markButton('关联所选文字');
    assert.equal(await run(() => fixtureMark.status), 'linked'); assert.equal(await run(() => fixtureMark.quote), newQuote); assert.equal(await run(() => fixtureMark.body), orphan.note);
    await run(() => { fixtureEvents = []; }); await markButton('跳转原文'); await waitForRootJump(); const relinked = await snapshot();
    assert.equal(relinked.body, orphan.body); assert.equal(relinked.modelBody, orphan.body); assert.equal(relinked.selected, newQuote); assert.equal(relinked.dialogOpen, false); assertNoDelete(relinked);
    results.cases.orphanExplicitRelinkAndJump = {orphanCannotJump: true, notePreserved: true, replacementSelectedExactly: true, bodyUnchangedByJump: true, deleteInputs: 0};

    // Changing books while the real central focus reset is pending must abort
    // the downstream module selection, even with identical chapter IDs/text.
    await run(async () => {
      await ManuscriptMarks.show('annotations'); fixtureEvents = []; fixturePendingJumpState = 'none';
      window.fixtureJumpInterrupt = () => { state.book = {...fixtureBook, id: 'other-disposable-book'}; };
    }); await tick(); await markButton('跳转原文'); await waitForRootJump();
    const switched = await snapshot();
    assert.equal(await run(() => fixturePendingJumpResult), false); assert.equal(switched.body, orphan.body); assert.equal(switched.selectionStart, 0); assert.equal(switched.selectionEnd, 0); assertNoDelete(switched);
    await run(() => { state.book = fixtureBook; window.fixtureJumpInterrupt = null; });
    results.cases.switchDuringFocusSettling = {navigationCancelled: true, noLateSelection: true, manuscriptPreserved: true, deleteInputs: 0};

    // A real native edit during that wait keeps its own caret and text. No
    // input event is prevented; the delayed navigation simply returns false.
    await run(async () => { await ManuscriptMarks.show('annotations'); fixtureEvents = []; fixturePendingJumpState = 'none'; }); await tick();
    await markButton('跳转原文', async () => {
      assert.equal(await run(() => fixturePendingJumpState), 'pending', 'Native edit must occur during the actual focus wait');
      await window.webContents.debugger.sendCommand('Input.insertText', {text: '用户编辑'});
    }); await waitForRootJump(); const typed = await snapshot();
    assert.equal(await run(() => fixturePendingJumpResult), false); assert.equal(typed.body, '用户编辑' + orphan.body); assert.equal(typed.modelBody, typed.body); assert.equal(typed.selectionStart, 4); assert.equal(typed.selectionEnd, 4); assertNoDelete(typed);
    assert.ok(typed.events.some(event => event.type === 'input' && event.inputType === 'insertText' && event.trusted));
    results.cases.nativeTypingDuringFocusSettling = {navigationCancelled: true, nativeEditPreserved: true, userCaretPreserved: true, deleteInputs: 0};

    window.webContents.debugger.detach(); results.passed = true; finish();
  } catch (error) { finish(error); }
});
