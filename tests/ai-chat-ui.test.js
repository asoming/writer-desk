'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.listeners={};this.dataset={};this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};this.open=false;}
  append(...children){children.forEach(child=>{child.parentElement=this;this.children.push(child);});}
  replaceChildren(...children){this.children=[];this.append(...children);}
  addEventListener(type,listener){this.listeners[type]=listener;}
  setAttribute(key,value){this[key]=String(value);}
  querySelectorAll(selector){const tags=selector.split(',').map(tag=>tag.toUpperCase());return descendants(this).filter(node=>tags.includes(node.tagName));}
  contains(target){return this===target||this.children.some(child=>child.contains(target));}
  focus(){this.focused=true;}
  close(){this.open=false;}
  showModal(){this.open=true;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
const find=(node,predicate)=>[node,...descendants(node)].find(predicate);
async function waitFor(h,predicate,label,timeoutMs=5000){
  const deadline=performance.now()+timeoutMs;
  while(!predicate()){
    assert.ok(performance.now()<deadline,'Timed out waiting for '+label);
    // WebCrypto completes on the native worker pool. Event-loop turns are not
    // a completion signal, so yield until the observable verification settles.
    await h.tick();
  }
}
function harness(storage=new Map()){
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},timers=new Map();let nextTimer=0;
  const h={calls:[],saves:[],storage,get,timers,candidates:[],notes:[],renders:0,toasts:[],settings:{enabled:true,endpoint:'http://127.0.0.1:9999/v1',model:'stub',contextMode:'auto'}};
  h.state={book:{id:'one',kind:'long',title:'测试书',chapters:[{id:'a',title:'第一章',body:'正文一'},{id:'b',title:'第二章',body:'正文二'}],outline:[{id:'plan',title:'第一卷',body:'提纲',chapterIds:['a']}],notes:[]},view:'write',chapterId:'a',outlineId:'plan',composing:false,transitioning:false};
  const localStorage={getItem:key=>storage.get(key)??null,setItem(key,value){if(h.storageFails)throw Error('quota');storage.set(key,value);},removeItem:key=>storage.delete(key)};
  h.preview=request=>({bookId:h.state.book.id,action:request.action,chapterIds:request.chapterIds,chat:true,historyMessages:request.history.length,historyChars:request.history.reduce((sum,message)=>sum+Array.from(message.content).length,0),counts:{chapters:request.chapterIds.length,outlines:1,people:0,relationships:0},contextChars:1000+JSON.stringify(request.history).length+request.instruction.length,contextMode:'auto',maxContextChars:null,overLimit:false,selectedSkillIds:request.skillIds,skillMode:request.skillMode});
  h.response=request=>({bookId:h.state.book.id,action:request.action,chapterIds:request.chapterIds,chat:true,reply:'收到：'+request.instruction,data:null});
  h.models=()=>({models:[{id:'stub'},{id:'second-model'}]});h.saveModel=async request=>(h.settings={...h.settings,...request});
  h.events={};const context=vm.createContext({document:{body:new Element('body'),createElementNS:(_,tag)=>new Element(tag),querySelector:selector=>{const classes=selector.split(',').map(value=>value.match(/^\.([\w-]+)\[open\]$/)?.[1]).filter(Boolean);return find(context.document.body,node=>node.open&&classes.includes(node.className))||null;}},console,structuredClone,crypto:{randomUUID},state:h.state,clientStorage:localStorage,$:get,addEventListener:(event,callback)=>h.events[event]=callback,T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>fn(),uid:randomUUID,toast:text=>h.toasts.push(text),preference:(key,value)=>value===undefined?localStorage.getItem(key):localStorage.setItem(key,value),el(tag,className,text){const element=new Element(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;},action(text,className,handler){const button=new Element('button');button.textContent=text;button.className=className;button.listeners.click=handler;return button;},requireSaved:async()=>h.saves.length?h.saves.shift():true,toggleNotes:value=>h.notes.push(value),showAppSettings:()=>{h.settingsOpened=true;},jumpToChapter:id=>{h.state.chapterId=id;h.state.view='write';},renderShell:()=>h.renders++});context.window=context;h.context=context;
  context.api=async(url,method='GET',request)=>{h.calls.push({url,method,request:structuredClone(request)});if(url==='/api/ai/settings')return method==='PUT'?h.saveModel(request):h.readSettings?h.readSettings():h.settings;if(url==='/api/ai/models')return h.models();if(url==='/api/skills')return{skills:[{id:'novelskill',imported:true}],defaults:{skillIds:['novelskill'],skillMode:'outline'}};if(url.endsWith('/preview'))return h.preview(request);if(url.endsWith('/ai'))return h.response(request);throw Error('Unexpected API '+url);};
  for(const file of ['public/ai.js','public/ai-chat.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  const realRenderer=context.renderAIResult;h.useRealRenderer=()=>{context.renderAIResult=realRenderer;};
  context.addField=(container,label,control)=>container.append(context.el('label',null,label),control);context.markDirty=()=>{h.mutations=(h.mutations||0)+1;h.state.dirty=true;};context.activeVolumes=()=>[];
  context.renderAIResult=(container,response,options)=>{const candidate={container,response,options,disposed:false};h.candidates.push(candidate);return{dispose(){candidate.disposed=true;},hasUnsavedAdoption(){return false;}};};
  h.run=source=>vm.runInContext(source,context);h.tick=async()=>{await new Promise(resolve=>setImmediate(resolve));};h.flush=async()=>{for(const [id,fn] of [...timers]){timers.delete(id);await fn();}await h.tick();};
  h.panel=()=>get('ai-chat-panel');h.field=id=>{const value=find(h.panel(),node=>node.id===id);assert.ok(value,'Missing field '+id);return value;};h.button=text=>{const value=find(h.panel(),node=>node.tagName==='BUTTON'&&(node.textContent===text||node['aria-label']===text));assert.ok(value,'Missing button '+text);return value;};
  h.open=async()=>{h.run('syncAIChat()');await h.tick();};h.prompt=async value=>{const input=h.field('ai-chat-prompt');input.value=value;input.listeners.input();await h.flush();};h.send=()=>h.button('发送').listeners.click();h.records=()=>JSON.parse(storage.get('yejian.ai-chat.'+h.state.book.id+'.'+h.state.view));return h;
}

test('streaming shows incremental reply without rendering a candidate before the validated final result',async()=>{
  const h=harness();h.context.AbortController=AbortController;let finish,delta;
  h.context.WriterAIStream={request:(url,request,options)=>{delta=options.onDelta;return new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'第一段第二段',data:{text:'完整候选'}});});}};
  await h.open();await h.prompt('逐步讨论');const pending=h.send();await h.tick();delta('第一段');assert.ok(find(h.panel(),node=>node.textContent==='第一段'));assert.equal(h.candidates.length,0);delta('第二段');finish();await pending;assert.equal(h.records().turns[0].reply,'第一段第二段');assert.equal(h.records().turns[0].status,'complete');assert.equal(h.candidates.length,1);
});

test('stream cancel aborts transport and ignores late tokens and candidates',async()=>{
  const h=harness();h.context.AbortController=AbortController;let finish,delta,signal;
  h.context.WriterAIStream={request:(url,request,options)=>{delta=options.onDelta;signal=options.signal;return new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'晚到的完整答复',data:{text:'不应采用'}});});}};
  await h.open();await h.prompt('可停止的讨论');const pending=h.send();await h.tick();delta('已显示片段');h.button('停止等待').listeners.click();assert.ok(signal.aborted);delta('晚到片段');finish();await pending;assert.equal(h.records().turns[0].status,'cancelled');assert.equal(h.records().turns[0].reply,'已显示片段');assert.equal(h.candidates.length,0);
});

test('AI memory is an explicit task, preserves source hash, and adopts only checked editable candidates',async()=>{
  const h=harness(),{createHash,webcrypto}=require('node:crypto');h.context.crypto=webcrypto;h.context.TextEncoder=TextEncoder;h.context.Uint8Array=Uint8Array;vm.runInContext(fs.readFileSync(path.join(root,'public/story-memory.js'),'utf8'),h.context);h.useRealRenderer();
  const hash=createHash('sha256').update('第一章\n正文一').digest('hex');h.response=request=>({bookId:'one',action:'memory',chapterIds:request.chapterIds,chat:true,reply:'这是待确认的章节记忆。',data:{entries:[{chapterId:'a',sourceHash:hash,summary:'事件摘要',characterStates:'人物状态',settingNotes:''}]}});
  await h.open();h.run("toggleAIChat('memory')");await h.flush();assert.match(h.field('ai-chat-prompt').value,/章节记忆/);assert.equal(h.state.book.storyMemory,undefined);await h.send();assert.equal(h.state.book.storyMemory,undefined);
  const box=find(h.panel(),node=>node.tagName==='INPUT'&&node.type==='checkbox'&&!node.value);assert.ok(box);await waitFor(h,()=>box.disabled===false,'verified memory source');box.checked=true;const summary=find(h.panel(),node=>node.tagName==='TEXTAREA'&&node.id?.endsWith('-summary'));summary.value='作者修改后的摘要';await h.button('采用勾选的记忆').listeners.click();assert.equal(h.state.book.storyMemory.entries[0].summary,'作者修改后的摘要');assert.equal(h.state.book.storyMemory.entries[0].sourceHash,hash);
});

test('a memory candidate from an earlier source revision is read only after chat restore',async()=>{
  const {createHash,webcrypto}=require('node:crypto'),hash=createHash('sha256').update('第一章\n旧正文').digest('hex');
  const turn={id:'old-memory',user:'整理章节',action:'memory',chapterIds:['a'],status:'complete',reply:'待确认',data:{entries:[{chapterId:'a',sourceHash:hash,summary:'旧摘要',characterStates:'',settingNotes:''}]}},h=harness(new Map([['yejian.ai-chat.one.write',JSON.stringify({version:1,open:true,turns:[turn]})]]));h.context.crypto=webcrypto;h.context.TextEncoder=TextEncoder;h.context.Uint8Array=Uint8Array;vm.runInContext(fs.readFileSync(path.join(root,'public/story-memory.js'),'utf8'),h.context);h.useRealRenderer();await h.open();await waitFor(h,()=>find(h.panel(),node=>node.textContent==='来源正文已变化，请重新整理记忆。'),'stale memory source rejection');const box=find(h.panel(),node=>node.tagName==='INPUT'&&node.type==='checkbox'&&!node.value);assert.equal(box.disabled,true);assert.equal(h.state.book.storyMemory,undefined);
});

test('memory selection stays disabled until source verification actually resolves',async()=>{
  const h=harness(),hash=require('node:crypto').createHash('sha256').update('第一章\n正文一').digest('hex');let verify;
  h.context.WriterStoryMemory={sourceHash:()=>new Promise(resolve=>{verify=()=>resolve(hash);})};h.useRealRenderer();h.response=request=>({bookId:'one',action:'memory',chapterIds:request.chapterIds,chat:true,reply:'待核对来源',data:{entries:[{chapterId:'a',sourceHash:hash,summary:'候选摘要',characterStates:'',settingNotes:''}]}});
  await h.open();h.run("toggleAIChat('memory')");await h.flush();await h.send();
  const box=find(h.panel(),node=>node.tagName==='INPUT'&&node.type==='checkbox'&&!node.value);assert.ok(box);assert.equal(box.disabled,true);assert.equal(h.state.book.storyMemory,undefined);
  await h.button('采用勾选的记忆').listeners.click();assert.equal(h.state.book.storyMemory,undefined);
  verify();await waitFor(h,()=>box.disabled===false,'deliberately delayed source verification');box.checked=true;await h.button('采用勾选的记忆').listeners.click();assert.equal(h.state.book.storyMemory.entries[0].summary,'候选摘要');
});

test('planning and writing get a docked conversation, no service request on opening',async()=>{
  const h=harness();await h.open();assert.equal(h.panel().hidden,false);assert.equal(h.field('ai-chat-task').value,'custom');assert.equal(h.field('ai-chat-prompt').value,'');assert.ok(h.button('发送').disabled);assert.deepEqual(h.notes,[false]);assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  h.state.view='outline';h.run('syncAIChat()');await h.tick();assert.equal(find(h.panel(),node=>node.className==='ai-chat-scope').textContent,'第一卷');
});

test('short story chat always uses its whole manuscript without chapter controls in either workspace',async()=>{
  for(const view of ['write','outline']){
    const storage=new Map([['yejian.ai-chat.one.'+view,JSON.stringify({version:1,manualChapters:true,chapterIds:[],turns:[]})]]),h=harness(storage);h.state.book.kind='short';h.state.book.chapters=[{id:'body',title:'正文',body:'许宁在书店等雨停。'}];h.state.book.outline[0].chapterIds=[];h.state.chapterId='body';h.state.view=view;await h.open();
    assert.equal(find(h.panel(),node=>node.className==='ai-chat-chapters').hidden,true);assert.equal(find(h.panel(),node=>node.className==='ai-chat-chapters').children.length,0);assert.equal(find(h.panel(),node=>node.className==='ai-chat-material-tools').hidden,true);assert.ok(find(h.panel(),node=>node.textContent==='资料 · 正文'));assert.ok(!find(h.panel(),node=>node.tagName==='OPTION'&&node.textContent==='章节创作'));
    if(view==='write')assert.equal(find(h.panel(),node=>node.className==='ai-chat-scope').textContent,'正文');h.run("toggleAIChat('outline')");await h.flush();assert.match(h.field('ai-chat-prompt').value,/总纲与情节/);await h.prompt('继续规划这个短篇');await h.send();assert.deepEqual(h.calls.find(call=>call.url.endsWith('/ai')).request.chapterIds,['body']);
  }
});

test('short story retry uses the canonical manuscript after old chapters have been merged',async()=>{
  const turn={id:'old-turn',user:'继续写这个短篇',action:'draft',chapterIds:['old-second'],status:'error',error:'连接失败'},storage=new Map([['yejian.ai-chat.one.write',JSON.stringify({version:1,open:true,turns:[turn]})]]),h=harness(storage);h.state.book.kind='short';h.state.book.chapters=[{id:'body',title:'正文',body:'前后两段合并的正文。'}];h.state.chapterId='body';await h.open();await h.button('重试').listeners.click();assert.deepEqual(h.calls.find(call=>call.url.endsWith('/ai')).request.chapterIds,['body']);assert.equal(h.records().turns.length,1);assert.equal(h.records().turns[0].status,'complete');
});
test('explicit send displays alternating text and full history on follow-up',async()=>{
  const h=harness();await h.open();await h.prompt('主角想要什么？');await h.send();await h.prompt('再具体一点');await h.send();const calls=h.calls.filter(call=>call.url.endsWith('/ai'));assert.equal(calls.length,2);assert.deepEqual(calls[0].request.history,[]);assert.deepEqual(calls[1].request.history,[{role:'user',content:'主角想要什么？'},{role:'assistant',content:'收到：主角想要什么？'}]);assert.equal(h.records().turns.length,2);assert.equal(h.field('ai-chat-prompt').value,'');
});
test('structured suggestion is included in follow-up and passed to the shared guarded renderer',async()=>{
  const h=harness();h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'这是候选章纲。',data:{nodes:[{key:'root',title:'潮汐'}]}});await h.open();await h.prompt('规划大纲');await h.send();assert.equal(h.candidates.length,1);assert.match(h.candidates[0].options.idPrefix,/chat-/);await h.prompt('调整潮汐这一部分');await h.send();const request=h.calls.filter(call=>call.url.endsWith('/ai')).at(-1).request;assert.equal(request.history[1].content,'这是候选章纲。\n\n{"nodes":[{"key":"root","title":"潮汐"}]}');
});
test('per-book planning and writing histories and unsent prompts persist independently',async()=>{
  const h=harness();await h.open();await h.prompt('写作草稿未发');h.state.view='outline';h.run('syncAIChat()');await h.tick();assert.equal(h.field('ai-chat-prompt').value,'');await h.prompt('大纲问题未发');h.state.view='write';h.run('syncAIChat()');await h.tick();assert.equal(h.field('ai-chat-prompt').value,'写作草稿未发');const old=h.state.book;h.state.book={...structuredClone(old),id:'two'};h.run('syncAIChat()');await h.tick();assert.equal(h.field('ai-chat-prompt').value,'');h.state.book=old;h.run('syncAIChat()');await h.tick();assert.equal(h.field('ai-chat-prompt').value,'写作草稿未发');
  const restart=harness(h.storage);await restart.open();assert.equal(restart.field('ai-chat-prompt').value,'写作草稿未发');
});
test('closing remembers visibility and reopening preserves the unsent prompt without sending',async()=>{
  const h=harness();await h.open();const input=h.field('ai-chat-prompt');input.value='尚未发出';input.listeners.input();h.run('closeAIChat()');assert.equal(h.panel().hidden,true);assert.equal(h.records().prompt,'尚未发出');h.run('syncAIChat()');assert.equal(h.panel().hidden,true);h.run('toggleAIChat()');await h.tick();assert.equal(h.panel().hidden,false);assert.equal(h.field('ai-chat-prompt').value,'尚未发出');assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
});
test('preset prompts are editable, separately remembered and resettable',async()=>{
  const h=harness();await h.open();const task=h.field('ai-chat-task');task.value='outline';task.listeners.change();await h.flush();assert.match(h.field('ai-chat-prompt').value,/分层候选大纲/);await h.prompt('按三卷来规划');task.value='custom';task.listeners.change();await h.flush();await h.prompt('其他问题');task.value='outline';task.listeners.change();await h.flush();assert.equal(h.field('ai-chat-prompt').value,'按三卷来规划');h.button('恢复默认提示词').listeners.click();await h.flush();assert.match(h.field('ai-chat-prompt').value,/分层候选大纲/);
});
test('IME Enter does not send, Shift+Enter stays a newline, normal Enter sends once',async()=>{
  const h=harness();await h.open();await h.prompt('继续讨论');const input=h.field('ai-chat-prompt');let prevented=0;const enter={key:'Enter',preventDefault(){prevented++;}};input.listeners.compositionstart();await input.listeners.keydown(enter);input.listeners.compositionend();await input.listeners.keydown({...enter,shiftKey:true});await input.listeners.keydown({...enter,isComposing:true});assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,0);await input.listeners.keydown(enter);assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);assert.equal(prevented,1);
});
test('failure and repeated retry reuse one user turn and exclude that turn from history',async()=>{
  const h=harness();await h.open();let fail=true;h.response=request=>{if(fail)throw Error('连接失败');return{bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'成功',data:null};};await h.prompt('测试重试');await h.send();assert.equal(h.records().turns.length,1);await h.button('重试').listeners.click();assert.equal(h.records().turns.length,1);fail=false;await h.button('重试').listeners.click();assert.equal(h.records().turns.length,1);assert.equal(h.records().turns[0].status,'complete');assert.ok(h.calls.filter(call=>call.url.endsWith('/ai')).every(call=>call.request.history.length===0));
});
test('an older failed turn cannot be replayed into the middle of later conversation history',async()=>{
  const h=harness();await h.open();let fail=true;h.response=request=>{if(fail)throw Error('暂时失败');return{bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'完成',data:null};};await h.prompt('旧的问题');await h.send();const obsoleteRetry=h.button('重试');fail=false;await h.prompt('新的问题');await h.send();await obsoleteRetry.listeners.click();assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,2);assert.ok(!find(h.panel(),node=>node.tagName==='BUTTON'&&node.textContent==='重试'));await h.prompt('旧的问题');await h.send();assert.equal(h.records().turns.length,3);assert.equal(h.records().turns[0].status,'error');assert.deepEqual(h.calls.filter(call=>call.url.endsWith('/ai')).at(-1).request.history,[{role:'user',content:'新的问题'},{role:'assistant',content:'完成'}]);
});
test('typing next prompt and selecting another chapter while pending preserves the request snapshot',async()=>{
  const h=harness();await h.open();let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'原章节建议',data:{title:'草稿',body:'正文'}});});await h.prompt('起草');const pending=h.send();await h.tick();h.state.chapterId='b';h.run('syncAIChat()');await h.prompt('下一条尚未发送');finish();await pending;assert.deepEqual(h.calls.find(call=>call.url.endsWith('/ai')).request.chapterIds,['a']);assert.equal(h.field('ai-chat-prompt').value,'下一条尚未发送');assert.deepEqual(h.candidates[0].options.chapterIds,['a']);assert.equal(h.candidates[0].options.current(),true);
});
test('switching book or channel while pending discards late output and restores a retryable user prompt',async()=>{
  for(const change of ['book','channel']){const h=harness();await h.open();let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'迟到结果',data:null});});await h.prompt('原作品问题');const pending=h.send();await h.tick();if(change==='book')h.state.book={...structuredClone(h.state.book),id:'two'};if(change==='channel')h.state.view='outline';h.run('syncAIChat()');await h.tick();finish();await pending;const previous=JSON.parse(h.storage.get('yejian.ai-chat.one.write'));assert.equal(previous.turns[0].status,'cancelled');assert.equal(previous.prompt,'原作品问题');assert.ok(!previous.turns[0].reply);}
});
test('collapsing the panel retains an in-flight reply without another model request',async()=>{
  const h=harness();await h.open();let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'后台完成',data:null});});await h.prompt('继续想想');const pending=h.send();await h.tick();h.run('closeAIChat()');finish();await pending;assert.equal(h.records().turns[0].status,'complete');assert.equal(h.panel().hidden,true);h.run('toggleAIChat()');await h.tick();assert.ok(find(h.panel(),node=>node.textContent==='后台完成'));assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);
});
test('real candidate renderer restores an unadopted draft after restarting the conversation',async()=>{
  const turn={id:'saved-draft',user:'起草一段',action:'draft',chapterIds:['a'],skillIds:[],skillMode:'auto',status:'complete',reply:'请看草稿',data:{title:'候选章',body:'可采用的草稿'}};
  const storage=new Map([['yejian.ai-chat.one.write',JSON.stringify({version:1,open:true,action:'custom',prompt:'',turns:[turn]})]]),h=harness(storage);h.useRealRenderer();await h.open();await h.button('追加到目标章节').listeners.click();assert.equal(h.state.book.chapters[0].body,'正文一\n\n可采用的草稿');assert.ok(find(h.panel(),node=>node.textContent==='已采用'));assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,0);
});
test('real candidates returned while collapsed, in settings or in another dialog become adoptable when reopened',async()=>{
  for(const mode of ['collapsed','settings','dialog']){
    const h=harness();h.useRealRenderer();await h.open();h.run("toggleAIChat('draft')");await h.prompt('起草一段');let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'候选已完成',data:{title:'候选章',body:'晚到的候选正文'}});});const pending=h.send();await h.tick();
    if(mode==='collapsed')h.run('closeAIChat()');else h.get(mode==='settings'?'settings-dialog':'dialog').open=true;finish();await pending;assert.ok(!find(h.panel(),node=>node.textContent==='追加到目标章节'));
    if(mode==='collapsed')h.run('toggleAIChat()');else if(mode==='settings'){h.get('settings-dialog').open=false;await h.run('refreshAIChatSettings()');}else{h.get('dialog').open=false;h.get('dialog').listeners.close();}await h.tick();await h.button('追加到目标章节').listeners.click();assert.equal(h.state.book.chapters[0].body,'正文一\n\n晚到的候选正文');assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);assert.equal(h.mutations,1);
  }
});
test('reopening and refreshing settings preserve a real failed-save renderer and never repeat its mutation',async()=>{
  const h=harness();h.useRealRenderer();await h.open();h.run("toggleAIChat('draft')");h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'可以采用',data:{title:'章',body:'只追加一次'}});await h.prompt('起草');await h.send();h.saves=[true,false];await h.button('追加到目标章节').listeners.click();const retry=h.button('重试保存');assert.equal(h.mutations,1);h.run('closeAIChat()');h.run('toggleAIChat()');assert.equal(h.button('重试保存'),retry);h.get('settings-dialog').open=true;h.get('settings-dialog').open=false;await h.run('refreshAIChatSettings()');assert.equal(h.button('重试保存'),retry);h.saves=[true];await retry.listeners.click();assert.equal(h.mutations,1);assert.equal(h.state.book.chapters[0].body,'正文一\n\n只追加一次');assert.ok(find(h.panel(),node=>node.textContent==='已采用'));
});
test('new conversation clears only this book and channel and does not send',async()=>{
  const h=harness();await h.open();await h.prompt('第一轮');await h.send();h.state.view='outline';h.run('syncAIChat()');await h.tick();await h.prompt('大纲草稿');h.state.view='write';h.run('syncAIChat()');await h.tick();await h.button('新对话').listeners.click();assert.equal(h.records().turns.length,0);assert.equal(JSON.parse(h.storage.get('yejian.ai-chat.one.outline')).prompt,'大纲草稿');assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);
});
test('manual overflow and malformed previews never reach the model, automatic large context stays sendable',async()=>{
  for(const malformed of [value=>({...value,bookId:'other'}),value=>({...value,selectedSkillIds:[]}),value=>({...value,contextMode:'manual',maxContextChars:100,overLimit:true})]){const h=harness(),normal=h.preview;h.preview=request=>malformed(normal(request));await h.open();await h.prompt('材料问题');assert.equal(h.button('发送').disabled,true);await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));}
  const h=harness(),normal=h.preview;h.preview=request=>({...normal(request),contextChars:800000});await h.open();await h.prompt('大纲');assert.equal(h.button('发送').disabled,false);assert.ok(!find(h.panel(),node=>/250000|250,000/.test(node.textContent)));
});
test('unsaved source blocks sending and response identity mismatch cannot show a candidate',async()=>{
  const h=harness();await h.open();await h.prompt('保存后发送');h.saves=[false];await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));assert.equal(h.field('ai-chat-prompt').value,'保存后发送');h.response=request=>({bookId:'wrong',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'wrong',data:{}});await h.flush();await h.send();assert.equal(h.candidates.length,0);assert.equal(h.records().turns[0].status,'error');
});
test('assistant output is plain text and candidate adoption is consumed before persistence retry',async()=>{
  const h=harness();h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'<img src=x onerror=alert(1)>',data:{title:'候选',body:'正文'}});await h.open();await h.prompt('生成');await h.send();const text=find(h.panel(),node=>node.className==='ai-chat-message-text'&&node.textContent.startsWith('<img'));assert.ok(text);assert.equal(text.children.length,0);const candidate=h.candidates[0];candidate.options.onApplied();assert.equal(h.records().turns[0].consumed,true);assert.equal(candidate.options.current(),true);candidate.options.onAdopt({view:'write',chapterId:'b'});assert.equal(h.state.chapterId,'b');assert.equal(h.renders,1);assert.ok(find(h.panel(),node=>node.textContent==='已采用'));assert.equal(candidate.disposed,true);
});
test('history counts Unicode characters exactly and pagehide flushes the last unsent keystroke',async()=>{
  const h=harness();await h.open();await h.prompt('🌊这段有表情');await h.send();await h.prompt('继续🌙');assert.equal(h.button('发送').disabled,false);const input=h.field('ai-chat-prompt');input.value='最后一字🌞';input.listeners.input();h.events.pagehide();assert.equal(h.records().prompt,'最后一字🌞');
});
test('open settings block a new send and adoption while an existing request may finish safely',async()=>{
  const h=harness();await h.open();await h.prompt('先别发');h.get('settings-dialog').open=true;await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));h.get('settings-dialog').open=false;h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'候选',data:{title:'章节',body:'正文'}});await h.send();h.get('dialog').open=true;assert.equal(h.candidates[0].options.current(),false);h.get('dialog').open=false;assert.equal(h.candidates[0].options.current(),true);
});
test('a Skill reading window blocks sends and defers candidate adoption until it closes',async()=>{
  const h=harness();await h.open();await h.prompt('先查看规则');const viewer=h.context.el('dialog','writing-skill-view-dialog');viewer.open=true;h.context.document.body.append(viewer);await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
  viewer.open=false;let finish;h.response=request=>new Promise(resolve=>finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'待确认',data:{title:'候选',body:'只可确认后采用'}}));const pending=h.send();await h.tick();viewer.open=true;finish();await pending;assert.equal(h.candidates.length,0);assert.equal(h.state.book.chapters[0].body,'正文一');viewer.open=false;h.run('resumeAIChatCandidates()');assert.equal(h.candidates.length,1);assert.equal(h.candidates[0].options.current(),true);viewer.open=true;assert.equal(h.candidates[0].options.current(),false);assert.equal(h.state.book.chapters[0].body,'正文一');
});

test('storage quota failures are visible and permanent book deletion clears both local channels',async()=>{
  const h=harness();await h.open();h.storageFails=true;await h.prompt('本机草稿');assert.ok(find(h.panel(),node=>node.textContent==='对话未能保存到本机。'));h.storageFails=false;h.run('closeAIChat()');h.storage.set('yejian.ai-chat.one.outline','{}');h.storage.set('yejian.ai-chat.two.write','other');h.run("clearAIChatBookHistory('one')");assert.equal(h.storage.has('yejian.ai-chat.one.write'),false);assert.equal(h.storage.has('yejian.ai-chat.one.outline'),false);assert.equal(h.storage.get('yejian.ai-chat.two.write'),'other');
});
test('interrupted conversation restores without silently repeating an AI call',async()=>{
  const storage=new Map([['yejian.ai-chat.one.write',JSON.stringify({version:1,open:true,action:'custom',prompt:'',turns:[{id:'interrupted',user:'待处理',action:'custom',chapterIds:['a'],status:'pending'}]})]]),h=harness(storage);await h.open();assert.ok(h.button('重试'));assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));await h.button('重试').listeners.click();assert.equal(h.records().turns.length,1);assert.equal(h.records().turns[0].status,'complete');
});

test('composer discovers models, saves only the chosen model and sends its snapshot',async()=>{
  const h=harness();await h.open();assert.equal(h.field('ai-chat-model').value,'stub');assert.deepEqual(h.field('ai-chat-model').children.map(option=>option.value),['stub','second-model','']);
  const select=h.field('ai-chat-model');select.value='second-model';await select.listeners.change();await h.prompt('换个模型继续讨论');await h.send();
  assert.deepEqual(h.calls.find(call=>call.url==='/api/ai/settings'&&call.method==='PUT').request,{model:'second-model'});assert.equal(h.settings.model,'second-model');assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'second-model');
  h.state.view='outline';h.run('syncAIChat()');await h.tick();assert.equal(h.field('ai-chat-model').value,'second-model');assert.equal(h.calls.filter(call=>call.url==='/api/ai/models').length,1);
});

test('model lists failing or omitting a custom model preserve the existing configuration and manual fallback',async()=>{
  const h=harness();h.settings.model='my-private-compatible-model';h.models=()=>{throw Error('无法读取模型列表，可手动填写模型名称。');};await h.open();assert.equal(h.field('ai-chat-model').value,'my-private-compatible-model');await h.prompt('照常使用自定义模型');assert.equal(h.button('发送').disabled,false);
  h.field('ai-chat-model').value='';await h.field('ai-chat-model').listeners.change();assert.equal(h.settingsOpened,true);assert.ok(!h.calls.some(call=>call.method==='PUT'));assert.equal(h.field('ai-chat-model').value,'my-private-compatible-model');
  h.models=()=>({models:[{id:'fresh-model'}]});await h.button('刷新模型').listeners.click();assert.deepEqual(h.field('ai-chat-model').children.map(option=>option.value),['my-private-compatible-model','fresh-model','']);
});

test('pending sends lock model changes and keep the selected request model despite settings reload',async()=>{
  const h=harness();await h.open();let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'原模型完成',data:null});});await h.prompt('当前模型的问题');const pending=h.send();await h.tick();const select=h.field('ai-chat-model');assert.equal(select.disabled,true);select.value='second-model';await select.listeners.change();assert.equal(select.value,'stub');assert.ok(!h.calls.some(call=>call.method==='PUT'));
  h.settings={...h.settings,model:'second-model'};await h.run('refreshAIChatSettings()');finish();await pending;assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'stub');assert.equal(h.records().turns[0].reply,'原模型完成');
});

test('a model save crossing a book switch cannot update the old view or let the new book send with stale settings',async()=>{
  const h=harness();await h.open();let finish;h.saveModel=request=>new Promise(resolve=>{finish=()=>{h.settings={...h.settings,...request};resolve(h.settings);};});const select=h.field('ai-chat-model');select.value='second-model';const pending=select.listeners.change();await h.tick();assert.equal(select.disabled,true);h.state.book={...structuredClone(h.state.book),id:'two'};h.run('syncAIChat()');await h.tick();await h.prompt('第二本书的问题');assert.equal(h.button('发送').disabled,true);finish();await pending;await h.tick();await h.flush();assert.equal(h.field('ai-chat-model').value,'second-model');assert.equal(h.records().turns.length,0);await h.send();assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).url,'/api/books/two/ai');assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'second-model');
});

test('successful persistence clears a prior storage warning without clearing unrelated errors',async()=>{
  const h=harness();await h.open();h.storageFails=true;await h.prompt('暂时未保存');assert.equal(find(h.panel(),node=>node.className==='ai-chat-status').textContent,'对话未能保存到本机。');h.storageFails=false;h.events.pagehide();assert.equal(find(h.panel(),node=>node.className==='ai-chat-status').textContent,'');assert.equal(h.records().prompt,'暂时未保存');
  h.response=()=>{throw Error('AI 服务连接失败。');};await h.prompt('服务失败保留');await h.send();const status=find(h.panel(),node=>node.className==='ai-chat-status');status.textContent='另一条重要提示';h.events.pagehide();assert.equal(status.textContent,'另一条重要提示');
});

test('a model saved while this conversation is suspended stays selected when returning from the shelf or characters',async()=>{
  for(const view of ['shelf','characters']){const h=harness();await h.open();let finish;h.saveModel=request=>new Promise(resolve=>{finish=()=>{h.settings={...h.settings,...request};resolve(h.settings);};});h.field('ai-chat-model').value='second-model';const pending=h.field('ai-chat-model').listeners.change();await h.tick();h.state.view=view;h.run('syncAIChat()');finish();await pending;h.state.view='write';h.run('syncAIChat()');await h.tick();await h.prompt('返回继续讨论');assert.equal(h.field('ai-chat-model').value,'second-model');await h.send();assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'second-model');}
});

test('an older settings reload arriving after a model save cannot replace the new model',async()=>{
  const h=harness();await h.open();await h.prompt('使用新模型');let finish;const stale={...h.settings};h.readSettings=()=>new Promise(resolve=>{finish=()=>resolve(stale);});const reload=h.run('refreshAIChatSettings()');await h.tick();assert.equal(h.button('发送').disabled,true);await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));h.field('ai-chat-model').value='second-model';await h.field('ai-chat-model').listeners.change();finish();await reload;assert.equal(h.field('ai-chat-model').value,'second-model');await h.flush();await h.send();assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'second-model');
});

test('composer leaves an unconfigured model empty until an explicit list selection saves it',async()=>{
  const h=harness();h.settings.model='';await h.open();const select=h.field('ai-chat-model');assert.equal(select.value,'');assert.equal(select.children[0].textContent,'选择模型');assert.ok(!h.calls.some(call=>call.method==='PUT'));await h.prompt('选定后再讨论');assert.equal(h.button('发送').disabled,true);select.value='second-model';await select.listeners.change();await h.flush();assert.equal(h.settings.model,'second-model');assert.equal(h.field('ai-chat-model').value,'second-model');await h.send();assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'second-model');
});

test('a model save failing while suspended restores the saved selection before returning to writing',async()=>{
  const h=harness();await h.open();let fail;h.saveModel=()=>new Promise((resolve,reject)=>{fail=()=>reject(Error('无法保存模型选择。'));});h.field('ai-chat-model').value='second-model';const pending=h.field('ai-chat-model').listeners.change();await h.tick();h.state.view='people';h.run('syncAIChat()');fail();await pending;h.state.view='write';h.run('syncAIChat()');await h.tick();assert.equal(h.settings.model,'stub');assert.equal(h.field('ai-chat-model').value,'stub');await h.prompt('仍使用已保存的模型');await h.send();assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.model,'stub');
});

function imageChatHarness(storage){
  const h=harness(storage);vm.runInContext(fs.readFileSync(path.join(root,'public/chat-images.js'),'utf8'),h.context);
  const normalize=h.context.WriterChatImages.normalizeReferences;h.imageControllers=[];h.galleries=[];h.sizes=[];
  h.context.WriterTextareaAutosize={attach(){const size={refreshes:0,disposed:false,refresh(){this.refreshes++;},dispose(){this.disposed=true;}};h.sizes.push(size);return size;}};
  h.context.WriterChatImages.attachComposer=options=>{
    let refs=normalize(options.initial,options.bookId),busy=false;
    const controller={options,get:()=>structuredClone(refs),set(value){refs=normalize(value,options.bookId);},isBusy:()=>busy,dispose(){this.disposed=true;},change(value){refs=normalize(value,options.bookId);options.onChange(structuredClone(refs));},setBusy(value){busy=value;options.onBusy(value);}};h.imageControllers.push(controller);return controller;
  };
  h.context.WriterChatImages.render=(container,refs,options)=>{const gallery={container,refs:structuredClone(refs),options,disposed:false};h.galleries.push(gallery);return{dispose(){gallery.disposed=true;}};};
  const preview=h.preview;h.preview=request=>{const result=preview(request),images=[...(request.attachments||[]),...request.history.flatMap(message=>message.attachments||[])];if(images.length){result.imageCount=images.length;result.imageBytes=images.length*123;}return result;};
  h.images=()=>h.imageControllers.at(-1);h.photo=(digit='a',bookId=h.state.book.id)=>({id:digit.repeat(64)+'.png',name:'人物.png',url:'/api/books/'+encodeURIComponent(bookId)+'/ai/images/'+digit.repeat(64)+'.png',mime:'image/png',bytes:123});
  return h;
}
test('image-only send snapshots references, displays both sides and keeps binary data out of preference storage',async()=>{
  const h=imageChatHarness();await h.open();const photo=h.photo(),reply=h.photo('b');h.images().change([photo]);await h.flush();assert.equal(h.button('发送').disabled,false);
  h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'',images:[reply],data:null});await h.send();
  const request=h.calls.find(call=>call.url.endsWith('/ai')).request;assert.equal(request.instruction,'');assert.deepEqual(request.attachments,[{id:photo.id,name:photo.name}]);assert.equal(h.records().turns[0].status,'complete');assert.deepEqual(h.records().attachments,[]);assert.equal(h.images().get().length,0);assert.ok(h.galleries.some(g=>g.refs[0].id===photo.id));assert.ok(h.galleries.some(g=>g.refs[0].id===reply.id));assert.ok(![...h.storage.values()].join('').includes('data:image/'));
});
test('follow-up history retains user and assistant image references while preserving text roles',async()=>{
  const h=imageChatHarness();await h.open();const photo=h.photo(),reply=h.photo('b');h.images().change([photo]);await h.prompt('看这张人物设定');h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'图片建议',images:[reply],data:null});await h.send();await h.prompt('保留这些颜色');await h.send();
  const history=h.calls.filter(call=>call.url.endsWith('/ai'))[1].request.history;assert.deepEqual(history,[{role:'user',content:'看这张人物设定',attachments:[{id:photo.id,name:photo.name}]},{role:'assistant',content:'图片建议',attachments:[{id:reply.id,name:reply.name}]}]);
});
test('unsent attachments are independent by book and channel and survive restart without resending',async()=>{
  const h=imageChatHarness();await h.open();const photo=h.photo();h.images().change([photo]);await h.flush();h.state.view='outline';h.run('syncAIChat()');await h.tick();assert.deepEqual(h.images().get(),[]);h.state.view='write';h.run('syncAIChat()');await h.tick();assert.equal(h.images().get()[0].id,photo.id);
  const restarted=imageChatHarness(h.storage);await restarted.open();assert.equal(restarted.images().get()[0].id,photo.id);assert.ok(!restarted.calls.some(call=>call.url.endsWith('/ai')));assert.ok(h.sizes.some(size=>size.disposed));assert.ok(restarted.sizes[0].refreshes>0);
});
test('pending upload blocks sends and finishing a request cannot overwrite the next image draft',async()=>{
  const h=imageChatHarness();await h.open();h.images().change([h.photo()]);await h.prompt('检查图中动机');h.images().setBusy(true);assert.equal(h.button('发送').disabled,true);await h.send();assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));h.images().setBusy(false);
  let finish;h.response=request=>new Promise(resolve=>{finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'建议',data:null});});const pending=h.send();await h.tick();h.images().change([h.photo('b')]);await h.prompt('下一张图');finish();await pending;assert.equal(h.field('ai-chat-prompt').value,'下一张图');assert.equal(h.records().attachments[0].id,h.photo('b').id);assert.equal(h.calls.find(call=>call.url.endsWith('/ai')).request.attachments[0].id,h.photo().id);
});
test('failure and explicit retry restore the original image, and a changed image is a fresh user turn',async()=>{
  const h=imageChatHarness();await h.open();h.images().change([h.photo()]);await h.prompt('看看');h.response=()=>{throw Error('失败');};await h.send();assert.equal(h.images().get()[0].id,h.photo().id);await h.button('重试').listeners.click();assert.equal(h.records().turns.length,1);assert.equal(h.calls.filter(call=>call.url.endsWith('/ai'))[1].request.attachments[0].id,h.photo().id);
  h.images().change([h.photo('b')]);await h.flush();await h.send();assert.equal(h.records().turns.length,2);assert.equal(h.calls.filter(call=>call.url.endsWith('/ai'))[2].request.attachments[0].id,h.photo('b').id);
});
test('foreign or malformed response images are rejected and original attachment remains retryable',async()=>{
  for(const bad of [null,{...imageChatHarness().photo(),url:'https://outside.test/picture.png'},imageChatHarness().photo('a','another-book')]){
    const h=imageChatHarness();await h.open();h.images().change([h.photo()]);await h.flush();h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'建议',images:[bad],data:null});await h.send();assert.equal(h.records().turns[0].status,'error');assert.equal(h.images().get()[0].id,h.photo().id);assert.ok(!h.galleries.some(g=>g.refs.includes(bad)));
  }
});
test('restart retains completed image-only turns and clearing a conversation disposes its galleries',async()=>{
  const h=imageChatHarness();await h.open();h.images().change([h.photo()]);await h.flush();h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'',images:[h.photo('b')],data:null});await h.send();
  const restarted=imageChatHarness(h.storage);await restarted.open();assert.equal(restarted.records().turns.length,1);assert.ok(restarted.galleries.some(g=>g.refs[0].id===h.photo('b').id));await restarted.button('新对话').listeners.click();assert.deepEqual(restarted.records().turns,[]);assert.ok(restarted.galleries.every(g=>g.disposed));assert.deepEqual(restarted.images().get(),[]);
});

test('composer switches service profiles and pins each request to the selected local configuration',async()=>{
  const h=harness(),profiles=[{id:'first',name:'首选服务',model:'stub'},{id:'second',name:'本机服务',model:'second-model'}];h.settings={...h.settings,activeProfileId:'first',profiles};h.saveModel=async request=>{const profile=profiles.find(item=>item.id===request.profileId)||profiles.find(item=>item.id===h.settings.activeProfileId);h.settings={...h.settings,...profile,...request,activeProfileId:profile.id,profiles};return h.settings;};
  await h.open();const choice=h.field('ai-chat-profile');assert.equal(choice.hidden,false);assert.equal(choice.value,'first');choice.value='second';await choice.listeners.change();await h.flush();assert.equal(choice.value,'second');assert.equal(h.field('ai-chat-model').value,'second-model');await h.prompt('讨论本章');await h.send();const request=h.calls.find(call=>call.url.endsWith('/ai')).request;assert.equal(request.profileId,'second');assert.equal(request.model,'second-model');assert.ok(!JSON.stringify(h.storage).includes('apiKey'));
});

test('late profile switch cannot replace a newly opened books configuration or transmit draft prompts',async()=>{
  const h=harness(),profiles=[{id:'first',name:'服务一'},{id:'second',name:'服务二'}];h.settings={...h.settings,activeProfileId:'first',profiles};let finish;h.saveModel=request=>new Promise(resolve=>{finish=()=>{h.settings={...h.settings,activeProfileId:request.profileId};resolve(h.settings);};});await h.open();await h.prompt('尚未发送');const previous=h.field('ai-chat-profile');previous.value='second';const switching=previous.listeners.change();await h.tick();h.state.book={...structuredClone(h.state.book),id:'new-book'};h.run('syncAIChat()');finish();await switching;await h.tick();assert.equal(h.field('ai-chat-prompt').value,'');assert.equal(h.field('ai-chat-profile').value,'second');assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
});


test('a completed AI reply opens an editable Skill preview without writing or executing its content',async()=>{
  const h=harness();h.response=request=>({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'<img src=x onerror=alert(1)>\n仅根据人物目标写对白。'});let preview;h.context.openWritingSkillEditor=value=>{preview=structuredClone(value);};await h.open();await h.prompt('给我一套对白规则');await h.send();const save=h.button('存为 Skill');assert.equal(save.textContent,'');assert.ok(find(save,node=>node.tagName==='SVG'));assert.equal(save.disabled,false);await save.listeners.click();assert.equal(preview.content,'<img src=x onerror=alert(1)>\n仅根据人物目标写对白。');assert.ok(!h.calls.some(call=>call.url==='/api/skills/custom'));assert.equal(h.state.book.chapters[0].body,'正文一');
});

test('pending generation disables save-as-Skill on older replies and no incomplete reply offers it',async()=>{
  const h=harness();let finish;await h.open();await h.prompt('第一轮');await h.send();const save=h.button('存为 Skill');let opened=false;h.context.openWritingSkillEditor=()=>{opened=true;};h.response=()=>new Promise(resolve=>finish=resolve);await h.prompt('第二轮');const request=h.send();await h.tick();assert.equal(save.disabled,true);await save.listeners.click();assert.equal(opened,false);assert.equal(descendants(h.panel()).filter(node=>node.title==='存为 Skill').length,1);finish({bookId:'one',action:'custom',chapterIds:['a'],chat:true,reply:'第二轮完成'});await request;assert.equal(save.disabled,false);
});


test('trying a Skill opens the current writing conversation and preserves its edited task and unsent prompt without sending',async()=>{
  const h=harness();await h.open();h.field('ai-chat-task').value='outline';h.field('ai-chat-task').listeners.change();await h.prompt('我已经改好的提示词，不要替换');const box=find(h.panel(),node=>node.value==='novelskill'&&node.tagName==='INPUT');assert.equal(box.role,'switch');assert.equal(box['aria-checked'],'true');box.checked=false;box.listeners.change();await h.flush();assert.equal(h.records().skillIds.length,0);const prompt=h.field('ai-chat-prompt').value,snapshot=JSON.stringify(h.state.book);h.get('settings-dialog').open=true;
  assert.equal(await h.run("tryWritingSkill('novelskill')"),true);assert.equal(h.get('settings-dialog').open,false);assert.equal(h.panel().hidden,false);assert.deepEqual(h.records().skillIds,['novelskill']);assert.equal(h.field('ai-chat-prompt').value,prompt);assert.equal(h.field('ai-chat-task').value,'outline');assert.equal(h.field('ai-chat-prompt').focused,true);assert.equal(find(h.panel(),node=>node.value==='novelskill'&&node.tagName==='INPUT')['aria-checked'],'true');assert.equal(JSON.stringify(h.state.book),snapshot);assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
});

test('trying a Skill from home uses the existing book and saved writing prompt, and does not choose another work',async()=>{
  const storage=new Map([['yejian.ai-chat.one.write',JSON.stringify({version:1,action:'custom',prompt:'留在写作栏的草稿',skillIds:[],skillMode:'polish',chapterIds:['a'],turns:[],open:false})]]),h=harness(storage);h.state.view='home';const current=h.state.book,navigated=[];h.context.navigate=async view=>{navigated.push(view);h.state.view=view;return true;};assert.equal(await h.run("tryWritingSkill('novelskill')"),true);assert.deepEqual(navigated,['write']);assert.equal(h.state.book,current);assert.equal(h.field('ai-chat-prompt').value,'留在写作栏的草稿');assert.equal(h.field('ai-chat-task').value,'custom');assert.equal(h.records().skillMode,'polish');assert.deepEqual(h.records().skillIds,['novelskill']);assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
});

test('trying a Skill without a current book, during composition or after failed save cannot select a hidden work or dismiss settings',async()=>{
  const h=harness();h.state.book=null;assert.equal(await h.run("tryWritingSkill('novelskill')"),false);assert.deepEqual(h.toasts,['先从书架选择作品。']);assert.equal(h.calls.length,0);
  const writing=harness();writing.get('settings-dialog').open=true;writing.state.composing=true;assert.equal(await writing.run("tryWritingSkill('novelskill')"),false);assert.equal(writing.get('settings-dialog').open,true);assert.equal(writing.calls.length,0);writing.state.composing=false;writing.saves.push(false);assert.equal(await writing.run("tryWritingSkill('novelskill')"),false);assert.equal(writing.get('settings-dialog').open,true);assert.equal(writing.calls.length,0);
});

test('trying an unavailable Skill leaves selected rules, prompt and manuscript unchanged without an AI request',async()=>{
  const h=harness();await h.open();await h.prompt('继续保留这个提示词');const snapshot=JSON.stringify(h.state.book),skills=h.records().skillIds;assert.equal(await h.run("tryWritingSkill('custom-missing')"),false);assert.deepEqual(h.records().skillIds,skills);assert.equal(h.field('ai-chat-prompt').value,'继续保留这个提示词');assert.equal(JSON.stringify(h.state.book),snapshot);assert.ok(h.toasts.includes('此 Skill 当前不可用，请刷新后重试。'));assert.ok(!h.calls.some(call=>call.url.endsWith('/ai')));
});

test('try Skill cannot move a pending reply to another task or clear the next prompt',async()=>{
  const h=harness();await h.open();await h.prompt('先发出的消息');let finish;h.response=request=>new Promise(resolve=>finish=()=>resolve({bookId:'one',action:request.action,chapterIds:request.chapterIds,chat:true,reply:'待返回内容'}));const pending=h.send();await h.tick();await h.prompt('接下来要问的问题');assert.equal(await h.run("tryWritingSkill('novelskill')"),false);assert.equal(h.field('ai-chat-prompt').value,'接下来要问的问题');finish();await pending;assert.equal(h.field('ai-chat-prompt').value,'接下来要问的问题');assert.equal(h.calls.filter(call=>call.url.endsWith('/ai')).length,1);
});


test('a delayed Try now save cannot close a newer Skill window or switch a replaced viewer to writing',async()=>{
  const h=harness();h.state.view='home';h.get('settings-dialog').open=true;let finish;h.context.requireSaved=()=>new Promise(resolve=>finish=resolve);h.context.first={id:'novelskill',name:'First',content:'First rules',files:[],usable:true};h.context.second={id:'human-writing',name:'Second',content:'Second rules',files:[],usable:true};h.run('openWritingSkillViewer(first)');let viewer=find(h.context.document.body,node=>node.id==='writing-skill-view-dialog');await viewer.loaded;const pending=find(viewer,node=>node.className==='writing-skill-view-try').listeners.click();await h.tick();await find(viewer,node=>node.title==='关闭').listeners.click();h.run('openWritingSkillViewer(second)');const newer=find(h.context.document.body,node=>node.id==='writing-skill-view-dialog');await newer.loaded;finish(true);await pending;assert.equal(newer.open,true);assert.equal(h.state.view,'home');assert.equal(h.get('settings-dialog').open,true);assert.equal(h.calls.length,0);
});
