'use strict';

async function navigateLibrarySearchResult(result){
  if(state.book?.id!==result.bookId)return false;
  if(result.type==='asset')return window.WriterAssetLibrary.show(result.id);
  if(result.type==='foreshadow'||result.type==='timeline')return window.WriterStoryTools.open(result.type==='foreshadow'?'foreshadows':'timeline',result.id);
  if(result.type==='note'){
    if(!state.book.notes.some(item=>item.id===result.id&&!item.deletedAt))return false;
    state.view='write';renderShell();toggleNotes(true);state.noteId=result.id;$('notes-filter').value='全部';renderNotes();return true;
  }
  const key=result.type==='outline'?'outline':result.type==='relation'?'relations':'notes';
  const item=state.book[key]?.find(item=>item.id===result.id&&!item.deletedAt);
  if(!item)return false;
  return jumpToOwner({type:result.type==='outline'?'outline':result.type==='relation'?'relation':'person',item});
}

function applyLivePurge(info){
  if(state.book!==info.book)return;
  state.seq++;
  if(info.replacementChapterId)state.chapterId=info.replacementChapterId;
  if(!info.unrelatedComposing)resetReviewAnchors();
  if(info.clean&&!info.unrelatedComposing){
    const chapter=currentChapter();if(chapter&&$('chapter-title').value!==chapter.title)$('chapter-title').value=chapter.title;
    $('book-name').textContent=state.book.title;$('short-story-title').textContent=state.book.title;document.title=state.book.title+T(' · 作家工作台');
  }
  if(info.removedCurrent){
    state.chapterId=null;$('editor').value='';$('editor').disabled=true;$('chapter-title').value='';$('chapter-title').disabled=true;
    if(!state.composing)selectChapter(activeChapters()[0]?.id);
  }else if(info.currentBodyChanged&&!info.unrelatedComposing){
    const chapter=currentChapter(),editor=$('editor'),top=$('writing-area').scrollTop,start=editor.selectionStart,end=editor.selectionEnd;
    if(chapter){editor.disabled=false;$('chapter-title').disabled=false;if($('chapter-title').value!==chapter.title)$('chapter-title').value=chapter.title;editor.value=chapter.body;editor.setSelectionRange(Math.min(start,editor.value.length),Math.min(end,editor.value.length));resizeEditor();$('writing-area').scrollTop=top;}
  }
  renderChapters();renderStats();if(!info.unrelatedComposing){renderBacklinks();if(state.view==='outline')renderOutline();else if(state.view==='people')renderPeople();}
  window.WriterEditorTools?.sync();
}
function applyLiveWholeBook(value){
  const bookId=typeof value==='string'?value:value.bookId;
  if(state.book?.id!==bookId)return;
  window.WriterEditorTools?.forcePurge(bookId,[],true);state.composing=false;
  if(typeof clearAIChatBookHistory==='function')clearAIChatBookHistory(bookId);
  if($('dialog').open)closeDialog();$('dialog-body').replaceChildren();
  clearBook();state.view='shelf';state.collection=null;exitFocus();renderShell();refreshBooks().then(renderShell).catch(()=>{});
}
function initializeWorkspaceExpansion(){
  window.WriterLiveSync?.configure({getBook:()=>state.book,getRevision:()=>state.revision,isDirty:()=>state.dirty,isSaving:()=>!!state.saving,
    normalizeBook:value=>{normalizeWorkspaceBook(value);normalizeShortManuscript(value);return value;},isComposing:()=>state.composing,getChapterId:()=>state.chapterId,getEditor:()=>$('editor'),getWritingArea:()=>$('writing-area'),api,
    forcePurge:(id,ids,whole)=>window.WriterEditorTools?.forcePurge(id,ids,whole),clearBookContent:(id,stamp)=>window.WriterContentCleanup.clear(id,stamp,true),clearAIChatBookHistory,markDirty,saveDraft,
    onApply:applyLivePurge,onWholeBook:applyLiveWholeBook,onRevision:(revision,info)=>{if(state.book?.id===info.bookId){state.revision=revision;if(info.safe){state.conflict=false;state.error=null;$('error-banner').hidden=true;if(state.dirty&&!state.composing){clearTimeout(state.timer);state.timer=setTimeout(saveNow,650);}}}},
    resetReviewAnchors,toast,setComposing:value=>{state.composing=value;}});
  window.WriterLiveSync?.start();
  window.WriterEditorTools.configure({getBook:()=>state.book,getChapterId:()=>state.chapterId,getRevision:()=>state.revision,
    getEditor:()=>$('editor'),getWritingArea:()=>$('writing-area'),getView:()=>state.view,
    isComposing:()=>state.composing,isTransitioning:()=>state.transitioning,
    setComposing:value=>{state.composing=value;},requireSaved,markDirty,saveNow,
    resetReviewAnchors,syncReviewAnchors,renderShell,renderChapters,renderStats,renderBacklinks,
    selectChapter,openBook,jumpToChapter,jumpToOwner,navigateSearchResult:navigateLibrarySearchResult,
    showWriting:()=>navigate('write'),api,showDialog,closeDialog,toast,T,uid,preference,resizeEditor,transition,saveStatus,
    acceptComparison:result=>setBook(result),
    extraActions:[{label:'素材库',run:()=>window.WriterAssetLibrary.show()}]});
  const tools=action('','icon-button',()=>window.WriterEditorTools.menu());
  tools.id='editor-tools';tools.setAttribute('aria-label',T('写作工具'));tools.title=T('写作工具');
  tools.append(el('span',null,'⋯'));$('book-search').before(tools);
  const search=action('','icon-button',()=>window.WriterEditorTools.showSearch());
  search.id='library-search';search.setAttribute('aria-label',T('全局搜索'));search.title=T('全局搜索');
  const icon=el('span');icon.dataset.icon='search';search.append(icon);$('theme-toggle').before(search);
  const sync=action(T('打开同步设置'),'secondary-button',()=>{closeAppSettings();window.SyncPanel.show();});
  $('settings-sync').append(sync);
  if(typeof initializeNetworkUpdates==='function')initializeNetworkUpdates();
}
