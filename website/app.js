'use strict';

const translations = Array.from(document.querySelectorAll('[data-en]'), element => ({
  element, zh: element.innerHTML, en: element.dataset.en,
}));
const accessibleTranslations = Array.from(document.querySelectorAll('[data-en-aria], [data-en-alt]'), element => ({
  element, attribute: element.hasAttribute('data-en-aria') ? 'aria-label' : 'alt',
  zh: element.getAttribute(element.hasAttribute('data-en-aria') ? 'aria-label' : 'alt'),
  en: element.dataset.enAria || element.dataset.enAlt,
}));
const views = {
  writing: { src: './assets/writing.png', version: '0.6.0',
    zh: '长篇按卷章写作，短篇是一篇连续正文。', en: 'Volumes and chapters for novels; one continuous manuscript for short stories.',
    altZh: '长篇写作：卷章目录、正文编辑与 AI 对话栏', altEn: 'Novel writing with volumes, chapters, a manuscript and the AI chat panel' },
  outline: { src: './assets/outline.png', version: '0.3.1',
    zh: '连续阅读完整大纲，点击目录定位，关联正文章节。', en: 'Read the outline continuously, navigate by text and link it to chapters.',
    altZh: '连续大纲阅读与分类目录', altEn: 'Continuous outline reading with a categorized table of contents' },
  characters: { src: './assets/characters.png', version: '0.3.1',
    zh: '主题分图、人物分组与关系索引，让群像脉络清晰。', en: 'Theme maps, groups and relationship details keep an ensemble connected.',
    altZh: '人物主题分图、关系连线与人物档案', altEn: 'Character theme maps, relationship lines and a character profile' },
  night: { src: './assets/night.jpg', version: '0.4.11',
    zh: '白天、黑夜与护眼模式，照顾不同的写作时刻。', en: 'Light, dark and eye-comfort modes for different writing hours.',
    altZh: '夜间模式下的小说写作界面', altEn: 'Novel writing in night mode' },
};
const languageButton = document.querySelector('.language-switch');
const previewImage = document.querySelector('#preview-image');
const caption = document.querySelector('#preview-caption-text');
const versionCaption = document.querySelector('#preview-version');
const tabs = Array.from(document.querySelectorAll('[data-view]'));
const imageDialog = document.querySelector('.image-dialog');
const dialogImage = imageDialog.querySelector('img');
let language = 'zh';
let currentView = 'writing';
const starLinks = Array.from(document.querySelectorAll('[data-star-link]'));
const starCounts = Array.from(document.querySelectorAll('[data-star-count]'));
const STAR_CACHE_KEY = 'writer-desk-site-stars-v1';
const STAR_REFRESH_INTERVAL = 5 * 60 * 1000;
let starCount = null;
let starUpdatedAt = 0;
let starLastAttemptAt = 0;
let starRequestPending = false;

function renderStarCount() {
  const available = starCount !== null;
  const exactCount = available ? starCount.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : '';
  const shortCount = available ? new Intl.NumberFormat('en-US', {
    notation: starCount >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1,
  }).format(starCount) : '—';
  for (const element of starCounts) element.textContent = shortCount;
  for (const link of starLinks) {
    const label = language === 'en'
      ? `Star Writer's Desk on GitHub${available ? ` · ${exactCount} ${starCount === 1 ? 'star' : 'stars'}` : ''} (opens in a new tab)`
      : `在 GitHub 给作家工作台点 Star${available ? ` · ${exactCount} 个 Star` : ''}（新窗口）`;
    link.setAttribute('aria-label', label);
    link.title = label;
  }
}

function restoreStarCount() {
  try {
    const cached = JSON.parse(localStorage.getItem(STAR_CACHE_KEY));
    if (cached && Number.isSafeInteger(cached.count) && cached.count >= 0
      && Number.isFinite(cached.updatedAt) && cached.updatedAt > 0 && cached.updatedAt <= Date.now()) {
      starCount = cached.count;
      starUpdatedAt = cached.updatedAt;
      starLastAttemptAt = Number.isFinite(cached.checkedAt) && cached.checkedAt >= cached.updatedAt
        && cached.checkedAt <= Date.now() ? cached.checkedAt : cached.updatedAt;
    }
  } catch { /* Storage is optional; the public API can still be used. */ }
}

async function fetchStarData(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      credentials: 'omit', cache: 'no-cache', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error('Star count unavailable');
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function acceptStarCount(repository, count, updatedAt) {
  if (repository !== 'asoming/writer-desk' || !Number.isSafeInteger(count) || count < 0
    || !Number.isFinite(updatedAt) || updatedAt <= 0) throw new Error('Invalid star count');
  if (updatedAt >= starUpdatedAt) {
    starCount = count;
    starUpdatedAt = Math.min(updatedAt, Date.now());
    renderStarCount();
  }
}

async function refreshStarCount() {
  if (document.visibilityState !== 'visible' || starRequestPending
    || Date.now() - starLastAttemptAt < STAR_REFRESH_INTERVAL) return;
  starLastAttemptAt = Date.now();
  starRequestPending = true;
  try {
    try {
      const repository = await fetchStarData('https://api.github.com/repos/asoming/writer-desk');
      acceptStarCount(repository.full_name, repository.stargazers_count, Date.now());
    } catch {
      // The published snapshot keeps a first visit useful during public API rate limits.
      const snapshot = await fetchStarData('./github-stars.json');
      acceptStarCount(snapshot.repository, snapshot.count, snapshot.updatedAt);
    }
  } catch { /* Keep the last known count, or the placeholder if none is known. */ }
  finally {
    try {
      if (starCount !== null) localStorage.setItem(STAR_CACHE_KEY, JSON.stringify({
        count: starCount, updatedAt: starUpdatedAt, checkedAt: starLastAttemptAt,
      }));
    } catch { /* The count remains available for this visit. */ }
    starRequestPending = false;
  }
}

function updatePreview() {
  const view = views[currentView];
  previewImage.src = view.src;
  previewImage.alt = language === 'en' ? view.altEn : view.altZh;
  caption.textContent = view[language];
  versionCaption.textContent = `${language === 'en' ? 'Recorded interface' : '界面记录'} · v${view.version}`;
  document.querySelector('#preview-panel').setAttribute('aria-labelledby', `tab-${currentView}`);
  for (const tab of tabs) {
    const active = tab.dataset.view === currentView;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  if (imageDialog.open) {
    dialogImage.src = view.src;
    dialogImage.alt = previewImage.alt;
  }
}

function setLanguage(nextLanguage, updateAddress = false) {
  language = nextLanguage === 'en' ? 'en' : 'zh';
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.title = language === 'en' ? "Writer's Desk · A local writing studio" : "作家工作台 · Writer's Desk";
  for (const item of translations) {
    if (language === 'en') item.element.textContent = item.en;
    else item.element.innerHTML = item.zh;
  }
  for (const item of accessibleTranslations) item.element.setAttribute(item.attribute, item[language]);
  languageButton.textContent = language === 'en' ? '中文' : 'EN';
  languageButton.setAttribute('aria-label', language === 'en' ? '切换为中文' : 'Switch to English');
  for (const link of document.querySelectorAll('.guide-link')) {
    link.href = language === 'en'
      ? 'https://github.com/asoming/writer-desk/blob/main/README.en.md#start-writing'
      : 'https://github.com/asoming/writer-desk/blob/main/docs/quickstart-zh.md';
  }
  updatePreview();
  renderStarCount();
  try { localStorage.setItem('writer-desk-site-language', language); } catch { /* Optional preference only. */ }
  if (updateAddress) {
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    history.replaceState(null, '', url);
  }
}

languageButton.addEventListener('click', () => setLanguage(language === 'en' ? 'zh' : 'en', true));
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => { currentView = tab.dataset.view; updatePreview(); });
  tab.addEventListener('keydown', event => {
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    currentView = tabs[nextIndex].dataset.view;
    updatePreview();
    tabs[nextIndex].focus();
  });
}

document.querySelector('.preview-expand').addEventListener('click', () => {
  dialogImage.src = previewImage.src;
  dialogImage.alt = previewImage.alt;
  imageDialog.showModal();
  document.body.classList.add('dialog-open');
});
document.querySelector('.dialog-close').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('click', event => {
  if (event.target === imageDialog) {
    const bounds = imageDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) imageDialog.close();
  }
});
imageDialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));

let initialLanguage = new URLSearchParams(location.search).get('lang');
if (!['zh', 'en'].includes(initialLanguage)) {
  try { initialLanguage = localStorage.getItem('writer-desk-site-language'); } catch { /* Chinese remains the default. */ }
}
restoreStarCount();
setLanguage(initialLanguage);
void refreshStarCount();
setInterval(refreshStarCount, STAR_REFRESH_INTERVAL);
window.addEventListener('focus', refreshStarCount);
document.addEventListener('visibilitychange', refreshStarCount);
