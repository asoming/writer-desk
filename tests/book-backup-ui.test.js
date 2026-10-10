'use strict';

// Book-scoped exports and historical restore against disposable records only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{test}=require('node:test');
const root=path.resolve(__dirname,'..'),copy=value=>JSON.parse(JSON.stringify(value));
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.textContent='';this.value='';this.listeners={};this.open=false;this.hidden=false;this.isConnected=true;this.attributes={};this.style={setProperty(){}};this.classList={toggle(){},add(){},remove(){}};}
  append(...items){for(const item of items){this.children.push(item);item.parentElement=this;for(const node of all(item))node.isConnected=true;}}
  replaceChildren(...items){for(const item of this.children)for(const node of all(item))node.isConnected=false;this.children=[];this.append(...items);}
  contains(item){return all(this).includes(item);}
  addEventListener(name,callback){this.listeners[name]=callback;}
  setAttribute(name,value){this.attributes[name]=value;}
  querySelectorAll(){return[];}
  showModal(){this.open=true;}close(){this.open=false;}focus(){}select(){}
}
function all(node){return[node,...node.children.flatMap(all)];}
function text(node){return all(node).map(value=>value.textContent).filter(Boolean).join(' ');}
function find(node,predicate){const value=all(node).find(predicate);assert.ok(value,'Missing expected DOM element');return value;}
function novel(id,kind){return{id,title:'书名 '+id,kind,cover:'',volumes:kind==='long'?[{id:id+'-v',title:'第一卷',summary:'卷纲',deletedAt:null}]:[],
  chapters:[{id:id+'-c',title:'第一章',body:id+' 的保存正文。',volumeId:kind==='long'?id+'-v':null,deletedAt:null},{id:id+'-deleted',title:'回收章节',body:'应在完整备份中。',volumeId:null,deletedAt:'2026-10-10'}],
  notes:[{id:id+'-p',title:'作者人物',type:'人物',body:'人物设定',chapterIds:[id+'-c'],deletedAt:null}],outline:[{id:id+'-o',title:'故事大纲',body:'大纲说明',chapterIds:[id+'-c'],kind:'story',parentId:null,deletedAt:null}],relations:[],atlasViews:[]};}
function harness({current=true,dirty=false,kind='long',language='zh'}={}){
  const elements=new Map(),values=new Map([['writer-desk.language',language]]),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const context=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:()=>[],body:new Element(),documentElement:new Element()},crypto:{randomUUID},sessionStorage:storage,localStorage:storage,NodeFilter:{SHOW_TEXT:4},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:fn=>fn()});context.window=context;
  for(const file of ['i18n.js','app.js','workspace.js','protection.js']){let source=fs.readFileSync(path.join(root,'public',file),'utf8');if(file==='workspace.js')source=source.replace(/\ninitialize\(\);\s*$/,'\n');vm.runInContext(source,context,{filename:file});}
  const run=expression=>vm.runInContext(expression,context),state=run('state'),records=new Map(),calls=[],downloads=[],setCalls=[];
  for(const[id,type,revision]of[['active','long',7],['target-long','long',31],['target-short','short',42]])records.set(id,{book:novel(id,type),revision});
  const summaries=()=>[...records.values()].map(({book,revision})=>({id:book.id,title:book.title,kind:book.kind,cover:book.cover,chapterCount:1,charCount:20,volumeCount:book.volumes.length,updatedAt:'2026-10-10T00:00:00Z',revision}));
  const active=current?copy(records.get('active').book):null;if(dirty)active.chapters[0].body+=' 本页未保存段落。';
  Object.assign(state,{book:active,revision:current?7:0,dirty,seq:1,view:'shelf',kind,chapterId:active?.chapters[0].id,books:summaries()});
  context.backupAPI=async(endpoint,method='GET',data)=>{
    calls.push({endpoint,method,data:data===undefined?undefined:copy(data)});
    if(endpoint==='/api/books')return{books:summaries(),trashCount:0};
    if(endpoint==='/api/import'){const book=copy(data.book);book.id=randomUUID();const record={book,revision:1};records.set(book.id,record);return copy(record);}
    const match=endpoint.match(/^\/api\/books\/([^/]+)(.*)$/);assert.ok(match);const record=records.get(match[1]);assert.ok(record);const suffix=match[2];
    if(method==='PUT'){assert.equal(data.revision,record.revision);record.book=copy(data.book);record.revision++;return{revision:record.revision};}
    if(suffix==='/history')return{versions:[{revision:1,savedAt:'2026-10-10',chapterCount:1,charCount:18}],currentRevision:record.revision};
    if(suffix==='/backups')return{backups:[{revision:1,token:'snapshot.json',reason:'manual',savedAt:'2026-10-10',chapterCount:1,charCount:18}],currentRevision:record.revision};
    if(suffix==='/checkpoint')return{backup:{revision:record.revision,token:'snapshot.json'}};
    if(suffix.endsWith('/restore')){if(data.revision!==record.revision)throw Object.assign(new Error('历史版本冲突'),{conflict:true});record.book.chapters[0].body=record.book.id+' 的历史正文。';record.revision++;return copy(record);}
    if(suffix.startsWith('/history/')||suffix.startsWith('/backups/')){const book=copy(record.book);book.chapters[0].body=book.id+' 的历史正文。';return{book,revision:1,savedAt:'2026-10-10',chapterCount:1,charCount:18};}
    assert.equal(suffix,'');return copy(record);
  };
  context.downloads=downloads;context.setCalls=setCalls;run('api=(...args)=>backupAPI(...args);download=(name,body,type)=>downloads.push({name,body,type});renderBacklinks=()=>{};renderShell=()=>renderCollection();setBook=result=>{setCalls.push(result.book.id);state.book=result.book;state.revision=result.revision;state.kind=result.book.kind;state.dirty=false;state.conflict=false;state.error=null;};');
  const click=label=>find(get('dialog-body'),node=>node.tagName==='BUTTON'&&text(node)===label).listeners.click();
  async function open(id){state.kind=records.get(id).book.kind;run('renderCollection()');const card=find(get('shelf-grid'),node=>node.className==='shelf-book'&&text(node).includes(records.get(id).book.title));await find(card,node=>node.tagName==='BUTTON'&&text(node)===(language==='en'?'Export and backup':'导出与备份')).listeners.click();}
  return{context,state,records,calls,downloads,setCalls,active,get,run,click,open};
}

test('exports belong to every long/short shelf card, with no sidebar export or global history action',async()=>{
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');assert.ok(!html.includes('id="open-backup"'));assert.ok(html.includes('id="import-backup"'));
  for(const language of ['zh','en'])for(const kind of ['long','short']){const h=harness({current:false,kind,language});await h.open('target-'+kind);assert.equal(h.state.book,null);assert.equal(h.state.view,'shelf');assert.ok(h.get('dialog-title').textContent.includes('书名 target-'+kind));assert.equal(h.setCalls.length,0);}
  const protection=fs.readFileSync(path.join(root,'public/protection.js'),'utf8');assert.ok(!protection.includes("()=>showHistory()"));
});

test('another book export saves current prose first, then downloads only the fixed target in TXT, Markdown and v3 backup',async()=>{
  for(const kind of ['long','short']){const h=harness({dirty:true,kind}),before=copy(h.active),target=copy(h.records.get('target-'+kind).book);await h.open(target.id);
    assert.deepEqual(h.calls.slice(0,2).map(call=>[call.endpoint,call.method]),[['/api/books/active','PUT'],['/api/books/'+target.id,'GET']]);
    await h.click('TXT 正文');await h.click('Markdown 正文');await h.click('下载完整备份');
    assert.equal(h.downloads.length,3);assert.ok(h.downloads[0].name.startsWith(target.title));assert.ok(h.downloads[0].body.includes(target.chapters[0].body));assert.ok(!h.downloads[0].body.includes(before.chapters[0].body));assert.ok(!h.downloads[0].body.includes('应在完整备份中'));
    assert.ok(h.downloads[1].body.startsWith('# '+target.title));assert.deepEqual(JSON.parse(h.downloads[2].body).book,target);assert.equal(JSON.parse(h.downloads[2].body).version,3);
    assert.equal(h.state.book,h.active);assert.deepEqual(h.active,before);assert.equal(h.state.revision,8);assert.equal(h.state.view,'shelf');assert.deepEqual(h.setCalls,[]);
  }
});

test('queued current-book edits are saved and reread before a fixed-target download',async()=>{
  const h=harness();await h.open('active');h.active.chapters[0].body+=' 下载前排队的新段落。';h.run('markDirty()');await h.click('下载完整备份');
  assert.equal(JSON.parse(h.downloads[0].body).book.chapters[0].body,h.active.chapters[0].body);assert.equal(h.state.revision,8);
  assert.deepEqual(h.calls.slice(-2).map(call=>call.method),['PUT','GET']);
});

test('save failures and missing or mismatched target responses never download or switch the edited book',async()=>{
  const failed=harness({dirty:true}),before=copy(failed.active);failed.context.backupAPI=async()=>{throw new Error('当前作品保存失败');};await failed.run("showBackup('target-long')");assert.equal(failed.get('dialog').open,false);assert.deepEqual(failed.active,before);assert.equal(failed.state.dirty,true);
  for(const broken of ['missing','mismatch']){const h=harness(),api=h.context.backupAPI;await h.open('target-long');h.context.backupAPI=(endpoint,...args)=>{if(endpoint==='/api/books/target-long'){if(broken==='missing')throw new Error('作品已删除');return{book:copy(h.records.get('active').book),revision:7};}return api(endpoint,...args);};await h.click('下载完整备份');assert.equal(h.downloads.length,0);assert.equal(h.state.book,h.active);assert.equal(h.setCalls.length,0);}
});

test('closing a pending export or replacing its dialog prevents late files and old actions cannot download a newly selected book',async()=>{
  const h=harness();await h.open('target-long');const old=find(h.get('dialog-body'),node=>node.tagName==='BUTTON'&&text(node)==='下载完整备份');await h.open('target-short');const count=h.calls.length;await old.listeners.click();assert.equal(h.calls.length,count);assert.equal(h.downloads.length,0);
  let release;const api=h.context.backupAPI;h.context.backupAPI=(endpoint,...args)=>endpoint==='/api/books/target-short'?new Promise(resolve=>{release=()=>resolve(api(endpoint,...args));}):api(endpoint,...args);
  const pending=h.click('下载完整备份');await Promise.resolve();await Promise.resolve();h.run('closeDialog()');release();await pending;assert.equal(h.downloads.length,0);assert.equal(h.state.book,h.active);
  const loading=h.run("showBackup('target-short')");await Promise.resolve();await Promise.resolve();h.run('closeDialog()');release();await loading;assert.equal(h.get('dialog').open,false);assert.equal(h.downloads.length,0);
});

test('another book historical restore and manual checkpoint use its ID and revision without replacing the current book',async()=>{
  const h=harness({dirty:true}),before=copy(h.active);await h.open('target-short');await h.click('历史与自动备份');assert.ok(h.get('dialog-title').textContent.includes('书名 target-short'));
  const row=find(h.get('dialog-body'),node=>node.className==='protection-version');await row.listeners.click();await h.click('恢复此版本');
  const restore=h.calls.find(call=>call.endpoint.endsWith('/restore'));assert.equal(restore.endpoint,'/api/books/target-short/history/1/restore');assert.equal(restore.data.revision,42);
  assert.deepEqual(h.active,before);assert.equal(h.state.book,h.active);assert.equal(h.state.revision,8);assert.equal(h.setCalls.length,0);assert.equal(h.records.get('target-short').revision,43);
  h.active.chapters[0].body+=' 备份前继续编辑。';h.run('markDirty()');const button=find(h.get('dialog-body'),node=>node.textContent==='立即备份');await button.listeners.click({currentTarget:button});
  assert.equal(h.calls.filter(call=>call.endpoint.endsWith('/checkpoint')).at(-1).endpoint,'/api/books/target-short/checkpoint');assert.equal(h.state.book,h.active);assert.equal(h.state.revision,9);assert.equal(h.setCalls.length,0);
});

test('a target history conflict retains both books and a closed preview cannot later restore',async()=>{
  const h=harness();await h.open('target-long');await h.click('历史与自动备份');await find(h.get('dialog-body'),node=>node.className==='protection-version').listeners.click();h.records.get('target-long').revision++;
  const before=copy(h.records.get('target-long').book);await h.click('恢复此版本');assert.deepEqual(h.records.get('target-long').book,before);assert.equal(h.state.book,h.active);assert.equal(h.setCalls.length,0);
  const restore=find(h.get('dialog-body'),node=>node.textContent==='恢复此版本');h.run('closeDialog()');const count=h.calls.length;await restore.listeners.click();assert.equal(h.calls.length,count);
});

test('importing a complete backup still creates a separate new book instead of overwriting either existing target',async()=>{
  const h=harness(),source=copy(h.records.get('target-short').book),original=copy(h.active);h.context.importFile={size:2000,text:async()=>JSON.stringify({format:'yejian-backup',version:3,book:source})};await h.run('importBackup(importFile)');
  assert.notEqual(h.state.book.id,source.id);assert.notEqual(h.state.book.id,'active');assert.deepEqual(h.records.get('target-short').book,source);assert.deepEqual(h.records.get('active').book,original);assert.equal(h.state.view,'write');
});
