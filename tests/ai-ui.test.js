'use strict';
// Real app functions with a disposable novel copy and an in-memory API stub.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{test}=require('node:test');
const root=path.resolve(__dirname,'..'),sample=JSON.parse(fs.readFileSync(path.join(root,'examples/tide-archive.yejian.json'),'utf8')).book;
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.value='';this.textContent='';this.listeners={};this.open=false;this.disabled=false;this.hidden=false;this.style={setProperty(){}};this.classList={toggle(){},add(){},remove(){}};}
  append(...children){children.forEach(child=>{this.children.push(child);child.parentElement=this;});}
  prepend(...children){this.children.unshift(...children);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(type,listener){this.listeners[type]=listener;}
  setAttribute(key,value){this[key]=String(value);}
  get options(){return this.children;}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  querySelectorAll(selector){const tags=selector.split(',').map(tag=>tag.toUpperCase());return descendants(this).filter(node=>tags.includes(node.tagName));}
  querySelector(){return null;}
  focus(){} scrollIntoView(){} close(){this.open=false;} showModal(){this.open=true;}
}
function descendants(node){return node.children.flatMap(child=>[child,...descendants(child)]);}
function find(node,predicate){return [node,...descendants(node)].find(predicate);}
function button(h,text){const result=find(h.get('dialog-body'),node=>node.tagName==='BUTTON'&&node.textContent===text);assert.ok(result,'Missing button '+text);return result;}
function field(h,id){const result=find(h.get('dialog-body'),node=>node.id===id);assert.ok(result,'Missing field '+id);return result;}
function harness(){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const storage={getItem:()=>null,setItem(){},removeItem(){},length:0};
  const context=vm.createContext({document:{getElementById:get,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),addEventListener(){},querySelector:()=>new Element()},crypto:{randomUUID},sessionStorage:storage,clientStorage:storage,structuredClone,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:fn=>fn(),addEventListener(){},T:(text,...args)=>Array.isArray(text)?text.reduce((out,part,i)=>out+part+(args[i]??''),''):String(text).replace(/\{(\d+)\}/g,(_,i)=>args[i]??'')});context.window=context;
  for(const file of ['public/app.js','public/workspace.js','public/ai.js']){let source=fs.readFileSync(path.join(root,file),'utf8');if(file.endsWith('workspace.js'))source=source.replace(/\ninitialize\(\);\s*$/,'\n');vm.runInContext(source,context,{filename:file});}
  const run=source=>vm.runInContext(source,context),state=run('state');state.book=structuredClone(sample);state.kind='long';state.view='write';state.chapterId=sample.chapters[0].id;
  const h={get,run,state,context,calls:[],saves:[],renderCount:0,settings:{enabled:true,endpoint:'http://127.0.0.1:9999/v1/chat/completions',model:'stub-model',hasKey:false,maxContextChars:250000,timeoutSeconds:60}};
  h.result=(request)=>({bookId:state.book.id,action:request.action,chapterIds:request.chapterIds,data:request.action==='draft'?{title:'AI测试草稿',body:'<img src=x onerror=alert(1)>\n一段新的试写。'}:request.action==='consistency'?{issues:[{title:'待核查',description:'核对人物设定',chapterIds:request.chapterIds,evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}:{people:[{name:'测试新人物',group:'测试组',description:'仅供确认',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}],relationships:[{from:'测试新人物',to:'沈砚',type:'cooperate',label:'测试核验',description:'作者确认后建立',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}});
  context.localAPI=async(url,method='GET',data)=>{h.calls.push({url,method,data:structuredClone(data)});if(url==='/api/ai/settings')return h.settings;if(url.endsWith('/ai/preview'))return{bookId:state.book.id,action:data.action,chapterIds:data.chapterIds,contextChars:2000,maxContextChars:250000,overLimit:!!h.overLimit,counts:{chapters:data.chapterIds.length,outlines:3,people:32,relationships:35}};if(url.endsWith('/ai'))return h.result(data);if(url==='/api/ai/test')return{ok:true};throw Error('Unexpected local API '+url);};
  context.fakeSave=async()=>{const value=await(h.saves.length?h.saves.shift():true);if(value)state.dirty=false;return value;};context.didRender=()=>{h.renderCount++;};
  run('api=(...args)=>localAPI(...args);saveNow=()=>fakeSave();markDirty=()=>{state.dirty=true;state.seq++;};renderShell=()=>didRender();');
  return h;
}

test('default settings stay collapsed, redact existing key, and clear the password field after save',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.settings.hasKey=true;
  h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const section=container.children[0],key=find(section,node=>node.id==='ai-api-key');assert.equal(section.open,false);assert.equal(key.type,'password');assert.equal(key.value,'');assert.match(key.placeholder,/留空保留/);
  key.value='stub-only-secret';await find(section,node=>node.textContent==='保存 AI 设置').listeners.click();
  assert.equal(key.value,'');assert.ok(h.calls.some(call=>call.method==='PUT'&&call.data.apiKey==='stub-only-secret'));
});

test('opening and previewing never sends to AI; disabled and oversized scopes cannot run',async()=>{
  for(const mode of ['disabled','oversized']){const h=harness();if(mode==='disabled')h.settings.enabled=false;else h.overLimit=true;
    await h.run("showAIAssistant('draft')");assert.ok(h.calls.some(call=>call.url.endsWith('/ai/preview')));assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
    assert.equal(button(h,'发送所选资料').disabled,true);await button(h,'发送所选资料').listeners.click();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  }
});

test('draft preview is plain text and a failed append retry never replaces or duplicates existing prose',async()=>{
  const h=harness(),before=h.state.book.chapters[0].body,count=h.state.book.chapters.length;
  await h.run("showAIAssistant('draft')");await button(h,'发送所选资料').listeners.click();
  const body=field(h,'ai-draft-body');assert.match(body.value,/<img src=x/);assert.ok(!find(h.get('dialog-body'),node=>node.tagName==='IMG'));
  h.saves=[true,false];await button(h,'追加到目标章节').listeners.click();
  assert.equal(h.get('dialog').open,true);assert.equal(h.state.book.chapters[0].body,before+'\n\n'+body.value);assert.equal(h.state.book.chapters.length,count);
  const retry=button(h,'重试保存');await retry.listeners.click();
  assert.equal(h.get('dialog').open,false);assert.equal(h.state.book.chapters[0].body,before+'\n\n'+body.value);assert.equal(h.state.book.chapters.length,count);
});

test('AI new chapter follows an unbuilt seventh-volume outline and failed-save retries create one volume and chapter',async()=>{
  const h=harness(),volume={id:'new-volume-outline',title:'第七卷',body:'卷七策划',kind:'volume',volumeId:null,parentId:null,chapterIds:[],deletedAt:null},outline={id:'new-chapter-outline',title:'第七卷第一章',body:'章纲内容',kind:'chapter',volumeId:null,parentId:volume.id,chapterIds:[],deletedAt:null};
  h.state.book.outline.push(volume,outline);h.state.outlineId=outline.id;h.state.view='outline';
  await h.run("showAIAssistant('draft')");assert.match(field(h,'ai-instruction').value,/章纲内容/);
  assert.equal(h.calls.find(call=>call.url.endsWith('/ai/preview')).data.chapterIds.length,0);
  await button(h,'发送所选资料').listeners.click();h.saves=[true,false];await button(h,'保存为新章节').listeners.click();
  assert.equal(h.state.book.volumes.length,7);assert.equal(h.state.book.chapters.length,37);assert.equal(outline.chapterIds.length,1);
  const chapter=h.state.book.chapters.find(chapter=>chapter.id===outline.chapterIds[0]);assert.equal(chapter.volumeId,volume.volumeId);assert.equal(h.state.book.volumes.at(-1).title,'第七卷');
  await button(h,'重试保存').listeners.click();assert.equal(h.state.book.volumes.length,7);assert.equal(h.state.book.chapters.length,37);assert.equal(outline.chapterIds.length,1);assert.equal(h.state.chapterId,chapter.id);
});

test('relationship suggestions require selection and failed-save retry creates each approved item once',async()=>{
  const h=harness(),notes=h.state.book.notes.length,relations=h.state.book.relations.length;
  await h.run("showAIAssistant('relationships')");await button(h,'发送所选资料').listeners.click();
  await button(h,'采用勾选的人物与关系').listeners.click();assert.equal(h.state.book.notes.length,notes);
  const list=find(h.get('dialog-body'),node=>node.className==='ai-suggestion-list');list.querySelectorAll('input').forEach(box=>box.checked=true);
  h.saves=[true,false];await button(h,'采用勾选的人物与关系').listeners.click();assert.equal(h.state.book.notes.length,notes+1);assert.equal(h.state.book.relations.length,relations+1);assert.equal(h.get('dialog').open,true);
  await button(h,'重试保存').listeners.click();assert.equal(h.state.book.notes.length,notes+1);assert.equal(h.state.book.relations.length,relations+1);
  assert.ok(h.state.book.notes.at(-1).chapterIds.includes(sample.chapters[0].id));assert.match(h.state.book.notes.at(-1).body,/AI 来源/);
});

test('closing or switching books during a request discards its result without changing either book',async()=>{
  for(const switchBook of [false,true]){const h=harness(),original=h.state.book,snapshot=JSON.stringify(original);let finish;
    h.result=()=>new Promise(resolve=>{finish=resolve;});await h.run("showAIAssistant('draft')");const pending=button(h,'发送所选资料').listeners.click();await new Promise(resolve=>setImmediate(resolve));
    h.get('dialog').open=false;if(switchBook)h.state.book={...structuredClone(sample),id:'other-book'};const current=JSON.stringify(h.state.book);
    finish({bookId:original.id,action:'draft',data:{title:'迟到结果',body:'不能写入'}});await pending;
    assert.equal(JSON.stringify(original),snapshot);assert.equal(JSON.stringify(h.state.book),current);assert.ok(!find(h.get('dialog-body'),node=>node.id==='ai-draft-body'));
  }
});

test('consistency findings expose source chapter navigation and never edit the manuscript',async()=>{
  const h=harness(),snapshot=JSON.stringify(h.state.book);h.context.jumps=[];h.run('jumpToChapter=id=>{jumps.push(id);};');
  await h.run("showAIAssistant('consistency')");await button(h,'发送所选资料').listeners.click();const link=find(h.get('dialog-body'),node=>node.className==='ai-evidence-link');assert.ok(link);link.listeners.click();
  assert.deepEqual(Array.from(h.context.jumps),[sample.chapters[0].id]);assert.equal(JSON.stringify(h.state.book),snapshot);
});

test('append and new-chapter buttons share one pending adoption and one failed-save retry',async()=>{
  const h=harness(),before=h.state.book.chapters[0].body,count=h.state.book.chapters.length;
  await h.run("showAIAssistant('draft')");await button(h,'发送所选资料').listeners.click();const draft=field(h,'ai-draft-body').value;
  let finish;h.saves=[true,new Promise(resolve=>{finish=resolve;})];
  const append=button(h,'追加到目标章节'),create=button(h,'保存为新章节');const pending=append.listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(append.disabled,true);assert.equal(create.disabled,true);
  await create.listeners.click();assert.equal(h.state.book.chapters.length,count);assert.equal(h.state.book.chapters[0].body,before+'\n\n'+draft);
  finish(false);await pending;assert.equal(append.textContent,'重试保存');assert.equal(create.textContent,'重试保存');
  await create.listeners.click();assert.equal(h.state.book.chapters.length,count);assert.equal(h.state.book.chapters[0].body,before+'\n\n'+draft);assert.equal(h.get('dialog').open,false);
});
