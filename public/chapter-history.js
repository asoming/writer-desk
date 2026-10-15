'use strict';

window.WriterChapterHistory=(()=>{
  let request=0;
  const hooks={beforePurge:null,afterPurge:null},pendingCopies=new Map();
  const path=record=>'/api/books/'+encodeURIComponent(record.bookId)+'/chapters/'+encodeURIComponent(record.chapterId);
  const visible=content=>$('dialog').open&&content.isConnected&&$('dialog-body').contains(content);
  const available=options=>typeof options.isCurrent!=='function'||options.isCurrent();

  function formatTime(value){
    if(!value||!Number.isFinite(new Date(value).getTime()))return T('时间未知');
    return new Date(value).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }

  function configure(options={}){
    hooks.beforePurge=typeof options.beforePurge==='function'?options.beforePurge:null;
    hooks.afterPurge=typeof options.afterPurge==='function'?options.afterPurge:null;
  }

  function validRecord(record){
    return record&&typeof record.bookId==='string'&&record.bookId&&typeof record.chapterId==='string'&&record.chapterId&&Number.isSafeInteger(record.revision)&&record.revision>0;
  }

  async function open(){
    if(state.transitioning||state.composing||!await requireSaved())return false;
    const sequence=++request,content=el('div','chapter-history-browser');
    content.append(el('p','empty-hint',T('正在读取历史记录…')));showDialog(T('历史记录'),content);
    const current=()=>sequence===request&&visible(content);
    try{
      const result=await api('/api/history/chapters');if(!current())return false;
      if(!Array.isArray(result.chapters)||result.chapters.some(record=>!validRecord(record)))throw new Error(T('历史记录无效，请重试。'));
      content.replaceChildren();
      if(state.book&&typeof showHistory==='function')content.append(action(T('历史版本与差异对比'),'secondary-button',()=>{if(current())showHistory(state.book.id);}));
      if(result.cleanupPendingBooks?.length||pendingCopies.size){const pending=el('div','chapter-history-pending');pending.append(el('p','dialog-description',T('部分备份或同步副本尚未清理完成，作家工作台会继续重试。')),action(T('重试'),'secondary-button',()=>retryCleanup(current)));content.append(pending);}
      if(!result.chapters.length){content.append(el('p','empty-hint',T('暂无删除的章节。')));return true;}
      const groups=new Map();
      result.chapters.forEach(record=>{if(!groups.has(record.bookId))groups.set(record.bookId,[]);groups.get(record.bookId).push(record);});
      for(const records of groups.values()){
        const group=el('section','chapter-history-group');group.append(el('h3',null,records[0].bookTitle||T('未命名作品')));
        records.forEach(record=>group.append(makeRow(record,current)));content.append(group);
      }
      return true;
    }catch(error){if(current())content.replaceChildren(el('p','dialog-description',error.message),action(T('重试'),'secondary-button',open));return false;}
  }

  async function retryCleanup(current){
    if(!current()||state.transitioning||state.composing)return false;
    const result=await transition(async()=>{
      if(!current()||!await requireSaved()||!current())return false;
      try{
        for(const [bookId,pending] of pendingCopies){if(!hooks.afterPurge)throw new Error(T('本机副本清理未完成，请重新启动作家工作台。'));await hooks.afterPurge(pending.record,pending.result);pendingCopies.delete(bookId);}
        await api('/api/history/chapters/cleanup','POST',{});return true;
      }catch(error){toast(error.message);return false;}
    });
    if(result&&current())await open();return result;
  }

  function makeRow(record,current){
    const row=el('div','chapter-history-row'),main=el('div','chapter-history-main'),text=el('div','chapter-history-copy'),buttons=el('div','chapter-history-actions');
    const preview=el('div','chapter-history-preview');preview.hidden=true;let previewRequest=0;
    const title=action(record.title||T('未命名章节'),'chapter-history-title',async()=>{
      if(!current())return;
      preview.hidden=!preview.hidden;title.setAttribute('aria-expanded',String(!preview.hidden));
      if(preview.hidden){previewRequest++;return;}
      const sequence=++previewRequest;preview.replaceChildren(el('p','empty-hint',T('正在读取正文…')));
      try{
        const snapshot=await api(path(record)+'/history');
        if(!current()||sequence!==previewRequest||preview.hidden||!row.isConnected)return;
        if(snapshot.bookId!==record.bookId||snapshot.chapter?.id!==record.chapterId||typeof snapshot.chapter.body!=='string')throw new Error(T('章节与目标不匹配，请刷新历史记录。'));
        const prose=el('textarea','text-field chapter-history-prose');prose.readOnly=true;prose.value=snapshot.chapter.body;prose.setAttribute('aria-label',T('已删除章节正文预览'));
        preview.replaceChildren(prose);
      }catch(error){if(current()&&sequence===previewRequest&&!preview.hidden)preview.replaceChildren(el('p','dialog-description',error.message));}
    });
    title.setAttribute('aria-expanded','false');text.append(title,el('small','chapter-history-date',T('删除于 {0}',formatTime(record.deletedAt))));
    if(record.bookDeleted)text.append(el('small','chapter-history-book-deleted',T('作品已在回收站，请先恢复作品。')));
    const restoreButton=action(T('恢复'),'secondary-button',()=>restore(record,{isCurrent:current}));restoreButton.disabled=record.canRestore===false||record.bookDeleted===true;
    buttons.append(restoreButton,action(T('彻底删除'),'text-button danger-button',()=>{if(current())confirmPurge(record);}));
    main.append(text,buttons);row.append(main,preview);return row;
  }

  function applyCurrent(result,record,captured){
    if(state.book!==captured.book||state.book?.id!==record.bookId||state.seq!==captured.seq)return false;
    const previous={view:state.view,collection:state.collection,chapterId:state.chapterId,outlineId:state.outlineId,personId:state.personId,noteId:state.noteId,volumeId:state.volumeId};
    setBook(result);state.view=previous.view;state.collection=previous.collection;
    if(state.book.chapters.some(item=>item.id===previous.chapterId&&!item.deletedAt))selectChapter(previous.chapterId);
    for(const [key,list] of [['outlineId','outline'],['personId','notes'],['noteId','notes'],['volumeId','volumes']])if(state.book[list]?.some(item=>item.id===previous[key]&&!item.deletedAt))state[key]=previous[key];
    return true;
  }

  async function mutate(record,operation,options){
    if(!validRecord(record)||!available(options)||state.transitioning||state.composing)return false;
    return transition(async()=>{
      if(!available(options)||!await requireSaved()||!available(options))return false;
      const captured={book:state.book,seq:state.seq},revision=state.book?.id===record.bookId?state.revision:record.revision;
      try{
        if(operation==='purge'&&hooks.beforePurge){await hooks.beforePurge(record);if(!available(options))return false;}
        const result=await api(path(record)+'/'+operation,'POST',{revision});
        if(result.book?.id!==record.bookId||!Number.isSafeInteger(result.revision)||result.revision<=revision)throw new Error(T('章节与目标不匹配，请刷新历史记录。'));
        if(operation==='purge'){
          if(!Array.isArray(result.removedChapterIds)||!result.removedChapterIds.includes(record.chapterId))throw new Error(T('章节与目标不匹配，请刷新历史记录。'));
        }
        const applied=applyCurrent(result,record,captured);let lateWarning=null,cleanupError=null;
        if(operation==='purge'&&!applied&&state.book?.id===record.bookId&&state.revision<result.revision){
          lateWarning=new Error(T('章节已删除，当前页面仍有旧稿，请重新打开作品后继续写作。'));lateWarning.conflict=true;state.error=lateWarning;state.conflict=true;state.dirty=true;
          clearTimeout(state.timer);if(typeof showError==='function')showError(lateWarning);if(typeof saveStatus==='function')saveStatus(T('需要另存副本'),true);
        }
        if(operation==='purge'&&hooks.afterPurge)try{await hooks.afterPurge(record,result);pendingCopies.delete(record.bookId);}catch(error){cleanupError=error;pendingCopies.set(record.bookId,{record,result});}
        try{await refreshBooks();}catch(error){toast(error.message);}renderShell();
        if(cleanupError)toast(cleanupError.message);
        else if(lateWarning)toast(lateWarning.message);
        else if(result.cleanupPending)toast(T('章节已删除，备份或同步清理尚未完成，请稍后重试。'));
        else if(result.cleanupWarning)toast(T(result.cleanupWarning));
        else toast(T(operation==='purge'?'章节已彻底删除。':'已恢复，原有关联也会保留。'));
        return true;
      }catch(error){toast(error.message);return false;}
    });
  }

  async function restore(record,options={}){
    if(record.canRestore===false||record.bookDeleted===true)return false;
    const result=await mutate(record,'restore',options);
    if(result&&available(options))await (options.onDone||open)();
    return result;
  }

  function confirmPurge(record,options={}){
    if(!validRecord(record)||!available(options)||state.transitioning||state.composing)return false;
    const content=el('div','chapter-history-confirm'),buttons=el('div','dialog-actions');
    const current=()=>visible(content)&&available(options);
    content.append(el('p','dialog-description',T('彻底删除「{0}」？',record.title||T('未命名章节'))),el('p','dialog-description',T('将从作家工作台的正文、历史版本与自动备份中移除，无法恢复；你另外导出的文件、系统备份不受此操作控制。')),el('p','dialog-description',T('本书的本机草稿、AI 对话及聊天图片也将清除。')));
    const confirm=action(T('彻底删除'),'primary-button danger-button',async()=>{
      if(confirm.disabled||!current())return;confirm.disabled=true;
      try{const result=await mutate(record,'purge',{isCurrent:current});if(result&&current())await (options.onDone||open)();}finally{confirm.disabled=false;}
    });
    buttons.append(action(T('取消'),'secondary-button',()=>{if(current())return (options.onCancel||open)();}),confirm);content.append(buttons);showDialog(T('彻底删除章节'),content);return true;
  }

  return{open,restore,confirmPurge,formatTime,configure};
})();
