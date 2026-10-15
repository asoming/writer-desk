'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.value='';this.textContent='';this.style={};this.dataset={};this.disabled=false;this.inert=false;this.open=false;this.clientHeight=600;this.offsetTop=0;this.offsetHeight=100;}
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}if(this.tagName==='SELECT'&&!this.value&&this.children[0])this.value=this.children[0].value;}
  replaceChildren(...items){for(const item of this.children)item.parentElement=null;this.children=[];this.append(...items);}
  addEventListener(type,handler){this.listeners[type]=handler;}
  setAttribute(key,value){this[key]=String(value);}
  querySelector(selector){return walk(this).find(item=>selector.startsWith('.')?(item.className||'').split(' ').includes(selector.slice(1)):item.tagName===selector.toUpperCase());}
  get isConnected(){return this.tagName==='BODY'||!!this.parentElement?.isConnected;}
  focus(){}setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}getBoundingClientRect(){return{width:600};}
  remove(){this.parentElement.children=this.parentElement.children.filter(item=>item!==this);this.parentElement=null;}
}
function walk(node){return node.children.flatMap(child=>[child,...walk(child)]);}
function make(){return{id:'review-book',kind:'long',title:'临时稿',chapters:[{id:'one',title:'第一章',body:'他迫不急待，然后然后，，“未闭合。',deletedAt:null},{id:'two',title:'第二章',body:'再接再励。',deletedAt:null},{id:'trash',body:'一愁莫展',deletedAt:'2026'}],notes:[],reviewTools:{dictionary:[],annotations:[],bookmarks:[]}};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function harness(){
  const body=new Element('body'),elements=new Map(),get=id=>{if(!elements.has(id)){const e=new Element(id==='dialog'?'dialog':id==='editor'?'textarea':'div');e.id=id;elements.set(id,e);if(id==='dialog-body')get('dialog').append(e);else body.append(e);}return elements.get(id);};get('dialog-body');
  const h={book:make(),toasts:[],mutations:[],saved:[],gate:async()=>true,save:async()=>true,located:[],network:0};h.state={book:h.book,chapterId:'one',revision:2,dirty:false,composing:false,transitioning:false};
  const context=vm.createContext({window:{},state:h.state,TextEncoder,console,$:get,T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,i)=>args[i]??''),el:(tag,cls,text)=>{const e=new Element(tag);e.className=cls||'';e.textContent=text??'';return e;},document:{createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;}},toast:message=>h.toasts.push(message),markDirty:()=>{h.state.dirty=true;h.mutations.push('edit');},saveNow:async()=>{h.saved.push(structuredClone(h.state.book));const saved=await h.save();if(saved){h.state.dirty=false;h.state.revision++;}return saved;},requireSaved:async()=>{if(!await h.gate())return false;return !h.state.dirty||await context.saveNow();},currentChapter:()=>h.state.book?.chapters.find(item=>item.id===h.state.chapterId&&!item.deletedAt),resizeEditor(){},renderChapters(){},renderStats(){},showDialog:(title,root)=>{get('dialog-body').replaceChildren(root);get('dialog').open=true;},fetch(){h.network++;throw new Error('Unexpected network call');},api(){h.network++;throw new Error('Unexpected API call');},getComputedStyle:()=>({font:'19px serif',lineHeight:'30px',padding:'0px',boxSizing:'border-box',wordBreak:'normal'}),jumpToChapter:async id=>{h.located.push(id);h.state.chapterId=id;get('dialog').open=false;get('editor').value=h.state.book.chapters.find(item=>item.id===id).body;}});context.window=context;
  context.action=(text,cls,handler)=>{const e=new Element('button');e.textContent=text;e.className=cls||'';e.listeners.click=handler;return e;};
  const publicDir=path.join(__dirname,'../public'),app=fs.readFileSync(path.join(publicDir,'app.js'),'utf8'),start=app.indexOf('async function transition('),end=app.indexOf('\nasync function api(',start);vm.runInContext(app.slice(start,end),context);
  for(const file of ['local-proofreading-model.js','local-proofreading.js'])vm.runInContext(fs.readFileSync(path.join(publicDir,file),'utf8'),context);
  h.context=context;h.get=get;h.root=()=>get('dialog-body');h.find=predicate=>walk(h.root()).find(predicate);h.button=label=>{const result=h.find(e=>e.tagName==='BUTTON'&&e.textContent===label);assert.ok(result,'Missing button '+label);return result;};h.field=label=>{const result=h.find(e=>e['aria-label']===label);assert.ok(result,'Missing field '+label);return result;};h.status=()=>h.find(e=>e.className==='subtle proofreading-status').textContent;h.boxes=()=>walk(h.root()).filter(e=>e.tagName==='INPUT'&&e.type==='checkbox'&&e['aria-label']?.startsWith('选择修正'));h.check=box=>{box.checked=true;box.listeners.change();};h.show=async()=>{await context.LocalProofreading.show();return h;};h.flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};return h;
}
test('opening is save-gated, defaults to current chapter and performs no network requests',async()=>{
  const blocked=harness();blocked.gate=async()=>false;await blocked.show();assert.equal(blocked.get('dialog').open,false);
  const h=await harness().show();assert.equal(h.field('校对范围').value,'chapter');assert.equal(h.boxes().filter(item=>!item.disabled).length,1);assert.ok(h.boxes().some(item=>item.disabled));assert.equal(h.button('修正选中').disabled,true);assert.equal(h.network,0);assert.equal(h.mutations.length,0);
});
test('all-book scope sees active chapters, explicit safe selections repair prose through normal save path',async()=>{
  const h=await harness().show(),scope=h.field('校对范围');scope.value='book';scope.listeners.change();await h.flush();assert.equal(h.boxes().filter(item=>!item.disabled).length,2);h.check(h.field('选择可修正项'));await h.button('修正选中').listeners.click();assert.ok(h.book.chapters[0].body.startsWith('他迫不及待，然后然后'));assert.equal(h.book.chapters[1].body,'再接再厉。');assert.equal(h.book.chapters[2].body,'一愁莫展');assert.deepEqual(h.mutations,['edit']);assert.equal(h.saved.length,1);assert.equal(h.network,0);assert.ok(h.toasts.some(message=>message.includes('历史版本')));
});
test('failed pre-apply gate leaves both manuscript and dictionary untouched',async()=>{
  const h=await harness().show();h.check(h.boxes()[0]);h.gate=async()=>false;const before=structuredClone(h.book);await h.button('修正选中').listeners.click();assert.deepEqual(h.book,before);assert.equal(h.mutations.length,0);await h.button('加入词典').listeners.click();assert.deepEqual(h.book,before);
});
test('source changes, revision changes and book switches during delayed save cannot retarget repairs',async()=>{
  for(const mode of ['source','revision','switch']){const h=await harness().show(),gate=deferred();h.check(h.boxes()[0]);h.gate=()=>gate.promise;const pending=h.button('修正选中').listeners.click();if(mode==='source')h.book.chapters[0].body+='继续写作';if(mode==='revision')h.state.revision++;if(mode==='switch')h.state.book={...make(),id:'other'};gate.resolve(true);await pending;assert.equal(h.mutations.length,0,mode);assert.ok(h.book.chapters[0].body.startsWith('他迫不急待'));assert.equal(h.saved.length,0);}
});
test('failed persistence keeps corrected dirty draft and cannot apply it twice',async()=>{
  const h=await harness().show();h.check(h.boxes()[0]);h.save=async()=>false;await h.button('修正选中').listeners.click();assert.ok(h.book.chapters[0].body.startsWith('他迫不及待'));assert.equal(h.state.dirty,true);assert.equal(h.mutations.length,1);assert.equal(h.button('修正选中').disabled,true);assert.ok(h.status().includes('重试保存'));await h.button('修正选中').listeners.click();assert.equal(h.mutations.length,1);h.save=async()=>true;await h.button('重新校对').listeners.click();assert.equal(h.state.dirty,false);assert.equal(h.mutations.length,1);
});
test('ignore is non-destructive and dictionary add/remove persists only this book',async()=>{
  const h=await harness().show(),before=h.book.chapters[0].body;await h.button('忽略').listeners.click();assert.equal(h.book.chapters[0].body,before);assert.equal(h.mutations.length,0);await h.button('重新校对').listeners.click();await h.button('加入词典').listeners.click();assert.deepEqual([...h.book.reviewTools.dictionary],['迫不急待']);assert.equal(h.book.chapters[0].body,before);assert.ok(!h.boxes().some(e=>e['aria-label']==='选择修正：迫不急待'));assert.equal(h.saved.length,1);await h.field('从词典移除：迫不急待').listeners.click();assert.deepEqual([...h.book.reviewTools.dictionary],[]);assert.ok(h.boxes().some(e=>e['aria-label']==='选择修正：迫不急待'));assert.equal(h.saved.length,2);
});
test('dictionary caps entries and codepoints without changing prose or dropping saved terms',async()=>{
  const h=await harness().show(),input=h.field('自定义词语'),form=h.find(e=>e.tagName==='FORM');input.value='甲'.repeat(101);await form.listeners.submit({preventDefault(){}});assert.equal(h.book.reviewTools.dictionary.length,0);assert.ok(h.toasts.some(message=>message.includes('100')));h.book.reviewTools.dictionary=Array.from({length:500},(_,i)=>'词'+i);input.value='新的词';await form.listeners.submit({preventDefault(){}});assert.equal(h.book.reviewTools.dictionary.length,500);assert.equal(h.mutations.length,0);assert.ok(h.toasts.some(message=>message.includes('500')));
});
test('locate selects exact UTF-16 offsets in the source chapter without a manuscript save',async()=>{
  const h=harness();h.book.chapters[0].body='🐈迫不急待。';await h.show();await h.find(e=>e.className==='proofreading-context').listeners.click();assert.deepEqual(h.located,['one']);assert.equal(h.get('editor').selectionStart,2);assert.equal(h.get('editor').selectionEnd,6);assert.equal(h.mutations.length,0);assert.equal(h.network,0);
});
