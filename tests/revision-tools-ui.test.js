'use strict';
// Exercise the real dialog controllers and transition save gate with temporary
// in-memory books. No browser profile, user manuscript or filesystem writes.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const directory=path.join(__dirname,'../public');
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.value='';this.textContent='';this.style={};this.dataset={};this.disabled=false;this.inert=false;this.open=false;}
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}if(this.tagName==='SELECT'&&!this.value&&this.children[0])this.value=this.children[0].value;}
  replaceChildren(...items){for(const item of this.children)item.parentElement=null;this.children=[];this.append(...items);}
  addEventListener(type,callback){this.listeners[type]=callback;}
  setAttribute(name,value){this[name]=String(value);}
  focus(){} close(){this.open=false;} showModal(){this.open=true;}
  get isConnected(){return this.tagName==='BODY'||!!this.parentElement?.isConnected;}
}
const children=node=>node.children.flatMap(child=>[child,...children(child)]);
const find=(node,predicate)=>[node,...children(node)].find(predicate);
const book=()=>({id:'book',kind:'long',title:'临时小说',chapters:[{id:'one',title:'第一章',body:'船票船票\n\n码头',deletedAt:null},{id:'two',title:'第二章',body:'船票\n\n旧仓库',deletedAt:null},{id:'trash',title:'回收章',body:'船票',deletedAt:'2026-10-15'}]});
function deferred(){let resolve;const promise=new Promise(value=>{resolve=value;});return{promise,resolve};}
function harness(){
  const body=new Element('body'),elements=new Map(),timers=new Map();let timerId=0;
  const get=id=>{if(!elements.has(id)){const node=new Element(id==='dialog'?'dialog':'div');node.id=id;elements.set(id,node);if(id==='dialog-body')get('dialog').append(node);else body.append(node);}return elements.get(id);};
  get('dialog-body');const h={book:book(),mutations:[],saved:[],toasts:[],gateCalls:0,gate:async()=>true,save:async()=>true};
  h.state={book:h.book,chapterId:'one',composing:false,transitioning:false,dirty:false};
  const context=vm.createContext({window:{},state:h.state,TextEncoder,Uint32Array,console,$:get,T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),el:(tag,cls,text)=>{const node=new Element(tag);node.className=cls||'';node.textContent=text??'';return node;},document:{createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;}},setTimeout:callback=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),toast:text=>h.toasts.push(text),requireSaved:async()=>{h.gateCalls++;return h.gate();},saveNow:async()=>{h.saved.push(structuredClone(h.state.book));const result=await h.save();if(result)h.state.dirty=false;return result;},markDirty:reason=>{h.mutations.push(reason||'edit');h.state.dirty=true;},currentChapter:()=>h.state.book?.chapters.find(chapter=>chapter.id===h.state.chapterId&&!chapter.deletedAt),resizeEditor(){},renderChapters(){},renderStats(){},showDialog:(title,root)=>{get('dialog-body').replaceChildren(root);get('dialog').open=true;}});context.window=context;
  context.action=(text,cls,callback)=>{const node=new Element('button');node.textContent=text;node.className=cls;node.listeners.click=callback;return node;};
  const app=fs.readFileSync(path.join(directory,'app.js'),'utf8'),start=app.indexOf('async function transition('),end=app.indexOf('\nasync function api(',start);vm.runInContext(app.slice(start,end),context);
  for(const file of ['book-search.js','version-diff.js'])vm.runInContext(fs.readFileSync(path.join(directory,file),'utf8'),context);
  h.context=context;h.get=get;h.root=()=>get('dialog-body');h.field=label=>{const node=find(h.root(),item=>item['aria-label']===label);assert.ok(node,'Missing '+label);return node;};h.button=label=>{const node=find(h.root(),item=>item.tagName==='BUTTON'&&item.textContent===label);assert.ok(node,'Missing '+label);return node;};h.flush=()=>{for(const [id,callback] of [...timers]){timers.delete(id);callback();}};
  h.search=async()=>{await context.WriterBookSearch.open();return h;};h.preview=(query='船票',replacement='新船票')=>{const q=h.field('查找文字'),r=h.field('替换为');q.value=query;r.value=replacement;r.listeners.input({isComposing:false});h.flush();};h.searchBoxes=()=>children(h.root()).filter(node=>node.className==='book-search-group').map(group=>find(group,node=>node.tagName==='INPUT'&&node.type==='checkbox'));
  h.compare=old=>{context.WriterVersionDiff.open({book:{...structuredClone(h.book),chapters:old||[{...h.book.chapters[0],body:'旧船票船票\n\n码头'},{...h.book.chapters[1],body:'旧船票\n\n旧仓库'}]}},'book');return h;};h.diffBoxes=()=>children(h.root()).filter(node=>node.className==='version-diff-change').map(group=>find(group,node=>node.tagName==='INPUT'));h.check=box=>{box.checked=true;box.listeners.change();};return h;
}

test('search requires the save gate before opening and applies only explicitly selected active chapters',async()=>{
  const blocked=harness();blocked.gate=async()=>false;await blocked.search();assert.equal(blocked.get('dialog').open,false);assert.equal(blocked.mutations.length,0);
  const h=await harness().search();h.preview('船票','$&');const boxes=h.searchBoxes();boxes[0].checked=false;boxes[0].listeners.change();await h.button('替换选中章节').listeners.click();assert.equal(h.book.chapters[0].body,'船票船票\n\n码头');assert.equal(h.book.chapters[1].body,'$&\n\n旧仓库');assert.equal(h.book.chapters[2].body,'船票');assert.equal(h.saved.length,1);assert.deepEqual(h.mutations,['edit']);
});

test('search makes no manuscript mutation when the delayed pre-apply save gate fails',async()=>{
  const h=await harness().search();h.preview();const gate=deferred();h.gate=()=>gate.promise;const original=structuredClone(h.book),pending=h.button('替换选中章节').listeners.click();assert.equal(h.get('dialog').inert,true);gate.resolve(false);await pending;assert.deepEqual(h.book,original);assert.equal(h.saved.length,0);assert.equal(h.get('dialog').inert,false);
});

test('search rejects a source edited while the save gate is pending before altering any other chapter',async()=>{
  const h=await harness().search();h.preview();const gate=deferred();h.gate=()=>gate.promise;const pending=h.button('替换选中章节').listeners.click();h.book.chapters[1].body+='\n外部更新';gate.resolve(true);await pending;assert.equal(h.book.chapters[0].body,'船票船票\n\n码头');assert.ok(h.book.chapters[1].body.endsWith('外部更新'));assert.equal(h.mutations.length,0);assert.ok(h.toasts.some(text=>text.includes('重新预览')));
});

test('switching books during the delayed search save gate cannot touch either manuscript',async()=>{
  const h=await harness().search();h.preview();const gate=deferred();h.gate=()=>gate.promise;const original=structuredClone(h.book),other={...book(),id:'other'},pending=h.button('替换选中章节').listeners.click();h.state.book=other;gate.resolve(true);await pending;assert.deepEqual(h.book,original);assert.equal(other.chapters[0].body,'船票船票\n\n码头');assert.equal(h.saved.length,0);
});

test('a replacement persistence failure keeps one dirty result and does not apply it twice on retry',async()=>{
  const h=await harness().search();h.preview('船票','船票船票');h.save=async()=>false;await h.button('替换选中章节').listeners.click();const failed=structuredClone(h.book);assert.equal(h.state.dirty,true);assert.equal(h.mutations.length,1);h.gate=async()=>false;await h.button('替换选中章节').listeners.click();assert.deepEqual(h.book,failed);assert.equal(h.mutations.length,1);h.gate=async()=>true;h.save=async()=>true;await h.button('替换选中章节').listeners.click();assert.deepEqual(h.book,failed);assert.equal(h.mutations.length,1);
});

test('queued dialog previews cannot change an already confirmed replacement operation during save',async()=>{
  const h=await harness().search();h.preview('船票','确认过的替换');const gate=deferred();h.gate=()=>gate.promise;const pending=h.button('替换选中章节').listeners.click();const replacement=h.field('替换为');replacement.value='后来的草稿';replacement.listeners.input({isComposing:false});h.flush();gate.resolve(true);await pending;assert.ok(h.book.chapters[0].body.startsWith('确认过的替换'));assert.ok(!h.book.chapters[0].body.includes('后来的草稿'));
});

test('partial restore saves only checked paragraphs with restore classification and preserves other chapters',async()=>{
  const h=harness();h.book.chapters[0].body='新甲\n\n新乙\n\n共同';h.compare([{...h.book.chapters[0],body:'旧甲\n\n旧乙\n\n共同'},{...h.book.chapters[1]}]);h.check(h.diffBoxes()[1]);await h.button('恢复选中段落').listeners.click();assert.equal(h.book.chapters[0].body,'新甲\n\n旧乙\n\n共同');assert.equal(h.book.chapters[1].body,'船票\n\n旧仓库');assert.deepEqual(h.mutations,['restore']);assert.equal(h.saved.length,1);
});

test('partial restore cannot modify prose after a failed gate, source edit, book switch, or removed source chapter',async()=>{
  for(const mode of ['gate','edit','switch','deleted']){const h=harness().compare(),gate=deferred();h.check(h.diffBoxes()[0]);h.gate=()=>gate.promise;const pending=h.button('恢复选中段落').listeners.click();if(mode==='edit')h.book.chapters[0].body='继续写下的新稿';if(mode==='switch')h.state.book={...book(),id:'another'};if(mode==='deleted')h.book.chapters[0].deletedAt='2026-10-15';gate.resolve(mode!=='gate');await pending;assert.equal(h.mutations.length,0,mode);assert.equal(h.saved.length,0,mode);}
});

test('failed partial-restore persistence retains one dirty restoration and a retry never repeats the mutation',async()=>{
  const h=harness().compare();h.check(h.diffBoxes()[0]);h.save=async()=>false;await h.button('恢复选中段落').listeners.click();const failed=structuredClone(h.book);assert.equal(h.state.dirty,true);assert.equal(h.mutations.length,1);h.save=async()=>true;await h.button('恢复选中段落').listeners.click();assert.deepEqual(h.book,failed);assert.equal(h.mutations.length,1);
});

test('changing the comparison chapter while waiting cannot retarget an already confirmed paragraph restore',async()=>{
  const h=harness().compare(),gate=deferred();h.check(h.diffBoxes()[0]);h.gate=()=>gate.promise;const pending=h.button('恢复选中段落').listeners.click();const selector=h.field('对比章节');selector.value='two';selector.listeners.change();h.check(h.diffBoxes()[0]);gate.resolve(true);await pending;assert.equal(h.book.chapters[0].body,'旧船票船票\n\n码头');assert.equal(h.book.chapters[1].body,'船票\n\n旧仓库');assert.deepEqual(h.mutations,['restore']);
});

test('oversized replacement previews stay disabled and leave every chapter unchanged',async()=>{
  const h=harness();h.book.chapters[0].body='甲'.repeat(10000);const original=structuredClone(h.book);await h.search();h.preview('甲','乙'.repeat(10000));assert.equal(h.button('替换选中章节').disabled,true);assert.deepEqual(h.book,original);assert.equal(h.saved.length,0);assert.ok(find(h.root(),node=>node.textContent.includes('正文过长')));
});

test('mixing legal old and current paragraphs cannot create an oversized unsavable restoration',async()=>{
  const h=harness();h.book.chapters[0].body='共同\n'+'乙'.repeat(2600000)+'\n';const original=structuredClone(h.book);h.compare([{...h.book.chapters[0],body:'甲'.repeat(2600000)+'\n共同\n'},{...h.book.chapters[1]}]);h.check(h.diffBoxes()[0]);await h.button('恢复选中段落').listeners.click();assert.deepEqual(h.book,original);assert.equal(h.mutations.length,0);assert.equal(h.saved.length,0);assert.ok(h.toasts.some(text=>text.includes('正文过长')));
});
