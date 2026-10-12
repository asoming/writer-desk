'use strict';
// Real app functions with a disposable novel copy and an in-memory API stub.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{test}=require('node:test');
const root=path.resolve(__dirname,'..'),sample=JSON.parse(fs.readFileSync(path.join(root,'examples/tide-archive.yejian.json'),'utf8')).book;
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.value='';this.textContent='';this.listeners={};this.open=false;this.disabled=false;this.hidden=false;this.dataset={};this.style={setProperty(){}};this.classList={toggle(){},add(){},remove(){}};}
  append(...children){children.forEach(child=>{this.children.push(child);child.parentElement=this;});}
  prepend(...children){this.children.unshift(...children);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
  addEventListener(type,listener){this.listeners[type]=listener;}
  setAttribute(key,value){this[key]=String(value);}
  get options(){return this.children;}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  querySelectorAll(selector){const tags=selector.split(',').map(tag=>tag.toUpperCase());return descendants(this).filter(node=>tags.includes(node.tagName));}
  querySelector(){return null;}
  focus(){} select(){this.selected=true;} scrollIntoView(){} close(){this.open=false;} showModal(){this.open=true;}
}
function descendants(node){return node.children.flatMap(child=>[child,...descendants(child)]);}
function find(node,predicate){return [node,...descendants(node)].find(predicate);}
function button(h,text){const result=find(h.get('dialog-body'),node=>node.tagName==='BUTTON'&&node.textContent===text);assert.ok(result,'Missing button '+text);return result;}
function field(h,id){const result=find(h.get('dialog-body'),node=>node.id===id);assert.ok(result,'Missing field '+id);return result;}
function harness(){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const storage={getItem:()=>null,setItem(){},removeItem(){},length:0};
  const context=vm.createContext({document:{body:new Element('body'),getElementById:get,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),addEventListener(){},querySelector:()=>new Element()},crypto:{randomUUID},sessionStorage:storage,clientStorage:storage,structuredClone,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:fn=>fn(),addEventListener(){},T:(text,...args)=>Array.isArray(text)?text.reduce((out,part,i)=>out+part+(args[i]??''),''):String(text).replace(/\{(\d+)\}/g,(_,i)=>args[i]??'')});context.window=context;
  for(const file of ['public/app.js','public/workspace.js','public/ai.js']){let source=fs.readFileSync(path.join(root,file),'utf8');if(file.endsWith('workspace.js'))source=source.replace(/\ninitialize\(\);\s*$/,'\n');vm.runInContext(source,context,{filename:file});}
  const run=source=>vm.runInContext(source,context),state=run('state');state.book=structuredClone(sample);state.kind='long';state.view='write';state.chapterId=sample.chapters[0].id;
  const h={get,run,state,context,calls:[],saves:[],copied:[],renderCount:0,settings:{enabled:true,endpoint:'http://127.0.0.1:9999/v1/chat/completions',model:'stub-model',imageModel:'',hasKey:false,contextMode:'auto',maxContextChars:250000,timeoutSeconds:60}};
  context.navigator={clipboard:{writeText:async text=>h.copied.push(text)}};
  h.skills={skills:['chinese-novelist','novelskill','human-writing'].map(id=>({id,name:id,available:true,imported:false,referenceCount:1})),defaults:{skillIds:[],skillMode:'auto'}};
  h.preview=data=>({bookId:state.book.id,action:data.action,chapterIds:data.chapterIds,contextChars:2000+data.instruction.length+data.skillIds.length*300,contextMode:h.settings.contextMode,maxContextChars:h.settings.contextMode==='manual'?h.settings.maxContextChars:null,overLimit:h.settings.contextMode==='manual'&&!!h.overLimit,counts:{chapters:data.chapterIds.length,outlines:3,people:32,relationships:35},selectedSkillIds:data.skillIds,skillMode:data.skillMode,skillChars:data.skillIds.length*300,skills:data.skillIds.map(id=>({id,name:id,mode:data.skillMode==='auto'?'chapter':data.skillMode,files:['SKILL.md','references/chapter.md']}))});
  h.skillDetail=id=>({id,name:id,content:'# SKILL.md\n<img src=x onerror=alert(1)>\n只读写作说明',files:[{path:'references/chapter.md',content:'连续阅读参考内容'}],imported:true});
  h.result=(request)=>({bookId:state.book.id,action:request.action,chapterIds:request.chapterIds,data:request.action==='draft'?{title:'AI测试草稿',body:'<img src=x onerror=alert(1)>\n一段新的试写。'}:request.action==='consistency'?{issues:[{title:'待核查',description:'核对人物设定',chapterIds:request.chapterIds,evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}:{people:[{name:'测试新人物',group:'测试组',description:'仅供确认',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}],relationships:[{from:'测试新人物',to:'沈砚',type:'cooperate',label:'测试核验',description:'作者确认后建立',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}});
  context.localAPI=async(url,method='GET',data)=>{
    h.calls.push({url,method,data:structuredClone(data)});
    if(url==='/api/ai/settings'){if(method==='PUT'){const {apiKey,clearKey,...settings}=data;h.settings={...h.settings,...settings,hasKey:clearKey?false:!!apiKey||h.settings.hasKey};}return h.settings;}
    if(url==='/api/ai/models')return h.models?h.models(data):{models:[{id:'stub-model'},{id:'second-model'}]};
    if(url==='/api/skills'){if(h.skillError)throw h.skillError;return structuredClone(h.skills);}
    if(url==='/api/skills/import'){data.skillIds.forEach(id=>h.skills.skills.find(skill=>skill.id===id).imported=true);return structuredClone(h.skills);}
    if(url==='/api/skills/settings'){h.skills.defaults=structuredClone(data);return structuredClone(h.skills);}
    if(url.startsWith('/api/skills/'))return h.skillDetail(url.split('/').at(-1));
    if(url.endsWith('/ai/preview'))return h.preview(data);
    if(url==='/api/ai/book-cover')return data.preview?h.preview({...data,action:'book_cover',chapterIds:[],instruction:data.prompt}):h.result({...data,action:'book_cover',chapterIds:[]});
    if(url==='/api/ai/cover-image')return h.imageResult(data);
    if(url.endsWith('/ai'))return h.result(data);
    if(url==='/api/ai/test')return{ok:true};throw Error('Unexpected local API '+url);
  };
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

test('AI settings automatically discover model choices and retain editable custom names',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));const model=find(container,node=>node.id==='ai-model'),choice=find(container,node=>node.id==='ai-model-choice');
  assert.ok(h.calls.some(call=>call.url==='/api/ai/models'));assert.equal(choice.value,'stub-model');assert.equal(model.hidden,true);choice.value='second-model';choice.listeners.change();assert.equal(model.value,'second-model');choice.value='';choice.listeners.change();assert.equal(model.hidden,false);model.value='my-custom-model';await find(container,node=>node.textContent==='保存 AI 设置').listeners.click();assert.equal(h.settings.model,'my-custom-model');assert.equal(model.hidden,false);
});

test('an empty model stays empty after discovery until the user explicitly chooses and saves one',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.settings.model='';h.settings.hasKey=true;h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));const model=find(container,node=>node.id==='ai-model'),choice=find(container,node=>node.id==='ai-model-choice');assert.equal(model.value,'');assert.equal(choice.value,'');assert.equal(choice.children[0].textContent,'选择模型');assert.equal(model.hidden,true);assert.equal(find(container,node=>node.id==='ai-api-key').value,'');assert.ok(!h.calls.some(call=>call.method==='PUT'));choice.value='second-model';choice.listeners.change();await find(container,node=>node.textContent==='保存 AI 设置').listeners.click();assert.equal(h.settings.model,'second-model');assert.ok(h.calls.filter(call=>call.url==='/api/ai/models').every(call=>!call.data||!call.data.apiKey));
});

test('editing provider credentials automatically reads a draft list without saving them',async()=>{
  const h=harness(),container=new Element();h.context.container=container;let timer;h.context.setTimeout=fn=>{timer=fn;return 1;};h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));const endpoint=find(container,node=>node.id==='ai-endpoint'),key=find(container,node=>node.id==='ai-api-key');endpoint.value='http://127.0.0.1:9555/new';key.value='fake-unsaved-key';endpoint.listeners.change();await timer();
  const request=h.calls.find(call=>call.url==='/api/ai/models'&&call.method==='POST');assert.equal(request.data.endpoint,endpoint.value);assert.equal(request.data.apiKey,'fake-unsaved-key');assert.ok(!h.calls.some(call=>call.method==='PUT'));assert.equal(key.value,'fake-unsaved-key');
});

test('unavailable provider model lists keep manual configuration and do not block saving',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.models=()=>{throw Error('无法读取模型列表，可手动填写模型名称。');};h.settings.model='custom-provider-model';h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));const model=find(container,node=>node.id==='ai-model');assert.equal(model.hidden,false);assert.equal(model.value,'custom-provider-model');assert.ok(find(container,node=>node.textContent==='无法读取模型列表，可手动填写模型名称。'));await find(container,node=>node.textContent==='保存 AI 设置').listeners.click();assert.equal(h.settings.model,'custom-provider-model');
});

test('automatic context is the default; manual character protection is optional, collapsed and preserves its saved value',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const advanced=find(container,node=>node.className==='ai-advanced'),manual=find(container,node=>node.id==='ai-context-manual'),limit=find(container,node=>node.id==='ai-context-limit'),save=find(container,node=>node.textContent==='保存 AI 设置');
  assert.equal(advanced.open,false);assert.equal(manual.checked,false);assert.equal(limit.disabled,true);assert.equal(limit.parentElement.hidden,true);
  await save.listeners.click();let payload=h.calls.filter(call=>call.method==='PUT').at(-1).data;
  assert.equal(payload.contextMode,'auto');assert.equal(Object.hasOwn(payload,'maxContextChars'),false);
  manual.checked=true;manual.listeners.change();assert.equal(limit.disabled,false);assert.equal(limit.parentElement.hidden,false);assert.equal(limit.min,'1');assert.equal(limit.max,'26214400');
  limit.value='1200000';await save.listeners.click();payload=h.calls.filter(call=>call.method==='PUT').at(-1).data;
  assert.equal(payload.contextMode,'manual');assert.equal(payload.maxContextChars,1200000);assert.equal(manual.checked,true);
  limit.value='';manual.checked=false;manual.listeners.change();await save.listeners.click();payload=h.calls.filter(call=>call.method==='PUT').at(-1).data;
  assert.equal(payload.contextMode,'auto');assert.equal(Object.hasOwn(payload,'maxContextChars'),false);assert.equal(h.settings.maxContextChars,1200000);assert.equal(limit.parentElement.hidden,true);
});

test('automatic previews above the old cap stay sendable with no fixed limit, token estimate or target URL in the assistant',async()=>{
  const h=harness(),normal=h.preview;h.preview=data=>({...normal(data),contextChars:800000});
  await h.run("showAIAssistant('draft')");
  const content=h.get('dialog-body'),material=find(content,node=>node.className==='ai-material');
  assert.equal(material.open,false);assert.equal(button(h,'发送所选资料').disabled,false);
  assert.ok(find(material,node=>node.textContent==='共 800,000 字符'));
  assert.ok(find(material,node=>node.tagName==='SUMMARY'&&node.textContent==='资料 · 1 章'));
  assert.ok(!find(content,node=>node.className==='ai-notice'||node.textContent.includes('250,000')||node.textContent.includes('上限')||node.textContent.includes('目标服务')||node.textContent.includes('token')));
  assert.equal(find(content,node=>node.className==='ai-status').textContent,'');assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  await button(h,'发送所选资料').listeners.click();assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);
});

test('manual limits and real provider context errors remain clear without blocking the prompt or modifying prose',async()=>{
  const h=harness(),snapshot=JSON.stringify(h.state.book);h.settings.contextMode='manual';h.settings.maxContextChars=1000;h.overLimit=true;
  await h.run("showAIAssistant('draft')");const material=find(h.get('dialog-body'),node=>node.className==='ai-material');
  assert.ok(find(material,node=>node.textContent.includes('手动上限 1,000')));assert.equal(button(h,'发送所选资料').disabled,true);
  assert.ok(find(h.get('dialog-body'),node=>node.textContent==='资料超过手动上限，请减少章节或调整设置。'));
  h.overLimit=false;await field(h,'ai-skill-mode').listeners.change();assert.equal(button(h,'发送所选资料').disabled,false);
  h.result=()=>{throw new Error('所选资料超出模型上下文，请减少章节后重试。');};await button(h,'发送所选资料').listeners.click();
  assert.ok(find(h.get('dialog-body'),node=>node.textContent==='所选资料超出模型上下文，请减少章节后重试。'));assert.equal(field(h,'ai-instruction').disabled,false);assert.equal(JSON.stringify(h.state.book),snapshot);
});

test('empty chapters create no explanatory gray paragraph and inconsistent auto-limit previews cannot send',async()=>{
  const h=harness();h.state.book.chapters=[];h.state.chapterId=null;await h.run("showAIAssistant('outline')");
  const material=find(h.get('dialog-body'),node=>node.className==='ai-material');assert.ok(find(material,node=>node.tagName==='SUMMARY'&&node.textContent==='资料'));
  assert.ok(!find(h.get('dialog-body'),node=>node.textContent.includes('还没有章节。')));assert.equal(find(material,node=>node.className==='ai-chapter-choices').hidden,true);
  assert.equal(button(h,'发送所选资料').disabled,false);
  for(const malformed of [value=>({...value,maxContextChars:250000}),value=>({...value,overLimit:true}),value=>({...value,contextMode:'unknown'})]){
    const bad=harness(),normal=bad.preview;bad.preview=data=>malformed(normal(data));await bad.run("showAIAssistant('draft')");assert.equal(button(bad,'发送所选资料').disabled,true);
    assert.ok(find(bad.get('dialog-body'),node=>node.textContent==='资料预览无效，请重试。'));
  }
});

test('opening and previewing never sends to AI; disabled and oversized scopes cannot run',async()=>{
  for(const mode of ['disabled','oversized']){const h=harness();if(mode==='disabled')h.settings.enabled=false;else{h.overLimit=true;h.settings.contextMode='manual';}
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

test('writing skill settings import local copies, save explicit defaults and keep the list concise',async()=>{
  const h=harness(),container=new Element(),snapshot=JSON.stringify(h.state.book);h.context.container=container;
  h.skills.skills[2].description='Very long original description '.repeat(80);
  h.run('appendWritingSkillSettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const section=container.children[0];assert.equal(section.open,false);
  const check=id=>find(section,node=>node.id==='writing-skill-default-'+id);
  assert.equal(check('chinese-novelist').disabled,true);assert.ok(!find(section,node=>node.textContent.includes('Very long')));
  await find(section,node=>node.textContent==='导入本机写作 Skill').listeners.click();
  assert.deepEqual(h.calls.find(call=>call.url==='/api/skills/import').data.skillIds,['chinese-novelist','novelskill','human-writing']);
  assert.equal(check('chinese-novelist').disabled,false);check('chinese-novelist').checked=true;check('chinese-novelist').listeners.change();
  find(section,node=>node.id==='writing-skill-default-mode').value='polish';
  await find(section,node=>node.textContent==='保存默认选择').listeners.click();
  assert.deepEqual(h.skills.defaults,{skillIds:['chinese-novelist'],skillMode:'polish'});
  await find(section,node=>node.tagName==='BUTTON'&&node.textContent==='查看').listeners.click();
  const viewer=find(section,node=>node.className==='writing-skill-viewer'),documents=descendants(viewer).filter(node=>node.tagName==='PRE');
  assert.equal(documents.length,2);assert.match(documents[0].textContent,/<img src=x/);assert.match(documents[1].textContent,/连续阅读参考内容/);
  assert.ok(!find(viewer,node=>node.tagName==='IMG'));assert.equal(JSON.stringify(h.state.book),snapshot);assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  check('chinese-novelist').checked=false;check('chinese-novelist').listeners.change();await find(section,node=>node.textContent==='保存默认选择').listeners.click();
  assert.deepEqual(h.skills.defaults.skillIds,[],'explicit no-skill preference is saved');
});

test('skill details discard out-of-order responses and results after a book switch',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.skills.skills.forEach(skill=>skill.imported=true);
  h.run('appendWritingSkillSettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const section=container.children[0],views=descendants(section).filter(node=>node.tagName==='BUTTON'&&node.textContent==='查看'),responses=[];
  h.skillDetail=id=>new Promise(resolve=>responses.push({id,resolve}));const first=views[0].listeners.click(),second=views[1].listeners.click();
  responses[1].resolve({content:'new selection',files:[]});await second;responses[0].resolve({content:'stale selection',files:[]});await first;
  assert.ok(find(section,node=>node.textContent==='new selection'));assert.ok(!find(section,node=>node.textContent==='stale selection'));
  const third=views[2].listeners.click();h.state.book={...h.state.book,id:'different-book'};responses[2].resolve({content:'different book late text',files:[]});await third;
  assert.ok(!find(section,node=>node.textContent==='different book late text'));
});

test('AI inherits imported skill defaults, previews names/references/counts and sends only the current explicit choice',async()=>{
  const h=harness();h.skills.skills[0].imported=true;h.skills.defaults={skillIds:['chinese-novelist','human-writing'],skillMode:'continue'};
  await h.run("showAIAssistant('draft')");
  assert.equal(find(h.get('dialog-body'),node=>node.className==='ai-writing-skills').open,false);
  assert.equal(field(h,'ai-skill-chinese-novelist').checked,true);assert.equal(field(h,'ai-skill-human-writing').disabled,true);assert.equal(field(h,'ai-skill-mode').value,'continue');
  const material=find(h.get('dialog-body'),node=>node.className==='ai-material');assert.equal(material.open,false);
  assert.ok(find(material,node=>node.textContent==='Skill：300 字符（计入总数）'));
  assert.ok(find(material,node=>node.textContent.includes('references/chapter.md')));assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  const box=field(h,'ai-skill-chinese-novelist');box.checked=false;box.listeners.change();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(!find(h.get('dialog-body'),node=>node.textContent.startsWith('Skill：')));assert.ok(find(h.get('dialog-body'),node=>node.tagName==='SUMMARY'&&node.textContent==='写作 Skill'));
  await button(h,'发送所选资料').listeners.click();const sent=h.calls.find(call=>call.url.endsWith('/ai')).data;
  assert.deepEqual(sent.skillIds,[]);assert.equal(sent.skillMode,'continue');assert.equal(sent.action,'draft');
});

test('failed or delayed skill previews never enable sending an old choice, including the instruction debounce gap',async()=>{
  const h=harness();h.skills.skills[0].imported=true;await h.run("showAIAssistant('draft')");
  const normal=h.preview,responses=[];h.preview=data=>new Promise((resolve,reject)=>responses.push({data,resolve,reject}));
  const box=field(h,'ai-skill-chinese-novelist');box.checked=true;box.listeners.change();assert.equal(button(h,'发送所选资料').disabled,true);
  const task=field(h,'ai-skill-mode');task.value='polish';task.listeners.change();responses[1].reject(Error('preview failed'));await new Promise(resolve=>setImmediate(resolve));
  responses[0].resolve(normal(responses[0].data));await new Promise(resolve=>setImmediate(resolve));assert.equal(button(h,'发送所选资料').disabled,true);
  await button(h,'发送所选资料').listeners.click();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  h.preview=normal;task.value='chapter';await task.listeners.change();assert.equal(button(h,'发送所选资料').disabled,false);
  h.preview=data=>new Promise(resolve=>responses.push({data,resolve}));task.value='outline';task.listeners.change();
  const latest=responses.at(-1);field(h,'ai-instruction').value='new instruction';field(h,'ai-instruction').listeners.input();latest.resolve(normal(latest.data));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button(h,'发送所选资料').disabled,true,'late preview cannot reopen send during debounce');
});

test('skill settings can refresh a failed scan, while pending AI requests lock skill selection and preserve the manuscript',async()=>{
  const h=harness(),container=new Element();h.context.container=container;h.skillError=Error('scan failed');h.run('appendWritingSkillSettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const refresh=find(container,node=>node.textContent==='导入本机写作 Skill');assert.equal(refresh.disabled,false);h.skillError=null;await refresh.listeners.click();assert.equal(h.skills.skills.every(skill=>skill.imported),true);
  await h.run("showAIAssistant('draft')");const snapshot=JSON.stringify(h.state.book);let finish;h.result=()=>new Promise(resolve=>{finish=resolve;});
  const pending=button(h,'发送所选资料').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(field(h,'ai-skill-mode').disabled,true);assert.equal(field(h,'ai-skill-chinese-novelist').disabled,true);assert.equal(button(h,'打开 AI 设置').disabled,true);
  finish({bookId:h.state.book.id,action:'draft',data:{title:'review first',body:'no automatic adoption'}});await pending;
  assert.equal(field(h,'ai-skill-mode').disabled,false);assert.equal(JSON.stringify(h.state.book),snapshot);
});

test('an initial skill scan arriving after an import cannot replace the imported list',async()=>{
  const h=harness(),container=new Element(),old=structuredClone(h.skills),original=h.context.localAPI;h.context.container=container;let finish,first=true;
  h.context.localAPI=(url,...args)=>{if(url==='/api/skills'&&first){first=false;return new Promise(resolve=>{finish=resolve;});}return original(url,...args);};
  h.run('appendWritingSkillSettings(container)');await find(container,node=>node.textContent==='导入本机写作 Skill').listeners.click();
  finish(old);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(find(container,node=>node.id==='writing-skill-default-chinese-novelist').disabled,false);
  assert.ok(find(container,node=>node.textContent==='本机写作 Skill 已导入。原文件未修改。'));
});

test('malformed or mismatched skill previews stay unsendable and all seven writing tasks remain available',async()=>{
  for(const malformed of [value=>({...value,counts:null}),value=>({...value,selectedSkillIds:['human-writing']}),value=>({...value,skillMode:'polish'})]){
    const h=harness(),normal=h.preview;h.preview=data=>malformed(normal(data));await h.run("showAIAssistant('draft')");
    assert.equal(field(h,'ai-skill-mode').options.length,7);assert.equal(button(h,'发送所选资料').disabled,true);
    await button(h,'发送所选资料').listeners.click();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  }
});

test('five presets are editable, each action keeps its own words, resetting restores that preset and sends exactly the visible prompt',async()=>{
  const h=harness();await h.run("showAIAssistant('draft')");const mode=field(h,'ai-action'),prompt=field(h,'ai-instruction'),draft=prompt.value;
  assert.equal(mode.options.length,6);assert.ok(draft.length>80);
  prompt.value='我的草稿要求：保留沈砚的动机，只写一个场景。';prompt.listeners.input();
  mode.value='outline';await mode.listeners.change();const outline=prompt.value;assert.ok(outline.includes('总纲'));assert.ok(!outline.includes('我的草稿要求'));
  prompt.value='我的大纲要求：三卷，每卷两章。';prompt.listeners.input();
  mode.value='draft';await mode.listeners.change();assert.equal(prompt.value,'我的草稿要求：保留沈砚的动机，只写一个场景。');
  await button(h,'恢复默认提示词').listeners.click();assert.equal(prompt.value,draft);
  for(const action of ['relationships','consistency']){mode.value=action;await mode.listeners.change();assert.ok(prompt.value.length>80);assert.ok(!prompt.value.includes('我的大纲要求'));}
  mode.value='outline';await mode.listeners.change();assert.equal(prompt.value,'我的大纲要求：三卷，每卷两章。');
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{nodes:[{key:'s',parentKey:null,kind:'story',title:'候选总纲',body:'作者可编辑的故事构思。'}]}});
  await button(h,'发送所选资料').listeners.click();const sent=h.calls.filter(call=>call.url.endsWith('/ai')).at(-1).data;
  assert.equal(sent.instruction,prompt.value);assert.equal(sent.action,'outline');
  assert.equal(h.calls.filter(call=>call.url.endsWith('/ai/preview')).at(-1).data.instruction,prompt.value);
});

test('a blank book adopts edited hierarchical outlines once, with ancestors, and existing volume/chapter builders can use them',async()=>{
  const h=harness();h.state.book={id:'blank',kind:'long',title:'新故事',volumes:[],chapters:[],outline:[],notes:[],relations:[]};h.state.chapterId=null;h.state.view='outline';
  const nodes=[{key:'s',parentKey:null,kind:'story',title:'候选总纲',body:'候选主线。'},{key:'v',parentKey:'s',kind:'volume',title:'第一卷 候选',body:'分卷安排。'},{key:'c',parentKey:'v',kind:'chapter',title:'第一章',body:'<img src=x>\n章纲。'},{key:'w',parentKey:'s',kind:'setting',title:'设定',body:'规则。'}];
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{nodes:structuredClone(nodes)}});
  await h.run("showAIAssistant('outline')");assert.equal(h.calls.find(call=>call.url.endsWith('/ai/preview')).data.chapterIds.length,0);
  await button(h,'发送所选资料').listeners.click();assert.equal(h.state.book.outline.length,0);assert.ok(!find(h.get('dialog-body'),node=>node.tagName==='IMG'));
  await button(h,'追加勾选的大纲').listeners.click();assert.equal(h.state.book.outline.length,0);
  const child=field(h,'ai-outline-select-2');child.checked=true;child.listeners.change();assert.equal(field(h,'ai-outline-select-0').checked,true);assert.equal(field(h,'ai-outline-select-1').checked,true);
  field(h,'ai-outline-title-2').value='第一章 作者修改';field(h,'ai-outline-body-2').value='作者补充的章纲。';
  h.saves=[true,false];await button(h,'追加勾选的大纲').listeners.click();assert.equal(h.get('dialog').open,true);assert.equal(h.state.book.outline.length,3);assert.equal(h.state.book.chapters.length,0);assert.equal(h.state.book.volumes.length,0);
  const ids=h.state.book.outline.map(node=>node.id);await button(h,'重试保存').listeners.click();assert.deepEqual(h.state.book.outline.map(node=>node.id),ids);assert.equal(h.state.view,'outline');
  const chapterOutline=h.state.book.outline[2];assert.equal(chapterOutline.parentId,h.state.book.outline[1].id);assert.equal(chapterOutline.title,'第一章 作者修改');
  h.run('chapterFromOutline(state.book.outline[2],false)');assert.equal(h.state.book.volumes.length,1);assert.equal(h.state.book.chapters.length,1);assert.equal(h.state.book.chapters[0].volumeId,h.state.book.volumes[0].id);assert.equal(h.state.book.chapters[0].body,'');
});

test('outline adoption appends to existing plans, maps settings to scene and keeps original manuscript untouched',async()=>{
  const h=harness(),before=structuredClone(h.state.book),count=before.outline.length;
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{nodes:[{key:'s',parentKey:null,kind:'story',title:'候选支线',body:'新的支线规划。'},{key:'w',parentKey:'s',kind:'setting',title:'新规则',body:'候选规则。'}]}});
  await h.run("showAIAssistant('outline')");await button(h,'发送所选资料').listeners.click();await button(h,'全选大纲').listeners.click();await button(h,'追加勾选的大纲').listeners.click();
  assert.equal(h.state.book.outline.length,count+2);assert.deepEqual(h.state.book.outline.slice(0,count),before.outline);assert.equal(h.state.book.outline.at(-1).kind,'scene');assert.equal(h.state.book.outline.at(-1).category,'世界设定');assert.deepEqual(h.state.book.chapters,before.chapters);assert.deepEqual(h.state.book.volumes,before.volumes);
});

function seededNewBook(){
  const h=harness();h.state.book={id:'new-book',kind:'long',title:'河岸旧事',cover:'',volumes:[{id:'default-volume',title:'第一卷',summary:'',deletedAt:null}],chapters:[],outline:[],notes:[],relations:[],atlasViews:[]};h.state.chapterId=null;h.state.view='outline';
  h.run('createOutlineTemplate()');
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{nodes:[{key:'s',parentKey:null,kind:'story',title:'河岸旧事总纲',body:'围绕旧档案展开调查。'},{key:'v',parentKey:'s',kind:'volume',title:'第一卷 河岸旧事',body:'调查从旧码头开始。'},{key:'c',parentKey:'v',kind:'chapter',title:'第一章 来信',body:'收到一封没有邮戳的信。'},{key:'w',parentKey:'s',kind:'setting',title:'河港规则',body:'涨潮时渡轮停航。'}]}});
  return h;
}
async function prepareOutlineAdoption(h){await h.run("showAIAssistant('outline')");await button(h,'发送所选资料').listeners.click();await button(h,'全选大纲').listeners.click();}

test('the untouched real new-book template reuses its first volume once and changes its title only when generating the directory',async()=>{
  const h=seededNewBook(),book=h.state.book,volume=book.volumes[0],originalVolume=structuredClone(volume),plan=book.outline[1],planId=plan.id;
  assert.equal(book.outline.length,5);await prepareOutlineAdoption(h);h.saves=[true,false];await button(h,'追加勾选的大纲').listeners.click();
  assert.equal(h.get('dialog').open,true);assert.equal(book.outline.length,8);assert.equal(book.outline.filter(node=>node.kind==='volume').length,1);assert.equal(plan.id,planId);assert.equal(plan.title,'第一卷 河岸旧事');assert.equal(plan.volumeId,volume.id);assert.deepEqual(volume,originalVolume);
  const chapter=book.outline.find(node=>node.kind==='chapter');assert.equal(chapter.parentId,planId);assert.equal(book.chapters.length,0);
  const ids=book.outline.map(node=>node.id);await button(h,'重试保存').listeners.click();assert.deepEqual(book.outline.map(node=>node.id),ids);assert.equal(book.volumes.length,1);
  h.run('renderOutline=()=>{};renderChapters=()=>{};renderStats=()=>{};buildOutlineStructure()');
  assert.ok(find(h.get('dialog-body'),node=>node.textContent.includes('建立 0 卷、1 个空白章节')));assert.deepEqual(volume,originalVolume);
  await button(h,'生成目录').listeners.click();assert.equal(book.volumes.length,1);assert.equal(book.chapters.length,1);assert.equal(book.chapters[0].volumeId,volume.id);assert.equal(volume.title,'第一卷 河岸旧事');assert.equal(volume.summary,'调查从旧码头开始。');
  h.run('buildOutlineStructure()');await button(h,'生成目录').listeners.click();assert.equal(book.volumes.length,1);assert.equal(book.chapters.length,1);assert.equal(volume.title,'第一卷 河岸旧事');
});

test('any authored or changed new-book material keeps AI outline adoption append-only',async()=>{
  const changes=[
    book=>{book.outline[0].body='作者的主线。';},
    book=>{book.outline[1].body='作者的分卷安排。';},
    book=>{book.outline[2].body='作者的世界规则。';},
    book=>{book.volumes[0].summary='作者的卷说明。';},
    book=>{book.volumes[0].title='作者命名的卷';book.outline[1].title=book.volumes[0].title;},
    book=>{book.outline[1].title='作者单独修改的卷纲';},
    book=>{book.chapters.push({id:'written',title:'第一章',body:'',volumeId:book.volumes[0].id,deletedAt:null});},
    book=>{book.notes.push({id:'person',type:'人物',title:'作者人物',body:'',chapterIds:[],deletedAt:null});},
    book=>{book.relations.push({id:'planned-relationship',fromId:'a',toId:'b',label:'预设关系',deletedAt:null});},
    book=>{book.outline[4].deletedAt='2026-10-10';},
    book=>{book.outline[1].parentId=null;},
    book=>{book.outline[1].chapterIds=['deleted-chapter'];},
    book=>{book.atlasViews.push({id:'planned-view',title:'作者分图'});}
  ];
  for(const change of changes){const h=seededNewBook();change(h.state.book);const before=structuredClone(h.state.book);await prepareOutlineAdoption(h);await button(h,'追加勾选的大纲').listeners.click();
    assert.equal(h.state.book.outline.length,9);assert.deepEqual(structuredClone(h.state.book.outline.slice(0,5)),before.outline);assert.deepEqual(h.state.book.volumes,before.volumes);assert.deepEqual(h.state.book.chapters,before.chapters);assert.equal(h.state.book.outline.at(-3).volumeId,null);
  }
});

test('custom starts blank, allows zero chapters, renders and copies editable plain text without any adoption action',async()=>{
  const h=harness(),before=JSON.stringify(h.state.book);h.state.book.chapters=[];h.state.chapterId=null;
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{text:'<script>alert(1)</script>\n几个候选名字。'}});
  await h.run("showAIAssistant('custom')");const prompt=field(h,'ai-instruction');assert.equal(prompt.value,'');assert.equal(button(h,'发送所选资料').disabled,true);
  prompt.value='请给档案馆取三个名字并解释。';prompt.listeners.input();await field(h,'ai-skill-mode').listeners.change();assert.equal(button(h,'发送所选资料').disabled,false);
  const snapshot=JSON.stringify(h.state.book);await button(h,'发送所选资料').listeners.click();const text=field(h,'ai-custom-result');assert.match(text.value,/<script>/);assert.ok(!find(h.get('dialog-body'),node=>node.tagName==='SCRIPT'));
  assert.ok(!find(h.get('dialog-body'),node=>node.textContent==='保存为新章节'||node.textContent==='追加勾选的大纲'));text.value='作者编辑后的回答';await button(h,'复制结果').listeners.click();assert.deepEqual(h.copied,['作者编辑后的回答']);assert.equal(JSON.stringify(h.state.book),snapshot);
  await button(h,'恢复默认提示词').listeners.click();assert.equal(prompt.value,'');assert.equal(button(h,'发送所选资料').disabled,true);assert.notEqual(snapshot,before);
});

test('action changes invalidate stale previews, pending sends lock prompts/actions/reset and late results after closing are discarded',async()=>{
  const h=harness();await h.run("showAIAssistant('draft')");const mode=field(h,'ai-action'),prompt=field(h,'ai-instruction'),normal=h.preview,responses=[];
  h.preview=data=>new Promise(resolve=>responses.push({data,resolve}));mode.value='outline';mode.listeners.change();mode.value='custom';mode.listeners.change();
  responses[0].resolve(normal(responses[0].data));await new Promise(resolve=>setImmediate(resolve));assert.equal(button(h,'发送所选资料').disabled,true);
  prompt.value='只讨论一个名字。';prompt.listeners.input();h.preview=normal;await field(h,'ai-skill-mode').listeners.change();
  let finish;h.result=()=>new Promise(resolve=>{finish=resolve;});const pending=button(h,'发送所选资料').listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(mode.disabled,true);assert.equal(prompt.disabled,true);assert.equal(button(h,'恢复默认提示词').disabled,true);
  mode.value='draft';mode.listeners.change();assert.equal(mode.value,'custom');const savedPrompt=prompt.value;await button(h,'恢复默认提示词').listeners.click();assert.equal(prompt.value,savedPrompt);
  const snapshot=JSON.stringify(h.state.book);h.get('dialog').open=false;finish({bookId:h.state.book.id,action:'custom',data:{text:'迟到回答'}});await pending;assert.ok(!find(h.get('dialog-body'),node=>node.id==='ai-custom-result'));assert.equal(JSON.stringify(h.state.book),snapshot);
});

const coverRaster='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
function coverHarness(){
  const h=harness();h.compositions=[];
  h.context.WriterCovers={composeImage:async(image,title)=>{h.compositions.push({image,title});return coverRaster;},render:(template,title)=>'template:'+template+':'+title};
  h.imageResult=()=>({image:coverRaster});
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{titles:['潮声替我来信','第七封信','无人签收的星光'],coverPrompt:'深蓝色海面，一封白色信，竖版构图，为书名留白。'}});
  return h;
}
function dialogButton(dialog,text){const result=find(dialog,node=>node.tagName==='BUTTON'&&node.textContent===text);assert.ok(result,'Missing cover button '+text);return result;}
function dialogField(dialog,id){const result=find(dialog,node=>node.id===id);assert.ok(result,'Missing cover field '+id);return result;}
async function showMetadataCover(h,options={}){
  h.get('dialog').open=true;h.applied=[];h.parentCurrent=true;
  h.context.coverOptions={bookId:null,title:'尚未保存的新书',kind:'long',isCurrent:()=>h.parentCurrent,onApply:value=>{h.applied.push(structuredClone(value));return true;},...options};
  await h.run('showAIBookCover(coverOptions)');return h.run('aiBookCoverDialog');
}

test('image model is optional, retained and explicitly editable in AI settings',async()=>{
  const h=coverHarness(),container=new Element();h.context.container=container;h.settings.imageModel='provider-image-v1';h.run('appendAISettings(container)');await new Promise(resolve=>setImmediate(resolve));
  const model=find(container,node=>node.id==='ai-image-model'),save=find(container,node=>node.textContent==='保存 AI 设置');
  assert.equal(model.value,'provider-image-v1');model.value='';await save.listeners.click();assert.equal(h.settings.imageModel,'');
  model.value='provider-image-v2';await save.listeners.click();assert.equal(h.calls.filter(call=>call.method==='PUT').at(-1).data.imageModel,'provider-image-v2');
});

test('the sixth action keeps an editable/resettable title prompt and previews without requesting images or modifying books',async()=>{
  const h=coverHarness(),snapshot=JSON.stringify(h.state.book);await h.run("showAIAssistant('book_cover')");const prompt=field(h,'ai-instruction'),preset=prompt.value;
  assert.equal(field(h,'ai-action').options.length,6);assert.match(preset,/候选书名/);assert.match(preset,/不生成图片/);
  prompt.value='我想要冷静克制的短书名，封面采用午夜蓝。';prompt.listeners.input();await field(h,'ai-skill-mode').listeners.change();await button(h,'发送所选资料').listeners.click();
  assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).at(-1).data.instruction,prompt.value);
  assert.equal(field(h,'ai-cover-title').value,'潮声替我来信');assert.equal(button(h,'采用书名与封面').disabled,true);assert.equal(h.calls.filter(call=>call.url==='/api/ai/cover-image').length,0);assert.equal(JSON.stringify(h.state.book),snapshot);
  await button(h,'生成封面').listeners.click();assert.ok(find(h.get('dialog-body'),node=>node.textContent==='请先在设置中填写图像模型。'));assert.equal(h.calls.filter(call=>call.url==='/api/ai/cover-image').length,0);
  await button(h,'恢复默认提示词').listeners.click();assert.equal(prompt.value,preset);assert.ok(!find(h.get('dialog-body'),node=>node.id==='ai-cover-title'));
});

test('cover images are requested only explicitly with the visible image prompt; changing the title recomposes locally and never sends an image as context',async()=>{
  const h=coverHarness();h.settings.imageModel='provider-image';await h.run("showAIAssistant('book_cover')");await button(h,'发送所选资料').listeners.click();
  field(h,'ai-cover-prompt').value='作者修改的海边封面构图';await button(h,'生成封面').listeners.click();
  assert.deepEqual(h.calls.filter(call=>call.url==='/api/ai/cover-image').map(call=>call.data),[{prompt:'作者修改的海边封面构图'}]);assert.equal(h.compositions.length,1);assert.equal(button(h,'采用书名与封面').disabled,false);
  await button(h,'第七封信').listeners.click();assert.equal(field(h,'ai-cover-title').value,'第七封信');field(h,'ai-cover-title').value='作者的新书名';await field(h,'ai-cover-title').listeners.input();
  assert.equal(h.compositions.length,3);assert.equal(h.compositions.at(-1).title,'作者的新书名');assert.equal(h.calls.filter(call=>call.url==='/api/ai/cover-image').length,1);
  assert.ok(!JSON.stringify(h.calls.filter(call=>call.url.endsWith('/ai'))).includes('data:image'));
  const before=structuredClone(h.state.book.chapters);h.state.book.coverTemplate='night';h.saves=[true,false];await button(h,'采用书名与封面').listeners.click();
  assert.equal(h.state.book.title,'作者的新书名');assert.equal(h.state.book.cover,coverRaster);assert.equal(h.state.book.coverTemplate,'');assert.deepEqual(h.state.book.chapters,before);assert.equal(field(h,'ai-cover-title').disabled,true);
  await button(h,'重试保存').listeners.click();assert.equal(h.get('dialog').open,false);assert.equal(h.calls.filter(call=>call.url==='/api/ai/cover-image').length,1);
});

test('title-only adoption preserves uploaded covers, updates templates and changes no manuscript content',async()=>{
  for(const template of ['', 'night']){const h=coverHarness(),original=structuredClone(h.state.book);h.state.book.cover='original-upload';h.state.book.coverTemplate=template;
    await h.run("showAIAssistant('book_cover')");await button(h,'发送所选资料').listeners.click();await button(h,'采用书名').listeners.click();
    assert.equal(h.state.book.title,'潮声替我来信');assert.equal(h.state.book.cover,template?'template:night:潮声替我来信':'original-upload');assert.equal(h.state.book.coverTemplate,template);assert.deepEqual(h.state.book.chapters,original.chapters);assert.deepEqual(h.state.book.outline,original.outline);
  }
});

test('invalid image responses and provider failures do not retry, overwrite the book or enable image adoption',async()=>{
  for(const response of [()=>({image:'https://provider.test/private.png'}),()=>({image:'data:image/svg+xml;base64,PHN2Zz4='}),()=>{throw Error('image provider failed');}]){
    const h=coverHarness();h.settings.imageModel='provider-image';h.imageResult=response;const snapshot=JSON.stringify(h.state.book);await h.run("showAIAssistant('book_cover')");await button(h,'发送所选资料').listeners.click();await button(h,'生成封面').listeners.click();
    assert.equal(h.calls.filter(call=>call.url==='/api/ai/cover-image').length,1);assert.equal(h.compositions.length,0);assert.equal(button(h,'采用书名与封面').disabled,true);assert.equal(JSON.stringify(h.state.book),snapshot);assert.equal(button(h,'生成封面').disabled,false);
  }
});

test('late image responses after a book switch, action change or dialog close cannot preview or adopt a cover',async()=>{
  for(const abandon of ['book','mode','close']){const h=coverHarness();h.settings.imageModel='provider-image';let finish;h.imageResult=()=>new Promise(resolve=>{finish=resolve;});await h.run("showAIAssistant('book_cover')");await button(h,'发送所选资料').listeners.click();const original=h.state.book,snapshot=JSON.stringify(original),pending=button(h,'生成封面').listeners.click();await new Promise(resolve=>setImmediate(resolve));
    if(abandon==='book')h.state.book={...structuredClone(sample),id:'another-book'};else if(abandon==='mode'){field(h,'ai-action').value='draft';await field(h,'ai-action').listeners.change();}else h.get('dialog').open=false;
    finish({image:coverRaster});await pending;assert.equal(h.compositions.length,0);assert.equal(JSON.stringify(original),snapshot);assert.ok(!find(h.get('dialog-body'),node=>node.tagName==='IMG'&&!node.hidden));
  }
});

test('local composition discards old results while typing and failed template composition cannot partially rename the book',async()=>{
  const h=coverHarness();h.settings.imageModel='provider-image';await h.run("showAIAssistant('book_cover')");await button(h,'发送所选资料').listeners.click();await button(h,'生成封面').listeners.click();
  const compositions=[];h.context.WriterCovers.composeImage=(image,title)=>new Promise(resolve=>compositions.push({title,resolve}));const title=field(h,'ai-cover-title');title.value='旧输入';const old=title.listeners.input();title.value='最终输入';const latest=title.listeners.input();
  assert.equal(button(h,'采用书名与封面').disabled,true);compositions[1].resolve(coverRaster);await latest;compositions[0].resolve('data:image/png;base64,b2xk');await old;
  assert.equal(button(h,'采用书名与封面').disabled,false);const originalTitle=h.state.book.title;h.state.book.coverTemplate='night';h.context.WriterCovers.render=()=>{throw Error('无法绘制封面，请重试。');};await button(h,'采用书名').listeners.click();
  assert.equal(h.state.book.title,originalTitle);assert.equal(field(h,'ai-cover-title').disabled,false);assert.equal(h.state.dirty,false);
});

test('metadata cover dialog previews locally, keeps the parent form open and applies only explicit candidates without saving or creating a book',async()=>{
  const h=coverHarness(),snapshot=JSON.stringify(h.state.book);const dialog=await showMetadataCover(h);assert.ok(dialog.open);assert.equal(h.get('dialog').open,true);assert.ok(h.calls.some(call=>call.url==='/api/ai/book-cover'&&call.data.preview===true));assert.equal(h.calls.filter(call=>call.url==='/api/ai/book-cover'&&!call.data.preview).length,0);
  const prompt=dialogField(dialog,'ai-book-cover-instruction'),preset=prompt.value;prompt.value='未保存新书的作者要求';prompt.listeners.input();await dialogField(dialog,'ai-book-cover-skill-mode').listeners.change();await dialogButton(dialog,'生成候选').listeners.click();
  const request=h.calls.filter(call=>call.url==='/api/ai/book-cover'&&!call.data.preview).at(-1).data;assert.equal(request.prompt,prompt.value);assert.equal(request.title,'尚未保存的新书');assert.ok(!Object.hasOwn(request,'cover'));assert.equal(h.applied.length,0);
  await dialogButton(dialog,'恢复默认提示词').listeners.click();assert.equal(prompt.value,preset);await dialogButton(dialog,'生成候选').listeners.click();await dialogButton(dialog,'采用书名').listeners.click();
  assert.deepEqual(h.applied,[{title:'潮声替我来信'}]);assert.equal(dialog.open,false);assert.equal(h.get('dialog').open,true);assert.equal(JSON.stringify(h.state.book),snapshot);assert.equal(h.renderCount,0);assert.ok(!h.calls.some(call=>call.url.startsWith('/api/books/')||call.url==='/api/books'));
});

test('metadata adoption closes successfully even when the parent invalidates the one-use callback token, and rejection can be retried',async()=>{
  const h=coverHarness();let attempts=0;const dialog=await showMetadataCover(h,{onApply:value=>{attempts++;if(attempts===1)return false;h.applied.push(structuredClone(value));h.parentCurrent=false;return true;}});
  await dialogButton(dialog,'生成候选').listeners.click();await dialogButton(dialog,'采用书名').listeners.click();assert.equal(dialog.open,true);assert.equal(dialogField(dialog,'ai-cover-title').disabled,false);
  await dialogButton(dialog,'采用书名').listeners.click();assert.equal(attempts,2);assert.equal(dialog.open,false);assert.equal(h.applied.length,1);
});

test('metadata error and late image/composition results cannot fill a closed or superseded parent book form',async()=>{
  for(const phase of ['image','compose']){const h=coverHarness();h.settings.imageModel='provider-image';let finish;const dialog=await showMetadataCover(h);await dialogButton(dialog,'生成候选').listeners.click();
    if(phase==='image')h.imageResult=()=>new Promise(resolve=>{finish=resolve;});else h.context.WriterCovers.composeImage=()=>new Promise(resolve=>{finish=resolve;});
    const pending=dialogButton(dialog,'生成封面').listeners.click();await new Promise(resolve=>setImmediate(resolve));h.parentCurrent=false;finish(phase==='image'?{image:coverRaster}:coverRaster);await pending;await dialogButton(dialog,'采用书名').listeners.click();assert.equal(h.applied.length,0);assert.ok(!find(dialog,node=>node.tagName==='IMG'&&!node.hidden));await dialogButton(dialog,'关闭').listeners.click();
    assert.equal(dialog.open,false);assert.equal(h.get('dialog').open,true);
  }
  const h=coverHarness();const dialog=await showMetadataCover(h,{onApply:()=>{throw Error('metadata failed');}});await dialogButton(dialog,'生成候选').listeners.click();await dialogButton(dialog,'采用书名').listeners.click();assert.ok(find(dialog,node=>node.textContent==='metadata failed'));assert.equal(dialogField(dialog,'ai-cover-title').disabled,false);
});

test('metadata AI uses the selected existing book even when another book is open and includes the proposed unsaved title',async()=>{
  const h=coverHarness(),current=h.state.book,targetId='shelf-book-not-open',normalPreview=h.preview,normalResult=h.result;
  h.preview=request=>({...normalPreview(request),bookId:targetId,contextChars:24000});h.result=request=>({...normalResult(request),bookId:targetId});
  const dialog=await showMetadataCover(h,{bookId:targetId,title:'作者待采用的新名字'});assert.equal(h.state.book,current);assert.ok(find(dialog,node=>node.textContent==='共 24,000 字符'));
  const preview=h.calls.find(call=>call.url==='/api/books/'+targetId+'/ai/preview');assert.equal(preview.data.action,'book_cover');assert.deepEqual(preview.data.chapterIds,[]);assert.match(preview.data.instruction,/待采用书名：作者待采用的新名字$/);assert.ok(find(dialog,node=>node.textContent==='待采用书名：作者待采用的新名字'));
  dialogField(dialog,'ai-book-cover-instruction').value='作者新提示';await dialogField(dialog,'ai-book-cover-skill-mode').listeners.change();await dialogButton(dialog,'生成候选').listeners.click();
  const request=h.calls.find(call=>call.url==='/api/books/'+targetId+'/ai');assert.equal(request.data.instruction,'作者新提示\n\n待采用书名：作者待采用的新名字');assert.ok(!h.calls.some(call=>call.url==='/api/ai/book-cover'));assert.equal(h.state.book,current);
  await dialogButton(dialog,'采用书名').listeners.click();assert.deepEqual(h.applied,[{title:'潮声替我来信'}]);assert.equal(h.state.book.title,sample.title);
});

test('existing metadata preview and result book IDs must match the chosen shelf book independently of the current book',async()=>{
  for(const mismatch of ['preview','result']){const h=coverHarness(),targetId='chosen-shelf-book',normalPreview=h.preview;h.preview=request=>({...normalPreview(request),bookId:mismatch==='preview'?h.state.book.id:targetId});
    const dialog=await showMetadataCover(h,{bookId:targetId});if(mismatch==='preview'){assert.equal(dialogButton(dialog,'生成候选').disabled,true);await dialogButton(dialog,'生成候选').listeners.click();assert.ok(!h.calls.some(call=>call.url==='/api/books/'+targetId+'/ai'));}
    else{await dialogButton(dialog,'生成候选').listeners.click();assert.ok(find(dialog,node=>node.textContent==='AI 结果与当前作品不匹配。'));assert.ok(!find(dialog,node=>node.id==='ai-cover-title'));}
    assert.equal(h.applied.length,0);
  }
});

function renderConversationCandidate(h,action='draft',options={}){
  const container=new Element(),response=options.response||h.result({action,chapterIds:[h.state.chapterId]});
  h.context.candidateContainer=container;h.context.candidateResponse=response;h.adoptions=[];h.applications=[];h.candidateActive=true;
  h.context.candidateOptions={book:h.state.book,chapters:h.state.book.chapters.filter(chapter=>!chapter.deletedAt),chapterIds:[h.state.chapterId],current:()=>h.candidateActive,settings:()=>h.settings,onApplied:target=>h.applications.push(structuredClone(target)),onAdopt:target=>h.adoptions.push(structuredClone(target)),...options};
  const controller=h.run('renderAIResult(candidateContainer,candidateResponse,candidateOptions)');
  return{container,controller,button:text=>dialogButton(container,text),field:id=>dialogField(container,(options.idPrefix||'')+id)};
}

test('conversation adoption previews first, keeps the current view and unrelated dialog open, and disables both actions after one save',async()=>{
  const h=harness(),original=h.state.book.chapters[0],before=original.body,count=h.state.book.chapters.length;h.get('dialog').open=true;
  const candidate=renderConversationCandidate(h,'draft',{idPrefix:'message-one-'}),draft=candidate.field('ai-draft-body').value;
  assert.equal(original.body,before);assert.equal(h.applications.length,0);assert.match(draft,/<img src=x/);assert.ok(!find(candidate.container,node=>node.tagName==='IMG'));
  h.state.view='outline';h.state.chapterId=h.state.book.chapters[1].id;
  await candidate.button('追加到目标章节').listeners.click();
  assert.equal(original.body,before+'\n\n'+draft);assert.equal(h.state.book.chapters.length,count);assert.equal(h.get('dialog').open,true);assert.equal(h.state.view,'outline');assert.equal(h.state.chapterId,h.state.book.chapters[1].id);assert.equal(h.renderCount,0);
  assert.deepEqual(h.applications,[{view:'write',chapterId:original.id}]);assert.deepEqual(h.adoptions,h.applications);assert.equal(candidate.controller.hasUnsavedAdoption(),false);
  assert.ok(descendants(candidate.container).filter(node=>node.tagName==='BUTTON').every(node=>node.disabled));
  for(const button of descendants(candidate.container).filter(node=>node.tagName==='BUTTON'))await button.listeners.click();
  assert.equal(original.body,before+'\n\n'+draft);assert.equal(h.state.book.chapters.length,count);assert.equal(h.adoptions.length,1);
});

test('conversation buttons share pending and failed-save decisions, notify history consumption once, then retry only persistence',async()=>{
  const h=harness(),chapter=h.state.book.chapters[0],before=chapter.body,count=h.state.book.chapters.length,candidate=renderConversationCandidate(h),draft=candidate.field('ai-draft-body').value;
  let resolveSave;h.saves=[true,new Promise(resolve=>{resolveSave=resolve;})];
  const append=candidate.button('追加到目标章节'),create=candidate.button('保存为新章节'),pending=append.listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(append.disabled,true);assert.equal(create.disabled,true);assert.equal(h.applications.length,1);assert.equal(h.adoptions.length,0);assert.equal(candidate.controller.hasUnsavedAdoption(),true);
  await create.listeners.click();assert.equal(chapter.body,before+'\n\n'+draft);assert.equal(h.state.book.chapters.length,count);
  resolveSave(false);await pending;assert.equal(append.textContent,'重试保存');assert.equal(create.textContent,'重试保存');assert.equal(candidate.controller.hasUnsavedAdoption(),true);
  await create.listeners.click();assert.equal(chapter.body,before+'\n\n'+draft);assert.equal(h.state.book.chapters.length,count);assert.equal(h.applications.length,1);assert.equal(h.adoptions.length,1);assert.equal(candidate.controller.hasUnsavedAdoption(),false);assert.equal(append.disabled,true);assert.equal(create.disabled,true);
});

test('conversation adoption re-resolves chapter objects after continued editing and rejects a deleted destination',async()=>{
  for(const deleted of [false,true]){
    const h=harness(),captured=h.state.book.chapters[0],before=captured.body,candidate=renderConversationCandidate(h),draft=candidate.field('ai-draft-body').value;
    const replacement={...captured,body:'作者在对话期间写下的新正文。',deletedAt:deleted?'2026-10-12':null};h.state.book.chapters[0]=replacement;
    await candidate.button('追加到目标章节').listeners.click();
    assert.equal(captured.body,before);assert.equal(replacement.body,'作者在对话期间写下的新正文。'+(deleted?'':'\n\n'+draft));assert.equal(h.applications.length,deleted?0:1);assert.equal(h.adoptions.length,deleted?0:1);
    if(deleted)assert.equal(h.get('toast').textContent,'请选择有效的目标章节。');
  }
});

test('conversation drafts use the live linked outline object rather than a stale captured outline',async()=>{
  const h=harness(),volume=h.state.book.volumes[0],captured={id:'live-outline-target',kind:'chapter',title:'新章纲',body:'当前计划',parentId:null,volumeId:volume.id,chapterIds:[],deletedAt:null};h.state.book.outline.push(captured);
  const candidate=renderConversationCandidate(h,'draft',{sourceOutline:captured}),live={...captured,chapterIds:[]};h.state.book.outline[h.state.book.outline.indexOf(captured)]=live;
  await candidate.button('保存为新章节').listeners.click();
  assert.equal(captured.chapterIds.length,0);assert.equal(live.chapterIds.length,1);const created=h.state.book.chapters.find(chapter=>chapter.id===live.chapterIds[0]);assert.ok(created);assert.equal(created.volumeId,volume.id);assert.deepEqual(h.adoptions,[{view:'write',chapterId:created.id}]);
});

test('conversation outlines stay in their original view, preserve the selection, and report the new outline only through the callback',async()=>{
  const h=harness(),before=h.state.book.outline.length,selectedId=h.state.book.outline[0].id;h.state.outlineId=selectedId;
  h.result=request=>({bookId:h.state.book.id,action:request.action,data:{nodes:[{key:'root',parentKey:null,kind:'story',title:'候选主线',body:'作者确认后追加的规划。'}]}});
  const candidate=renderConversationCandidate(h,'outline');await candidate.button('全选大纲').listeners.click();await candidate.button('追加勾选的大纲').listeners.click();
  assert.equal(h.state.book.outline.length,before+1);assert.equal(h.state.view,'write');assert.equal(h.state.outlineId,selectedId);assert.deepEqual(h.adoptions,[{view:'outline',outlineId:h.state.book.outline.at(-1).id}]);assert.equal(candidate.button('重试保存').disabled,true);
});

test('disposed, mismatched and conflicted conversation candidates cannot mutate books or invoke callbacks',async()=>{
  const bad=harness();assert.throws(()=>renderConversationCandidate(bad,'draft',{response:{bookId:'other-book',action:'draft',data:{title:'坏结果',body:'不可采用'}}}),/不匹配/);
  for(const reason of ['disposed','inactive','detached','book','conflict','closing-during-save']){
    const h=harness(),book=h.state.book,before=JSON.stringify(book),candidate=renderConversationCandidate(h),adoptButton=candidate.button('追加到目标章节');let resolveSave;
    if(reason==='disposed')candidate.controller.dispose();else if(reason==='inactive')h.candidateActive=false;else if(reason==='detached')candidate.container.replaceChildren();else if(reason==='book')h.state.book={...structuredClone(book),id:'other-book'};else if(reason==='conflict')h.saves=[false];else h.saves=[new Promise(resolve=>{resolveSave=resolve;})];
    const pending=adoptButton.listeners.click();if(resolveSave){await new Promise(resolve=>setImmediate(resolve));candidate.controller.dispose();resolveSave(true);}await pending;
    assert.equal(JSON.stringify(book),before,reason);assert.equal(h.applications.length,0,reason);assert.equal(h.adoptions.length,0,reason);
  }
});

test('a saved conversation result remains consumed even if its refresh callback fails',async()=>{
  const h=harness(),chapter=h.state.book.chapters[0],before=chapter.body,candidate=renderConversationCandidate(h,'draft',{onAdopt:()=>{throw Error('refresh failed');}}),draft=candidate.field('ai-draft-body').value;
  await candidate.button('追加到目标章节').listeners.click();assert.equal(chapter.body,before+'\n\n'+draft);assert.equal(h.state.dirty,false);assert.equal(candidate.controller.hasUnsavedAdoption(),false);assert.equal(candidate.button('重试保存').disabled,true);
  await candidate.button('重试保存').listeners.click();assert.equal(chapter.body,before+'\n\n'+draft);assert.equal(h.applications.length,1);
});

test('multiple conversation results have distinct field IDs and citations use the provided navigation callback',async()=>{
  const h=harness(),first=renderConversationCandidate(h,'draft',{idPrefix:'first-'}),second=renderConversationCandidate(h,'draft',{idPrefix:'second-'});
  assert.notEqual(first.field('ai-draft-body').id,second.field('ai-draft-body').id);first.field('ai-draft-body').value='第一条消息编辑后的草稿';assert.notEqual(second.field('ai-draft-body').value,first.field('ai-draft-body').value);
  const jumps=[],candidate=renderConversationCandidate(h,'consistency',{onNavigate:id=>jumps.push(id)}),link=find(candidate.container,node=>node.className==='ai-evidence-link');
  link.listeners.click();assert.deepEqual(jumps,[h.state.chapterId]);candidate.controller.dispose();link.listeners.click();assert.equal(jumps.length,1);
});
