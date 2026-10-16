'use strict';
const $=id=>document.getElementById(id);
const state={book:null,revision:0,chapterId:null,noteId:null,dirty:false,seq:0,saving:null,timer:null,error:null,conflict:false,composing:false,transitioning:false,fontSize:19,kind:"long",view:"home",books:[],trashBookCount:0,outlineId:null,personId:null,trail:null,folderWarning:null,protectionWarning:null};
const activeChapters=()=>state.book?.chapters.filter(c=>!c.deletedAt)||[];
const currentChapter=()=>state.book?.chapters.find(c=>c.id===state.chapterId);
const currentNote=()=>state.book?.notes.find(n=>n.id===state.noteId&&!n.deletedAt);
const count=text=>Array.from(text).filter(c=>!/\s/u.test(c)).length;
const clone=value=>JSON.parse(JSON.stringify(value));
const uid=()=>crypto.randomUUID();
let reviewAnchorBook=null,reviewAnchorBodies=new Map();
function resetReviewAnchors(){
  reviewAnchorBook=state.book;reviewAnchorBodies=new Map((state.book?.chapters||[]).map(chapter=>[chapter.id,chapter.body]));
  if(state.book)window.ManuscriptMarks?.normalize(state.book);
  window.ManuscriptMarks?.sync();
}
function syncReviewAnchors(){
  if(!state.book||state.composing)return;
  if(reviewAnchorBook!==state.book){resetReviewAnchors();return;}
  for(const chapter of state.book.chapters){const before=reviewAnchorBodies.get(chapter.id);if(before!==undefined&&before!==chapter.body)window.ManuscriptMarks?.reanchorChapter(chapter.id,before,chapter.body,state.book);reviewAnchorBodies.set(chapter.id,chapter.body);}
  const present=new Set(state.book.chapters.map(chapter=>chapter.id));for(const id of reviewAnchorBodies.keys())if(!present.has(id))reviewAnchorBodies.delete(id);
  window.ManuscriptMarks?.sync();
}
function normalizeShortManuscript(book){
  if(book.kind!=='short')return{manuscript:null,changed:false};
  const active=book.chapters.filter(chapter=>!chapter.deletedAt);
  let changed=false;
  if(!active.length){
    const prefix=book.id.slice(0,70)+'-manuscript',ids=new Set(book.chapters.map(chapter=>chapter.id));let id=prefix,suffix=1;
    while(ids.has(id))id=prefix+'-'+suffix++;
    const manuscript={id,title:'正文',body:'',volumeId:null,deletedAt:null};book.chapters.push(manuscript);
    active.push(manuscript);changed=true;
  }
  const manuscript=active[0],previous=Array.isArray(book.shortSections)?book.shortSections:[],previousOwner=active.find(chapter=>chapter.id===previous[0]?.id)||manuscript,sections=[],ids=new Set(active.map(chapter=>chapter.id)),recycled=new Set(book.chapters.filter(chapter=>chapter.deletedAt).map(chapter=>chapter.id)),reviewOffsets={};let offset=0;
  active.forEach((chapter,index)=>{
    if(index)offset+=2;
    reviewOffsets[chapter.id]=offset;
    if(chapter===previousOwner)previous.forEach(section=>{reviewOffsets[section.id]??=offset+Math.min(section.start,chapter.body.length);});
    if(chapter===previousOwner&&previous.length)previous.forEach(section=>sections.push({...section,start:offset+Math.min(section.start,chapter.body.length),end:offset+Math.min(section.end,chapter.body.length)}));
    else if(active.length>1)sections.push({id:chapter.id,title:chapter.title,start:offset,end:offset+chapter.body.length});
    offset+=chapter.body.length;
  });
  if(active.length>1){manuscript.body=active.map(chapter=>chapter.body).join('\n\n');book.chapters=book.chapters.filter(chapter=>chapter===manuscript||chapter.deletedAt);changed=true;}
  if(manuscript.volumeId!==null){manuscript.volumeId=null;changed=true;}
  const seen=new Set(),unique=sections.filter(section=>{if(seen.has(section.id))return false;seen.add(section.id);return true;});
  if(JSON.stringify(previous)!==JSON.stringify(unique)){if(unique.length)book.shortSections=unique;else delete book.shortSections;changed=true;}
  unique.forEach(section=>ids.add(section.id));
  for(const owner of ['notes','outline','relations'].flatMap(key=>book[key]||[]).concat(book.assetLibrary?.items||[])){
    const old=owner.chapterIds||[],mapped=[...new Set(old.map(id=>ids.has(id)&&!recycled.has(id)?manuscript.id:id))];
    if(old.length!==mapped.length||old.some((id,index)=>id!==mapped[index])){owner.chapterIds=mapped;changed=true;}
  }
  window.ManuscriptMarks?.remapShortLinks(book,ids,manuscript.id,recycled,reviewOffsets);
  return{manuscript,changed};
}
function resolveShortManuscriptId(id,book=state.book){
  if(book?.kind!=='short'||book.chapters.some(c=>c.id===id))return id;
  return book.shortSections?.some(section=>section.id===id)?book.chapters.find(c=>!c.deletedAt)?.id||id:id;
}
function ensureShortManuscript(){
  if(state.book?.kind!=='short')return null;
  const result=normalizeShortManuscript(state.book);
  if(result.changed){state.chapterId=result.manuscript.id;markDirty();}
  return result.manuscript;
}
let toastTimer;
const draftOwner=crypto.randomUUID();
let previousDraftOwner=null;
try{previousDraftOwner=sessionStorage.getItem('yejian.draft-owner');sessionStorage.setItem('yejian.draft-owner',draftOwner);}catch{}
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function action(text,className,handler){const b=el('button',className,text);b.type='button';b.addEventListener('click',handler);return b;}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3200);}
function preference(key,value){try{if(value!==undefined)clientStorage.setItem(key,value);else return clientStorage.getItem(key);}catch{}return null;}
function safeDraft(id){
  try{const prefix='yejian.draft.'+id+'.',drafts=[];
    for(let i=0;i<(clientStorage.getLength?.()??clientStorage.length);i++){const key=clientStorage.key(i);if(!key.startsWith(prefix))continue;try{const d=JSON.parse(clientStorage.getItem(key));if(d?.book)drafts.push({...d,key,own:key===prefix+previousDraftOwner});}catch{}}
    drafts.sort((a,b)=>Number(b.own)-Number(a.own)||(b.savedAt||'').localeCompare(a.savedAt||''));return drafts[0]||null;
  }catch{return null;}
}
function saveDraft(){if(window.WriterLiveSync?.guardBeforeDirty()===false||!state.book)return;try{clientStorage.setItem('yejian.draft.'+state.book.id+'.'+draftOwner,JSON.stringify({book:state.book,revision:state.revision,savedAt:new Date().toISOString()}));}catch{/* SQLite remains authoritative. */}}
function removeDraft(id,key){try{clientStorage.removeItem(key||'yejian.draft.'+id+'.'+draftOwner);}catch{}}
async function transition(task){
  if(state.transitioning)return false;if(state.composing){toast(T('请先完成当前输入。'));return false;}
  state.transitioning=true;$('workspace').inert=true;$('dialog').inert=true;const settingsDialog=$('settings-dialog');if(settingsDialog)settingsDialog.inert=true;$('workspace').setAttribute('aria-busy','true');
  try{return await task();}finally{state.transitioning=false;$('workspace').inert=false;$('dialog').inert=false;if(settingsDialog)settingsDialog.inert=false;$('workspace').setAttribute('aria-busy','false');}
}
async function api(path,method='GET',data){
  let r;try{r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Writer-Client':'1'},body:data===undefined?undefined:JSON.stringify(data)});}catch{throw new Error(T('无法连接本机保存服务。请重新启动作家工作台，或先下载本页备份。'));}
  const v=await r.json();if(!r.ok)throw Object.assign(new Error(T(v.error||'暂时无法完成操作')),{conflict:!!v.conflict,deleted:!!v.deleted});return v;
}
function saveStatus(text,error=false){$('save-status').textContent=text;$('save-status').classList.toggle('error',error);}
function showError(error){$('error-message').textContent=error.message;$('error-banner').hidden=false;$('retry-save').hidden=!!error.conflict;$('rescue-copy').hidden=!error.conflict;}
function markDirty(reason='edit'){if(window.WriterLiveSync?.guardBeforeDirty()===false||!state.book)return;window.WriterEditorTools?.canonicalChanged();syncReviewAnchors();state.saveReason=reason==='restore'||(state.dirty&&state.saveReason==='restore')?'restore':reason==='structure'&&(!state.dirty||state.saveReason==='structure')?'structure':'edit';state.dirty=true;state.seq++;saveStatus(state.conflict?T('需要另存副本'):T('待保存'),state.conflict);saveDraft();clearTimeout(state.timer);if(!state.composing&&!state.conflict)state.timer=setTimeout(()=>saveNow(),650);renderStats();}
async function saveNow(){
  if(window.WriterEditorTools&&!await window.WriterEditorTools.flushDrafts())return false;
  clearTimeout(state.timer);if(window.WriterLiveSync?.guardBeforeDirty()===false||!state.book)return true;if(state.composing)return false;
  if(state.saving){await state.saving;if(state.dirty&&!state.error)return saveNow();return !state.error;}
  if(!state.dirty)return true;if(state.conflict)return false;
  syncReviewAnchors();
  const owner=state.book,requestRevision=state.revision,seq=state.seq,payload=clone(state.book),saveReason=['restore','structure'].includes(state.saveReason)?state.saveReason:'edit';saveStatus(T('正在保存…'));
  state.saving=(async()=>{try{
    const r=await api('/api/books/'+payload.id,'PUT',{book:payload,revision:requestRevision,saveReason});if(state.book!==owner)return true;if(r.revision>=state.revision){state.revision=r.revision;window.WriterLiveSync?.saved(payload,r.revision);}
    if(state.seq===seq){state.dirty=false;removeDraft(payload.id);}else saveDraft();
    state.error=null;$('error-banner').hidden=true;saveStatus(state.dirty?T('待保存'):T('已保存'));if(r.folderWarning&&r.folderWarning!==state.folderWarning)toast(T(r.folderWarning));state.folderWarning=r.folderWarning||null;if(r.protectionWarning&&r.protectionWarning!==state.protectionWarning)toast(T(r.protectionWarning));state.protectionWarning=r.protectionWarning||null;return true;
  }catch(error){if(state.book!==owner)return true;if(error.conflict&&state.revision>requestRevision)return true;state.error=error;state.conflict=!!error.conflict;saveDraft();saveStatus(T('保存未完成'),true);showError(error);return false;}})();
  const result=await state.saving;state.saving=null;if(result&&state.dirty)return saveNow();if(result&&state.view==='write')renderBacklinks();return result;
}
async function requireSaved(){if(await saveNow())return true;if(state.error?.deleted)showTrashedBookNotice();else toast(T('本页还有未保存的内容，请先重试或下载备份。'));return false;}
function showTrashedBookNotice(){
  if(!state.book)return;const book=state.book,body=el('div'),buttons=el('div','dialog-actions');body.append(el('p','dialog-description',T('原作品已回收或删除。本页内容仍保留，可另存新作品或下载备份。')));
  buttons.append(action(T('下载本页备份'),'secondary-button',()=>downloadBackup(book)),action(T('另存为新作品'),'primary-button',async()=>{if(state.book!==book)return;await rescueCopy();if(state.book!==book)closeDialog();}),action(T('保留草稿并返回书架'),'secondary-button',()=>transition(async()=>{
    if(state.book!==book)return false;saveDraft();try{const draft=JSON.parse(clientStorage.getItem('yejian.draft.'+book.id+'.'+draftOwner));if(!draft?.book||JSON.stringify(draft.book)!==JSON.stringify(book)||draft.revision!==state.revision)throw new Error();}catch{toast(T('无法保留本机草稿，请先下载完整备份或另存为新作品。'));return false;}
    clearBook();state.view='shelf';state.collection=null;closeDialog();try{await refreshBooks();}catch(error){toast(error.message);}renderShell();toast(T('草稿已保留在本机，可另存为新作品。'));return true;
  })));body.append(buttons);showDialog(T('原作品无法保存'),body);
}
function renderStats(){
  renderTrashCount();
  const reminder=$('foreshadow-reminder'),unresolved=(state.book?.storyTools?.foreshadows||[]).filter(item=>item.status!=='resolved').length;
  if(reminder){reminder.hidden=!unresolved;reminder.textContent=String(unresolved);$('story-tools').title=unresolved?T('创作工具 · {0} 条伏笔未回收',unresolved):T('创作工具');}
  if(!state.book)return;const chapters=activeChapters(),total=chapters.reduce((sum,c)=>sum+count(c.body),0);
  $('chapter-stats').textContent=T`${count(currentChapter()?.body||'').toLocaleString()} 字`;
  $('total-stats').textContent=T`${state.kind==='short'?T('全文'):T('全书')} ${total.toLocaleString()} 字`;
  $('total-stats').hidden=state.kind==='short';
  $('book-total-words').textContent=T('总字数 {0} 字',total.toLocaleString());
  $('chapter-stats').title=T('按字符计数，包含标点和英文字母，不计空格与换行');
  $('chapter-list').querySelectorAll('[data-chapter]').forEach(row=>{const c=chapters.find(c=>c.id===row.dataset.chapter);const n=row.querySelector('.chapter-item-count');if(c&&n)n.textContent=c.body?T`${count(c.body).toLocaleString()} 字`:T('尚未动笔');});
}
function renderTrashCount(){const n=(state.trashBookCount||0)+['chapters','notes','outline','relations','volumes'].flatMap(key=>state.book?.[key]||[]).filter(item=>item.deletedAt).length;$('trash-count').textContent=n?`(${n})`:'';}

function renderChapters(){renderVolumeChapters();}

function resizeEditor(){if(state.view!=='write'||!state.book)return;window.WriterEditorLayout.resize($('editor'),$('writing-area'));window.WriterEditorTools?.resize();}
function closeSidebar(){$('workspace').classList.remove('sidebar-mobile-open');$('sidebar-backdrop').hidden=true;}
function selectChapter(id){
  if(window.WriterEditorTools?.beforeChapter(id)===false)return;
  if(state.composing)return;if(state.kind==='short')id=ensureShortManuscript()?.id;const c=activeChapters().find(c=>c.id===id);state.chapterId=c?.id||null;if(typeof syncAIChat==='function')syncAIChat();if(c){state.collapsedVolumes?.delete(c.volumeId);const query=$('chapter-search').value.trim().toLocaleLowerCase();if(query&&!(c.title+' '+c.body).toLocaleLowerCase().includes(query))$('chapter-search').value='';}
  const short=state.kind==='short';$('chapter-title').hidden=short;$('chapter-number').hidden=short;$('chapter-tools').hidden=short;$('short-story-title').hidden=!short;$('short-story-title').textContent=state.book?.title||'';$('backlinks-label').textContent=short?T('正文关联'):T('本章关联');$('editor').setAttribute('aria-label',short?T('正文'):T('章节正文'));
  $('editor-empty').hidden=!!c;$('manuscript').hidden=!c;$('chapter-volume-control').hidden=!c||state.kind==='short';
  $('link-current-chapter').disabled=!c;$('backlinks-edit').disabled=!c;$('toggle-focus').hidden=state.view!=='write'||!c;
  if(!c){$('chapter-title').value='';$('editor').value='';$('chapter-title').disabled=true;$('editor').disabled=true;renderChapters();renderStats();renderBacklinks();window.WriterEditorTools?.sync();return;}
  $('chapter-title').disabled=false;$('editor').disabled=false;state.volumeId=c.volumeId||null;preference('yejian.chapter.'+state.book.id,c.id);
  $('chapter-title').value=c.title;$('editor').value=c.body;const list=activeChapters().filter(x=>x.volumeId===c.volumeId),index=list.findIndex(x=>x.id===id),volume=activeVolumes().find(v=>v.id===c.volumeId);
  $('chapter-number').textContent=(volume?volume.title+' · ':'')+T('章节')+' '+String(index+1).padStart(2,'0');
  $('move-up').disabled=index<=0;$('move-down').disabled=index===list.length-1;$('trash-chapter').disabled=false;
  renderChapterVolumeSelect();renderChapters();renderStats();renderBacklinks();resizeEditor();$('writing-area').scrollTop=0;requestAnimationFrame(()=>{Array.from($('chapter-list').querySelectorAll('[data-chapter]')).find(row=>row.dataset.chapter===state.chapterId)?.scrollIntoView({block:'nearest'});});closeSidebar();window.WriterEditorTools?.sync();
}

function setBook(r){
  if(window.WriterEditorTools?.beforeSwitch()===false)return false;
  state.protectionWarning=null;
  clearTimeout(state.timer);state.book=r.book;normalizeWorkspaceBook(state.book);normalizeShortManuscript(state.book);state.kind=state.book.kind;state.revision=r.revision;state.seq=0;state.dirty=false;state.saveReason='edit';state.error=null;state.conflict=false;state.noteId=null;state.trail=null;state.collection=null;state.analysis=null;state.analysisSeq=-1;state.folderWarning=null;state.graphZoom=null;state.graphVolume='';state.graphGroup='';state.graphScope='all';state.atlasView='core';state.atlasMode='graph';state.atlasFocusId=null;state.personEditing=false;state.graphRelationType='';state.atlasLayoutKey=null;state.outlineCategory='all';state.outlineVolumeFilter='';state.outlineKindFilter='';state.showAutomatic=false;state.collapsedVolumes=new Set(activeVolumes().map(v=>v.id));$('chapter-search').value='';$('outline-search').value='';$('person-search').value='';$('relation-search').value='';$('relation-type-filter').value='manual';
  resetReviewAnchors();state.outlineId=activeOutline()[0]?.id||null;state.personId=people()[0]?.id||null;state.volumeId=activeVolumes()[0]?.id||null;
  $('error-banner').hidden=true;$('book-name').textContent=state.book.title;
  preference('yejian.last-book',state.book.id);preference('yejian.last-book.'+state.kind,state.book.id);preference('yejian.kind',state.kind);
  if(r.protectionWarning){state.protectionWarning=r.protectionWarning;toast(T(r.protectionWarning));}
  const old=preference('yejian.chapter.'+state.book.id);selectChapter(activeChapters().some(c=>c.id===old)?old:activeChapters()[0]?.id);renderNotes();saveStatus(T('已保存'));document.title=state.book.title+T(' · 作家工作台');renderShell();window.WriterLiveSync?.loaded(state.book,state.revision);
}

async function openBook(id,target='outline'){return await transition(async()=>{if(!await requireSaved())return false;try{await window.WriterContentCleanup?.sync();setBook(await api('/api/books/'+id));state.view=target;state.collection=null;closeDialog();closeNav();await refreshBooks();renderShell();await recoverDraft();return true;}catch(e){toast(e.message);return false;}});}

async function recoverDraft(){
  const draft=safeDraft(state.book.id);if(!draft?.book||!Array.isArray(draft.book.chapters)||!Array.isArray(draft.book.notes))return;
  if(JSON.stringify(draft.book)===JSON.stringify(state.book)){removeDraft(state.book.id,draft.key);return;}
  if(draft.own&&draft.revision===state.revision){setBook({book:draft.book,revision:state.revision});renderShell();markDirty();toast(T('已找回上次未完成的输入。'));if(await saveNow())removeDraft(state.book.id,draft.key);}
  else{
    const sourceId=state.book.id,p=el('p','dialog-description',T('找到一份未完成的草稿。它与已保存的版本不同，可以恢复为新作品，原作品会保留。')),a=el('div','dialog-actions');
    a.append(action(T('暂时保留'),'secondary-button',closeDialog),action(T('恢复为新作品'),'primary-button',()=>transition(async()=>{try{const r=await api('/api/import','POST',{format:'yejian-backup',version:1,book:draft.book});removeDraft(sourceId,draft.key);setBook(r);state.view='write';closeDialog();await refreshBooks();renderShell();toast(T('草稿已恢复为新作品。'));}catch(e){toast(e.message);}})));showDialog(T('找回未完成的草稿'),p,a);
  }
}
function showDialog(title,...children){$('dialog-title').textContent=title;$('dialog-body').replaceChildren(...children);if(!$('dialog').open)$('dialog').showModal();}
function closeDialog(){$('dialog').close();}
async function showLibrary(){await showCollection('shelf');}

function showBookName(rename,kind=state.kind){if(rename&&state.book)return editBookSettings(state.book.id);showBookSettings(rename,kind);}

function renameChapter(id){
  if(state.kind==='short'||state.composing||state.transitioning)return;
  const book=state.book,chapter=activeChapters().find(item=>item.id===id);if(!chapter)return;
  const comparing=id===state.chapterId&&window.WriterEditorTools?.isComparing();
  const form=el('form'),input=el('input','dialog-input');input.id='rename-chapter-title';input.value=comparing?$('chapter-title').value:chapter.title;input.maxLength=200;input.required=true;input.setAttribute('aria-label',T('章节标题'));
  const buttons=el('div','dialog-actions'),submit=el('button','primary-button',T('保存'));submit.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),submit);form.append(input,buttons);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(submit.disabled||state.book!==book||chapter.deletedAt)return;
    const title=input.value.trim();if(!title){toast(T('章节名称不能为空。'));return;}if(Array.from(title).length>200){toast(T('章节名称不能超过 200 个字符。'));return;}
    submit.disabled=true;
    try{await transition(async()=>{
      if(id===state.chapterId&&window.WriterEditorTools?.isComparing()){$('chapter-title').value=title;window.WriterEditorTools.captureInput('title');}
      else{chapter.title=title;if(state.chapterId===id)$('chapter-title').value=title;markDirty();renderChapters();renderBacklinks();if(typeof syncAIChat==='function')syncAIChat();}
      if(await requireSaved())closeDialog();
    });}finally{submit.disabled=false;}
  });
  showDialog(T('重命名章节'),form);input.focus();input.select();
}

function addChapter(title,volumeId=state.volumeId){
  if(!state.book||state.composing||state.transitioning)return null;
  if(state.kind==='short'){const manuscript=ensureShortManuscript();state.view='write';state.collection=null;renderShell();selectChapter(manuscript.id);$('editor').focus();return manuscript;}
  if(state.kind==='long'&&!activeVolumes().some(v=>v.id===volumeId))volumeId=activeVolumes()[0]?.id||null;
  if(state.kind==='short')volumeId=null;
  const c={id:uid(),title:title||(state.kind==='short'?T('正文'):T`第 ${activeChapters().length+1} 章`),body:'',volumeId,deletedAt:null};
  const i=state.book.chapters.findIndex(c=>c.id===state.chapterId);state.book.chapters.splice(i+1,0,c);state.view='write';state.collection=null;markDirty();renderShell();selectChapter(c.id);$('chapter-title').focus();$('chapter-title').select();return c;
}

function moveChapter(direction){
  if(state.kind==='short')return;
  const current=currentChapter();if(!current)return;const list=activeChapters().filter(c=>c.volumeId===current.volumeId),i=list.indexOf(current),other=list[i+direction];if(!other)return;
  const a=state.book.chapters.indexOf(current),b=state.book.chapters.indexOf(other);[state.book.chapters[a],state.book.chapters[b]]=[state.book.chapters[b],state.book.chapters[a]];markDirty();selectChapter(state.chapterId);
}

function confirmTrash(kind){
  if(kind==='chapter'&&state.kind==='short')return;
  const item=kind==='chapter'?currentChapter():kind==='outline'?currentOutline():kind==='person'?currentPerson():kind==='relation'?state.book.relations.find(r=>r.id===state.relationId):currentNote();if(!item)return;
  const p=el('p','dialog-description',T`将「${item.title||item.label||T('未命名')}」移入回收站？内容及关联会保留，之后可以恢复。`),a=el('div','dialog-actions');
  a.append(action(T('取消'),'secondary-button',closeDialog),action(T('移入回收站'),'primary-button',()=>{const list=activeChapters(),i=list.findIndex(c=>c.id===item.id);item.deletedAt=new Date().toISOString();markDirty();if(kind==='chapter')selectChapter(list[i+1]?.id||list[i-1]?.id);else if(kind==='outline'){state.outlineId=null;renderOutline();}else{state.noteId=null;state.personId=null;renderNotes();if(state.view==='people')renderPeople();}renderBacklinks();closeDialog();toast(T('已移入回收站。'));}));showDialog(T('移入回收站'),p,a);
}
let trashRequest=0;
async function showTrash(){
  if(state.composing||state.transitioning||!await requireSaved())return;
  const book=state.book,sequence=++trashRequest,content=el('div'),books=el('div','trash-books'),itemsList=el('div','trash-items');
  content.append(el('h3',null,T('回收的作品')),el('p','dialog-description',T('整部作品保留 30 天，到期自动彻底删除。')),books);books.append(el('p','dialog-description',T('正在读取回收站…')));
  if(book){const items=[['chapters',book.kind==='short'?T('正文'):T('章节')],['notes',T('资料 / 人物')],['outline',T('大纲')],['relations',T('人物关系')],['volumes',T('卷')]].flatMap(([key,kind])=>(book[key]||[]).filter(item=>item.deletedAt).map(item=>({item,kind,key})));content.append(el('h3',null,T('当前作品内的回收内容 · {0}',book.title)),itemsList);
    if(!items.length)itemsList.append(el('p','dialog-description',T('当前作品内没有回收内容。')));
    items.forEach(({item,kind,key})=>{const row=el('div','trash-row'),text=el('div',null,item.title||item.label||T('未命名'));text.append(el('small',null,kind),el('small',null,T('删除于 {0}',window.WriterChapterHistory.formatTime(item.deletedAt))));const buttons=el('div','trash-book-actions');row.append(text,buttons);buttons.append(action(T('恢复'),'secondary-button',()=>{if(state.book!==book||state.transitioning)return;if(key==='chapters'&&book.kind==='short'){book.chapters=book.chapters.filter(chapter=>chapter!==item);book.chapters.push(item);book.shortSections=book.shortSections?.filter(section=>section.id!==item.id);item.deletedAt=null;ensureShortManuscript();}else item.deletedAt=null;if(key==='chapters'&&item.volumeId){const volume=book.volumes.find(volume=>volume.id===item.volumeId);if(volume)volume.deletedAt=null;}markDirty();renderShell();showTrash();toast(T('已恢复，原有关联也会保留。'));}));if(key==='chapters')buttons.append(action(T('彻底删除'),'text-button danger-button',()=>window.WriterChapterHistory.confirmPurge({bookId:book.id,chapterId:item.id,title:item.title,revision:state.revision,deletedAt:item.deletedAt},{isCurrent:()=>state.book?.id===book.id,onDone:showTrash,onCancel:showTrash})));itemsList.append(row);});
  }
  showDialog(T('回收站'),content);
  const current=()=>sequence===trashRequest&&state.book===book&&$('dialog').open&&$('dialog-body').contains(content);
  try{const result=await api('/api/trash/books');if(!current())return;state.trashBookCount=result.books.length;renderTrashCount();books.replaceChildren();
    if(!result.books.length)books.append(el('p','dialog-description',T('没有回收的作品。')));
    result.books.forEach(record=>{const row=el('div','trash-row'),text=el('div',null,record.title),buttons=el('div','trash-book-actions');text.append(el('small',null,record.kind==='short'?T('短篇')+' · '+T('{0} 字',record.charCount.toLocaleString()):T('{0} · {1} 章 · {2} 字',kindName(record.kind),record.chapterCount,record.charCount.toLocaleString())));if(record.expiresAt)text.append(el('small',null,T('到期删除：{0}',new Date(record.expiresAt).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN'))));else text.append(el('small',null,T('移入时间：{0}',new Date(record.deletedAt).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN'))));buttons.append(action(T('恢复到书架'),'secondary-button',()=>{if(current())return restoreTrashedBook(record);}),action(T('彻底删除'),'text-button danger-button',()=>{if(current())confirmPurgeBook(record);}));row.append(text,buttons);books.append(row);});
  }catch(error){if(current()){books.replaceChildren(el('p','dialog-description',error.message),action(T('重试'),'secondary-button',showTrash));}}
}
async function restoreTrashedBook(record){
  return transition(async()=>{if(!await requireSaved())return false;try{const result=await api('/api/books/'+encodeURIComponent(record.id)+'/restore','POST',{revision:record.revision});if(state.book?.id===record.id)setBook(result);state.trashBookCount=Math.max(0,(state.trashBookCount||0)-1);closeDialog();try{await refreshBooks();}catch(error){toast(error.message);}renderShell();if(result.folderWarning)toast(T(result.folderWarning));else toast(T('作品已恢复到书架，原内容和关联均已保留。'));return true;}catch(error){toast(error.message);return false;}});
}
function confirmPurgeBook(record){
  if(state.transitioning||state.composing)return;const body=el('div'),buttons=el('div','dialog-actions'),visible=()=>$('dialog').open&&$('dialog-body').contains(body),confirm=action(T('彻底删除'),'primary-button danger-button',async()=>{if(confirm.disabled||!visible())return;confirm.disabled=true;try{await purgeTrashedBook(record,visible);}finally{confirm.disabled=false;}});body.append(el('p','dialog-description',T('彻底删除「{0}」？正文、关联、历史和本机备份将无法恢复。',record.title)));buttons.append(action(T('取消'),'secondary-button',()=>{if(visible())return showTrash();}),confirm);body.append(buttons);showDialog(T('彻底删除作品'),body);
}
async function purgeTrashedBook(record,visible){
  return transition(async()=>{if(!visible()||!await requireSaved()||!visible())return false;try{const result=await api('/api/books/'+encodeURIComponent(record.id)+'/purge','POST',{revision:record.revision});if(result.ok!==true||result.id!==record.id)throw new Error(T('删除结果与目标作品不匹配，请刷新回收站。'));if(typeof clearAIChatBookHistory==='function')clearAIChatBookHistory(record.id);if(state.book?.id===record.id){removeDraft(record.id);clearBook();state.view='shelf';state.collection=null;exitFocus();}state.books=state.books.filter(book=>book.id!==record.id);state.trashBookCount=Math.max(0,(state.trashBookCount||0)-1);closeDialog();try{await refreshBooks();}catch(error){toast(error.message);}renderShell();toast(T(result.cleanupPending?'作品已删除，备份或同步清理将在后台重试。':'作品已彻底删除。'));return true;}catch(error){toast(error.message);return false;}});
}
function toggleNotes(force){const visible=force===undefined?$('notes-panel').hidden:force;if(visible){if(typeof closeAIChat==='function')closeAIChat();window.WriterWorkPlan?.close();}$('notes-panel').hidden=!visible;$('toggle-notes').setAttribute('aria-expanded',String(visible));$('workspace').classList.toggle('notes-open',visible);if(visible){renderNotes();renderBacklinks();}requestAnimationFrame(resizeEditor);}
function filteredNotes(){return state.book.notes.filter(n=>!n.deletedAt&&($('notes-filter').value==='全部'||n.type===$('notes-filter').value));}
function renderNotes(){
  if(!state.book)return;const notes=filteredNotes();if(!notes.some(n=>n.id===state.noteId))state.noteId=notes[0]?.id||null;$('note-list').replaceChildren();
  notes.forEach(n=>{const b=action('','note-card'+(n.id===state.noteId?' active':''),()=>{state.noteId=n.id;renderNotes();});b.append(el('span','note-card-name',n.title||T('未命名资料')),el('span','note-card-type',T(n.type)));$('note-list').append(b);});
  const n=currentNote();$('note-detail').hidden=!n;$('notes-empty').hidden=!!notes.length;if(n){$('note-title').value=n.title;$('note-body').value=n.body;$('note-type').value=n.type;}
}
function addNote(){if(!state.book)return;const type=$('notes-filter').value==='全部'?'人物':$('notes-filter').value,n={id:uid(),type,title:'',body:'',chapterIds:[],aliases:[],profile:emptyProfile(),deletedAt:null};state.book.notes.push(n);state.noteId=n.id;markDirty();renderNotes();$('note-title').focus();}
function renderNoteNames(){const notes=filteredNotes();$('note-list').querySelectorAll('.note-card-name').forEach((e,i)=>e.textContent=notes[i].title||T('未命名资料'));}
function download(filename,body,type){const blob=new Blob([body],{type}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function filename(extension,book=state.book){return(book.title.replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0,100)||T('我的作品'))+extension;}
function backupData(book=state.book){return{format:'yejian-backup',version:4,exportedAt:new Date().toISOString(),book:clone(book)};}
function exportBook(format,book){
  const md=format==='md';let text=(md?'# ':'')+book.title+'\n\n';
  if(book.kind==='short'){text+=book.chapters.filter(c=>!c.deletedAt).map(c=>c.body).join('\n\n');download(filename('.'+format,book),(format==='txt'?'\uFEFF':'')+text,md?'text/markdown;charset=utf-8':'text/plain;charset=utf-8');toast(T('正文已导出。'));return;}
  const volumes=book.volumes.filter(volume=>!volume.deletedAt),active=book.chapters.filter(chapter=>!chapter.deletedAt),volumeIds=new Set(volumes.map(volume=>volume.id)),groups=book.kind==='long'?[...volumes,{id:null,title:T('未分卷')}]:[{id:null,title:''}];
  groups.forEach(volume=>{const chapters=active.filter(chapter=>book.kind==='short'||(volume.id?chapter.volumeId===volume.id:!volumeIds.has(chapter.volumeId)));if(!chapters.length)return;if(volume.title)text+=(md?'## ':'')+volume.title+'\n\n';text+=chapters.map(chapter=>(md?(book.kind==='long'?'### ':'## '):'')+(chapter.title||T('未命名章节'))+'\n\n'+chapter.body).join('\n\n\n')+'\n\n';});
  download(filename('.'+format,book),(format==='txt'?'\uFEFF':'')+text,md?'text/markdown;charset=utf-8':'text/plain;charset=utf-8');toast(T('正文已按卷、章节顺序导出。'));
}

function downloadBackup(book=state.book){if(!book)return;download(filename('.yejian.json',book),JSON.stringify(backupData(book),null,2),'application/json;charset=utf-8');toast(T('完整备份已下载。'));}
let backupRequest=0;
async function showBackup(bookId){
  if(typeof bookId!=='string'||!bookId)return;
  return transition(async()=>{if(!await requireSaved())return false;const sequence=++backupRequest,content=el('div','book-backup');content.append(el('p','dialog-description',T('正在读取作品…')));showDialog(T('导出与备份'),content);const visible=()=>sequence===backupRequest&&$('dialog').open&&$('dialog-body').contains(content);
    try{const record=await api('/api/books/'+encodeURIComponent(bookId));if(!visible())return false;if(record.book?.id!==bookId)throw new Error(T('作品与目标不匹配，请重试。'));const book=clone(record.book),grid=el('div','export-grid');
      [[T('TXT 正文'),'txt'],[T('Markdown 正文'),'md']].forEach(([title,format])=>{const button=action('','export-card',()=>withBackupBook(book.id,visible,target=>exportBook(format,target)));button.append(el('strong',null,title));grid.append(button);});
      grid.append(action(T('排版导出'),'export-card',()=>{if(visible())showFormattedExport(book);}));
      const section=el('div','backup-section'),buttons=el('div','dialog-actions');buttons.append(action(T('下载完整备份'),'primary-button',()=>withBackupBook(book.id,visible,downloadBackup)));section.append(buttons);if(typeof showHistory==='function')section.append(action(T('历史与自动备份'),'text-button',()=>{if(visible())return showHistory(book.id);}));content.replaceChildren(grid,section);$('dialog-title').textContent=T('导出与备份 · {0}',book.title);return true;
    }catch(error){if(visible())content.replaceChildren(el('p','dialog-description',error.message),action(T('重试'),'secondary-button',()=>showBackup(bookId)));return false;}
  });
}
async function withBackupBook(bookId,visible,perform){
  return transition(async()=>{if(!visible()||!await requireSaved()||!visible())return false;try{const record=await api('/api/books/'+encodeURIComponent(bookId));if(!visible())return false;if(record.book?.id!==bookId)throw new Error(T('作品与目标不匹配，请重试。'));await perform(clone(record.book));return true;}catch(error){if(visible())toast(error.message);return false;}});
}
async function importBackup(file){
  if(!file)return;if(file.size>50*1024*1024){toast(T('备份文件超过 50 MB，请使用较小的文件。'));$('import-file').value='';return;}
  await transition(async()=>{try{const data=JSON.parse(await file.text());if(!await requireSaved())return;setBook(await api('/api/import','POST',data));state.view='write';closeDialog();await refreshBooks();renderShell();toast(T('备份已恢复为新作品，原作品仍保留。'));}catch(e){toast(e instanceof SyntaxError?T('文件不是有效的 JSON 备份，原有作品未改变。'):e.message);}finally{$('import-file').value='';}});
}
async function rescueCopy(){if(!state.book)return;await transition(async()=>{try{const oldId=state.book.id,r=await api('/api/import','POST',backupData());removeDraft(oldId);setBook(r);state.view='write';await refreshBooks();renderShell();toast(T('本页内容已另存为新作品。'));}catch(e){showError(e);}});}
function setFont(delta){state.fontSize=Math.max(16,Math.min(26,state.fontSize+delta));document.documentElement.style.setProperty('--font-size',state.fontSize+'px');preference('yejian.font-size',String(state.fontSize));resizeEditor();}
function exitFocus(){$('workspace').classList.remove('focus');$('exit-focus').hidden=true;resizeEditor();}
const settingsEditCommands=new Set(['undo','redo','cut','copy','paste','selectAll']);
let lastSettingsEditor=null,settingsEditor=null,settingsFocusRestored=false,settingsRequest=0,settingsActionPending=false,settingsEventsBound=false;
const appSettingsState={version:'',dataPath:'',zoomFactor:1,fullscreen:false,maximized:false};
function hasDesktopSettings(){return typeof window.WriterDesktop?.getAppSettings==='function'&&typeof window.WriterDesktop?.performAppAction==='function';}
function isSettingsEditor(target){return !!target&&!target.disabled&&!target.closest('#settings-dialog')&&(target.tagName==='TEXTAREA'||target.tagName==='INPUT'&&['text','search','url','tel','email','password'].includes(target.type||'text'))&&typeof target.selectionStart==='number';}
function rememberSettingsEditor(target=document.activeElement){
  if(!isSettingsEditor(target))return;
  lastSettingsEditor={target,start:target.selectionStart,end:target.selectionEnd,direction:target.selectionDirection,scrollTop:target.scrollTop,scrollLeft:target.scrollLeft,bookId:state.book?.id,chapterId:state.chapterId};
}
function currentSettingsEditor(){
  const saved=settingsEditor,target=saved?.target;
  if(!target?.isConnected||!isSettingsEditor(target)||target.closest('[hidden]')||saved.bookId!==state.book?.id||saved.chapterId!==state.chapterId)return null;
  return saved;
}
function restoreSettingsEditor(){
  const saved=currentSettingsEditor();if(!saved)return false;
  saved.target.focus({preventScroll:true});saved.target.setSelectionRange(saved.start,saved.end,saved.direction||'none');saved.target.scrollTop=saved.scrollTop;saved.target.scrollLeft=saved.scrollLeft;return true;
}
function updateAppSettings(info={}){
  if(typeof updateContinuationSettings==='function')updateContinuationSettings(info);
  for(const key of ['version','dataPath'])if(typeof info[key]==='string')appSettingsState[key]=info[key];
  if(Number.isFinite(info.zoomFactor))appSettingsState.zoomFactor=info.zoomFactor;
  for(const key of ['fullscreen','maximized'])if(typeof info[key]==='boolean')appSettingsState[key]=info[key];
  $('settings-version').textContent=appSettingsState.version?T('版本 {0}',appSettingsState.version):'—';
  $('settings-data-path').value=appSettingsState.dataPath;
  $('settings-zoom-value').textContent=Math.round(appSettingsState.zoomFactor*100)+'%';
  $('settings-zoom-out').disabled=appSettingsState.zoomFactor<=.5;
  $('settings-zoom-in').disabled=appSettingsState.zoomFactor>=2;
  $('settings-fullscreen').textContent=T(appSettingsState.fullscreen?'退出全屏':'进入全屏');
  $('settings-fullscreen').setAttribute('aria-pressed',String(appSettingsState.fullscreen));
  const maximize=$('window-maximize'),label=T(appSettingsState.maximized?'还原窗口':'最大化');maximize.title=label;maximize.setAttribute('aria-label',label);maximize.querySelector('[data-icon]').innerHTML=svgIcon(appSettingsState.maximized?'restore':'maximize');
  if(typeof syncSettingsLayout==='function')syncSettingsLayout();
}
async function showAppSettings(page){
  if(state.composing){toast(T('请先完成当前输入。'));return;}if(state.transitioning||$('dialog').open)return;
  if($('settings-dialog').open){if(typeof selectSettingsPage==='function')selectSettingsPage(typeof page==='string'?page:undefined);return;}
  rememberSettingsEditor();settingsEditor=lastSettingsEditor?{...lastSettingsEditor}:null;settingsFocusRestored=false;
  $('settings-edit-actions').querySelectorAll('[data-settings-edit]').forEach(button=>{const saved=currentSettingsEditor();button.disabled=!saved||(saved.target.readOnly&&!['copy','selectAll'].includes(button.dataset.settingsEdit));});
  closeNav();updateAppSettings();$('settings-dialog').showModal();const request=++settingsRequest;
  if(typeof buildContinuationSettings==='function')Promise.resolve(buildContinuationSettings()).then(()=>{if(typeof syncSettingsLayout==='function')syncSettingsLayout();});
  if(typeof syncSettingsLayout==='function')syncSettingsLayout();
  if(typeof selectSettingsPage==='function')selectSettingsPage(typeof page==='string'?page:undefined);
  if(hasDesktopSettings())try{const info=await window.WriterDesktop.getAppSettings();if(request===settingsRequest&&$('settings-dialog').open)updateAppSettings(info);}catch(error){if(request===settingsRequest)toast(error.message||T('无法读取设置。'));}
}
function closeAppSettings(){
  if(state.transitioning)return false;
  settingsFocusRestored=true;++settingsRequest;if($('settings-dialog').open)$('settings-dialog').close();restoreSettingsEditor();
}
async function performSettingsAction(command){
  if(settingsActionPending||state.transitioning)return false;
  if(settingsEditCommands.has(command)){
    if(state.composing){toast(T('请先完成当前输入。'));return false;}
    const saved=currentSettingsEditor();if(!saved){toast(T('请先选择要编辑的文字。'));return false;}
    closeAppSettings();
    try{
      if(hasDesktopSettings())await window.WriterDesktop.performAppAction(command);
      else if(command==='selectAll')saved.target.setSelectionRange(0,saved.target.value.length);
      else if(!document.execCommand(command)){toast(T('请使用键盘快捷键完成此操作。'));return false;}
      return true;
    }catch(error){toast(error.message||T('暂时无法完成操作'));return false;}
  }
  settingsActionPending=true;
  try{
    if(hasDesktopSettings())updateAppSettings(await window.WriterDesktop.performAppAction(command));
    else if(command==='toggleFullscreen'){
      if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();
      updateAppSettings({fullscreen:!!document.fullscreenElement});
    }else return false;
    return true;
  }catch(error){toast(error.message||T('暂时无法完成操作'));return false;}finally{settingsActionPending=false;}
}
function bindAppSettingsEvents(){
  if(settingsEventsBound)return;settingsEventsBound=true;
  const native=hasDesktopSettings();document.body.classList.toggle('desktop-app',native);$('window-controls').hidden=!native;
  document.querySelectorAll('[data-desktop-only]').forEach(element=>{element.hidden=!native;});
  if(!native&&!document.fullscreenEnabled)$('settings-display').hidden=true;
  if(typeof bindSettingsLayout==='function')bindSettingsLayout();
  document.addEventListener('focusin',event=>rememberSettingsEditor(event.target));document.addEventListener('selectionchange',()=>rememberSettingsEditor());document.addEventListener('input',event=>rememberSettingsEditor(event.target));
  $('open-settings').addEventListener('pointerdown',()=>rememberSettingsEditor());$('open-settings').addEventListener('click',showAppSettings);$('close-settings').addEventListener('click',closeAppSettings);
  $('settings-dialog').addEventListener('cancel',event=>{event.preventDefault();closeAppSettings();});
  $('settings-dialog').addEventListener('close',()=>{if(!settingsFocusRestored){settingsFocusRestored=true;++settingsRequest;restoreSettingsEditor();}if(typeof refreshAIChatSettings==='function')refreshAIChatSettings();});
  $('settings-edit-actions').querySelectorAll('[data-settings-edit]').forEach(button=>button.addEventListener('click',()=>performSettingsAction(button.dataset.settingsEdit)));
  $('settings-dialog').querySelectorAll('[data-settings-action]').forEach(button=>button.addEventListener('click',()=>performSettingsAction(button.dataset.settingsAction)));
  for(const [id,command]of [['window-minimize','minimize'],['window-maximize','toggleMaximize'],['window-close','close']])$(id).addEventListener('click',()=>performSettingsAction(command));
  if(native){const unsubscribe=window.WriterDesktop.onWindowState?.(updateAppSettings);if(typeof unsubscribe==='function')window.addEventListener('pagehide',unsubscribe,{once:true});window.WriterDesktop.getAppSettings().then(updateAppSettings).catch(()=>{});}
  else document.addEventListener('fullscreenchange',()=>updateAppSettings({fullscreen:!!document.fullscreenElement}));
}
function bindEvents(){
  if(typeof initializeWorkspaceExpansion==='function')initializeWorkspaceExpansion();
  if(typeof initializeReviewTools==='function')initializeReviewTools();
  if(typeof bindAppearanceEvents==='function')bindAppearanceEvents();
  $('book-search').addEventListener('click',()=>window.WriterBookSearch.open());$('story-tools').addEventListener('click',()=>window.WriterStoryTools.open());$('outline-story-tools').addEventListener('click',()=>window.WriterStoryTools.open());
  $('editor').addEventListener('input',()=>{if(!currentChapter()||window.WriterEditorTools?.captureInput('body'))return;currentChapter().body=$('editor').value;markDirty();resizeEditor();});
  document.addEventListener('compositionstart',()=>{state.composing=true;clearTimeout(state.timer);});
  document.addEventListener('compositionend',()=>{state.composing=false;window.WriterEditorTools?.flushDrafts();syncReviewAnchors();if(state.book&&state.view==='write'&&!currentChapter())selectChapter(activeChapters()[0]?.id);if(state.dirty){saveDraft();}if(state.dirty&&!state.conflict){clearTimeout(state.timer);state.timer=setTimeout(saveNow,650);}});
  $('chapter-title').addEventListener('input',()=>{if(!currentChapter()||window.WriterEditorTools?.captureInput('title'))return;currentChapter().title=$('chapter-title').value;markDirty();renderChapters();renderBacklinks();});
  $('add-chapter').addEventListener('click',()=>addChapter());$('move-up').addEventListener('click',()=>moveChapter(-1));$('move-down').addEventListener('click',()=>moveChapter(1));$('trash-chapter').addEventListener('click',()=>confirmTrash('chapter'));
  $('open-trash').addEventListener('click',showTrash);$('import-backup').addEventListener('click',()=>$('import-file').click());
  $('toggle-sidebar').addEventListener('click',()=>{if(window.innerWidth<=540){$('workspace').classList.toggle('sidebar-mobile-open');$('sidebar-backdrop').hidden=!$('workspace').classList.contains('sidebar-mobile-open');}else{$('workspace').classList.toggle('sidebar-hidden');requestAnimationFrame(resizeEditor);}});
  $('sidebar-backdrop').addEventListener('click',closeSidebar);
  $('toggle-notes').addEventListener('click',()=>toggleNotes());$('close-notes').addEventListener('click',()=>toggleNotes(false));$('notes-filter').addEventListener('change',renderNotes);$('add-note').addEventListener('click',addNote);
  $('note-title').addEventListener('input',()=>{if(!currentNote())return;currentNote().title=$('note-title').value;markDirty();renderNoteNames();renderBacklinks();});
  $('note-body').addEventListener('input',()=>{if(!currentNote())return;currentNote().body=$('note-body').value;markDirty();});
  $('note-type').addEventListener('change',()=>{const n=currentNote();if(!n)return;if(n.type==='人物'&&$('note-type').value!=='人物'&&(state.book.relations.some(r=>r.fromId===n.id||r.toId===n.id)||state.book.atlasViews.some(v=>v.personIds.includes(n.id))||state.book.atlasMainPersonIds?.includes(n.id)||['foreshadows','timeline'].some(key=>state.book.storyTools?.[key]?.some(item=>item.personIds.includes(n.id))))){$('note-type').value=n.type;toast(T('这个人物已加入关系或主题分图，请保留为人物类型。'));return;}n.type=$('note-type').value;markDirty();renderNotes();renderBacklinks();});$('trash-note').addEventListener('click',()=>confirmTrash('note'));
  $('toggle-focus').addEventListener('click',()=>{if(state.view!=='write'||!state.book)return;$('workspace').classList.add('focus');$('exit-focus').hidden=false;resizeEditor();$('editor').focus();});$('exit-focus').addEventListener('click',exitFocus);
  $('font-smaller').addEventListener('click',()=>setFont(-1));$('font-larger').addEventListener('click',()=>setFont(1));$('close-dialog').addEventListener('click',closeDialog);
  $('import-file').addEventListener('change',e=>importBackup(e.target.files[0]));$('retry-save').addEventListener('click',async()=>{if(state.book)await saveNow();else location.reload();});$('emergency-backup').addEventListener('click',()=>downloadBackup());$('rescue-copy').addEventListener('click',rescueCopy);
  window.addEventListener('keydown',e=>{if(e.isComposing)return;if((e.ctrlKey||e.metaKey)&&e.shiftKey&&['f','h'].includes(e.key.toLowerCase())&&!$('dialog').open&&!$('settings-dialog').open){e.preventDefault();window.WriterBookSearch?.open();return;}if(e.key==='Escape'&&!$('dialog').open&&!$('settings-dialog').open){exitFocus();closeSidebar();closeNav();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveNow();}});
  window.addEventListener('beforeunload',e=>{if(state.dirty||window.WriterEditorTools?.hasPendingDrafts()){saveDraft();e.preventDefault();e.returnValue='';}});
  window.addEventListener('resize',resizeEditor);document.addEventListener('visibilitychange',()=>{if(document.hidden&&(state.dirty||window.WriterEditorTools?.hasPendingDrafts())){saveDraft();saveNow();}});bindPlanningEvents();
}
function installIcons(){document.querySelectorAll('[data-icon]').forEach(node=>{node.innerHTML=svgIcon(node.dataset.icon);});}
async function registerTools(){
  const context=document.modelContext;if(!context?.registerTool)return;const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  try{
    await context.registerTool({name:'get_manuscript_outline',title:T('查看当前作品大纲'),description:T('读取当前作品的章节标题、顺序和字数，不返回正文，不修改作品。'),inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error(T('不接受额外参数'));if(!state.book)throw new Error(T('作品尚未打开'));return{title:state.book.title,kind:state.book.kind,outline:activeOutline().map(o=>({id:o.id,title:o.title,parentId:o.parentId,chapterIds:o.chapterIds})),chapters:activeChapters().map(c=>({id:c.id,title:c.title,characters:count(c.body)}))};}},{signal:lifecycle.signal});
    await context.registerTool({name:'create_chapter',title:T('新建章节'),description:T('在当前章节之后新建空白章节，打开并保存到本机。'),inputSchema:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:200}},required:['title'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},async execute(input){if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>200||Object.keys(input).some(k=>k!=='title'))throw new Error(T('请输入 1–200 字的章节标题'));if(!state.book||state.composing||state.transitioning||$('dialog').open||$('settings-dialog').open)throw new Error(T('请先打开作品、完成输入并关闭当前对话框'));if(state.kind==='short')throw new Error(T('短篇使用单篇正文，无需新建章节。'));if(!await requireSaved())throw new Error(T('当前内容未保存'));const c=addChapter(input.title.trim());if(!c)throw new Error(T('正在切换作品，请稍后重试'));if(!await saveNow())throw new Error(T('章节尚未保存，请重试或下载备份'));return{id:c.id,title:c.title,saved:true};}},{signal:lifecycle.signal});
  }catch{console.info(T('当前浏览器未启用写作工具接口。'));}
}
async function initialize(){
  state.kind=preference('yejian.kind')==='short'?'short':'long';state.view='home';state.collection=null;
  window.WriterHomeDashboard?.configure({api,getBooks:()=>state.books,getView:()=>state.view,isVisible:()=>state.view==='home',openBook,navigate,translate:T,icons:svgIcon,getLanguage:()=>uiLanguage});
  window.WriterInterfacePolish?.configure({translate:T,getContext:()=>({kind:state.kind,outlineMode:state.outlineMode,personEditing:state.personEditing,trailView:state.trail?.view})});
  window.WriterStoryTools?.configure({openHome:()=>navigate('home'),getBook:()=>state.book,markDirty,saveNow,api,T,setComposing:value=>{state.composing=value;if(value)clearTimeout(state.timer);else if(state.dirty&&!state.conflict){clearTimeout(state.timer);state.timer=setTimeout(saveNow,650);}},jumpToChapter:id=>jumpToChapter(id),jumpToPerson:id=>jumpToOwner({type:'person',item:people().find(p=>p.id===id)})});
  bindEvents();window.WriterWorkPlan?.bind();window.WriterChapterHistory?.configure({beforePurge:record=>suspendAIChatForPurge(record.bookId),afterPurge:(record,result)=>window.WriterContentCleanup.clear(record.bookId,result.purgedAt)});$('open-history')?.addEventListener('click',()=>window.WriterChapterHistory?.open());bindWorkspaceEvents();bindLanguageEvents();bindAppSettingsEvents();if(typeof bindContinuationEvents==='function')bindContinuationEvents();installIcons();const font=Number(preference('yejian.font-size'));if(font>=16&&font<=26)state.fontSize=font;setFont(0);
  try{await window.WriterContentCleanup?.sync();await refreshBooks();await loadKind(state.kind);state.view='home';renderShell();if(state.book)await recoverDraft();await registerTools();}catch(e){saveStatus(T('无法打开作品'),true);showError(e);}
}


function kindName(kind=state.kind){return kind==='short'?T('短篇'):T('长篇');}
const activeOutline=()=>state.book?.outline.filter(o=>!o.deletedAt)||[];
const people=()=>state.book?.notes.filter(n=>n.type==='人物'&&!n.deletedAt)||[];
const currentOutline=()=>activeOutline().find(o=>o.id===state.outlineId);
const currentPerson=()=>people().find(n=>n.id===state.personId);
function svgIcon(name){const paths={home:'M3 11l9-8 9 8M5 9v12h5v-7h4v7h5V9',compare:'M3 4h18v16H3zM12 4v16M6 8h3M6 12h3M15 8h3M15 12h3',review:'M5 3h10l4 4v6M15 3v5h4M5 3v18h7M8 8h3M8 12h7M15 18l2 2 4-5',search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M15 15l6 6',history:'M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',moon:'M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14',sparkles:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM19 3v4M17 5h4',book:'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z',shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',keyboard:'M3 6h18v13H3zM7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 13h.01M11 13h.01M15 13h.01M7 16h10',download:'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',info:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v6M12 7h.01',settings:'M9 3h6l1 4 4 1v6l-4 1-1 4H9l-1-4-4-1V8l4-1zM15 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0',minimize:'M5 12h14',maximize:'M5 5h14v14H5z',restore:'M8 8h11v11H8zM5 16V5h11',close:'M6 6l12 12M18 6 6 18',folder:'M3 7V5h6l2 2h10v13H3zM3 7h18',brand:'M5 4h10a3 3 0 0 1 3 3v14H8a3 3 0 0 1-3-3V4zM5 17h13M9 8h5M9 11h5',shelf:'M5 4v16M9 4v16M13 5l5-1 3 15-5 1z',outline:'M5 5h14M5 12h14M5 19h14M3 5h.1M3 12h.1M3 19h.1',people:'M8 7a3 3 0 1 0 0 .1M17 17a3 3 0 1 0 0 .1M10 9l5 5M5 18a2 2 0 1 0 0 .1M7 16l2-5',pen:'M4 20l4-1L20 7l-3-3L5 16zM15 6l3 3',short:'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h4',menu:'M4 6h16M4 12h16M4 18h16',notes:'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3',focus:'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',backup:'M12 3v12M8 11l4 4 4-4M4 17v4h16v-4',links:'M10 13l4-4M8 15l-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M14 9l2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0'};return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.notes)+'"/></svg>';}
async function refreshBooks(){const result=await api('/api/books');state.books=result.books.map(book=>({...book,kind:book.kind||'long'}));state.trashBookCount=Number.isSafeInteger(result.trashCount)?result.trashCount:0;renderTrashCount();}
function clearBook(){if(window.WriterEditorTools?.beforeSwitch()===false)return false;clearTimeout(state.timer);state.book=null;resetReviewAnchors();state.chapterId=null;state.outlineId=null;state.personId=null;state.noteId=null;state.dirty=false;state.conflict=false;state.error=null;state.trail=null;for(const id of ['editor','chapter-title','note-title','note-body','outline-title','outline-body','person-title','person-body']){const input=$(id);if(input)input.value='';}$('error-banner').hidden=true;$('editor').disabled=true;$('chapter-title').disabled=true;$('book-name').textContent='';$('book-name').hidden=true;$('chapter-list').replaceChildren();renderTrashCount();saveStatus(T('本机保存'));document.title=T('作家工作台 · {0}书架',kindName());}
async function loadKind(kind){
  state.kind=kind;preference('yejian.kind',kind);if(state.book?.kind===kind)return;
  const last=preference('yejian.last-book.'+kind),book=state.books.find(b=>b.kind===kind&&b.id===last);
  if(book)setBook(await api('/api/books/'+book.id));else{clearBook();state.view='shelf';state.collection=null;}
}
async function navigate(view,kind=state.kind){
  if(view==='home')return showHome();
  if(!state.book||state.book.kind!==kind)return showCollection('shelf',kind);
  return transition(async()=>{if(!await requireSaved())return false;state.view=view;state.collection=null;state.trail=null;closeDialog();closeNav();exitFocus();renderShell();return true;});
}
function closeNav(){$('workspace').classList.remove('nav-open');$('nav-backdrop').hidden=true;}
function renderShell(){renderWorkspaceShell();window.WriterInterfacePolish?.apply();window.WriterStoryTools?.sync();if(typeof syncAIChat==='function')syncAIChat();window.WriterWorkPlan?.sync();window.WriterEditorTools?.sync();}

function renderShelf(){renderCollection();}

function outlineRows(){const list=activeOutline(),ids=new Set(list.map(o=>o.id)),children=new Map(),result=[];list.forEach(o=>{const key=ids.has(o.parentId)?o.parentId:null;if(!children.has(key))children.set(key,[]);children.get(key).push(o);});const stack=(children.get(null)||[]).map(o=>({o,depth:0})).reverse();while(stack.length){const entry=stack.pop();result.push(entry);(children.get(entry.o.id)||[]).slice().reverse().forEach(o=>stack.push({o,depth:entry.depth+1}));}return result;}
function isDescendant(candidate,id){const map=new Map(state.book.outline.map(o=>[o.id,o.parentId]));let p=map.get(candidate),limit=map.size;while(p&&limit--){if(p===id)return true;p=map.get(p);}return false;}
function renderOutline(){renderOutlineWorkspace();window.WriterInterfacePolish?.apply();if(typeof syncAIChat==='function')syncAIChat();}

function addOutline(parentId=null,kind='scene',volumeId=null){
  if(!state.book||state.composing)return;const parent=activeOutline().find(o=>o.id===parentId),item={id:uid(),title:'',body:'',parentId,kind,volumeId:volumeId||parent?.volumeId||null,chapterIds:[],deletedAt:null};
  state.book.outline.push(item);state.outlineId=item.id;state.outlineMode='edit';markDirty();renderOutline();$('outline-title').focus();
}

function moveOutline(delta){const item=currentOutline();if(!item)return;const list=state.book.outline.filter(o=>!o.deletedAt&&o.parentId===item.parentId),i=list.indexOf(item),other=list[i+delta];if(!other)return;const a=state.book.outline.indexOf(item),b=state.book.outline.indexOf(other);[state.book.outline[a],state.book.outline[b]]=[state.book.outline[b],state.book.outline[a]];markDirty();renderOutline();}
function allOwners(){if(!state.book)return[];return activeOutline().map(item=>({type:'outline',item,name:item.title||T('未命名节点'),kind:T('大纲')})).concat(people().map(item=>({type:'person',item,name:item.title||T('未命名人物'),kind:T('人物')})),activeRelations().map(item=>({type:'relation',item,name:item.label||T('未命名关系'),kind:T('关系')})));}
function renderChapterLinks(container,owner,beforeJump){
  container.replaceChildren();const short=state.kind==='short';
  if(!owner.chapterIds?.length){container.append(el('p','empty-hint',short?T('尚未关联正文。'):T('还没有关联。选择章节后，就能从这里进入正文。')));return;}
  const seen=new Set();owner.chapterIds.forEach(id=>{const resolved=resolveShortManuscriptId(id),chapter=state.book.chapters.find(c=>c.id===resolved);if(!chapter||seen.has(resolved))return;seen.add(resolved);const button=action('','chapter-link'+(chapter.deletedAt?' archived':''),()=>{if(beforeJump&&!beforeJump())return;jumpToChapter(id);});button.append(el('span',null,short?(chapter.deletedAt?T('回收正文 · {0}',chapter.title):T('正文')):chapter.title||T('未命名章节')),el('small',null,chapter.deletedAt?T('已在回收站'):T('打开正文')));container.append(button);});
}
function chooseChapters(owner,after){
  if(!owner||!state.book)return;const short=state.kind==='short',list=el('div','choice-list'),checks=[];
  state.book.chapters.forEach(c=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=owner.chapterIds.some(id=>resolveShortManuscriptId(id)===c.id);const text=el('span',null,short?(c.deletedAt?T('回收正文 · {0}',c.title):T('正文')):c.title||T('未命名章节')),volume=activeVolumes().find(v=>v.id===c.volumeId);if(volume)text.append(el('small',null,volume.title));if(c.deletedAt)text.append(el('small',null,short?T('已在回收站'):T('已在回收站 · 恢复章节后可以跳转')));row.append(box,text);list.append(row);checks.push({box,id:c.id});});
  const buttons=el('div','dialog-actions');buttons.append(action(T('取消'),'secondary-button',closeDialog),action(T('保存关联'),'primary-button',()=>{owner.chapterIds=checks.filter(c=>c.box.checked).map(c=>c.id);markDirty();closeDialog();after?.();renderBacklinks();toast(T('正文关联已更新。'));}));
  if(short)showDialog(T('关联正文 · ')+(owner.title||owner.label||T('未命名')),list,buttons);
  else{addChoiceSearch(list,T('查找卷或章节'));showDialog(T('关联正文 · ')+(owner.title||owner.label||T('未命名')),el('p','dialog-description',T('选择这条大纲、人物或关系对应的章节。章节改名和排序后，关联仍然有效。')),list,buttons);}
}
async function jumpToChapter(id,quote=''){
  const book=state.book;if(!book)return false;
  const short=book.kind==='short',resolved=resolveShortManuscriptId(id,book),chapter=book.chapters.find(c=>c.id===resolved);
  if(!chapter||chapter.deletedAt){toast(short?T('这段正文已移入回收站，请先恢复。'):T('这个章节已移入回收站，请先恢复章节。'));return false;}
  const section=short&&resolved!==id?book.shortSections?.find(section=>section.id===id):null,trail={view:state.view,outlineId:state.outlineId,personId:state.personId};let jumped=false;
  await transition(async()=>{if(!await requireSaved()||state.book!==book||!book.chapters.includes(chapter)||chapter.deletedAt)return;state.view='write';state.trail=trail;closeDialog();renderShell();selectChapter(resolved);jumped=true;const heading=short?$('manuscript'):document.querySelector('.chapter-heading');heading.classList.remove('jump-highlight');requestAnimationFrame(()=>heading.classList.add('jump-highlight'));toast(short?T('已打开正文。'):T('已打开正文：')+(chapter.title||T('未命名章节')));});
  if(!jumped||state.book!==book||state.chapterId!==resolved)return false;
  const editor=$('editor'),body=chapter.body,area=$('writing-area');
  if(editor.disabled||editor.value!==body)return false;
  // Linux input methods complete focus reset asynchronously. Keep an empty
  // caret while that reset settles, then highlight the destination; selecting
  // immediately can make the native reset delete the highlighted manuscript.
  editor.setSelectionRange(0,0);editor.focus({preventScroll:true});editor.setSelectionRange(0,0);
  let interrupted=false;const interrupt=()=>{interrupted=true;},events=['keydown','pointerdown','beforeinput','compositionstart','blur'];
  for(const name of events)editor.addEventListener(name,interrupt);
  try{await new Promise(resolve=>setTimeout(resolve,100));}
  finally{for(const name of events)editor.removeEventListener?.(name,interrupt);}
  if(interrupted||state.book!==book||state.chapterId!==resolved||state.view!=='write'||state.composing||state.transitioning||!book.chapters.includes(chapter)||chapter.deletedAt||chapter.body!==body||editor.value!==body||editor.disabled||document.activeElement!==editor||editor.selectionStart!==0||editor.selectionEnd!==0)return false;
  const citation=short&&typeof quote==='string'&&quote.length>0,position=citation?body.indexOf(quote):-1,start=citation?Math.max(0,position):Math.min(section?.start||0,body.length),end=citation&&position>=0?start+quote.length:start,located=!!section||citation;
  editor.setSelectionRange(start,end);area.scrollTop=located?Math.max(0,editor.offsetTop+start/Math.max(1,body.length)*editor.scrollHeight-area.clientHeight/3):0;
  return true;
}

function renderBacklinks(){renderLinkedBacklinks();}

async function jumpToOwner(owner){await transition(async()=>{if(!await requireSaved())return;state.trail=null;if(owner.type==='outline'){state.view='outline';state.outlineId=owner.item.id;revealOutlinePath(owner.item.id);state.outlineCategory='all';state.outlineVolumeFilter='';state.outlineKindFilter='';$('outline-search').value='';}else{state.view='people';state.personId=owner.type==='person'?owner.item.id:owner.item.fromId;resetAtlasForPerson();}renderShell();if(owner.type==='outline')selectOutlineNode(owner.item.id);if(owner.type==='relation')showRelation(owner.item);});}
function addChoiceSearch(list,placeholder){const search=el('input','text-field choice-search');search.type='search';search.placeholder=placeholder;search.setAttribute('aria-label',placeholder);const rows=Array.from(list.querySelectorAll('.checkbox-row'));search.addEventListener('input',()=>{const query=search.value.trim().toLocaleLowerCase();rows.forEach(row=>row.hidden=!row.textContent.toLocaleLowerCase().includes(query));});list.prepend(search);}
function linkCurrentChapter(){if(!state.book||!currentChapter())return;const owners=allOwners(),list=el('div','choice-list'),checks=[];owners.forEach(owner=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=owner.item.chapterIds.includes(state.chapterId);const text=el('span',null,owner.name);text.append(el('small',null,owner.kind));row.append(box,text);list.append(row);checks.push({box,owner});});if(!owners.length){list.append(el('p','dialog-description',state.kind==='short'?T('先建立大纲或人物，再回来关联正文。'):T('先到大纲或人物脉络中新建节点和人物，再回来关联这一章。')));showDialog(T('关联大纲 / 人物'),list);return;}addChoiceSearch(list,T('查找大纲、人物或关系'));const id=state.chapterId,a=el('div','dialog-actions');a.append(action(T('取消'),'secondary-button',closeDialog),action(T('保存关联'),'primary-button',()=>{checks.forEach(({box,owner})=>{owner.item.chapterIds=owner.item.chapterIds.filter(c=>c!==id);if(box.checked)owner.item.chapterIds.push(id);});markDirty();renderBacklinks();closeDialog();toast(state.kind==='short'?T('正文关联已更新。'):T('本章的大纲与人物关联已更新。'));}));showDialog(state.kind==='short'?T('正文关联'):T('本章关联 · ')+(currentChapter().title||T('未命名章节')),el('p','dialog-description',T('勾选相关大纲、人物或人物关系。以后可以从两边相互跳转。')),list,a);}
function activeRelations(){const ids=new Set(people().map(p=>p.id));return state.book?.relations.filter(r=>!r.deletedAt&&ids.has(r.fromId)&&ids.has(r.toId))||[];}
function personName(id){return state.book.notes.find(n=>n.id===id)?.title||T('未命名人物');}
function svgElement(tag,attrs={},text){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,String(value)));if(text!==undefined)node.textContent=text;return node;}
function graphActivate(node,handler){node.addEventListener('click',handler);node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();handler();}});}
function renderGraph(){renderAtlas();}

function renderPersonRelations(){renderRelationsForPerson();}

function renderPersonSearch(){const query=$('person-search').value.trim().toLocaleLowerCase(),container=$('person-results');container.replaceChildren();container.hidden=!query;if(!query)return;const found=people().filter(p=>[p.title,...p.aliases,p.profile.group].join(' ').toLocaleLowerCase().includes(query)).slice(0,30);found.forEach(p=>container.append(action(p.title||T('未命名人物'),'',()=>{state.personId=p.id;resetAtlasForPerson();$('person-search').value='';container.hidden=true;renderPeople();})));if(!found.length)container.append(el('p','empty-hint',T('没有找到这个人物。')));}
function renderPeople(){renderPersonWorkspace();window.WriterInterfacePolish?.apply();}

function addPerson(){if(!state.book||state.composing)return;const person={id:uid(),title:'',type:'人物',body:'',chapterIds:[],aliases:[],profile:emptyProfile(),deletedAt:null};state.book.notes.push(person);state.personId=person.id;resetAtlasForPerson();state.personEditing=true;markDirty();renderPeople();renderNotes();$('person-title').focus();}
function showRelation(relation=null){
  const list=people();if(list.length<2){toast(T('先创建两个人物，再添加他们之间的关系。'));return;}const fresh=!relation||!state.book.relations.some(r=>r.id===relation.id),item=relation||{id:uid(),fromId:state.personId||list[0].id,toId:list.find(p=>p.id!==state.personId)?.id||list[1].id,label:'',body:'',chapterIds:[],deletedAt:null};state.relationId=item.id;
  item.type??='other';item.stage??='';item.volumeIds??=[];const form=el('form','relation-form'),from=el('select','text-field'),to=el('select','text-field'),label=el('input','text-field'),body=el('textarea','text-field');from.id='relation-from';to.id='relation-to';label.id='relation-label';body.id='relation-body';from.setAttribute('aria-label',T('关系起点人物'));to.setAttribute('aria-label',T('关系终点人物'));label.setAttribute('aria-label',T('关系名称'));body.setAttribute('aria-label',T('关系说明'));label.maxLength=200;label.placeholder=T('例如：母子、同伴、彼此隐瞒');label.value=item.label;body.value=item.body;body.placeholder=T('这段关系怎样开始，又将怎样改变？');
  list.forEach(p=>{[from,to].forEach(select=>{const option=el('option',null,p.title||T('未命名人物'));option.value=p.id;select.append(option);});});from.value=item.fromId;to.value=item.toId;
  [[T('起点人物'),from],[T('终点人物'),to],[T('关系名称'),label],[T('关系说明'),body]].forEach(([title,input])=>{const l=el('label','field-label',title);l.htmlFor=input.id;form.append(l,input);});
  const type=el('select','text-field'),stage=el('input','text-field');type.id='relation-type';stage.id='relation-stage';stage.maxLength=200;Object.entries(relationTypes).filter(([key])=>key!=='automatic').forEach(([key,text])=>{const option=el('option',null,text);option.value=key;type.append(option);});type.value=item.type;stage.value=item.stage;addField(form,T('关系类型'),type);addField(form,T('阶段 / 变化'),stage);const scopes=el('div','relation-volume-choices'),scopeChecks=[];activeVolumes().forEach(volume=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=item.volumeIds.includes(volume.id);row.append(box,el('span',null,volume.title));scopes.append(row);scopeChecks.push({box,id:volume.id});});if(activeVolumes().length)form.append(el('label','field-label',T('关联卷')),scopes);function apply(){if(from.value===to.value){from.value=item.fromId;to.value=item.toId;toast(T('请选择两个不同的人物。'));return false;}item.fromId=from.value;item.toId=to.value;item.label=label.value.trim();item.body=body.value;item.type=type.value;item.stage=stage.value;item.volumeIds=[...item.volumeIds.filter(id=>!scopeChecks.some(c=>c.id===id)),...scopeChecks.filter(c=>c.box.checked).map(c=>c.id)];if(fresh&&!state.book.relations.some(r=>r.id===item.id))state.book.relations.push(item);markDirty();renderBacklinks();renderGraph();renderPersonRelations();return true;}
  label.addEventListener('input',apply);body.addEventListener('input',apply);type.addEventListener('change',apply);stage.addEventListener('input',apply);scopeChecks.forEach(c=>c.box.addEventListener('change',apply));from.addEventListener('change',apply);to.addEventListener('change',apply);form.prepend(el('p','dialog-description',T('关系文字和人物选择会自动保存到本机，也可以按 Ctrl+S 立即保存。')));
  if(!fresh){const section=el('div','linked-section'),header=el('div','section-label'),links=el('div');header.append(el('span',null,T('关联正文')),action(state.kind==='short'?T('关联正文'):T('＋ 关联章节'),'text-button',()=>{if(apply())chooseChapters(item,()=>{renderPeople();showRelation(item);});}));renderChapterLinks(links,item,apply);section.append(header,links);form.append(section);}
  const a=el('div','dialog-actions');if(!fresh)a.append(action(T('移入回收站'),'secondary-button',()=>confirmTrash('relation')));a.append(action(T('关闭'),'secondary-button',()=>{closeDialog();renderPeople();}));const submit=el('button','primary-button',T('保存关系'));submit.type='submit';a.append(submit);form.append(a);form.addEventListener('submit',async event=>{event.preventDefault();if(apply()&&await saveNow()){closeDialog();renderPeople();toast(T('人物关系已保存。'));}});showDialog(fresh?T('添加人物关系'):T('人物关系'),form);
}
function bindPlanningEvents(){
  $('nav-home').addEventListener('click',()=>navigate('home'));$('writing-compare').addEventListener('click',()=>window.WriterEditorTools?.toggleComparison());
  $('nav-shelf').addEventListener('click',()=>showCollection('shelf'));$('nav-outline').addEventListener('click',()=>navigate('outline'));$('nav-people').addEventListener('click',()=>navigate('people'));
  $('nav-write').addEventListener('click',()=>navigate('write'));
  ['long','short'].forEach(kind=>$('shelf-'+kind).addEventListener('click',()=>showCollection('shelf',kind)));
  $('new-book').addEventListener('click',()=>showBookName(false));$('empty-new-book').addEventListener('click',()=>showBookName(false));
  $('toggle-nav').addEventListener('click',()=>{$('workspace').classList.add('nav-open');$('nav-backdrop').hidden=false;});$('close-nav').addEventListener('click',closeNav);$('nav-backdrop').addEventListener('click',closeNav);
  $('add-outline').addEventListener('click',()=>showNewOutline());$('outline-child').addEventListener('click',()=>showNewOutline(state.outlineId));$('trash-outline').addEventListener('click',()=>confirmTrash('outline'));
  $('outline-up').addEventListener('click',()=>moveOutline(-1));$('outline-down').addEventListener('click',()=>moveOutline(1));
  $('outline-title').addEventListener('input',()=>{const item=currentOutline();if(!item)return;item.title=$('outline-title').value;syncOutlineVolume(item);markDirty();const title=$('outline-tree').querySelector('.outline-node.active .outline-node-title');if(title)title.textContent=item.title||T('未命名节点');renderBacklinks();});
  $('outline-body').addEventListener('input',()=>{const item=currentOutline();if(!item)return;item.body=$('outline-body').value;syncOutlineVolume(item);markDirty();});$('outline-parent').addEventListener('change',()=>{if(!currentOutline())return;const item=currentOutline();item.parentId=$('outline-parent').value||null;if(item.kind==='chapter'||item.kind==='scene'){const parent=activeOutline().find(o=>o.id===item.parentId);item.volumeId=parent?outlineVolume(parent)?.id||null:null;}markDirty();renderOutline();});$('outline-link').addEventListener('click',()=>chooseChapters(currentOutline(),renderOutline));
  $('add-person').addEventListener('click',addPerson);$('add-relation').addEventListener('click',()=>showRelation());$('person-relation').addEventListener('click',()=>showRelation());$('trash-person').addEventListener('click',()=>confirmTrash('person'));
  $('person-title').addEventListener('input',()=>{const person=currentPerson();if(!person)return;person.title=$('person-title').value;markDirty();renderGraph();renderNotes();renderBacklinks();});$('person-body').addEventListener('input',()=>{if(!currentPerson())return;currentPerson().body=$('person-body').value;markDirty();});$('person-search').addEventListener('input',renderPersonSearch);$('person-link').addEventListener('click',()=>chooseChapters(currentPerson(),renderPeople));
  $('link-current-chapter').addEventListener('click',linkCurrentChapter);$('backlinks-edit').addEventListener('click',linkCurrentChapter);$('return-source').addEventListener('click',()=>transition(async()=>{if(!await requireSaved())return;const trail=state.trail;if(!trail)return;state.view=trail.view;state.outlineId=trail.outlineId;state.personId=trail.personId;state.trail=null;if(state.view==='outline')revealOutlinePath(state.outlineId);renderShell();if(state.view==='outline')selectOutlineNode(state.outlineId);}));
}

