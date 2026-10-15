'use strict';

// Keep ordinary scrolling in Chromium. Only an intentional, horizontal Mac
// trackpad stroke on a non-editable surface can return to the bookshelf.
(() => {
  const desktop = window.WriterDesktop;
  const isMac = desktop?.isDesktop === true && desktop.platform === 'darwin';
  let bound = false, stroke = null, returning = false, blockedUntil = 0;

  function canReturn() {
    return !!state.book && !['home', 'shelf'].includes(state.view) && !state.composing && !state.transitioning &&
      !document.hidden && !$('dialog')?.open && !$('settings-dialog')?.open;
  }

  function reservedSurface(target) {
    if (!target?.closest || target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="slider"],.graph-scroll,.panel-resize-handle,dialog')) return true;
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      // Horizontal lists and tables own their complete gesture, including their
      // boundary. Reaching the first item must not unexpectedly leave the book.
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  }

  async function returnToShelf() {
    if (returning || !canReturn()) return false;
    returning = true;
    try { return await showCollection('shelf', state.kind); }
    finally { returning = false; }
  }

  function onWheel(event) {
    const now = performance.now(), x = Number(event.deltaX), y = Number(event.deltaY);
    if (!canReturn() || event.ctrlKey || event.metaKey || event.altKey ||
        event.deltaMode !== 0 || !Number.isFinite(x) || !Number.isFinite(y) || x >= 0 ||
        Math.abs(x) > 90 || Math.abs(x) < Math.abs(y) * 3 || now < blockedUntil || reservedSurface(event.target)) {
      stroke = null; return;
    }
    if (!stroke || stroke.bookId !== state.book.id || stroke.view !== state.view || now - stroke.last > 180 || now - stroke.start > 700) stroke = { start: now, last: now, bookId: state.book.id, view: state.view, x: 0, y: 0, events: 0 };
    stroke.last = now; stroke.x -= x; stroke.y += Math.abs(y); stroke.events++;
    if (stroke.y > 45) { stroke = null; return; }
    if (stroke.x < 220 || stroke.events < 3) return;
    event.preventDefault();
    stroke = null; blockedUntil = now + 800;
    // showCollection uses the existing save gate. Never change Chromium history
    // or unload the writing document to implement a gesture.
    void returnToShelf();
  }

  function bind() {
    if (bound || !isMac) return;
    bound = true;
    document.body.classList.add('desktop-mac');
    const controls = $('window-controls'); if (controls) controls.hidden = true;
    $('workspace')?.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', event => {
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '[' && !event.isComposing && canReturn()) {
        event.preventDefault(); void returnToShelf();
      }
    });
    window.addEventListener('blur', () => { stroke = null; });
  }

  window.WriterGestures = Object.freeze({ bind, returnToShelf });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
