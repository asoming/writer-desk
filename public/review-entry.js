'use strict';

function showWritingReviewTools(){
  if(!state.book||state.composing||state.transitioning||!currentChapter())return;
  const actions=el('div','revision-shortcuts');
  for(const [label,run] of [
    ['本地校对',()=>window.LocalProofreading.show()],
    ['添加批注',()=>window.ManuscriptMarks.add('annotations')],
    ['添加书签',()=>window.ManuscriptMarks.add('bookmarks')],
    ['批注',()=>window.ManuscriptMarks.show('annotations')],
    ['书签',()=>window.ManuscriptMarks.show('bookmarks')]
  ])actions.append(action(T(label),'secondary-button',()=>{closeDialog();run();}));
  showDialog(T('校对与批注'),actions);
}

function initializeReviewTools(){
  window.ManuscriptMarks?.configure({getBook:()=>state.book,getChapterId:()=>state.chapterId,getEditor:()=>$('editor'),getWritingArea:()=>$('writing-area'),
    T,markDirty,saveNow,requireSaved,jumpToChapter,toast,showDialog,closeDialog,el,action,uid,
    setComposing:value=>{state.composing=value;},isComposing:()=>state.composing,isTransitioning:()=>state.transitioning});
  $('import-manuscript')?.addEventListener('click',()=>window.ManuscriptImport.show());
  $('writing-review')?.addEventListener('click',showWritingReviewTools);
  window.addEventListener('keydown',event=>{
    if(event.isComposing||state.composing||state.transitioning||!(event.ctrlKey||event.metaKey)||!event.shiftKey||event.altKey||state.view!=='write'||document.activeElement!==$('editor')||$('dialog').open||$('settings-dialog').open)return;
    const tab={m:'annotations',b:'bookmarks'}[event.key.toLowerCase()];if(!tab)return;
    event.preventDefault();window.ManuscriptMarks?.add(tab);
  });
}
