'use strict';

// Planning stays in the selected book. Activity is read from successful saves.
window.WriterStoryTools = (() => {
  let options = null, dialog = null, owner = null, tab = 'foreshadows', selected = null;
  let statusFilter = 'unresolved', statsRequest = 0, statsData = null, chartDays = 7, calendarMonth = null;
  const translate = (...args) => options?.T ? options.T(...args) : args[0];
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, className, handler) => {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  };
  const current = () => owner && options?.getBook?.() === owner;
  const chapters = () => (owner?.chapters || []).filter(item => !item.deletedAt);
  const people = () => (owner?.notes || []).filter(item => item.type === '人物' && !item.deletedAt);
  const statusLabel = status => translate(({planted: '埋下', developing: '推进', resolved: '回收'})[status] || '埋下');
  const wordLabel = value => translate('{0} 字', Number(value).toLocaleString());
  const ensure = book => {
    if (!book.storyTools) book.storyTools = {foreshadows: [], timeline: [], dailyGoal: 2000};
    return book.storyTools;
  };
  function changed() { if (current()) options.markDirty(); }
  function field(label, input) {
    const wrapper = node('label', 'story-tools-field');
    wrapper.append(node('span', null, translate(label)), input);
    return wrapper;
  }
  function input(value, handler, multiline = false) {
    const element = node(multiline ? 'textarea' : 'input', 'story-tools-input');
    if (!multiline) element.type = 'text';
    element.value = value || '';
    element.maxLength = multiline ? 100000 : 200;
    element.addEventListener('input', () => { if (current()) handler(element.value); });
    element.addEventListener('compositionstart', () => options?.setComposing?.(true));
    element.addEventListener('compositionend', () => options?.setComposing?.(false));
    return element;
  }
  function records() { return ensure(owner)[tab]; }
  function visibleRecords() {
    const items = records();
    if (tab !== 'foreshadows' || statusFilter === 'all') return items;
    return items.filter(item => statusFilter === 'unresolved' ? item.status !== 'resolved' : item.status === statusFilter);
  }
  function initializeDialog() {
    if (dialog) return;
    dialog = node('dialog', 'story-tools-dialog');
    dialog.id = 'story-tools-dialog';
    dialog.setAttribute('aria-label', translate('创作工具'));
    document.body.append(dialog);
    dialog.addEventListener('close', () => { statsRequest++; owner = null; options?.setComposing?.(false); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  }
  function render() {
    if (!current()) return close();
    const header = node('header', 'story-tools-header');
    const heading = node('div', 'story-tools-heading');
    heading.append(node('strong', null, translate('创作工具')), node('span', 'story-tools-book', owner.title));
    const dismiss = button('×', 'icon-button', close);
    dismiss.title = translate('关闭'); dismiss.setAttribute('aria-label', translate('关闭'));
    header.append(heading, dismiss);
    const tabs = node('div', 'story-tools-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', translate('创作工具'));
    const keys = ['foreshadows', 'timeline', 'stats'];
    const labels = ['伏笔追踪', '故事时间线', '写作统计'];
    keys.forEach((key, index) => {
      const control = button(translate(labels[index]), 'story-tools-tab', () => selectTab(key));
      control.setAttribute('role', 'tab'); control.id = 'story-tools-tab-' + key;
      control.setAttribute('aria-controls', 'story-tools-body');
      control.setAttribute('aria-selected', String(tab === key)); control.tabIndex = tab === key ? 0 : -1;
      control.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        selectTab(keys[next]); dialog.querySelector('#story-tools-tab-' + keys[next])?.focus();
      });
      tabs.append(control);
    });
    const body = node('div', 'story-tools-body'); body.id = 'story-tools-body';
    body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', 'story-tools-tab-' + tab);
    dialog.replaceChildren(header, tabs, body);
    if (tab === 'stats') renderStats(body); else renderPlanning(body);
  }
  function selectTab(next) {
    if (!current()) return;
    tab = next; selected = null;
    render();
  }
  function renderPlanning(body) {
    const sidebar = node('aside', 'story-tools-list-pane');
    const toolbar = node('div', 'story-tools-list-toolbar');
    if (tab === 'foreshadows') {
      const filter = node('select', 'story-tools-input');
      [['unresolved', '未回收'], ['all', '全部伏笔'], ['planted', '埋下'], ['developing', '推进'], ['resolved', '回收']].forEach(([value, label]) => {
        const item = node('option', null, translate(label)); item.value = value; filter.append(item);
      });
      filter.value = statusFilter; filter.setAttribute('aria-label', translate('伏笔状态'));
      filter.addEventListener('change', () => { statusFilter = filter.value; selected = null; render(); });
      toolbar.append(filter);
    }
    toolbar.append(button('+ ' + translate(tab === 'foreshadows' ? '新建伏笔' : '新建事件'), 'primary-button', () => {
      if (!current()) return;
      const record = {id: crypto.randomUUID(), title: '', body: '', chapterIds: [], personIds: []};
      if (tab === 'foreshadows') { record.status = 'planted'; statusFilter = 'unresolved'; } else record.storyTime = '';
      records().push(record); selected = record.id; changed(); render();
      dialog.querySelector('.story-tools-title-input')?.focus();
    }));
    sidebar.append(toolbar);
    const list = node('div', 'story-tools-list');
    const items = visibleRecords();
    if (!items.some(item => item.id === selected)) selected = items[0]?.id || null;
    if (!items.length) list.append(node('p', 'story-tools-empty', translate(tab === 'foreshadows' ? '暂无伏笔' : '暂无事件')));
    for (const item of items) {
      const row = button('', 'story-tools-item' + (selected === item.id ? ' selected' : ''), () => { selected = item.id; render(); });
      row.dataset.storyId = item.id;
      row.append(node('strong', 'story-tools-item-title', item.title || translate('未命名')));
      row.append(node('small', 'story-tools-item-meta', tab === 'foreshadows' ? statusLabel(item.status) : item.storyTime || translate('未设置时间')));
      row.setAttribute('aria-pressed', String(selected === item.id)); list.append(row);
    }
    sidebar.append(list);
    const editor = node('div', 'story-tools-editor');
    body.classList.add('story-tools-planning'); body.append(sidebar, editor);
    const record = records().find(item => item.id === selected);
    if (record) renderEditor(editor, record);
  }
  function updateList(record) {
    const row = [...dialog.querySelectorAll('[data-story-id]')].find(item => item.dataset.storyId === record.id);
    if (!row) return;
    row.querySelector('.story-tools-item-title').textContent = record.title || translate('未命名');
    row.querySelector('.story-tools-item-meta').textContent = tab === 'foreshadows' ? statusLabel(record.status) : record.storyTime || translate('未设置时间');
  }
  function renderEditor(editor, record) {
    const title = input(record.title, value => { record.title = value; changed(); updateList(record); });
    title.classList.add('story-tools-title-input'); title.placeholder = translate(tab === 'foreshadows' ? '伏笔名称' : '事件名称');
    editor.append(field('标题', title));
    if (tab === 'foreshadows') {
      const status = node('select', 'story-tools-input');
      ['planted', 'developing', 'resolved'].forEach(value => { const item = node('option', null, statusLabel(value)); item.value = value; status.append(item); });
      status.value = record.status; status.addEventListener('change', () => {
        if (!current()) return; record.status = status.value; changed();
        if (statusFilter !== 'all' && (statusFilter === 'unresolved' ? record.status === 'resolved' : statusFilter !== record.status)) { selected = null; render(); }
        else updateList(record);
      });
      editor.append(field('伏笔状态', status));
    } else {
      const time = input(record.storyTime, value => { record.storyTime = value; changed(); updateList(record); });
      time.placeholder = translate('如：第三日清晨／帝国历 120 年');
      editor.append(field('故事时间', time));
    }
    editor.append(field('说明', input(record.body, value => { record.body = value; changed(); }, true)));
    editor.append(linkSelector(record, 'chapterIds', '关联正文', chapters(), item => owner.kind === 'short' ? translate('正文') : item.title || translate('未命名章节'), id => options.jumpToChapter?.(id)));
    editor.append(linkSelector(record, 'personIds', '关联人物', people(), item => item.title || translate('未命名人物'), id => options.jumpToPerson?.(id)));
    const footer = node('div', 'story-tools-editor-actions');
    if (tab === 'timeline') {
      const index = records().indexOf(record);
      const move = step => {
        if (!current()) return; const items = records(), at = items.indexOf(record), next = at + step;
        if (next < 0 || next >= items.length) return;
        [items[at], items[next]] = [items[next], items[at]]; changed(); render();
      };
      const up = button(translate('上移'), 'secondary-button', () => move(-1)); up.disabled = index === 0;
      const down = button(translate('下移'), 'secondary-button', () => move(1)); down.disabled = index === records().length - 1;
      footer.append(up, down);
    }
    footer.append(button(translate('删除'), 'text-button danger-button', () => {
      if (!current() || !window.confirm(translate(tab === 'foreshadows' ? '删除这条伏笔？' : '删除这个事件？'))) return;
      const items = records(); items.splice(items.indexOf(record), 1); selected = null; changed(); render();
    }));
    editor.append(footer);
  }
  function linkSelector(record, key, label, items, itemLabel, jump) {
    const group = node('section', 'story-tools-links');
    const heading = node('div', 'story-tools-links-heading', translate(label));
    group.append(heading);
    const active = new Set(items.map(item => item.id));
    const chips = node('div', 'story-tools-link-chips');
    for (const id of record[key]) {
      const item = items.find(candidate => candidate.id === id);
      if (!item) continue;
      chips.append(button(itemLabel(item) + ' ↗', 'story-tools-link-chip', async () => {
        if (!current() || !await options.saveNow()) return;
        close(); jump(id);
      }));
    }
    if (chips.childElementCount) group.append(chips);
    const details = node('details', 'story-tools-link-picker');
    details.append(node('summary', null, translate('选择关联')));
    const choices = node('div', 'story-tools-link-choices');
    if (!items.length) choices.append(node('p', 'story-tools-empty', translate('暂无可关联内容')));
    for (const item of items) {
      const wrapper = node('label', 'story-tools-link-option'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.linkId = item.id; checkbox.checked = record[key].includes(item.id);
      checkbox.addEventListener('change', () => {
        if (!current()) return;
        const values = new Set(record[key].filter(id => active.has(id)));
        if (checkbox.checked) values.add(item.id); else values.delete(item.id);
        record[key] = [...values]; changed();
        const replacement = linkSelector(record, key, label, items, itemLabel, jump);
        replacement.querySelector('details').open = true; group.replaceWith(replacement);
        [...replacement.querySelectorAll('input')].find(control => control.dataset.linkId === item.id)?.focus({preventScroll: true});
      });
      wrapper.append(checkbox, node('span', null, itemLabel(item))); choices.append(wrapper);
    }
    details.append(choices); group.append(details); return group;
  }
  async function loadStats() {
    const request = ++statsRequest, book = owner;
    const saved = await options.saveNow();
    if (!saved || request !== statsRequest || !current() || owner !== book) return;
    try {
      const result = await options.api('/api/books/' + encodeURIComponent(book.id) + '/writing-stats');
      if (request !== statsRequest || !current() || owner !== book || tab !== 'stats') return;
      statsData = result; calendarMonth = result.today.slice(0, 7); render();
    } catch (error) {
      if (request !== statsRequest || !current() || tab !== 'stats') return;
      const content = dialog.querySelector('.story-tools-body'); content.replaceChildren(node('p', 'story-tools-error', error.message));
      content.append(button(translate('重试'), 'secondary-button', () => { statsData = null; loadStats(); }));
    }
  }
  function renderStats(body) {
    body.classList.add('story-tools-statistics');
    if (!statsData || statsData.bookId !== owner.id) {
      body.append(node('p', 'story-tools-empty', translate('正在加载…'))); loadStats(); return;
    }
    const summary = node('div', 'story-tools-stat-cards');
    const today = node('div', 'story-tools-stat-card'); today.append(node('span', null, translate('今日新增')), node('strong', null, wordLabel(statsData.todayChars)));
    today.title = translate('按成功保存的正文增量统计，导入与恢复不计入');
    const total = node('div', 'story-tools-stat-card'); total.append(node('span', null, translate('全书字数')), node('strong', null, wordLabel(statsData.totalChars)));
    const goal = node('div', 'story-tools-stat-card'), goalInput = node('input', 'story-tools-input story-tools-goal-input');
    goalInput.type = 'number'; goalInput.min = '0'; goalInput.max = '1000000'; goalInput.step = '1'; goalInput.value = String(ensure(owner).dailyGoal);
    goalInput.setAttribute('aria-label', translate('每日目标')); goal.append(field('每日目标', goalInput));
    const progress = node('progress', 'story-tools-goal-progress'); progress.max = Math.max(1, ensure(owner).dailyGoal); progress.value = statsData.todayChars;
    progress.setAttribute('aria-label', translate('目标进度')); progress.hidden = ensure(owner).dailyGoal === 0; goal.append(progress);
    goalInput.addEventListener('change', () => {
      if (!current()) return;
      if (!/^\d+$/.test(goalInput.value) || Number(goalInput.value) > 1000000) { goalInput.value = String(ensure(owner).dailyGoal); return; }
      ensure(owner).dailyGoal = Number(goalInput.value); changed(); progress.max = Math.max(1, ensure(owner).dailyGoal); progress.value = statsData.todayChars; progress.hidden = ensure(owner).dailyGoal === 0;
    });
    const refresh = button(translate('刷新'), 'secondary-button story-tools-stats-refresh', () => { statsData = null; render(); });
    summary.append(today, total, goal); body.append(summary, refresh);
    const trend = node('section', 'story-tools-trend');
    const trendHeader = node('div', 'story-tools-section-header'); trendHeader.append(node('h3', null, translate('字数趋势')));
    [7, 30].forEach(days => { const control = button(translate('{0} 天', days), 'story-tools-range' + (chartDays === days ? ' selected' : ''), () => { chartDays = days; render(); }); control.setAttribute('aria-pressed', String(chartDays === days)); trendHeader.append(control); });
    trend.append(trendHeader);
    const chart = node('div', 'story-tools-chart'); chart.setAttribute('role', 'list'); chart.setAttribute('aria-label', translate('每日新增字数'));
    const days = statsData.days.slice(-chartDays), maximum = Math.max(1, ...days.map(day => day.addedChars));
    days.forEach(day => {
      const bar = node('div', 'story-tools-chart-column'); bar.setAttribute('role', 'listitem'); bar.tabIndex = 0; bar.title = day.date + ' · ' + wordLabel(day.addedChars); bar.setAttribute('aria-label', bar.title);
      const height = node('div', 'story-tools-chart-track'), fill = node('span', 'story-tools-chart-fill'); fill.style.height = (day.addedChars / maximum * 100) + '%'; height.append(fill);
      bar.append(height, node('small', null, day.date.slice(8))); chart.append(bar);
    });
    trend.append(chart); body.append(trend); renderCalendar(body);
  }
  function shiftMonth(value, offset) {
    const [year, month] = value.split('-').map(Number), shifted = new Date(year, month - 1 + offset, 1);
    return shifted.getFullYear() + '-' + String(shifted.getMonth() + 1).padStart(2, '0');
  }
  function renderCalendar(body) {
    const section = node('section', 'story-tools-calendar'), header = node('div', 'story-tools-section-header');
    const month = calendarMonth || statsData.today.slice(0, 7);
    const previous = button('‹', 'icon-button', () => { calendarMonth = shiftMonth(month, -1); render(); }); previous.setAttribute('aria-label', translate('上个月'));
    previous.disabled = shiftMonth(month, -1) + '-01' < statsData.days[0].date;
    const next = button('›', 'icon-button', () => { calendarMonth = shiftMonth(month, 1); render(); }); next.setAttribute('aria-label', translate('下个月')); next.disabled = month >= statsData.today.slice(0, 7);
    header.append(node('h3', null, translate('写作日历')), previous, node('strong', 'story-tools-calendar-month', month), next); section.append(header);
    const grid = node('div', 'story-tools-calendar-grid');
    ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].forEach(day => grid.append(node('span', 'story-tools-weekday', translate(day))));
    const [year, number] = month.split('-').map(Number), firstDay = new Date(year, number - 1, 1), count = new Date(year, number, 0).getDate(), offset = (firstDay.getDay() + 6) % 7;
    for (let at = 0; at < offset; at++) grid.append(node('span'));
    const lookup = new Map(statsData.days.map(day => [day.date, day.addedChars])), goal = ensure(owner).dailyGoal;
    for (let at = 1; at <= count; at++) {
      const day = month + '-' + String(at).padStart(2, '0'), amount = lookup.get(day) || 0;
      const cell = node('div', 'story-tools-calendar-day' + (amount ? ' has-writing' : '') + (goal > 0 && amount >= goal ? ' reached-goal' : '') + (day === statsData.today ? ' is-today' : ''));
      cell.title = day + ' · ' + wordLabel(amount); cell.setAttribute('aria-label', cell.title); cell.tabIndex = 0;
      cell.append(node('span', null, String(at)), node('small', null, amount ? amount.toLocaleString() : ''));
      if (day > statsData.today) { cell.classList.add('future'); cell.tabIndex = -1; }
      grid.append(cell);
    }
    section.append(grid); body.append(section);
  }
  async function open(next = 'foreshadows') {
    const book = options?.getBook?.();
    if (!book || !await options.saveNow() || options.getBook() !== book) return false;
    owner = book;
    ensure(owner); tab = ['foreshadows', 'timeline', 'stats'].includes(next) ? next : 'foreshadows'; selected = null; statsData = null; statsRequest++;
    initializeDialog(); render(); if (!dialog.open) dialog.showModal(); return true;
  }
  function close() { if (dialog?.open) dialog.close(); else { owner = null; statsRequest++; } }
  function sync() { if (dialog?.open && !current()) close(); }
  function configure(value) { options = value; }
  return {configure, open, close, sync};
})();
