'use strict';

// Exercise the actual painters and image composition with an instrumented
// Canvas contract. Real raster screenshots are checked separately in the UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../public/book-covers.js'), 'utf8');
function harness(language = 'zh') {
  const canvases = [], images = [];
  class Image {
    constructor() { this.naturalWidth = 1024; this.naturalHeight = 768; images.push(this); }
    set src(value) { this.value = value; queueMicrotask(() => this.onload()); }
  }
  const context = vm.createContext({ uiLanguage: language, Image, Math: Object.create(Math), document: { createElement(tag) {
    assert.equal(tag, 'canvas'); const operations = [], state = {};
    const ctx = new Proxy({}, {
      set(target, key, value) { state[key] = value; operations.push([key, value]); return true; },
      get(target, key) {
        if (key === 'measureText') return value => ({ width: Array.from(value).length * (Number(/(\d+)px/.exec(state.font)?.[1]) || 12) * .62 });
        if (key === 'createLinearGradient') return (...points) => { const stops = []; operations.push(['gradient', points, stops]); return { addColorStop: (offset, color) => stops.push([offset, color]) }; };
        return (...args) => operations.push([key, ...args.map(value => typeof value === 'object' ? 'decoded-image' : value)]);
      },
    });
    const canvas = { width: 0, height: 0, operations, getContext(type) { assert.equal(type, '2d'); return ctx; },
      toDataURL(type, quality) { this.encoding = { type, quality }; return 'data:image/jpeg;base64,' + createHash('sha256').update(JSON.stringify(operations)).digest('base64'); } };
    canvases.push(canvas); return canvas;
  } } });
  context.window = context; vm.runInContext(source, context, { filename: 'public/book-covers.js' });
  return { api: context.WriterCovers, context, canvases, images };
}
const tests = [];
const check = (name, test) => tests.push({ name, test });

check('ten distinct deterministic painters use 600×800 JPEG output and incorporate the given title', () => {
  const h = harness(), outputs = [];
  assert.equal(h.api.templates.length, 10); assert.equal(new Set(h.api.templates.map(value => value.id)).size, 10);
  for (const template of h.api.templates) {
    const output = h.api.render(template.id, '潮汐档案馆', 'long'), canvas = h.canvases.at(-1); outputs.push(output);
    assert.equal(canvas.width, 600); assert.equal(canvas.height, 800); assert.deepEqual(canvas.encoding, { type: 'image/jpeg', quality: .88 });
    const words = canvas.operations.filter(op => op[0] === 'fillText').map(op => op[1]).join('');
    assert.ok(words.includes('潮汐档案馆')); assert.ok(words.includes('长 篇 小 说'));
    assert.equal(h.api.render(template.id, '潮汐档案馆', 'long'), output, 'Template art should be stable on re-open');
    assert.notEqual(h.api.render(template.id, '另一部作品', 'long'), output, 'The title must affect raster output');
  }
  assert.equal(new Set(outputs).size, 10, 'Every template must draw a different composition');
});

check('cover labels follow English and short-fiction mode without translating authored titles', () => {
  const h = harness('en'); h.api.render('paper', '来自海边的信', 'short');
  const words = h.canvases.at(-1).operations.filter(op => op[0] === 'fillText').map(op => op[1]).join('');
  assert.ok(words.includes('SHORT FICTION')); assert.ok(words.includes('来自海边的信')); assert.ok(!words.includes('A NOVEL'));
  assert.throws(() => h.api.render('unknown', 'Title'), /封面模板不存在/); assert.throws(() => h.api.render('toString', 'Title'), /封面模板不存在/);
});

check('very long Chinese and English titles stay within a bounded number of rendered lines', () => {
  for (const language of ['zh', 'en']) for (const template of harness(language).api.templates) {
    const h = harness(language), title = language === 'zh' ? '一部非常长但必须保持排版的小说书名'.repeat(15) : 'The Unfinished Bookshop Beyond the Last Lighthouse '.repeat(10);
    h.api.render(template.id, title, 'long'); const text = h.canvases.at(-1).operations.filter(op => op[0] === 'fillText');
    assert.ok(text.length <= 5); for (const [, word, x, y, width] of text) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); assert.ok(y >= 0 && y < 800); if (width) assert.ok(width <= 600); assert.ok(word.length > 0); }
  }
});

check('local title dice cannot repeat consecutively even with a constant random source', () => {
  const h = harness(); h.context.Math.random = () => 0;
  for (const language of ['zh', 'en']) {
    let previous = ''; for (let i = 0; i < 30; i++) { const title = h.api.randomTitle(language, previous); assert.notEqual(title, previous); assert.ok(language === 'en' ? /^[A-Za-z]/.test(title) : /[\u4e00-\u9fff]/.test(title)); previous = title; }
  }
});

check('AI image composition is local, crops to 600×800, adds a legible title overlay, and compresses to JPEG', async () => {
  const h = harness(), input = 'data:image/png;base64,Y292ZXI='; const output = await h.api.composeImage(input, '夜航船上的最后一封信');
  assert.equal(h.images.length, 1); assert.equal(h.images[0].value, input); assert.match(output, /^data:image\/jpeg;base64,/);
  const canvas = h.canvases.at(-1); assert.equal(canvas.width, 600); assert.equal(canvas.height, 800); assert.deepEqual(canvas.encoding, { type: 'image/jpeg', quality: .88 });
  assert.ok(canvas.operations.some(op => op[0] === 'drawImage')); assert.ok(canvas.operations.filter(op => op[0] === 'fillText').map(op => op[1]).join('').includes('夜航船上的最后一封信'));
  for (const input of ['https://example.com/cover.png', 'data:image/svg+xml;base64,Y292ZXI=', 'data:image/png;base64,@@', '', null]) await assert.rejects(h.api.composeImage(input, 'Title'), /这张图片无法读取/);
  assert.equal(h.images.length, 1, 'Invalid input must not initiate image loading');
});

(async () => { let failed = 0; for (const { name, test } of tests) { try { await test(); console.log('PASS:', name); } catch (error) { failed++; console.error('FAIL:', name, '\n', error.stack); } } if (failed) process.exitCode = 1; })();
