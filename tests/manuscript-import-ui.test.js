'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.value='';this.textContent='';this.style={};this.disabled=false;this.open=false;}
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
  replaceChildren(...items){for(const item of this.children)item.parentElement=null;this.children=[];this.append(...items);}
  addEventListener(type,callback){this.listeners[type]=callback;}setAttribute(key,value){this[key]=String(value);}focus(){}
  get isConnected(){return this.tagName==='BODY'||!!this.parentElement?.isConnected;}
}
const walk=node=>[node,...node.children.flatMap(walk)];
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{resolve,promise};}
function harness(){
  const body=new Element('body'),dialog=new Element('dialog');body.append(dialog);const state={kind:'long',book:{id:'original',title:'原小说'},composing:false,transitioning:false},h={calls:[],toasts:[],saved:[],refreshes:0,gate:async()=>true};let uuid=0;
  const preview={sourceHash:'a'.repeat(64),title:'稿件',kind:'long',words:6,volumes:[{key:'v0',title:'第一卷'}],chapters:[{key:'c0',title:'第一章',volumeKey:'v0',body:'未覆盖原小说。',words:6}],warnings:[]};
  h.api=async(url,method,data)=>url.endsWith('/preview')?structuredClone({...preview,kind:data.kind,volumes:data.kind==='short'?[]:preview.volumes}):{book:{id:'imported',title:'稿件'},revision:1};
  const context=vm.createContext({state,btoa,Uint8Array,console,crypto:{randomUUID:()=>`request-${++uuid}`},T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,n)=>args[n]??''),$:(id)=>{assert.equal(id,'dialog');return dialog;},el:(tag,className,text)=>{const node=new Element(tag);node.className=className||'';node.textContent=text??'';return node;},requireSaved:()=>h.gate(),api:async(...args)=>{h.calls.push(structuredClone(args));return await h.api(...args);},transition:async fn=>{state.transitioning=true;try{return await fn();}finally{state.transitioning=false;}},setBook:r=>{h.saved.push(r);state.book=r.book;},closeDialog:()=>{dialog.open=false;},refreshBooks:async()=>{h.refreshes++;},renderShell(){},toast:text=>h.toasts.push(text)});context.window=context;
  context.action=(text,className,callback)=>{const node=new Element('button');node.textContent=text;node.className=className;node.listeners.click=callback;return node;};
  context.showDialog=(title,root)=>{dialog.replaceChildren(root);dialog.open=true;};vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/manuscript-import.js'),'utf8'),context);
  h.state=state;h.dialog=dialog;h.open=()=>context.ManuscriptImport.show();h.field=label=>{const node=walk(dialog).find(n=>n['aria-label']===label);assert.ok(node,'Missing '+label);return node;};h.button=label=>{const node=walk(dialog).find(n=>n.tagName==='BUTTON'&&n.textContent===label);assert.ok(node,'Missing '+label);return node;};h.file=async(name='小说.txt',content='第一章\n正文。')=>{const input=h.field('稿件文件'),bytes=new TextEncoder().encode(content);input.files=[{name,size:bytes.length,arrayBuffer:async()=>bytes.buffer}];await input.listeners.change();};h.preview=()=>h.button('预览').listeners.click();return h;
}

test('preview is read-only, commit creates a separate book and carries identical source plus digest and request id',async()=>{
  const h=harness();await h.open();await h.file();assert.equal(h.calls.length,0);await h.preview();assert.equal(h.calls.length,1);assert.equal(h.state.book.id,'original');assert.equal(h.saved.length,0);
  h.field('卷名 第一卷').value='第二卷';h.field('卷名 第一卷').listeners.input();h.field('章节标题 第一章').value='旧船票';h.field('章节标题 第一章').listeners.input();await h.button('导入为新作品').listeners.click();
  assert.equal(h.calls.length,2);const first=h.calls[0][2],last=h.calls[1][2];for(const key of ['filename','content','kind','title','options'])assert.deepEqual(last[key],first[key]);assert.equal(last.sourceHash,'a'.repeat(64));assert.equal(last.requestId,'request-1');assert.deepEqual(last.edits,{volumes:{v0:'第二卷'},chapters:{c0:'旧船票'}});assert.equal(h.state.book.id,'imported');assert.equal(h.refreshes,1);assert.equal(h.dialog.open,false);
});

test('failed save gate and cancellation never import or mutate the original book',async()=>{
  const blocked=harness();blocked.gate=async()=>false;await blocked.open();assert.equal(blocked.dialog.open,false);assert.equal(blocked.calls.length,0);
  const h=harness();await h.open();await h.file();await h.preview();h.gate=async()=>false;await h.button('导入为新作品').listeners.click();assert.equal(h.calls.length,1);assert.equal(h.state.book.id,'original');h.button('取消').listeners.click();assert.equal(h.dialog.open,false);
});

test('changing file options or book title invalidates preview and requires another preview before commit',async()=>{
  for(const [label,value] of [['作品类型','short'],['分章策略','single'],['文字编码','utf-16'],['作品名称','新作品']]){const h=harness();await h.open();await h.file();await h.preview();const control=h.field(label);control.value=value;control.listeners.input();assert.equal(h.button('导入为新作品').disabled,true,label);await h.button('导入为新作品').listeners.click();assert.equal(h.calls.length,1,label);await h.preview();assert.equal(h.button('导入为新作品').disabled,false,label);}
});

test('stale preview responses and closing the dialog cannot enable a commit or change a library',async()=>{
  const h=harness();await h.open();await h.file();const pending=deferred();h.api=()=>pending.promise;const previewing=h.preview();const type=h.field('作品类型');type.value='short';type.listeners.input();pending.resolve({kind:'long',words:1,volumes:[],chapters:[],warnings:[]});await previewing;assert.equal(h.button('导入为新作品').disabled,true);assert.equal(h.state.book.id,'original');
  const other=harness();await other.open();await other.file();const wait=deferred();other.api=()=>wait.promise;const task=other.preview();other.button('取消').listeners.click();wait.resolve({});await task;assert.equal(other.saved.length,0);
});

test('network retry retains the same idempotency id and double click cannot issue a second commit',async()=>{
  const h=harness();await h.open();await h.file();await h.preview();let failing=true;h.api=async()=>{if(failing)throw new Error('offline');return{book:{id:'imported'},revision:1};};await h.button('导入为新作品').listeners.click();assert.equal(h.dialog.open,true);assert.equal(h.saved.length,0);const id=h.calls.at(-1)[2].requestId;
  failing=false;const wait=deferred();h.api=()=>wait.promise;const commit=h.button('导入为新作品').listeners.click();await Promise.resolve();await h.button('导入为新作品').listeners.click();wait.resolve({book:{id:'imported'},revision:1});await commit;assert.equal(h.calls.filter(c=>c[0].endsWith('/commit')).length,2);assert.equal(h.calls.at(-1)[2].requestId,id);assert.equal(h.saved.length,1);
});

test('file type, size, read race and short layout are handled before an API mutation',async()=>{
  for(const name of ['macro.docm','app.exe']){const h=harness();await h.open();await h.file(name);await h.preview();assert.equal(h.calls.length,0);}
  const h=harness();await h.open();const input=h.field('稿件文件');input.files=[{name:'big.txt',size:13*1024*1024,arrayBuffer(){throw new Error('must not read');}}];await input.listeners.change();assert.equal(h.calls.length,0);
  const read=deferred();input.files=[{name:'old.txt',size:1,arrayBuffer:()=>read.promise}];const pending=input.listeners.change();await h.file('new.txt','新稿');read.resolve(new TextEncoder().encode('旧稿').buffer);await pending;const kind=h.field('作品类型');kind.value='short';kind.listeners.input();await h.preview();assert.equal(h.calls[0][2].filename,'new.txt');assert.equal(h.calls[0][2].options.strategy,'single');assert.equal(h.field('分章策略').disabled,true);assert.equal(walk(h.dialog).filter(n=>(n['aria-label']||'').startsWith('章节标题')).length,0);
});

test('blank renamed chapter is rejected without API commit and editing it changes retry identity',async()=>{
  const h=harness();await h.open();await h.file();await h.preview();const chapter=h.field('章节标题 第一章');chapter.value=' ';chapter.listeners.input();await h.button('导入为新作品').listeners.click();assert.equal(h.calls.length,1);chapter.value='新章';chapter.listeners.input();h.api=async()=>{throw new Error('offline');};await h.button('导入为新作品').listeners.click();const before=h.calls.at(-1)[2].requestId;chapter.value='另一章';chapter.listeners.input();await h.button('导入为新作品').listeners.click();assert.notEqual(h.calls.at(-1)[2].requestId,before);
});

test('typing a book title while the selected file is still being read does not discard that file',async()=>{
  const h=harness();await h.open();const input=h.field('稿件文件'),read=deferred();input.files=[{name:'待载入.txt',size:4,arrayBuffer:()=>read.promise}];const loading=input.listeners.change();const title=h.field('作品名称');title.value='载入期间修改书名';title.listeners.input();read.resolve(new TextEncoder().encode('正文。').buffer);await loading;await h.preview();assert.equal(h.calls[0][2].filename,'待载入.txt');assert.equal(h.calls[0][2].title,'载入期间修改书名');
});
