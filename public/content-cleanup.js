'use strict';

// Purge receipts contain only IDs and timestamps. Replay before opening a book
// so a crash between a server purge and client cleanup cannot revive a draft.
window.WriterContentCleanup=(()=>{
  const marker=id=>'yejian.chapter-purge.'+id;
  function contentKey(key,bookId){
    if(key==='yejian.ai-chat.'+bookId+'.outline'||key==='yejian.ai-chat.'+bookId+'.write')return true;
    const prefix='yejian.draft.'+bookId+'.';
    if(!key.startsWith(prefix))return false;
    if(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key.slice(prefix.length)))return true;
    try{return JSON.parse(clientStorage.getItem(key))?.book?.id===bookId;}catch{return false;}
  }
  function clear(bookId,purgedAt){
    if(typeof bookId!=='string'||!bookId||typeof purgedAt!=='string'||!Number.isFinite(Date.parse(purgedAt)))throw new Error(T('章节清理记录无效。'));
    if(clientStorage.getItem(marker(bookId))===purgedAt)return;
    if(typeof clearAIChatBookHistory==='function')clearAIChatBookHistory(bookId);
    if(typeof clientStorage.clearBookContent==='function')clientStorage.clearBookContent(bookId,purgedAt);
    else{
      const keys=[];for(let i=0;i<(clientStorage.getLength?.()??clientStorage.length);i++){const key=clientStorage.key(i);if(typeof key==='string'&&contentKey(key,bookId))keys.push(key);}
      keys.forEach(key=>clientStorage.removeItem(key));clientStorage.setItem(marker(bookId),purgedAt);
    }
  }
  async function sync(){
    const result=await api('/api/history/chapter-purges');
    if(!Array.isArray(result.purges))throw new Error(T('章节清理记录无效。'));
    for(const item of result.purges)clear(item.bookId,item.purgedAt);
  }
  return{clear,sync};
})();
