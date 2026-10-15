'use strict';
(function(global){
  const copy=value=>JSON.parse(JSON.stringify(value));
  function equal(a,b){
    if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(key=>Object.prototype.hasOwnProperty.call(b,key)&&equal(a[key],b[key]));
  }
  // Keep live editor owners and untouched chapters intact. Replacing the whole
  // book would detach input handlers and reset an unrelated composition/undo.
  function patchInPlace(target,source){
    if(equal(target,source))return target;
    if(Array.isArray(target)&&Array.isArray(source)){
      const keyed=source.every(item=>item&&typeof item.id==='string')&&target.every(item=>item&&typeof item.id==='string');
      const owners=keyed?new Map(target.map(item=>[item.id,item])):null;
      const next=source.map((item,index)=>{const old=owners?owners.get(item.id):target[index];return old&&item&&typeof old==='object'&&typeof item==='object'&&Array.isArray(old)===Array.isArray(item)?patchInPlace(old,item):copy(item);});
      target.splice(0,target.length,...next);return target;
    }
    for(const key of Object.keys(target))if(!Object.prototype.hasOwnProperty.call(source,key))delete target[key];
    for(const [key,value]of Object.entries(source)){const old=target[key];target[key]=old&&value&&typeof old==='object'&&typeof value==='object'&&Array.isArray(old)===Array.isArray(value)?patchInPlace(old,value):value&&typeof value==='object'?copy(value):value;}
    return target;
  }
  function normalizeReceipts(result){
    if(!result||!Array.isArray(result.purges)||result.purges.length>10000)throw Error('Invalid purge receipts');
    return result.purges.map(row=>{
      if(!row||typeof row.bookId!=='string'||!row.bookId||row.bookId.length>200||typeof row.purgedAt!=='string'||!Number.isFinite(Date.parse(row.purgedAt))||!Array.isArray(row.chapterIds)||row.chapterIds.length>10000||row.chapterIds.some(id=>typeof id!=='string'||!id||id.length>200)||typeof row.permanentlyDeleted!=='boolean')throw Error('Invalid purge receipt');
      return{bookId:row.bookId,chapterIds:[...new Set(row.chapterIds)],purgedAt:row.purgedAt,permanentlyDeleted:row.permanentlyDeleted};
    });
  }
  function createController(environment={}){
    let hooks={},pending=null,timer=null,applying=false,started=false,stopped=false;
    const host=environment.window||global,doc=environment.document||host.document,records=new Map(),bases=new Map(),composing=new Set(),quarantined=new Set(),guardedControls=new WeakSet();
    const model=()=>environment.purgeModel||host.MobilePurge;
    const book=()=>hooks.getBook?.(),dirty=()=>!!hooks.isDirty?.()||!!hooks.isComposing?.();
    function signature(record){return JSON.stringify([record.purgedAt,record.whole,[...record.ids].sort()]);}
    function clear(record){
      try{hooks.clearAIChatBookHistory?.(record.id);hooks.clearBookContent?.(record.id,record.purgedAt,true);record.cleared=signature(record);return true;}
      catch(error){record.cleared=null;hooks.onError?.(error);return false;}
    }
    function unsafe(value,record){
      if(record.whole)return true;const ids=record.ids;
      if((value.chapters||[]).some(item=>ids.has(item.id))||(value.shortSections||[]).some(item=>ids.has(item.id)))return true;
      const owners=['outline','notes','relations'].flatMap(key=>value[key]||[]).concat(value.storyTools?.foreshadows||[],value.storyTools?.timeline||[],value.assetLibrary?.items||[]);
      return owners.some(item=>(item.chapterIds||[]).some(id=>ids.has(id)))||(value.storyMemory?.entries||[]).some(item=>ids.has(item.chapterId))||['annotations','bookmarks'].some(key=>(value.reviewTools?.[key]||[]).some(item=>ids.has(item.chapterId)));
    }
    function sanitize(value,record,remote=null){
      const before=new Set((value.chapters||[]).map(item=>item.id)),clean=model().sanitize(value,[...record.ids],remote);
      if(value.kind==='short'&&!remote)for(const item of clean.chapters||[])if(!before.has(item.id))record.generated.add(item.id);
      return clean;
    }
    function alignGenerated(value,record,remote){
      if(value.kind!=='short'||!record.generated.size)return value;
      const target=remote?.chapters?.find(item=>!item.deletedAt&&!record.ids.has(item.id)),owner=value.chapters.find(item=>!item.deletedAt&&record.generated.has(item.id));
      if(!target||!owner||owner.id===target.id||value.chapters.some(item=>item!==owner&&item.id===target.id))return value;
      const old=owner.id;owner.id=target.id;
      for(const item of ['outline','notes','relations'].flatMap(key=>value[key]||[]).concat(value.storyTools?.foreshadows||[],value.storyTools?.timeline||[],value.assetLibrary?.items||[]))if(item.chapterIds)item.chapterIds=[...new Set(item.chapterIds.map(id=>id===old?target.id:id))];
      for(const key of ['annotations','bookmarks'])for(const item of value.reviewTools?.[key]||[])if(item.chapterId===old)item.chapterId=target.id;
      for(const item of value.storyMemory?.entries||[])if(item.chapterId===old)item.chapterId=target.id;
      return value;
    }
    function cancelPrimary(){
      const editor=hooks.getEditor?.(),title=hooks.getChapterTitle?.()||doc?.getElementById?.('chapter-title'),controls=[editor,title].filter(Boolean);
      const active=doc?.activeElement,ownComposition=controls.some(control=>composing.has(control))||!!hooks.isPrimaryComposing?.()||!!hooks.isComposing?.()&&controls.includes(active);
      for(const control of controls){quarantined.add(control);if(!guardedControls.has(control)){control.addEventListener?.('input',event=>{if(quarantined.has(control))event.stopImmediatePropagation();},true);control.addEventListener?.('focus',()=>quarantined.delete(control),true);guardedControls.add(control);}}
      // Book state has already been scrubbed. Any blur/compositionend event can
      // only see the replacement owner, never the removed chapter.
      for(const control of controls){control.value='';control.disabled=true;composing.delete(control);if(control===active)control.blur?.();}
      if(ownComposition)hooks.setComposing?.(false);
    }
    function applyCurrent(record,{remote=null,clean=false,revision=null,force=false}={}){
      const owner=book();if(!owner||owner.id!==record.id)return false;
      if(record.whole){
        (hooks.forcePurge||host.WriterEditorTools?.forcePurge)?.(record.id,null,true);cancelPrimary();hooks.setComposing?.(false);hooks.onWholeBook?.(record.id);return true;
      }
      if(!force&&!unsafe(owner,record))return false;
      const currentId=hooks.getChapterId?.(),before=owner.chapters?.find(item=>item.id===currentId),beforeBody=before?.body,hadDirty=dirty();
      let next=clean&&remote?copy(remote):sanitize(owner,record,remote);if(remote)next=alignGenerated(next,record,remote);
      const after=next.chapters?.find(item=>item.id===currentId),replacement=before&&record.generated.has(currentId)&&!after?next.chapters?.find(item=>!item.deletedAt&&!record.ids.has(item.id)):null;
      const removedCurrent=!!before&&!after&&!replacement,currentBodyChanged=!!before&&(after||replacement)?.body!==beforeBody;
      const changed=!equal(owner,next);patchInPlace(owner,next);
      (hooks.forcePurge||host.WriterEditorTools?.forcePurge)?.(record.id,[...record.ids],false);
      if(removedCurrent||currentBodyChanged)cancelPrimary();
      if(changed||removedCurrent||replacement)hooks.onApply?.({book:owner,bookId:record.id,affectedChapterIds:[...record.ids],removedCurrent,currentBodyChanged,replacementChapterId:replacement?.id||null,unrelatedComposing:!!hooks.isComposing?.(),remote,clean,revision,preservedDirty:hadDirty});
      if(hadDirty&&book()===owner)hooks.saveDraft?.();
      return changed;
    }
    function consume(result){
      const rows=normalizeReceipts(result);let changed=false;
      applying=true;
      try{for(const row of rows){
        let record=records.get(row.bookId);if(!record){record={id:row.bookId,ids:new Set(),whole:false,purgedAt:row.purgedAt,generated:new Set(),cleared:null,reconcile:false};records.set(row.bookId,record);}
        const previous=signature(record);row.chapterIds.forEach(id=>record.ids.add(id));record.whole||=row.permanentlyDeleted;if(Date.parse(row.purgedAt)>Date.parse(record.purgedAt))record.purgedAt=row.purgedAt;
        const fresh=previous!==signature(record)||record.cleared===null;if(!fresh)continue;
        changed=true;clear(record);record.reconcile=!record.whole;
        const base=bases.get(record.id);if(base){if(record.whole)bases.delete(record.id);else base.book=sanitize(base.book,record);}
        applyCurrent(record,{force:true});
      }}finally{applying=false;}
      return changed;
    }
    function guardBeforeDirty(){
      const owner=book();if(!owner)return false;if(applying)return !records.get(owner.id)?.whole;
      const record=records.get(owner.id);if(!record)return true;
      if(record.whole||unsafe(owner,record)){
        applying=true;try{clear(record);applyCurrent(record,{force:true});}finally{applying=false;}
      }
      return book()===owner&&!record.whole;
    }
    function loaded(value,revision){
      if(!value||typeof value.id!=='string')return;for(const id of bases.keys())if(id!==value.id)bases.delete(id);const record=records.get(value.id);
      if(record){applying=true;try{if(record.whole||unsafe(value,record)){clear(record);applyCurrent(record,{force:true});}}finally{applying=false;}}
      if(record?.whole)return;bases.set(value.id,{book:copy(value),revision});if(record)record.reconcile=true;
    }
    function saved(value,revision){
      if(!value||typeof value.id!=='string'||records.get(value.id)?.whole)return;
      const record=records.get(value.id),clean=record?sanitize(value,record):copy(value);bases.set(value.id,{book:clean,revision});
    }
    async function reconcile(){
      const owner=book(),record=owner&&records.get(owner.id);if(!record||record.whole||!record.reconcile||hooks.isSaving?.())return;
      const startRevision=hooks.getRevision?.(),base=bases.get(owner.id),response=await hooks.api('/api/books/'+encodeURIComponent(owner.id));
      if(stopped||book()!==owner||hooks.getRevision?.()!==startRevision||hooks.isSaving?.())return;
      if(!response?.book||response.book.id!==owner.id||!Number.isInteger(response.revision)||response.revision<startRevision)throw Error('Invalid synchronized book');
      const remote=sanitize(response.book,record,response.book);hooks.normalizeBook?.(remote);
      const active=dirty(),proof=base&&equal(alignGenerated(sanitize(base.book,record,remote),record,remote),remote);
      applying=true;
      try{
        if(!active){applyCurrent(record,{remote,clean:true,revision:response.revision,force:true});hooks.onRevision?.(response.revision,{bookId:owner.id,preservedDirty:false,safe:true});bases.set(owner.id,{book:copy(remote),revision:response.revision});}
        else if(proof){applyCurrent(record,{remote,force:true});hooks.onRevision?.(response.revision,{bookId:owner.id,preservedDirty:true,safe:true});bases.set(owner.id,{book:copy(remote),revision:response.revision});if(book()===owner)hooks.saveDraft?.();}
        else{applyCurrent(record,{force:true});hooks.onConflict?.({bookId:owner.id,revision:response.revision,preservedDirty:true});}
        record.reconcile=false;
      }finally{applying=false;}
    }
    function refresh(){
      if(pending)return pending;stopped=false;
      pending=(async()=>{const result=await hooks.api('/api/sync/purge-receipts');if(stopped)return;consume(result);await reconcile();return result;})().finally(()=>{pending=null;});return pending;
    }
    function quietRefresh(){refresh().catch(error=>hooks.onError?.(error));}
    const onCompositionStart=event=>composing.add(event.target),onCompositionEnd=event=>composing.delete(event.target);
    const onVisible=()=>{if(!doc||doc.visibilityState!=='hidden')quietRefresh();};
    function start(){if(started)return;started=true;stopped=false;timer=(environment.setInterval||host.setInterval)(quietRefresh,3000);timer?.unref?.();doc?.addEventListener?.('visibilitychange',onVisible);doc?.addEventListener?.('compositionstart',onCompositionStart,true);doc?.addEventListener?.('compositionend',onCompositionEnd,true);host.addEventListener?.('focus',onVisible);quietRefresh();}
    function stop(){started=false;stopped=true;if(timer!==null)(environment.clearInterval||host.clearInterval)(timer);timer=null;doc?.removeEventListener?.('visibilitychange',onVisible);doc?.removeEventListener?.('compositionstart',onCompositionStart,true);doc?.removeEventListener?.('compositionend',onCompositionEnd,true);host.removeEventListener?.('focus',onVisible);composing.clear();quarantined.clear();}
    function configure(options){hooks=options;return controller;}
    const controller={configure,loaded,saved,guardBeforeDirty,refresh,start,stop,consume};return controller;
  }
  if(typeof module==='object'&&module.exports)module.exports={createController,patchInPlace,normalizeReceipts};else global.WriterLiveSync=createController();
})(typeof window==='undefined'?globalThis:window);
