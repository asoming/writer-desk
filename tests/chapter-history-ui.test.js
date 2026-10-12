'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));

class Element{
  constructor(tag='div',className='',textContent=''){Object.assign(this,{tagName:tag,className,textContent,children:[],listeners:{},attributes:{},hidden:false,disabled:false,isConnected:false,open:false});}
  connect(value){this.isConnected=value;this.children.forEach(child=>child.connect(value));}
  append(...children){this.children.push(...children);children.forEach(child=>child.connect(this.isConnected));}
  replaceChildren(...children){this.children.forEach(child=>child.connect(false));this.children=[];this.append(...children);}
  contains(node){return this===node||this.children.some(child=>child.contains(node));}
  setAttribute(name,value){this.attributes[name]=String(value);}
  set innerHTML(_){throw Error('History must render user text safely');}
}
const nodes=node=>[node,...node.children.flatMap(nodes)];
const find=(node,predicate)=>nodes(node).find(predicate);
const button=(node,label)=>find(node,item=>item.tagName==='button'&&item.textContent===label);
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function harness(){
  const chapter=(id,deletedAt=null)=>({id,title:id==='deleted'?'已删除章节 <img src=x>':'当前章节',body:id==='deleted'?'保留原文\n<script>window.bad=true</script>':'未删除正文',deletedAt,volumeId:'v'});
  const makeBook=id=>({id,title:'作品 '+id,kind:'long',chapters:[chapter('current'),chapter('deleted','2026-10-12T01:02:03Z')],volumes:[{id:'v',deletedAt:null}],outline:[{id:'o',deletedAt:null}],notes:[{id:'p',deletedAt:null}]});
  const stored=new Map([['a',{book:makeBook('a'),revision:7}],['b',{book:makeBook('b'),revision:12}]]);
  const state={book:copy(stored.get('a').book),revision:7,view:'write',collection:null,chapterId:'current',volumeId:'v',outlineId:'o',personId:'p',noteId:null,dirty:false,seq:0,transitioning:false,composing:false};
  const elements=new Map(),calls=[],messages=[],sets=[],cleanup=[];
  const get=id=>{if(!elements.has(id)){const element=new Element();element.connect(true);elements.set(id,element);}return elements.get(id);};
  let allowed=true;
  const context=vm.createContext({window:{},state,uiLanguage:'zh',Date,encodeURIComponent,
    $:get,clearTimeout,el:(tag,cls,text)=>new Element(tag,cls,text),T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),
    action:(text,cls,listener)=>{const element=new Element('button',cls,text);element.listeners.click=listener;return element;},
    showDialog:(title,content)=>{get('dialog').open=true;get('dialog-title').textContent=title;get('dialog-body').replaceChildren(content);},
    toast:message=>messages.push(message),requireSaved:async()=>{if(!allowed)return false;if(state.dirty){const record=stored.get(state.book.id);record.book=copy(state.book);record.revision++;state.revision=record.revision;state.dirty=false;}return true;},
    transition:async task=>{if(state.transitioning)return false;state.transitioning=true;try{return await task();}finally{state.transitioning=false;}},
    setBook:record=>{sets.push(copy(record));state.book=record.book;state.revision=record.revision;state.seq=0;state.dirty=false;state.view='outline';state.chapterId='deleted';},
    selectChapter:id=>{state.chapterId=id;},refreshBooks:async()=>{},renderShell:()=>{},
    api:async(endpoint,method='GET',data)=>{
      calls.push({endpoint,method,data:data?copy(data):data});
      if(context.override){const result=context.override(endpoint,method,data);if(result!==undefined)return result;}
      if(endpoint==='/api/history/chapters')return{chapters:[...stored.values()].flatMap(({book,revision})=>book.chapters.filter(item=>item.deletedAt).map(item=>({bookId:book.id,bookTitle:book.title,kind:book.kind,revision,bookDeleted:false,chapterId:item.id,title:item.title,deletedAt:item.deletedAt,wordCount:4,canRestore:true})))};
      const match=endpoint.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/(history|restore|purge)$/);assert.ok(match,'Unexpected endpoint '+endpoint);
      const [,bookId,chapterId,operation]=match,record=stored.get(decodeURIComponent(bookId)),target=record.book.chapters.find(item=>item.id===decodeURIComponent(chapterId));assert.ok(record&&target);
      if(method==='GET')return{bookId:record.book.id,bookTitle:record.book.title,revision:record.revision,chapter:copy(target)};
      assert.equal(method,'POST');if(record.revision!==data.revision)throw Error('作品已在另一个窗口更新');
      if(operation==='restore')target.deletedAt=null;else record.book.chapters=record.book.chapters.filter(item=>item!==target);
      record.revision++;return{...copy(record),removedChapterIds:operation==='purge'?[target.id]:[],...(operation==='purge'?{purgedAt:'2026-10-12T03:04:05Z',clearBookLocalCopies:true}:{})};
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root,'public/chapter-history.js'),'utf8'),context);
  const module=context.window.WriterChapterHistory;module.configure({afterPurge:(record,result)=>cleanup.push({record:copy(record),result:copy(result)})});
  return{context,state,stored,calls,messages,sets,cleanup,get,module,body:()=>get('dialog-body'),allowSave:value=>{allowed=value;},record:(bookId='a')=>({bookId,bookTitle:'作品 '+bookId,chapterId:'deleted',title:'已删除章节 <img src=x>',revision:stored.get(bookId).revision,deletedAt:'2026-10-12T01:02:03Z',canRestore:true})};
}

test('global history groups deleted chapters by book, renders safe titles and dates, and previews exact read-only text',async()=>{
  const h=harness(),before=copy(h.state.book);await h.module.open();
  assert.equal(h.get('dialog-title').textContent,'历史记录');assert.equal(nodes(h.body()).filter(item=>item.tagName==='h3').length,2);
  const title=find(h.body(),item=>item.className==='chapter-history-title');assert.equal(title.textContent,'已删除章节 <img src=x>');
  assert.match(find(h.body(),item=>item.className==='chapter-history-date').textContent,/2026/);
  await title.listeners.click();const prose=find(h.body(),item=>item.className?.includes('chapter-history-prose'));
  assert.equal(prose.readOnly,true);assert.equal(prose.value,h.stored.get('a').book.chapters[1].body);assert.deepEqual(h.state.book,before);assert.equal(h.sets.length,0);assert.equal(h.calls.filter(call=>call.method!=='GET').length,0);
});

test('failed saving blocks opening and mutation, while restore saves first and uses the new current revision',async()=>{
  const h=harness();h.allowSave(false);assert.equal(await h.module.open(),false);assert.equal(h.calls.length,0);
  assert.equal(await h.module.restore(h.record()),false);assert.equal(h.calls.length,0);
  h.allowSave(true);h.state.book.chapters[0].body+=' 未保存段落';h.state.dirty=true;const expected=copy(h.state.book.chapters[0]);
  assert.equal(await h.module.restore(h.record(),{onDone:()=>{}}),true);
  const mutation=h.calls.find(call=>call.method==='POST');assert.equal(mutation.data.revision,8);assert.equal(h.state.revision,9);assert.deepEqual(h.state.book.chapters[0],expected);
  assert.equal(h.state.book.chapters[1].deletedAt,null);assert.equal(h.state.view,'write');assert.equal(h.state.chapterId,'current');assert.equal(h.state.volumeId,'v');assert.equal(h.state.outlineId,'o');
});

test('restoring another book uses its own revision and never replaces the current book or selection',async()=>{
  const h=harness(),before=copy(h.state);assert.equal(await h.module.restore(h.record('b'),{onDone:()=>{}}),true);
  assert.equal(h.calls.find(call=>call.method==='POST').data.revision,12);assert.deepEqual(h.state,before);assert.equal(h.sets.length,0);
});

test('purge requires explicit confirmation, explains application storage scope, cleans client copies and returns to the requested surface',async()=>{
  const h=harness();let returned=0;h.module.confirmPurge(h.record(),{onDone:()=>returned++});
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0);assert.ok(find(h.body(),item=>item.textContent==='将从作家工作台的正文、历史版本与自动备份中移除，无法恢复；你另外导出的文件、系统备份不受此操作控制。'));
  await button(h.body(),'彻底删除').listeners.click();assert.equal(returned,1);assert.equal(h.cleanup.length,1);assert.deepEqual(h.cleanup[0].result.removedChapterIds,['deleted']);
  assert.equal(h.state.book.chapters.some(item=>item.id==='deleted'),false);assert.equal(h.messages.at(-1),'章节已彻底删除。');
});

test('canceling or hiding purge confirmation cannot delete a chapter',async()=>{
  const h=harness();let canceled=0;h.module.confirmPurge(h.record(),{onCancel:()=>canceled++});await button(h.body(),'取消').listeners.click();assert.equal(canceled,1);assert.equal(h.calls.length,0);
  const confirm=button(h.body(),'彻底删除');h.get('dialog').open=false;await confirm.listeners.click();assert.equal(h.calls.length,0);
});

test('a stale revision or mismatched response keeps text and selection and never invokes client cleanup',async()=>{
  const h=harness(),record=h.record('b'),before=copy(h.state);h.stored.get('b').revision++;
  assert.equal(await h.module.restore(record,{onDone:()=>{}}),false);assert.deepEqual(h.state,before);assert.match(h.messages.at(-1),/另一个窗口/);
  h.context.override=(endpoint,method)=>method==='POST'?{book:{id:'wrong'},revision:99,removedChapterIds:['deleted']}:undefined;
  h.module.confirmPurge(h.record());await button(h.body(),'彻底删除').listeners.click();assert.deepEqual(h.state,before);assert.equal(h.cleanup.length,0);assert.equal(button(h.body(),'彻底删除').disabled,false);
});

test('a late list or preview cannot replace a newer dialog',async()=>{
  const h=harness();let resolveList;h.context.override=endpoint=>endpoint==='/api/history/chapters'?new Promise(resolve=>{resolveList=resolve;}):undefined;
  const old=h.module.open();await settle();h.get('dialog-body').replaceChildren(new Element('p','','new dialog'));resolveList({chapters:[h.record()]});await old;
  assert.equal(h.body().children[0].textContent,'new dialog');
  h.context.override=null;await h.module.open();let resolvePreview;h.context.override=(endpoint,method)=>method==='GET'&&endpoint.includes('/history')?new Promise(resolve=>{resolvePreview=resolve;}):undefined;
  const title=find(h.body(),item=>item.className==='chapter-history-title'),pending=title.listeners.click();h.get('dialog-body').replaceChildren(new Element('p','','different dialog'));resolvePreview({bookId:'a',chapter:{id:'deleted',body:'old text'}});await pending;
  assert.equal(h.body().children[0].textContent,'different dialog');
});

test('a mutation response cannot overwrite a later book selection or edit sequence',async()=>{
  for(const change of ['book','seq']){
    const h=harness();let resolveMutation;h.context.override=(endpoint,method)=>method==='POST'?new Promise(resolve=>{resolveMutation=resolve;}):undefined;
    const pending=h.module.restore(h.record(),{onDone:()=>{}});await settle();
    if(change==='book')h.state.book=copy(h.stored.get('b').book);else{h.state.seq++;h.state.book.chapters[0].body+=' later edit';}
    const expected=copy(h.state.book),result=copy(h.stored.get('a'));result.revision++;result.book.chapters[1].deletedAt=null;resolveMutation(result);await pending;
    assert.deepEqual(h.state.book,expected);assert.equal(h.sets.length,0);
  }
});

test('recycled books disable restore, unknown dates are honest, and pending cleanup never claims completion',async()=>{
  const h=harness();h.context.override=endpoint=>endpoint==='/api/history/chapters'?{chapters:[{...h.record(),deletedAt:null,bookDeleted:true,canRestore:false}]}:undefined;
  await h.module.open();assert.equal(button(h.body(),'恢复').disabled,true);assert.ok(find(h.body(),item=>item.textContent.includes('时间未知')));assert.equal(h.module.formatTime('bad-date'),'时间未知');
  h.context.override=(endpoint,method)=>method==='POST'?{...copy(h.stored.get('a')),revision:8,removedChapterIds:['deleted'],cleanupPending:true}:undefined;
  h.module.confirmPurge(h.record(),{onDone:()=>{}});await button(h.body(),'彻底删除').listeners.click();assert.equal(h.messages.at(-1),'章节已删除，本机备份清理尚未完成，请稍后重试。');
});

test('pending cleanup is retried only by an explicit POST and the list stays read-only',async()=>{
  const h=harness();let pending=true;
  h.context.override=(endpoint,method)=>{
    if(endpoint==='/api/history/chapters/cleanup'){assert.equal(method,'POST');pending=false;return{cleanupPendingBooks:[]};}
    if(endpoint==='/api/history/chapters')return{chapters:[],cleanupPendingBooks:pending?['a']:[]};
    return undefined;
  };
  await h.module.open();assert.equal(h.calls.filter(call=>call.method==='POST').length,0);
  assert.ok(find(h.body(),item=>item.textContent==='部分本机副本尚未清理完成，作家工作台会继续重试。'));
  await button(h.body(),'重试').listeners.click();assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(h.calls.at(-1).endpoint,'/api/history/chapters');assert.equal(h.calls.at(-1).method,'GET');
  assert.equal(find(h.body(),item=>item.className==='chapter-history-pending'),undefined);
});

test('client cleanup failure does not roll back an already completed purge or leave the old revision live',async()=>{
  const h=harness();h.module.configure({afterPurge:async()=>{throw Error('本机草稿清理未完成');}});
  let done=0;h.module.confirmPurge(h.record(),{onDone:()=>done++});await button(h.body(),'彻底删除').listeners.click();
  assert.equal(done,1);assert.equal(h.state.revision,8);assert.equal(h.state.book.chapters.some(item=>item.id==='deleted'),false);
  assert.equal(h.messages.at(-1),'本机草稿清理未完成');
});

test('stable book ID guards allow returning after setBook replaces the current object',async()=>{
  for(const operation of ['restore','purge']){
    const h=harness(),original=h.state.book;let done=0;
    const options={isCurrent:()=>h.state.book?.id===original.id,onDone:()=>done++};
    if(operation==='restore')await h.module.restore(h.record(),options);else{h.module.confirmPurge(h.record(),options);await button(h.body(),'彻底删除').listeners.click();}
    assert.notEqual(h.state.book,original);assert.equal(done,1);
  }
});

test('beforePurge runs after saving and before the request; aborting its preparation prevents deletion',async()=>{
  const h=harness();h.state.dirty=true;let prepared=0;
  h.module.configure({beforePurge:async record=>{prepared++;assert.equal(record.bookId,'a');assert.equal(h.state.revision,8);assert.equal(h.calls.some(call=>call.method==='POST'),false);},afterPurge:async(record,result)=>{assert.equal(record.bookId,'a');assert.equal(result.purgedAt,'2026-10-12T03:04:05Z');}});
  h.module.confirmPurge(h.record(),{onDone:()=>{}});await button(h.body(),'彻底删除').listeners.click();assert.equal(prepared,1);assert.equal(h.state.revision,9);
  const blocked=harness();blocked.module.configure({beforePurge:async()=>{throw Error('无法停止当前 AI 请求');}});
  blocked.module.confirmPurge(blocked.record());await button(blocked.body(),'彻底删除').listeners.click();assert.equal(blocked.calls.some(call=>call.method==='POST'),false);assert.equal(blocked.state.revision,7);assert.equal(blocked.messages.at(-1),'无法停止当前 AI 请求');
});

test('failed client cleanup remains visible in history and can be retried without repeating the chapter purge',async()=>{
  const h=harness();let attempts=0;h.module.configure({afterPurge:async()=>{if(++attempts===1)throw Error('本机草稿清理未完成');}});
  h.context.override=endpoint=>endpoint==='/api/history/chapters/cleanup'?{cleanupPendingBooks:[]}:undefined;
  h.module.confirmPurge(h.record());await button(h.body(),'彻底删除').listeners.click();
  assert.ok(find(h.body(),item=>item.className==='chapter-history-pending'));assert.equal(h.messages.at(-1),'本机草稿清理未完成');
  await button(h.body(),'重试').listeners.click();assert.equal(attempts,2);assert.equal(find(h.body(),item=>item.className==='chapter-history-pending'),undefined);
  assert.equal(h.calls.filter(call=>call.endpoint.endsWith('/purge')).length,1);assert.equal(h.calls.filter(call=>call.endpoint.endsWith('/cleanup')).length,1);
});

test('a purge response cannot silently leave a newly changed stale draft saveable',async()=>{
  const h=harness();let resolveMutation;h.context.override=(endpoint,method)=>method==='POST'?new Promise(resolve=>{resolveMutation=resolve;}):undefined;
  h.module.confirmPurge(h.record(),{onDone:()=>{}});const pending=button(h.body(),'彻底删除').listeners.click();await settle();
  h.state.seq++;h.state.book.chapters[0].body+=' new edit';const result=copy(h.stored.get('a'));result.book.chapters=result.book.chapters.filter(item=>item.id!=='deleted');result.revision++;result.removedChapterIds=['deleted'];
  resolveMutation(result);await pending;assert.equal(h.sets.length,0);assert.equal(h.state.conflict,true);assert.equal(h.state.error.conflict,true);assert.equal(h.state.dirty,true);
  assert.equal(h.messages.at(-1),'章节已删除，当前页面仍有旧稿，请重新打开作品后继续写作。');
});
