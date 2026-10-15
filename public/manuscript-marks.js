'use strict';

// Anchors address UTF-16 ranges, exactly like textarea selections. A quote is
// evidence, never a request to jump to the first equal sentence in another place.
(function(global) {
  const MAX_MARKS = 5000, MAX_QUOTE = 20000, CONTEXT = 64;
  let options = null, dialog = null, ownerId = null, ownerBook = null, tab = 'annotations', scope = 'chapter', selected = null;
  const keys = ['annotations', 'bookmarks'];
  const defaults = () => ({version: 1, dictionary: [], annotations: [], bookmarks: []});
  const validBoundary = (text, at) => Number.isInteger(at) && at >= 0 && at <= text.length && !(at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]));
  function ensure(book) {
    if (!book.reviewTools || typeof book.reviewTools !== 'object' || Array.isArray(book.reviewTools)) book.reviewTools = defaults();
    for (const [key, value] of Object.entries(defaults())) if (book.reviewTools[key] === undefined) book.reviewTools[key] = value;
    return book.reviewTools;
  }
  function normalize(book) {
    const tools = ensure(book), chapters = new Map((book.chapters || []).map(chapter => [chapter.id, chapter]));
    for (const key of keys) for (const mark of tools[key]) {
      const chapter = chapters.get(mark.chapterId);
      if (mark.status !== 'orphaned' && (!chapter || !matches(mark, chapter.body))) orphan(mark);
    }
    return tools;
  }
  function contextAt(body, start, end) {
    let left = Math.max(0, start - CONTEXT), right = Math.min(body.length, end + CONTEXT);
    if (!validBoundary(body, left)) left++;
    if (!validBoundary(body, right)) right--;
    return {prefix: body.slice(left, start), suffix: body.slice(end, right)};
  }
  function paragraphRange(body, start, end = start) {
    if (!validBoundary(body, start) || !validBoundary(body, end) || end < start) throw new Error('正文选择位置不正确。');
    if (start === end) {
      start = body.lastIndexOf('\n', start - 1) + 1;
      end = body.indexOf('\n', end); if (end < 0) end = body.length;
      while (start < end && /\s/.test(body[start])) start++;
      while (end > start && /\s/.test(body[end - 1])) end--;
    }
    if (start === end || !body.slice(start, end).trim()) throw new Error('请选中文字，或将光标放在有正文的段落。');
    if (end - start > MAX_QUOTE) throw new Error('一次最多关联 20000 字符，请缩小选择范围。');
    return {start, end};
  }
  function anchorAt(body, start, end) {
    const range = paragraphRange(body, start, end);
    return {...range, quote: body.slice(range.start, range.end), ...contextAt(body, range.start, range.end), status: 'linked'};
  }
  function createMark(book, kind, chapterId, start, end, metadata = {}) {
    if (!keys.includes(kind)) throw new Error('批注类型不正确。');
    const chapter = book.chapters.find(item => item.id === chapterId && !item.deletedAt);
    if (!chapter) throw new Error('请先打开正文。');
    const records = ensure(book)[kind];
    if (records.length >= MAX_MARKS) throw new Error('批注或书签最多保存 5000 条。');
    const stamp = metadata.stamp || new Date().toISOString();
    const record = {id: metadata.id || global.crypto.randomUUID(), chapterId, ...anchorAt(chapter.body, start, end), body: '', label: '', resolved: false, createdAt: stamp, updatedAt: stamp};
    records.push(record); return record;
  }
  function matches(mark, body) {
    return mark.status !== 'orphaned' && validBoundary(body, mark.start) && validBoundary(body, mark.end) && mark.end > mark.start && body.slice(mark.start, mark.end) === mark.quote;
  }
  function orphan(mark) { mark.status = 'orphaned'; mark.prefix = ''; mark.suffix = ''; }
  function setRange(mark, body, start, end) {
    if (!validBoundary(body, start) || !validBoundary(body, end) || end <= start || end - start > MAX_QUOTE || !body.slice(start, end).trim()) return false;
    Object.assign(mark, {start, end, quote: body.slice(start, end), status: 'linked'}, contextAt(body, start, end)); return true;
  }
  function uniqueIndex(body, needle) {
    const at = body.indexOf(needle); return at >= 0 && body.indexOf(needle, at + 1) < 0 ? at : -1;
  }
  function reanchorChapter(chapterId, before, after, book = options?.getBook?.()) {
    if (!book || before === after || typeof before !== 'string' || typeof after !== 'string') return 0;
    const marks = keys.flatMap(key => ensure(book)[key]).filter(mark => mark.chapterId === chapterId && mark.status !== 'orphaned');
    if (!marks.length) return 0;
    let left = 0, right = 0;
    while (left < before.length && left < after.length && before[left] === after[left]) left++;
    if (!validBoundary(before, left) || !validBoundary(after, left)) left--;
    while (right < before.length - left && right < after.length - left && before[before.length - right - 1] === after[after.length - right - 1]) right++;
    if (!validBoundary(before, before.length - right) || !validBoundary(after, after.length - right)) right--;
    let fullSuffix = right;
    while (fullSuffix < before.length && fullSuffix < after.length && before[before.length - fullSuffix - 1] === after[after.length - fullSuffix - 1]) fullSuffix++;
    // Repeated adjacent text permits several equivalent edit alignments. Only
    // the prefix shared by every alignment is safe; detach ambiguous copies.
    const safePrefix = Math.min(left, before.length - fullSuffix, after.length - fullSuffix);
    const oldEnd = before.length - right, newEnd = after.length - right, delta = after.length - before.length;
    let moved = 0;
    const signatures = new Map();
    for (const mark of marks) {
      if (!matches(mark, before)) { orphan(mark); moved++; continue; }
      const {start, end} = mark;
      let located = false;
      if (end <= safePrefix) located = setRange(mark, after, start, end);
      else if (start >= oldEnd) located = setRange(mark, after, start + delta, end + delta);
      // A local edit inside a marked passage keeps its surviving passage. A
      // complete removal/replacement is detached, even if another copy exists.
      else if (safePrefix >= start && oldEnd <= end && /[\p{L}\p{N}]/u.test(before.slice(start, safePrefix) + before.slice(oldEnd, end))) located = setRange(mark, after, start, end + delta);
      if (!located && !(left <= start && oldEnd >= end && newEnd === left)) {
        const context = contextAt(before, start, end), signature = context.prefix + mark.quote + context.suffix;
        if (!signatures.has(signature)) signatures.set(signature, {before: uniqueIndex(before, signature), after: uniqueIndex(after, signature)});
        const evidence = signatures.get(signature);
        if (evidence.before === start - context.prefix.length) {
          const at = evidence.after, candidate = at + context.prefix.length;
          if (at >= 0 && (context.prefix || candidate === 0) && (context.suffix || candidate + mark.quote.length === after.length)) located = setRange(mark, after, candidate, candidate + mark.quote.length);
        }
      }
      if (!located) orphan(mark);
      moved++;
    }
    return moved;
  }
  function remapShortLinks(book, aliases, manuscriptId, recycled = [], offsets = {}) {
    const allowed = new Set(aliases), removed = new Set(recycled), positions = Object.fromEntries((book.shortSections || []).map(item => [item.id, item.start]));
    Object.assign(positions, offsets);
    for (const key of keys) for (const mark of ensure(book)[key]) {
      const id = mark.chapterId;
      if (id === manuscriptId || !allowed.has(id) || removed.has(id)) continue;
      mark.chapterId = manuscriptId;
      if (Number.isInteger(positions[id]) && positions[id] >= 0) { mark.start += positions[id]; mark.end += positions[id]; }
      else orphan(mark);
    }
    return book;
  }

  const t = (text, ...args) => options?.T ? options.T(text, ...args) : String(text).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  const node = (tag, cls, text) => { const element = document.createElement(tag); if (cls) element.className = cls; if (text !== undefined) element.textContent = text; return element; };
  const button = (text, cls, callback) => { const element = node('button', cls, text); element.type = 'button'; element.addEventListener('click', callback); return element; };
  const current = () => options?.getBook?.()?.id === ownerId && options.getBook() === ownerBook;
  const book = () => current() ? options.getBook() : null;
  const chapters = () => (book()?.chapters || []).filter(item => !item.deletedAt);
  const records = () => normalize(book())[tab];
  const chapterLabel = chapter => book().kind === 'short' ? t('正文') : chapter.title || t('未命名章节');
  function changed(record) { if (!current()) return; if (record) record.updatedAt = new Date().toISOString(); options.markDirty(); }
  function close() { if (dialog?.open) dialog.close(); ownerId = null; ownerBook = null; options?.setComposing?.(false); }
  function initialize() {
    if (dialog) return;
    dialog = node('dialog', 'manuscript-marks-dialog'); dialog.id = 'manuscript-marks-dialog'; dialog.setAttribute('aria-label', t('批注与书签'));
    document.body.append(dialog);
    dialog.addEventListener('close', () => { ownerId = null; ownerBook = null; options?.setComposing?.(false); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  }
  function render() {
    if (!current()) return close();
    const header = node('header', 'marks-header'), title = node('div', 'marks-heading');
    title.append(node('strong', null, t('批注与书签')), node('span', null, book().title));
    const dismiss = button('×', 'icon-button', close); dismiss.setAttribute('aria-label', t('关闭')); header.append(title, dismiss);
    const tabs = node('div', 'marks-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('批注与书签'));
    keys.forEach((key, index) => {
      const control = button(t(key === 'annotations' ? '段落批注' : '书签'), 'marks-tab', () => { tab = key; selected = null; render(); });
      control.id = 'marks-tab-' + key; control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(tab === key)); control.setAttribute('aria-controls', 'marks-content'); control.tabIndex = tab === key ? 0 : -1;
      control.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); tab = keys[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index]; selected = null; render(); dialog.querySelector('#marks-tab-' + tab)?.focus(); });
      tabs.append(control);
    });
    const content = node('div', 'marks-content'); content.id = 'marks-content'; content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', 'marks-tab-' + tab);
    const sidebar = node('aside', 'marks-sidebar'), toolbar = node('div', 'marks-list-toolbar'), filter = node('select', 'marks-input');
    [['chapter', '当前正文'], ['book', '全书']].forEach(([value, label]) => { const choice = node('option', null, t(label)); choice.value = value; filter.append(choice); }); filter.value = scope; filter.setAttribute('aria-label', t('批注查看范围'));
    filter.addEventListener('change', () => { scope = filter.value; selected = null; render(); });
    toolbar.append(filter, button('+ ' + t(tab === 'annotations' ? '添加批注' : '添加书签'), 'primary-button', () => add(tab))); sidebar.append(toolbar);
    const list = node('div', 'marks-list'), active = new Map(chapters().map(item => [item.id, item]));
    const items = records().filter(item => active.has(item.chapterId) && (scope === 'book' || item.chapterId === options.getChapterId())).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!items.some(item => item.id === selected)) selected = items[0]?.id || null;
    if (!items.length) list.append(node('p', 'marks-empty', t(tab === 'annotations' ? '暂无批注' : '暂无书签')));
    for (const item of items) {
      const row = button('', 'marks-item' + (item.id === selected ? ' selected' : ''), () => { selected = item.id; render(); }); row.dataset.markId = item.id; row.setAttribute('aria-pressed', String(item.id === selected));
      row.append(node('strong', 'marks-item-title', item.label || (tab === 'annotations' && item.body.trim() ? item.body.trim().slice(0, 45) : item.quote.slice(0, 45))), node('small', 'marks-item-meta', chapterLabel(active.get(item.chapterId)) + ' · ' + t(item.status === 'orphaned' ? '原文已变更' : item.resolved && tab === 'annotations' ? '已解决' : '已关联'))); list.append(row);
    }
    sidebar.append(list); const detail = node('div', 'marks-detail'); content.append(sidebar, detail); dialog.replaceChildren(header, tabs, content);
    const item = records().find(item => item.id === selected); if (item) renderDetail(detail, item);
  }
  function field(label, input) { const wrapper = node('label', 'marks-field'); wrapper.append(node('span', null, t(label)), input); return wrapper; }
  function input(value, limit, callback, multiline = false) {
    const element = node(multiline ? 'textarea' : 'input', 'marks-input'); element.value = value || ''; element.maxLength = limit; if (!multiline) element.type = 'text';
    element.addEventListener('input', () => { if (current()) callback(element.value); }); element.addEventListener('compositionstart', () => options?.setComposing?.(true)); element.addEventListener('compositionend', () => options?.setComposing?.(false)); return element;
  }
  function updateTitle(item) {
    const row = [...dialog.querySelectorAll('[data-mark-id]')].find(element => element.dataset.markId === item.id);
    if (row) row.querySelector('.marks-item-title').textContent = item.label || (tab === 'annotations' && item.body.trim() ? item.body.trim().slice(0, 45) : item.quote.slice(0, 45));
  }
  function renderDetail(detail, item) {
    detail.append(node('small', 'marks-date', t('创建于 {0}', new Date(item.createdAt).toLocaleString())));
    const label = input(item.label, 200, value => { item.label = value; changed(item); updateTitle(item); }); label.setAttribute('aria-label', t(tab === 'bookmarks' ? '书签名称' : '批注标题')); label.placeholder = t('可选'); detail.append(field(tab === 'bookmarks' ? '书签名称' : '批注标题', label));
    const quote = node('blockquote', 'marks-quote', item.quote); quote.setAttribute('aria-label', t('关联原文')); detail.append(quote);
    if (item.status === 'orphaned') detail.append(node('p', 'marks-detached', t('原文已变更，请重新关联。')));
    if (tab === 'annotations') {
      const body = input(item.body, 10000, value => { item.body = value; changed(item); updateTitle(item); }, true); body.setAttribute('aria-label', t('批注内容')); body.placeholder = t('记录修改想法…'); detail.append(field('批注内容', body));
      const resolved = node('input'); resolved.type = 'checkbox'; resolved.checked = item.resolved;
      const line = node('label', 'marks-resolved'); line.append(resolved, node('span', null, t('已解决'))); resolved.addEventListener('change', () => { if (!current()) return; item.resolved = resolved.checked; changed(item); const at = detail.scrollTop; render(); dialog.querySelector('.marks-detail').scrollTop = at; }); detail.append(line);
    }
    const actions = node('div', 'marks-actions'), locate = button(t('跳转原文'), 'primary-button', () => jump(item)); locate.disabled = item.status === 'orphaned';
    const relink = button(t('重新关联'), 'secondary-button', () => renderRelink(detail, item));
    actions.append(locate, relink, button(t('删除'), 'text-button danger-button', () => { if (!current()) return; const items = records(), at = items.findIndex(record => record.id === item.id); if (at < 0) return; items.splice(at, 1); selected = null; changed(); render(); })); detail.append(actions);
  }
  function renderRelink(detail, item) {
    if (!current()) return;
    const chooser = node('section', 'marks-relink'), select = node('select', 'marks-input'); select.setAttribute('aria-label', t('重新关联正文'));
    for (const chapter of chapters()) { const choice = node('option', null, chapterLabel(chapter)); choice.value = chapter.id; select.append(choice); }
    select.value = chapters().some(chapter => chapter.id === item.chapterId) ? item.chapterId : chapters()[0]?.id || '';
    const preview = node('textarea', 'marks-input marks-source'); preview.readOnly = true; preview.setAttribute('aria-label', t('选择新的关联原文'));
    const status = node('p', 'marks-empty', t('在下方选中文字后关联。'));
    let source = '', sourceId = '';
    const refresh = () => { sourceId = select.value; source = chapters().find(chapter => chapter.id === sourceId)?.body || ''; preview.value = source; preview.setSelectionRange(0, 0); }; refresh(); select.addEventListener('change', refresh);
    const apply = button(t('关联所选文字'), 'primary-button', () => {
      if (!current()) return;
      const chapter = chapters().find(candidate => candidate.id === sourceId);
      if (!chapter || chapter.body !== source) { options.toast?.(t('正文已变化，请重新选择。')); refresh(); return; }
      try { const start = preview.selectionStart, end = preview.selectionEnd; if (start === end) throw new Error('请先选中新的关联文字。'); Object.assign(item, {chapterId: sourceId}, anchorAt(source, start, end)); changed(item); render(); }
      catch (error) { options.toast?.(t(error.message)); }
    });
    chooser.append(field('关联正文', select), status, preview, apply); detail.replaceChildren(chooser); preview.focus({preventScroll: true});
  }
  async function show(next = 'annotations') {
    const initial = options?.getBook?.(); if (!initial || (options?.isComposing?.() || options?.isTransitioning?.())) return false;
    if (!await options.saveNow() || options.getBook()?.id !== initial.id) return false;
    ownerId = initial.id; ownerBook = options.getBook(); normalize(book()); tab = keys.includes(next) ? next : 'annotations'; selected = null;
    initialize(); render(); if (!dialog.open) dialog.showModal(); return true;
  }
  async function add(next = 'annotations') {
    const initial = options?.getBook?.(), editor = options?.getEditor?.(), chapterId = options?.getChapterId?.();
    if (!initial || !editor || editor.disabled || (options?.isComposing?.() || options?.isTransitioning?.())) return false;
    const chapter = initial.chapters.find(item => item.id === chapterId && !item.deletedAt); if (!chapter) return false;
    const source = chapter.body, start = editor.selectionStart, end = editor.selectionEnd;
    try {
      const range = paragraphRange(source, start, end);
      if (!await options.saveNow() || options.getBook()?.id !== initial.id) return false;
      const activeBook = options.getBook(), active = activeBook.chapters.find(item => item.id === chapterId && !item.deletedAt);
      if (!active || active.body !== source) throw new Error('正文已变化，请重新选择。');
      ownerId = initial.id; ownerBook = activeBook; tab = keys.includes(next) ? next : 'annotations'; const item = createMark(activeBook, tab, chapterId, range.start, range.end); selected = item.id;
      scope = chapterId === options.getChapterId() ? 'chapter' : 'book'; options.markDirty(); initialize(); render(); if (!dialog.open) dialog.showModal();
      dialog.querySelector(tab === 'annotations' ? 'textarea' : 'input')?.focus({preventScroll: true}); return true;
    } catch (error) { options.toast?.(t(error.message)); return false; }
  }
  function scrollToSelection(editor, start) {
    const area = options?.getWritingArea?.(); if (!area || typeof getComputedStyle !== 'function') return;
    const marker = node('div'); marker.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none;'; const css = getComputedStyle(editor);
    for (const key of ['font', 'letterSpacing', 'lineHeight', 'padding', 'boxSizing', 'wordBreak']) marker.style[key] = css[key]; marker.style.width = editor.getBoundingClientRect().width + 'px'; marker.textContent = editor.value.slice(0, start) + '\u200b'; editor.parentElement.append(marker);
    const behavior = area.style.scrollBehavior; area.style.scrollBehavior = 'auto'; area.scrollTop = Math.max(0, editor.offsetTop + marker.offsetHeight - area.clientHeight / 3); area.style.scrollBehavior = behavior; marker.remove();
  }
  async function jump(item) {
    if (!current() || item.status === 'orphaned') return false;
    const expectedBook = ownerId, kind = tab, markId = item.id;
    if (!await options.saveNow() || !current()) return false;
    const latest = normalize(book())[kind].find(record => record.id === markId), chapter = chapters().find(candidate => candidate.id === latest?.chapterId);
    if (!latest || !chapter || !matches(latest, chapter.body)) { if (latest) { orphan(latest); changed(latest); render(); } options.toast?.(t('原文已变更，请重新关联。')); return false; }
    const expectedBody = chapter.body, range = {start: latest.start, end: latest.end}; close(); if (await options.jumpToChapter(chapter.id) === false) return false;
    const currentBook = options.getBook(), currentChapter = currentBook?.chapters.find(candidate => candidate.id === chapter.id && !candidate.deletedAt), editor = options.getEditor();
    if (currentBook?.id !== expectedBook || options.getChapterId() !== chapter.id || currentChapter?.body !== expectedBody || !editor || editor.value !== expectedBody) return false;
    editor.focus({preventScroll: true}); editor.setSelectionRange(range.start, range.end); scrollToSelection(editor, range.start); return true;
  }
  function sync() { if (!dialog?.open) return; const latest = options?.getBook?.(); if (latest?.id !== ownerId) close(); else if (latest !== ownerBook) { ownerBook = latest; render(); } }
  function configure(value) { options = value; }
  const model = {defaults, normalize, validBoundary, contextAt, paragraphRange, anchorAt, createMark, matches, reanchorChapter, remapShortLinks};
  if (typeof module === 'object' && module.exports) module.exports = model;
  else global.ManuscriptMarks = {...model, configure, show, add, close, sync};
})(typeof window === 'undefined' ? globalThis : window);
