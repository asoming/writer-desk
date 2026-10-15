'use strict';

// Each book has independent planning and manuscript conversations. Only an
// explicit send may reach the configured AI service; previews stay local.
const aiChatTasks={custom:'自由对话',outline:'生成大纲',draft:'生成写作草稿',memory:'整理长篇记忆',consistency:'检查人物与剧情一致性',relationships:'提取人物与关系'};
let aiChatView=null;

function aiChatChannel(){return state.book&&['outline','write'].includes(state.view)?state.view:null;}
function aiChatStorageKey(bookId,channel){return 'yejian.ai-chat.'+bookId+'.'+channel;}
function aiChatImages(value,bookId){return window.WriterChatImages?.normalizeReferences(value,bookId)||[];}
function aiChatImagePayload(value){return (value||[]).map(({id,name})=>({id,name}));}
function aiChatMessage(role,content,images=[]){return{role,content,...(images.length?{attachments:aiChatImagePayload(images)}:{})};}
function aiChatSameImages(a,b){return JSON.stringify(aiChatImagePayload(a))===JSON.stringify(aiChatImagePayload(b));}
function aiChatRead(bookId,channel){
  let stored=null;try{stored=JSON.parse(preference(aiChatStorageKey(bookId,channel))||'null');}catch{}
  const value={version:1,open:true,action:'custom',prompt:'',attachments:[],prompts:{},turns:[],skillIds:null,skillMode:null,manualChapters:false,chapterIds:[]};
  if(!stored||stored.version!==1)return value;
  if(typeof stored.open==='boolean')value.open=stored.open;
  if(Object.hasOwn(aiChatTasks,stored.action))value.action=stored.action;
  if(typeof stored.prompt==='string'&&stored.prompt.length<=10000)value.prompt=stored.prompt;
  value.attachments=aiChatImages(stored.attachments,bookId);
  if(stored.prompts&&typeof stored.prompts==='object')for(const key of Object.keys(aiChatTasks))if(typeof stored.prompts[key]==='string'&&stored.prompts[key].length<=10000)value.prompts[key]=stored.prompts[key];
  if(Array.isArray(stored.skillIds)&&stored.skillIds.every(id=>typeof id==='string'))value.skillIds=[...new Set(stored.skillIds)];
  if(Object.hasOwn(writingSkillModes,stored.skillMode))value.skillMode=stored.skillMode;
  value.manualChapters=stored.manualChapters===true;
  if(Array.isArray(stored.chapterIds)&&stored.chapterIds.every(id=>typeof id==='string'))value.chapterIds=[...new Set(stored.chapterIds)];
  if(Array.isArray(stored.turns))value.turns=stored.turns.filter(turn=>turn&&typeof turn.id==='string'&&typeof turn.user==='string'&&(turn.user.trim()||aiChatImages(turn.attachments,bookId).length)&&turn.user.length<=10000&&Object.hasOwn(aiChatTasks,turn.action)&&Array.isArray(turn.chapterIds)&&turn.chapterIds.every(id=>typeof id==='string')&&['complete','error','cancelled','pending'].includes(turn.status)&&(turn.status!=='complete'||typeof turn.reply==='string'&&(turn.reply.trim()||aiChatImages(turn.images,bookId).length))&&(!turn.reply||typeof turn.reply==='string'&&turn.reply.length<=100000)).map(turn=>({...turn,attachments:aiChatImages(turn.attachments,bookId),images:aiChatImages(turn.images,bookId),status:turn.status==='pending'?'error':turn.status,error:turn.status==='pending'?T('请求中断，可重试。'):typeof turn.error==='string'?turn.error:'',consumed:turn.consumed===true}));
  return value;
}

function closeAIChat(){if(aiChatView)aiChatView.close();}
function suspendAIChatForPurge(bookId){
  if(aiChatView?.book.id===bookId){aiChatView.dispose();aiChatView=null;$('ai-chat-panel').hidden=true;}
}
function clearAIChatBookHistory(bookId){
  if(aiChatView?.book.id===bookId){aiChatView.dispose();aiChatView=null;$('ai-chat-panel').hidden=true;}
  for(const channel of ['outline','write'])try{clientStorage.removeItem(aiChatStorageKey(bookId,channel));}catch{toast(T('对话未能从本机删除。'));}
}
function refreshAIChatSettings(){return aiChatView?.reload();}
function flushAIChat(){aiChatView?.flush();}
addEventListener('pagehide',flushAIChat);
addEventListener('beforeunload',flushAIChat);
addEventListener('writer-chat-image-viewer-closed',()=>aiChatView?.resumeCandidates());
$('dialog')?.addEventListener('close',()=>aiChatView?.resumeCandidates());
function toggleAIChat(initialAction){
  const channel=aiChatChannel();if(!channel)return;
  syncAIChat();if(!aiChatView)return;
  if(initialAction&&Object.hasOwn(aiChatTasks,initialAction))aiChatView.open(initialAction);
  else aiChatView.visible()?aiChatView.close():aiChatView.open();
}
function syncAIChat(){
  const panel=$('ai-chat-panel'),channel=aiChatChannel();if(!panel)return;
  if(!channel){aiChatView?.suspend();panel.hidden=true;return;}
  if(!aiChatView||aiChatView.book!==state.book||aiChatView.channel!==channel){aiChatView?.dispose();aiChatView=createAIChatView(panel,state.book,channel);}
  aiChatView.sync();
}

function createAIChatView(panel,book,channel){
  const saved=aiChatRead(book.id,channel),key=aiChatStorageKey(book.id,channel),root=el('div','ai-chat-inner');
  let disposed=false,active=false,requestSeq=0,previewSeq=0,loadSeq=0,modelSeq=0,preview=null,previewKey='',previewDelay=null,writeDelay=null,pending=null,pendingAbort=null,configuration=null,skills=[],ready=false,composing=false,scopeKey='',storageError=false,modelIds=[],modelSaving=false,modelsLoading=false,configurationLoading=false;
  const candidates=new Map(),bubbles=new Map(),deferredCandidates=new Set(),imageViews=new Map();
  const header=el('header','ai-chat-header'),heading=el('strong',null,'AI'),headerActions=el('div','ai-chat-header-actions');
  const fresh=action('＋','icon-button',newConversation),close=action('×','icon-button',()=>controller.close());fresh.setAttribute('aria-label',T('新对话'));fresh.title=T('新对话');close.setAttribute('aria-label',T('关闭 AI 对话'));close.title=T('关闭 AI 对话');headerActions.append(fresh,close);header.append(heading,headerActions);
  const context=el('div','ai-chat-context'),scope=el('span','ai-chat-scope'),task=el('select','ai-chat-task');task.id='ai-chat-task';task.setAttribute('aria-label',T('写作任务'));
  Object.entries(aiChatTasks).forEach(([value,label])=>{const option=el('option',null,T(label));option.value=value;task.append(option);});task.value=saved.action;context.append(scope,task);
  const transcript=el('div','ai-chat-transcript');transcript.setAttribute('role','log');transcript.setAttribute('aria-label',T('AI 对话'));transcript.setAttribute('aria-live','polite');
  const footer=el('div','ai-chat-footer'),material=el('details','ai-chat-material'),materialSummary=el('summary'),materialBody=el('div','ai-chat-material-body'),chapterChoices=el('div','ai-chat-chapters'),skillChoices=el('div','ai-chat-skills'),skillMode=writingSkillModeSelect('ai-chat-skill-mode'),materialCount=el('span','ai-chat-material-count');
  const chapterTools=el('div','ai-chat-material-tools'),selectAll=action(T('全选'),'text-button',()=>chooseChapters(true)),clearChapters=action(T('清空'),'text-button',()=>chooseChapters(false));chapterTools.append(selectAll,clearChapters);materialBody.append(chapterTools,chapterChoices,el('div','ai-chat-skill-label',T('写作 Skill')),skillChoices,skillMode,materialCount);material.append(materialSummary,materialBody);
  const memoryButton=window.WriterStoryMemory?action(T('长篇记忆'),'text-button',()=>{if(!pending&&current())window.WriterStoryMemory.open(book,{onChanged:schedulePreview});}):null;if(memoryButton)materialBody.append(memoryButton);
  const composer=el('div','ai-chat-composer'),input=el('textarea'),send=action('↑','ai-chat-send',()=>run()),composerBar=el('div','ai-chat-composer-bar'),modelGroup=el('div','ai-chat-model-group'),profileChoice=el('select','ai-chat-model ai-chat-profile'),modelChoice=el('select','ai-chat-model'),refreshModels=action('↻','ai-chat-model-refresh',()=>loadModels(true));modelChoice.id='ai-chat-model';modelChoice.setAttribute('aria-label',T('模型'));refreshModels.setAttribute('aria-label',T('刷新模型'));refreshModels.title=T('刷新模型');input.id='ai-chat-prompt';input.rows=3;input.maxLength=10000;input.value=saved.prompt;input.placeholder=T('输入提示词…');input.setAttribute('aria-label',T('提示词'));send.setAttribute('aria-label',T('发送'));send.title=T('发送');profileChoice.id='ai-chat-profile';profileChoice.setAttribute('aria-label',T('服务配置'));modelGroup.append(profileChoice,modelChoice,refreshModels);composerBar.append(modelGroup,send);composer.append(input,composerBar);
  const composerTools=el('div','ai-chat-composer-tools'),reset=action(T('恢复默认提示词'),'text-button',()=>chooseTask(task.value,true)),status=el('p','ai-chat-status'),configure=action(T('打开 AI 设置'),'text-button',()=>showAppSettings('ai'));configure.hidden=true;composerTools.append(reset);footer.append(material,status,configure,composer,composerTools);root.append(header,context,transcript,footer);panel.replaceChildren(root);

  const promptSize=window.WriterTextareaAutosize?.attach(input,{container:root});
  const current=()=>!disposed&&state.book===book&&state.view===channel;
  const visible=()=>current()&&active&&!panel.hidden;
  const modalOpen=()=>$('dialog')?.open||$('settings-dialog')?.open||window.WriterChatImages?.viewerOpen();
  const imageInput=window.WriterChatImages?.attachComposer({bookId:book.id,input,composer,toolbar:modelGroup,initial:saved.attachments,current:()=>!disposed&&state.book===book,onChange:images=>{saved.attachments=images;persist();if(!pending)schedulePreview();},onBusy:()=>controls(),onError:message=>{status.textContent=T(message);}});
  const draftImages=()=>imageInput?.get()||saved.attachments;
  const hasPrompt=()=>!!input.value.trim()||draftImages().length>0;
  function setDraftImages(images){saved.attachments=aiChatImages(images,book.id);imageInput?.set(saved.attachments,{notify:false});}
  function persist(){
    clearTimeout(writeDelay);
    saved.prompt=input.value;saved.action=task.value;saved.attachments=draftImages();promptSize?.refresh();
    try{clientStorage.setItem(key,JSON.stringify(saved));storageError=false;if(status.textContent===T('对话未能保存到本机。'))status.textContent='';}catch{storageError=true;status.textContent=T('对话未能保存到本机。');}
  }
  function persistLater(){saved.prompt=input.value;saved.action=task.value;clearTimeout(writeDelay);writeDelay=setTimeout(persist,250);}
  function validChapters(){return book.chapters.filter(chapter=>!chapter.deletedAt);}
  function sourceOutline(){return channel==='outline'?book.outline.find(node=>node.id===state.outlineId&&!node.deletedAt)||null:null;}
  function defaultChapterIds(){const chapters=validChapters(),outline=sourceOutline();if(book.kind==='short')return chapters.map(chapter=>chapter.id);return outline?(outline.chapterIds||[]).filter(id=>chapters.some(chapter=>chapter.id===id)):chapters.some(chapter=>chapter.id===state.chapterId)?[state.chapterId]:[];}
  function updateScope(){
    const outline=sourceOutline(),chapter=validChapters().find(item=>item.id===state.chapterId),next=channel+':'+(outline?.id||chapter?.id||'');
    scope.textContent=channel==='outline'?(outline?.title||T('故事大纲')):book.kind==='short'?T('正文'):(chapter?.title||T('正文写作'));scope.title=scope.textContent;
    if(next===scopeKey)return false;scopeKey=next;
    if(!saved.manualChapters)saved.chapterIds=defaultChapterIds();
    return true;
  }
  function payload(turn=null){
    const history=saved.turns.filter(item=>item.status==='complete').flatMap(item=>[aiChatMessage('user',item.user,item.attachments),aiChatMessage('assistant',item.reply+(item.data?'\n\n'+JSON.stringify(item.data):''),item.images)]),images=turn?.attachments||draftImages();
    return{action:turn?.action||task.value,chapterIds:book.kind==='short'?validChapters().map(chapter=>chapter.id):turn?turn.chapterIds:validChapters().filter(chapter=>saved.chapterIds.includes(chapter.id)).map(chapter=>chapter.id),instruction:turn?.user??input.value,...(images.length?{attachments:aiChatImagePayload(images)}:{}),skillIds:turn&&Array.isArray(turn.skillIds)?turn.skillIds:skills.filter(skill=>skill.imported&&(saved.skillIds||[]).includes(skill.id)).map(skill=>skill.id),skillMode:turn&&Object.hasOwn(writingSkillModes,turn.skillMode)?turn.skillMode:saved.skillMode,...(configuration?.model?{model:configuration.model}:{}),...(configuration?.activeProfileId?{profileId:configuration.activeProfileId}:{}),chat:true,history};
  }
  function available(){return ready&&configuration?.enabled&&configuration.endpoint&&configuration.model;}
  function controls(){
    send.disabled=!!pending||!!imageInput?.isBusy()||modelSaving||configurationLoading||!!aiModelChangePending||!available()||!hasPrompt()||!preview||preview.overLimit||previewKey!==JSON.stringify(payload())||(['relationships','consistency','memory'].includes(task.value)&&!saved.chapterIds.length);
    task.disabled=reset.disabled=selectAll.disabled=clearChapters.disabled=!!pending;skillMode.disabled=!!pending||!ready;
    chapterChoices.querySelectorAll('input').forEach(box=>box.disabled=!!pending);skillChoices.querySelectorAll('input').forEach(box=>box.disabled=!!pending||box.dataset.available!=='true');
    configure.hidden=!!available();reset.hidden=task.value==='custom';
    profileChoice.disabled=modelChoice.disabled=!!pending||modelSaving||configurationLoading||!ready;refreshModels.disabled=!!pending||modelSaving||modelsLoading||!configuration?.endpoint;
    if(memoryButton)memoryButton.disabled=!!pending;
  }
  function renderModels(){
    profileChoice.replaceChildren();for(const profile of configuration?.profiles||[]){const option=el('option',null,T(profile.name));option.value=profile.id;profileChoice.append(option);}profileChoice.value=configuration?.activeProfileId||'';profileChoice.hidden=(configuration?.profiles?.length||0)<2;
    modelChoice.replaceChildren();const selected=configuration?.model||'',ids=selected?[selected,...modelIds.filter(id=>id!==selected)]:modelIds;
    if(!selected){const placeholder=el('option',null,T('选择模型'));placeholder.value='';modelChoice.append(placeholder);}ids.forEach(id=>{const option=el('option',null,id);option.value=id;modelChoice.append(option);});const custom=el('option',null,T('自定义模型'));custom.value='';modelChoice.append(custom);modelChoice.value=selected;modelChoice.title=selected||T('模型');controls();
  }
  async function loadModels(refresh=false){
    const sequence=++modelSeq;if(!configuration?.endpoint){modelIds=[];renderModels();return;}modelsLoading=true;controls();
    try{const ids=await aiReadModels(configuration,refresh);if(!current()||disposed||sequence!==modelSeq)return;modelIds=ids;renderModels();modelChoice.title=configuration.model||T('模型');}
    catch(error){if(current()&&!disposed&&sequence===modelSeq){modelChoice.title=T(error.message);if(refresh)toast(T(error.message));}}
    finally{if(!disposed&&sequence===modelSeq){modelsLoading=false;controls();}}
  }
  profileChoice.addEventListener('change',async()=>{
    const selected=profileChoice.value;if(pending||modelSaving||configurationLoading||!ready||selected===configuration?.activeProfileId){profileChoice.value=configuration?.activeProfileId||'';return;}
    if(!configuration.profiles?.some(profile=>profile.id===selected)){renderModels();return;}
    modelSaving=true;++loadSeq;++modelSeq;++previewSeq;preview=null;previewKey='';modelsLoading=configurationLoading=false;controls();
    try{const settings=await aiSaveProfileChoice(selected);if(disposed)return;configuration=settings;modelIds=[];aiModelCatalog=null;renderModels();if(current()){loadModels(true);schedulePreview();}}
    catch(error){if(!disposed){renderModels();status.textContent=T(error.message);}}
    finally{modelSaving=false;if(current()&&!disposed)controls();}
  });
  modelChoice.addEventListener('change',async()=>{
    const selected=modelChoice.value;if(pending||modelSaving||!ready){modelChoice.value=configuration?.model||'';return;}
    if(!selected){modelChoice.value=configuration?.model||'';showAppSettings('ai');return;}
    if(selected===configuration.model)return;if(!modelIds.includes(selected)){renderModels();return;}
    modelSaving=true;++loadSeq;++modelSeq;modelsLoading=configurationLoading=false;controls();
    try{const settings=await aiSaveModelChoice(selected,configuration?.activeProfileId);if(disposed)return;configuration=settings;renderModels();if(current())schedulePreview();}
    catch(error){if(!disposed){renderModels();status.textContent=T(error.message);}}
    finally{modelSaving=false;if(current()&&!disposed)controls();}
  });
  function renderChoices(){
    const chapters=validChapters();saved.chapterIds=book.kind==='short'?chapters.map(chapter=>chapter.id):saved.chapterIds.filter(id=>chapters.some(chapter=>chapter.id===id));materialSummary.textContent=saved.chapterIds.length?(book.kind==='short'?T('资料 · 正文'):T('资料 · {0} 章',saved.chapterIds.length)):T('资料');chapterChoices.replaceChildren();chapterTools.hidden=chapterChoices.hidden=book.kind==='short'||!chapters.length;
    if(book.kind!=='short')chapters.forEach(chapter=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.value=chapter.id;box.checked=saved.chapterIds.includes(chapter.id);box.addEventListener('change',()=>{if(pending)return;saved.manualChapters=true;saved.chapterIds=box.checked?[...new Set([...saved.chapterIds,chapter.id])]:saved.chapterIds.filter(id=>id!==chapter.id);renderChoices();persist();schedulePreview();});row.append(box,el('span',null,chapter.title||T('未命名章节')));chapterChoices.append(row);});
    skillChoices.replaceChildren();skills.forEach(skill=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.value=skill.id;box.checked=(saved.skillIds||[]).includes(skill.id);box.dataset.available=String(!!skill.imported);box.addEventListener('change',()=>{if(pending)return;saved.skillIds=box.checked?[...new Set([...(saved.skillIds||[]),skill.id])]:saved.skillIds.filter(id=>id!==skill.id);persist();schedulePreview();});row.append(box,el('span',null,writingSkillName(skill.id)),el('small',null,skill.imported?T('已导入'):T('未导入')));skillChoices.append(row);});skillMode.value=saved.skillMode;controls();
  }
  function chooseChapters(all){if(pending)return;saved.manualChapters=true;saved.chapterIds=all?validChapters().map(chapter=>chapter.id):[];renderChoices();persist();schedulePreview();}
  function chooseTask(value,restore=false){
    if(pending)return;saved.prompts[task.value]=input.value;
    task.value=value;input.value=restore?aiDefaultPrompt(value):(saved.prompts[value]??aiDefaultPrompt(value));saved.prompts[value]=input.value;persist();schedulePreview();input.focus();
  }
  task.addEventListener('change',()=>{const selected=task.value;task.value=saved.action;chooseTask(selected);});
  skillMode.addEventListener('change',()=>{if(pending)return;saved.skillMode=skillMode.value;persist();schedulePreview();});
  input.addEventListener('input',()=>{saved.prompts[task.value]=input.value;persistLater();if(!pending)schedulePreview();});
  input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();if(!event.repeat)return run();}});
  function schedulePreview(){clearTimeout(previewDelay);++previewSeq;preview=null;previewKey='';materialCount.textContent='';controls();if(!pending&&hasPrompt())previewDelay=setTimeout(()=>updatePreview(),200);}
  function validatePreview(value,request){
    if(value?.chat!==true||value.bookId!==book.id||value.action!==request.action||!Array.isArray(value.chapterIds)||JSON.stringify(value.chapterIds)!==JSON.stringify(request.chapterIds)||!Array.isArray(value.selectedSkillIds)||JSON.stringify([...value.selectedSkillIds].sort())!==JSON.stringify([...request.skillIds].sort())||value.skillMode!==request.skillMode||value.historyMessages!==request.history.length||value.historyChars!==request.history.reduce((sum,message)=>sum+Array.from(message.content).length,0)||!value.counts||!['chapters','outlines','people','relationships'].every(name=>Number.isSafeInteger(value.counts[name])&&value.counts[name]>=0)||!Number.isSafeInteger(value.contextChars)||value.contextChars<0||!['auto','manual'].includes(value.contextMode)||(value.contextMode==='auto'?(value.maxContextChars!==null||value.overLimit!==false):(!Number.isSafeInteger(value.maxContextChars)||value.maxContextChars<1||typeof value.overLimit!=='boolean')))throw Error(T('资料预览无效，请重试。'));
    const imageCount=(request.attachments?.length||0)+request.history.reduce((sum,message)=>sum+(message.attachments?.length||0),0);
    if(imageCount&&(value.imageCount!==imageCount||!Number.isSafeInteger(value.imageBytes)||value.imageBytes<=0||value.imageBytes>20*1024*1024))throw Error(T('资料预览无效，请重试。'));
    return value;
  }
  async function updatePreview(request=payload()){
    const sequence=++previewSeq;preview=null;previewKey='';controls();if(!current()||!ready||(!request.instruction.trim()&&!request.attachments?.length))return null;
    try{const value=validatePreview(await api('/api/books/'+encodeURIComponent(book.id)+'/ai/preview','POST',request),request);if(sequence!==previewSeq||!current())return null;preview=value;previewKey=JSON.stringify(request);materialCount.textContent=T('共 {0} 字符',value.contextChars.toLocaleString())+(value.imageCount?T(' · {0} 张图片',value.imageCount):'');status.textContent=value.overLimit?(book.kind==='short'?T('资料超过手动上限，请调整设置。'):T('资料超过手动上限，请减少章节或调整设置。')):!available()?T('请先在设置中启用并配置 AI。'):storageError?T('对话未能保存到本机。'):'';controls();return value;}catch(error){if(sequence===previewSeq&&current()){status.textContent=T(error.message);controls();}return null;}
  }
  function scrollEnd(){requestAnimationFrame(()=>{transcript.scrollTop=transcript.scrollHeight;});}
  function renderImages(key,container,images){imageViews.get(key)?.dispose();imageViews.delete(key);if(images?.length&&window.WriterChatImages)imageViews.set(key,window.WriterChatImages.render(container,images,{bookId:book.id}));}
  function clearImageViews(){imageViews.forEach(view=>view.dispose());imageViews.clear();}
  function appendTurn(turn){
    const group=el('section','ai-chat-turn'),user=el('div','ai-chat-message ai-chat-user'),answer=el('div','ai-chat-message ai-chat-assistant');if(turn.user)user.append(el('div','ai-chat-message-text',turn.user));renderImages(turn.id+':user',user,turn.attachments);group.append(user,answer);transcript.append(group);bubbles.set(turn.id,{group,answer});saved.turns.filter(item=>item!==turn&&['error','cancelled'].includes(item.status)).forEach(renderAnswer);renderAnswer(turn);scrollEnd();
  }
  function renderAnswer(turn){
    const answer=bubbles.get(turn.id)?.answer;if(!answer)return;renderImages(turn.id+':reply',answer,[]);answer.replaceChildren();candidates.get(turn.id)?.dispose();candidates.delete(turn.id);deferredCandidates.delete(turn.id);
    if(turn.status==='pending'){answer.append(el('div',turn.reply?'ai-chat-message-text ai-chat-streaming':'ai-chat-waiting',turn.reply||T('正在思考…')),action(T('停止等待'),'text-button',cancelPending));return;}
    if(turn.status!=='complete'){if(turn.reply)answer.append(el('div','ai-chat-message-text',turn.reply));answer.append(el('p','ai-chat-message-error',T(turn.error||'请求中断，可重试。')));if(turn===saved.turns.at(-1))answer.append(action(T('重试'),'text-button',()=>run(turn)));return;}
    if(turn.reply)answer.append(el('div','ai-chat-message-text',turn.reply));renderImages(turn.id+':reply',answer,turn.images);if(typeof turn.imageWarning==='string'&&turn.imageWarning.length<=2000)answer.append(el('p','ai-chat-message-error',T(turn.imageWarning)));
    if(turn.data&&!turn.consumed){
      const host=el('div','ai-chat-candidate');answer.append(host);
      // The shared renderer's interaction guard also guards initial creation.
      // Defer only candidates that have no renderer; existing save retries and
      // edited fields must survive closing the panel or opening settings.
      if(!visible()||modalOpen()){deferredCandidates.add(turn.id);return;}
      try{const renderer=renderAIResult(host,{bookId:book.id,action:turn.action,chapterIds:turn.chapterIds,data:turn.data},{book,chapters:validChapters(),chapterIds:turn.chapterIds,sourceOutline:book.outline.find(node=>node.id===turn.outlineId&&!node.deletedAt)||null,idPrefix:'chat-'+turn.id+'-',current:()=>visible()&&!modalOpen()&&saved.turns.includes(turn)&&turn.status==='complete',settings:()=>configuration,onApplied:()=>{turn.consumed=true;persist();},onAdopt:target=>{turn.consumed=true;persist();renderAnswer(turn);if(current()){if(target?.view===channel){if(target.chapterId)state.chapterId=target.chapterId;if(target.outlineId)state.outlineId=target.outlineId;}renderShell();}},onNavigate:(id,quote)=>jumpToChapter(id,quote)});candidates.set(turn.id,renderer);}catch(error){host.replaceChildren(el('p','ai-chat-message-error',T(error.message)));}
    }else if(turn.consumed)answer.append(el('span','ai-chat-adopted',T('已采用')));
  }
  function resumeCandidates(){if(!visible()||modalOpen())return;saved.turns.filter(turn=>deferredCandidates.has(turn.id)).forEach(renderAnswer);}
  function restoreTurnPrompt(turn){if(!hasPrompt()){input.value=turn.user;setDraftImages(turn.attachments||[]);}}
  function cancelPending(){
    if(!pending)return;pendingAbort?.abort();pendingAbort=null;const turn=pending;pending=null;++requestSeq;++previewSeq;turn.status='cancelled';turn.error=T('已停止等待');restoreTurnPrompt(turn);renderAnswer(turn);persist();renderChoices();schedulePreview();
  }
  async function run(retry=null){
    if(pending||imageInput?.isBusy()||modelSaving||configurationLoading||aiModelChangePending||!visible()||modalOpen()||!ready||!available()||composing||state.composing||state.transitioning)return;
    const last=saved.turns.at(-1),matched=retry||(last?.status!=='complete'&&last?.user===input.value&&last?.action===task.value&&aiChatSameImages(last?.attachments,draftImages())?last:null);
    if(retry&&(last!==retry||retry.status==='complete'))return;
    if(!retry&&(!hasPrompt()||send.disabled))return;
    const turn=matched||{id:uid(),user:input.value,attachments:aiChatImages(draftImages(),book.id),action:task.value,chapterIds:payload().chapterIds,skillIds:payload().skillIds,skillMode:saved.skillMode,outlineId:sourceOutline()?.id||null,status:'pending'};
    const request=payload(turn),sequence=++requestSeq;pending=turn;controls();status.textContent='';
    try{
      if(!await requireSaved()||!current()||modalOpen()||sequence!==requestSeq)return;
      const checked=await updatePreview(request);if(!current()||modalOpen()||sequence!==requestSeq)return;if(!checked||checked.overLimit)return;
      if(['relationships','consistency','memory'].includes(request.action)&&!request.chapterIds.length){status.textContent=T('请先选择正文资料。');return;}
      turn.status='pending';turn.error='';turn.reply='';turn.data=null;if(!saved.turns.includes(turn)){saved.turns.push(turn);appendTurn(turn);}else renderAnswer(turn);
      if(input.value===turn.user&&aiChatSameImages(draftImages(),turn.attachments)){input.value='';setDraftImages([]);}persist();
      const path='/api/books/'+encodeURIComponent(book.id)+'/ai';
      pendingAbort=window.WriterAIStream?new AbortController():null;
      const response=window.WriterAIStream?await window.WriterAIStream.request(path,request,{signal:pendingAbort.signal,onDelta:fragment=>{
        if(sequence!==requestSeq||!current()||turn.status!=='pending')return;
        if(typeof fragment!=='string'||turn.reply.length+fragment.length>100000){pendingAbort?.abort();throw Error(T('AI 返回内容过大，请减少生成范围后重试。'));}
        const follow=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight<80;
        turn.reply+=fragment;const answer=bubbles.get(turn.id)?.answer,text=answer?.firstElementChild;if(text){text.className='ai-chat-message-text ai-chat-streaming';text.textContent=turn.reply;}else renderAnswer(turn);
        if(follow)scrollEnd();
      }}):await api(path,'POST',request);
      if(sequence!==requestSeq||!current())return;
      const images=aiChatImages(response?.images,book.id);
      if(response?.bookId!==book.id||response.action!==request.action||response.chat!==true||!Array.isArray(response.chapterIds)||JSON.stringify(response.chapterIds)!==JSON.stringify(request.chapterIds)||typeof response.reply!=='string'||(!response.reply.trim()&&!images.length)||response.reply.length>100000||(response.images!==undefined&&(!Array.isArray(response.images)||response.images.length!==images.length)))throw Error(T('AI 结果与当前作品不匹配。'));
      turn.reply=response.reply;turn.images=images;turn.imageWarning=typeof response.imageWarning==='string'&&response.imageWarning.length<=2000?response.imageWarning:'';turn.data=response.data||null;turn.status='complete';renderAnswer(turn);persist();scrollEnd();
    }catch(error){if(sequence===requestSeq&&current()){turn.status='error';turn.error=error.message;if(!saved.turns.includes(turn)){saved.turns.push(turn);appendTurn(turn);}else renderAnswer(turn);restoreTurnPrompt(turn);persist();}}
    finally{if(sequence===requestSeq){pending=null;pendingAbort=null;if(current()){renderChoices();schedulePreview();}}}
  }
  async function newConversation(){
    if(!visible()||modalOpen()||!await requireSaved()||!visible())return;cancelPending();candidates.forEach(renderer=>renderer.dispose());candidates.clear();deferredCandidates.clear();clearImageViews();bubbles.clear();saved.turns=[];saved.action=task.value='custom';saved.prompts={};input.value='';setDraftImages([]);transcript.replaceChildren();status.textContent='';persist();schedulePreview();input.focus();
  }
  async function load(){
    const sequence=++loadSeq;configurationLoading=true;controls();
    try{if(aiModelChangePending)await aiModelChangePending.catch(()=>{});const [settings,value]=await Promise.all([api('/api/ai/settings'),api('/api/skills')]);if(disposed||sequence!==loadSeq)return;configuration=settings;configurationLoading=false;modelIds=[];skills=writingSkillList(value);if(saved.skillIds===null)saved.skillIds=(value.defaults?.skillIds||[]).filter(id=>skills.some(skill=>skill.id===id&&skill.imported));if(!Object.hasOwn(writingSkillModes,saved.skillMode))saved.skillMode=Object.hasOwn(writingSkillModes,value.defaults?.skillMode)?value.defaults.skillMode:'auto';ready=true;renderModels();renderChoices();persist();resumeCandidates();loadModels();if(current()){status.textContent=available()?(storageError?T('对话未能保存到本机。'):''):T('请先在设置中启用并配置 AI。');if(hasPrompt())await updatePreview();}}catch(error){if(!disposed&&sequence===loadSeq){configurationLoading=false;ready=false;status.textContent=T(error.message);controls();}}
  }
  const controller={book,channel,visible:()=>active&&!panel.hidden,
    open(initialAction){window.WriterWorkPlan?.close();saved.open=true;active=true;panel.hidden=false;if(typeof toggleNotes==='function')toggleNotes(false);persist();resumeCandidates();if(initialAction)chooseTask(initialAction);else if(ready&&hasPrompt())updatePreview();if(!ready)load();controls();input.focus();},
    close(){saved.open=false;active=false;panel.hidden=true;window.WriterChatImages?.closeViewers();persist();},
    suspend(){cancelPending();persist();active=false;panel.hidden=true;window.WriterChatImages?.closeViewers();},
    dispose(){cancelPending();persist();disposed=true;active=false;++previewSeq;++loadSeq;clearTimeout(previewDelay);clearTimeout(writeDelay);candidates.forEach(renderer=>renderer.dispose());candidates.clear();deferredCandidates.clear();clearImageViews();imageInput?.dispose();promptSize?.dispose();},
    reload:load,
    resumeCandidates,
    flush:persist,
    sync(){const wasActive=active;active=saved.open;panel.hidden=!active;const changed=updateScope();if((changed||!wasActive)&&!pending){renderChoices();persist();if(active&&typeof toggleNotes==='function')toggleNotes(false);if(ready&&active&&hasPrompt())updatePreview();}resumeCandidates();controls();}
  };
  updateScope();saved.turns.forEach(appendTurn);renderChoices();active=saved.open;panel.hidden=!active;if(active&&typeof toggleNotes==='function')toggleNotes(false);resumeCandidates();load();return controller;
}
