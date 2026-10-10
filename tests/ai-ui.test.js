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
  focus(){} select(){this.selected=true;} scrollIntoView(){} close(){this.open=false;} showModal(){this.open=true;}
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
  const h={get,run,state,context,calls:[],saves:[],copied:[],renderCount:0,settings:{enabled:true,endpoint:'http://127.0.0.1:9999/v1/chat/completions',model:'stub-model',hasKey:false,maxContextChars:250000,timeoutSeconds:60}};
  context.navigator={clipboard:{writeText:async text=>h.copied.push(text)}};
  h.skills={skills:['chinese-novelist','novelskill','human-writing'].map(id=>({id,name:id,available:true,imported:false,referenceCount:1})),defaults:{skillIds:[],skillMode:'auto'}};
  h.preview=data=>({bookId:state.book.id,action:data.action,chapterIds:data.chapterIds,contextChars:2000+data.instruction.length+data.skillIds.length*300,maxContextChars:250000,overLimit:!!h.overLimit,counts:{chapters:data.chapterIds.length,outlines:3,people:32,relationships:35},selectedSkillIds:data.skillIds,skillMode:data.skillMode,skillChars:data.skillIds.length*300,skills:data.skillIds.map(id=>({id,name:id,mode:data.skillMode==='auto'?'chapter':data.skillMode,files:['SKILL.md','references/chapter.md']}))});
  h.skillDetail=id=>({id,name:id,content:'# SKILL.md\n<img src=x onerror=alert(1)>\n只读写作说明',files:[{path:'references/chapter.md',content:'连续阅读参考内容'}],imported:true});
  h.result=(request)=>({bookId:state.book.id,action:request.action,chapterIds:request.chapterIds,data:request.action==='draft'?{title:'AI测试草稿',body:'<img src=x onerror=alert(1)>\n一段新的试写。'}:request.action==='consistency'?{issues:[{title:'待核查',description:'核对人物设定',chapterIds:request.chapterIds,evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}:{people:[{name:'测试新人物',group:'测试组',description:'仅供确认',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}],relationships:[{from:'测试新人物',to:'沈砚',type:'cooperate',label:'测试核验',description:'作者确认后建立',evidence:[{chapterId:request.chapterIds[0],quote:sample.chapters[0].body.slice(0,40)}]}]}});
  context.localAPI=async(url,method='GET',data)=>{
    h.calls.push({url,method,data:structuredClone(data)});
    if(url==='/api/ai/settings')return h.settings;
    if(url==='/api/skills'){if(h.skillError)throw h.skillError;return structuredClone(h.skills);}
    if(url==='/api/skills/import'){data.skillIds.forEach(id=>h.skills.skills.find(skill=>skill.id===id).imported=true);return structuredClone(h.skills);}
    if(url==='/api/skills/settings'){h.skills.defaults=structuredClone(data);return structuredClone(h.skills);}
    if(url.startsWith('/api/skills/'))return h.skillDetail(url.split('/').at(-1));
    if(url.endsWith('/ai/preview'))return h.preview(data);
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
  assert.ok(find(h.get('dialog-body'),node=>node.textContent.includes('此次写作 Skill：中文小说创作；300 字符')));
  assert.ok(find(h.get('dialog-body'),node=>node.textContent.includes('references/chapter.md')));assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  const box=field(h,'ai-skill-chinese-novelist');box.checked=false;box.listeners.change();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(find(h.get('dialog-body'),node=>node.textContent.includes('此次写作 Skill：不使用；0 字符')));
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

test('four presets are editable, each action keeps its own words, resetting restores that preset and sends exactly the visible prompt',async()=>{
  const h=harness();await h.run("showAIAssistant('draft')");const mode=field(h,'ai-action'),prompt=field(h,'ai-instruction'),draft=prompt.value;
  assert.equal(mode.options.length,5);assert.ok(draft.length>80);
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
