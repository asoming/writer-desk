'use strict';

const writingSkillDefinitions=[
  {id:'chinese-novelist',name:'中文小说创作',description:'分章创作、悬念与自然叙事。'},
  {id:'novelskill',name:'小说项目管理',description:'人物、分层大纲、伏笔与状态追踪。'},
  {id:'human-writing',name:'自然中文表达',description:'润色文字、对白与叙事节奏。'}
];
const writingSkillModes={auto:'自动匹配',chapter:'章节创作',continue:'续写',polish:'润色',outline:'大纲规划',characters:'人物塑造',check:'一致性检查'};
const writingSkillCatalog=new Map(writingSkillDefinitions.map(skill=>[skill.id,skill]));
function writingSkillName(id){const skill=writingSkillCatalog.get(id);return skill?.builtin===false?skill.name:T(skill?.name||id);}
function writingSkillList(value){
  const seen=new Set(),skills=[];
  for(const item of Array.isArray(value?.skills)?value.skills:[]){
    if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))continue;
    const fallback=writingSkillDefinitions.find(skill=>skill.id===item.id),skill={...item,name:typeof item.name==='string'&&item.name&&item.name!==item.id?item.name:fallback?.name||item.id,description:typeof item.description==='string'?item.description:fallback?.description||'',imported:item.usable===true||item.imported===true};
    seen.add(skill.id);skills.push(skill);writingSkillCatalog.set(skill.id,skill);
  }
  return skills;
}
function writingSkillOriginName(skill){return T(!(skill.usable===true||skill.imported===true)?'未导入':skill.origin==='builtin'?'内置':skill.builtin===false?'自定义':skill.origin==='local'?'本机副本':'已导入');}
function writingSkillModeName(mode,book=state.book){return book?.kind==='short'&&mode==='chapter'?T('正文创作'):T(writingSkillModes[mode]||(mode==='custom'?'自定义':mode));}
function writingSkillModeSelect(id){const select=el('select','text-field');select.id=id;Object.keys(writingSkillModes).forEach(value=>{const option=el('option',null,writingSkillModeName(value));option.value=value;select.append(option);});select.value='auto';return select;}

let aiModelCatalog=null,aiModelChangePending=null;
function aiValidateModels(value){
  if(!Array.isArray(value?.models)||value.models.length>10000||value.models.some(item=>!item||typeof item.id!=='string'||!item.id.trim()||item.id.length>200||/[\x00-\x1f\x7f]/.test(item.id)))throw Error(T('无法读取模型列表，可手动填写模型名称。'));
  return [...new Set(value.models.map(item=>item.id))];
}
function aiReadModels(settings,refresh=false){
  const signature=JSON.stringify([settings.activeProfileId,settings.endpoint,settings.hasKey]);
  if(!refresh&&aiModelCatalog?.signature===signature&&Date.now()-aiModelCatalog.time<300000)return aiModelCatalog.promise;
  const promise=(settings.activeProfileId?api('/api/ai/models','POST',{profileId:settings.activeProfileId}):api('/api/ai/models')).then(aiValidateModels);aiModelCatalog={signature,time:Date.now(),promise};return promise;
}
function aiMutateSettings(path,method,data){
  const previous=aiModelChangePending;
  const request=(previous?previous.catch(()=>{}):Promise.resolve()).then(()=>api(path,method,data));aiModelChangePending=request;
  return request.finally(()=>{if(aiModelChangePending===request)aiModelChangePending=null;});
}
function aiSaveModelChoice(model,profileId){return aiMutateSettings('/api/ai/settings','PUT',{model,...(profileId?{profileId}:{})});}
function aiSaveProfileChoice(profileId){return aiMutateSettings('/api/ai/settings','PUT',{profileId});}

function aiDefaultPrompt(action,book=state.book){
  if(action==='memory')return T('请仅根据所选正文整理可维护的章节记忆。每章简洁概括已发生事件、人物目标与行动、转折和未解决的问题，另列人物最新位置、已知信息、伤势与关系变化，以及明确的世界规则。区分事实、猜测和传闻，不凭常识补全缺失信息，不把大纲中尚未发生的情节写成既成事实。只返回候选摘要，确认后才保存；不改写正文。');
  if(book?.kind==='short'){
    const prompts={
      relationships:T('请仅根据整篇正文提取人物与关系。优先使用已登记姓名，区分真名、别名和称呼。每个人物与关系都给出可逐字核对的原文证据；共同提及不等于确认关系。不要根据常识补全亲属、阵营或感情，不确定的内容请略去。'),
      draft:T('请依据大纲、人物设定和已有正文，起草或续写这篇短篇小说。全文为一篇连续正文，不分卷、不分章、不添加章节标题。围绕核心冲突推进人物行动，保持视角、人物对白与叙事节奏。按我本次要求提供可追加或替换的候选正文，不重复已有内容，不自动修改作品。'),
      consistency:T('请检查整篇正文与大纲、人物设定是否一致，核对时间、身份、称呼、动机、已知信息、世界规则与伏笔。区分明确矛盾与资料不足，引用可逐字核对的正文证据。不要把隐瞒、回忆或尚未揭晓的信息直接判为错误，也不要修改正文。'),
      outline:T('请根据书名、我的构思和已有策划，生成可追加的短篇候选大纲。先明确主线、核心冲突、主角目标与结局，再安排开端、发展、转折、高潮与收束，写清人物变化及伏笔回收。按总纲与情节 / 设定组织，不分卷、不分章。已有内容保持原意，不覆盖既有策划。只规划这一个完整故事，不生成正文。')
    };
    if(Object.hasOwn(prompts,action))return prompts[action];
  }
  const prompts={
    relationships:T('请仅根据所选正文提取人物与关系。优先使用已登记姓名，区分真名、别名和称呼。每个人物与关系都给出可逐字核对的原文证据；同章提及不等于确认关系。不要根据常识补全亲属、阵营或感情，不确定的内容请略去。保留人物动机与关系变化中有证据的具体细节。'),
    draft:T('请依据已有大纲、人物设定和所选正文，起草一个可继续修改的新章节。承接已发生的事件与人物已知信息，以人物目标、行动、阻力和代价推动场景，保持对白个性与叙事视角。避免重复讲述前文、堆砌解释或无依据改变设定。本次只写一章，结尾留下合乎情节的推进方向，不自动续写下一章。'),
    consistency:T('请检查所选正文与提供的大纲、人物设定是否一致，重点核对时间顺序、人物身份与称呼、行动动机、已知信息、世界规则和伏笔。区分明确矛盾与资料不足，逐项说明影响，并引用可逐字核对的章节证据。不要把故意隐瞒、回忆或尚未揭晓的信息直接判为错误，也不要修改正文。'),
    outline:T('请根据书名、我的构思和已有策划，生成一份可追加的分层候选大纲。先明确故事主线、核心冲突、主角目标与结局，再规划分卷和章纲，写清各阶段目标、转折、代价、人物变化及伏笔回收，并补充必要的世界设定。长篇按总纲→分卷→章纲组织。已有内容保持原意，新内容明确作为候选，不覆盖既有策划。资料较少时可提出一份具体的原创候选方案；本次给出规模适中的完整规划，不生成正文。'),
    custom:'',
    book_cover:T('请根据书名、故事构思、大纲、人物与所选正文，提出三到五个有辨识度、符合题材和情绪的候选书名，并写一段可编辑的封面图像提示词。书名简洁，避免套用已有知名作品名称。封面采用竖版构图，明确主体、场景、色调、光线与氛围，为书名留出清晰空间；图像本身不要生成文字、水印或标志。只返回候选书名与图像提示词，不生成图片，不修改作品。')
  };
  return Object.hasOwn(prompts,action)?prompts[action]:prompts.draft;
}

function aiEmptyDefaultPlanningVolume(book){
  // Only the complete, untouched createOutlineTemplate scaffold is reusable.
  // A manually edited plan (including deleted material) must retain append behavior.
  if(book.kind!=='long'||book.volumes.length!==1||book.chapters.length||book.notes.length||book.relations.length||book.atlasViews?.length||book.outline.length!==5)return null;
  const volume=book.volumes[0],[root,plan,...settings]=book.outline;
  if(Object.keys(volume).length!==4||!volume.id||volume.title!=='第一卷'||volume.summary!==''||volume.deletedAt!==null)return null;
  const expected=[
    [root,T('全书总纲'),'story','故事主线',null,null],
    [plan,volume.title,'volume','分卷剧情',root.id,volume.id],
    ...[[T('世界观与规则'),'世界设定'],[T('伏笔与回收'),'伏笔回收'],[T('连续性检查'),'连续性检查']].map(([title,category],index)=>[settings[index],title,'scene',category,null,null])
  ];
  if(new Set(book.outline.map(item=>item.id)).size!==5||expected.some(([item,title,kind,category,parentId,volumeId])=>Object.keys(item).length!==9||!item.id||item.title!==title||item.kind!==kind||item.category!==category||item.parentId!==parentId||item.volumeId!==volumeId||item.body!==''||item.deletedAt!==null||!Array.isArray(item.chapterIds)||item.chapterIds.length))return null;
  return plan;
}

function writingSkillIcon(label,icon,handler){
  const paths={add:'M12 5v14M5 12h14',edit:'m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5',view:'M12 4C6 4 2 12 2 12s4 8 10 8 10-8 10-8-4-8-10-8Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',upload:'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',remove:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',reset:'M3 11a9 9 0 1 1 2 7M3 4v7h7',close:'m6 6 12 12M18 6 6 18',spark:'m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z',save:'M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-8h10v8'};
  const button=action('','skill-icon-button',handler),svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');
  button.title=T(label);button.setAttribute('aria-label',T(label));svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',paths[icon]||paths.view);svg.append(path);button.append(svg);return button;
}
function writingSkillsChanged(){if(typeof refreshAIChatSettings==='function')Promise.resolve(refreshAIChatSettings()).catch(()=>{});}
function writingSkillDraft(value){
  return{name:typeof value?.name==='string'?value.name:'',description:typeof value?.description==='string'?value.description:'',content:typeof value?.content==='string'?value.content:'',files:Array.isArray(value?.files)?value.files.filter(file=>file&&typeof file.path==='string'&&typeof file.content==='string'&&file.path!=='SKILL.md').map(file=>({path:file.path,content:file.content})):[]};
}
let writingSkillViewer=null;
function closeWritingSkillViewer(options){writingSkillViewer?.close(options);}
function openWritingSkillViewer(value={},options={}){
  closeWritingSkillViewer({restoreFocus:false});
  const opener=options.opener||document.activeElement,dialog=el('dialog','writing-skill-view-dialog'),header=el('header','writing-skill-view-header'),headingGroup=el('div','writing-skill-view-heading'),heading=el('h2',null,(value.id?writingSkillName(value.id):value.name)||T('写作 Skill')),description=el('p','writing-skill-view-description'),origin=el('span','writing-skill-view-origin'),body=el('div','writing-skill-view-body'),navigation=el('nav','writing-skill-view-files'),documentView=el('section','writing-skill-view-document'),filename=el('h3','writing-skill-view-path'),rules=el('pre','writing-skill-view-content'),status=el('p','writing-skill-view-status',T('正在读取 Skill 内容…'));
  let closed=false,observer=null,files=[];
  const controller={dialog,close};writingSkillViewer=controller;dialog.id='writing-skill-view-dialog';dialog.setAttribute('aria-labelledby','writing-skill-view-title');dialog.setAttribute('aria-busy','true');heading.id='writing-skill-view-title';documentView.id='writing-skill-view-document';navigation.setAttribute('aria-label',T('Skill 文件'));status.setAttribute('role','status');rules.tabIndex=0;description.textContent=value.description||'';description.hidden=!description.textContent;origin.textContent=writingSkillOriginName(value);headingGroup.append(heading,description,origin);
  const dismiss=writingSkillIcon('关闭','close',()=>close());dismiss.autofocus=true;header.append(headingGroup,dismiss);documentView.append(filename,rules);navigation.hidden=documentView.hidden=true;body.append(status,navigation,documentView);dialog.append(header,body);document.body.append(dialog);
  function otherModalOpen(){return Array.from(document.querySelectorAll?.('dialog[open]')||[]).some(other=>other!==dialog&&other!==options.host);}
  function current(){return !closed&&dialog.open&&dialog.isConnected!==false&&writingSkillViewer===controller&&(!options.current||options.current())&&!otherModalOpen();}
  function close({restoreFocus=true}={}){
    if(closed)return;closed=true;observer?.disconnect();options.host?.removeEventListener?.('close',hostClosed);if(writingSkillViewer===controller)writingSkillViewer=null;dialog.close();dialog.remove();
    if(restoreFocus&&(!options.current||options.current())&&opener?.isConnected!==false)opener?.focus?.({preventScroll:true});
    if(typeof resumeAIChatCandidates==='function')resumeAIChatCandidates();
  }
  function hostClosed(){close({restoreFocus:false});}
  function selectFile(path){const file=files.find(entry=>entry.path===path);if(!file||!current())return;filename.textContent=file.path;rules.textContent=file.content;rules.scrollTop=0;documentView.scrollTop=0;for(const button of navigation.children)button.setAttribute('aria-current',String(button.dataset.skillFile===path));}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',()=>close());options.host?.addEventListener('close',hostClosed);dialog.showModal();dismiss.focus();
  if(typeof MutationObserver==='function'){observer=new MutationObserver(()=>{if(!current())close({restoreFocus:false});});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden']});}
  dialog.loaded=(async()=>{
    try{
      const detail=options.load?await options.load():value;if(!current()){close({restoreFocus:false});return;}
      if(typeof detail?.content!=='string')throw Error(T('无法读取 Skill。'));
      const metadata={...value,...detail},title=detail.name&&detail.name!==detail.id?detail.name:writingSkillCatalog.get(value.id)?.name||value.name||detail.name||'写作 Skill';heading.textContent=metadata.builtin===false?title:T(title);description.textContent=detail.description||'';description.hidden=!description.textContent;origin.textContent=writingSkillOriginName(metadata);
      const seen=new Set();files=[{path:'SKILL.md',content:detail.content},...(Array.isArray(detail.files)?detail.files:[])].filter(file=>{if(!file||typeof file.path!=='string'||typeof file.content!=='string'||seen.has(file.path))return false;seen.add(file.path);return true;});
      for(const file of files){const button=action(file.path,'writing-skill-view-file',()=>selectFile(file.path));button.dataset.skillFile=file.path;button.setAttribute('aria-controls',documentView.id);navigation.append(button);}status.hidden=true;navigation.hidden=files.length<2;documentView.hidden=false;selectFile('SKILL.md');
    }catch(error){if(current()){status.textContent=T(error.message||'无法读取 Skill。');status.setAttribute('role','alert');}else close({restoreFocus:false});}
    finally{if(!closed)dialog.setAttribute('aria-busy','false');}
  })();return dialog;
}
function openWritingSkillEditor(value={},options={}){
  closeWritingSkillViewer({restoreFocus:false});
  const draft=writingSkillDraft(value),existing=options.skill||null,dialog=el('dialog','writing-skill-editor'),header=el('header','writing-skill-editor-header'),body=el('div','writing-skill-editor-body'),footer=el('footer','writing-skill-editor-footer'),status=el('p','writing-skill-editor-status');
  dialog.id='writing-skill-editor';dialog.setAttribute('aria-labelledby','writing-skill-editor-title');const heading=el('h2',null,T(existing?'编辑 Skill':'新增 Skill'));heading.id='writing-skill-editor-title';header.append(heading,writingSkillIcon('关闭','close',close));status.setAttribute('role','status');
  const name=el('input','text-field'),description=el('input','text-field'),rules=el('textarea','text-field');name.id='writing-skill-name';name.maxLength=200;name.value=draft.name;description.id='writing-skill-description';description.maxLength=2000;description.value=draft.description;rules.id='writing-skill-content';rules.maxLength=262144;rules.value=draft.content;rules.spellcheck=false;rules.placeholder=T('写下 AI 应遵循的写作规则…');
  addField(body,T('名称'),name);addField(body,T('简介'),description);addField(body,T('写作规则'),rules);
  let files=draft.files,closed=false,saving=false,generating=false,sequence=0,promptSize=null;
  const references=el('details','writing-skill-references');function renderReferences(){references.replaceChildren(el('summary',null,T('参考文件 · {0}',files.length)));references.hidden=!files.length;for(const file of files){const entry=el('article','writing-skill-file');entry.append(el('h5',null,file.path),el('pre',null,file.content));references.append(entry);}}renderReferences();body.append(references);
  const generatePanel=el('section','writing-skill-generate'),prompt=el('textarea','text-field'),generate=action(T('生成草稿'),'secondary-button',generateDraft),generateToggle=writingSkillIcon('用 AI 创建 Skill','spark',()=>{generatePanel.hidden=!generatePanel.hidden;if(!generatePanel.hidden){promptSize?.refresh();prompt.focus();}});generatePanel.hidden=true;prompt.id='writing-skill-generate-prompt';prompt.maxLength=8000;prompt.placeholder=T('描述你想要的写作方法或规则…');prompt.setAttribute('aria-label',T('Skill 创建提示词'));generate.id='writing-skill-generate-send';generatePanel.append(prompt,generate);body.prepend(generatePanel);footer.append(generateToggle,status,action(T('取消'),'secondary-button',close));
  const save=action(T(existing?'保存修改':'保存 Skill'),'primary-button',persist);save.id='writing-skill-save';footer.append(save);dialog.append(header,body,footer);document.body.append(dialog);
  function controls(){for(const field of [name,description,rules,prompt,generate,generateToggle,save])field.disabled=saving||generating;save.disabled=saving||generating||!name.value.trim()||!rules.value.trim();generate.disabled=saving||generating||!prompt.value.trim();dialog.setAttribute('aria-busy',String(saving||generating));}
  for(const field of [name,rules,prompt])field.addEventListener('input',controls);
  function close(){if(closed||saving)return;closed=true;++sequence;promptSize?.dispose();dialog.close();dialog.remove();options.onClose?.();if(typeof resumeAIChatCandidates==='function')resumeAIChatCandidates();}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  async function persist(){
    if(closed||saving||generating||save.disabled)return;saving=true;controls();status.textContent='';const payload={name:name.value.trim(),description:description.value.trim(),content:rules.value,files,...(existing?.revision?{revision:existing.revision}:{})};
    try{const result=await api(existing?'/api/skills/'+encodeURIComponent(existing.id):'/api/skills/custom',existing?'PUT':'POST',payload);if(closed)return;writingSkillList(result);writingSkillsChanged();options.onSaved?.(result);saving=false;close();toast(T('Skill 已保存。'));}catch(error){if(!closed)status.textContent=T(error.message);}finally{saving=false;if(!closed)controls();}
  }
  async function generateDraft(){
    if(closed||saving||generating||!prompt.value.trim())return;generating=true;const active=++sequence;controls();status.textContent=T('正在生成…');
    try{if(aiModelChangePending)await aiModelChangePending.catch(()=>{});if(closed||active!==sequence)return;const settings=await api('/api/ai/settings');if(closed||active!==sequence)return;const result=await api('/api/skills/generate','POST',{prompt:prompt.value,...(settings.model?{model:settings.model}:{}),...(settings.activeProfileId?{profileId:settings.activeProfileId}:{})});if(closed||active!==sequence)return;const next=writingSkillDraft(result.draft||result);if(!next.name.trim()||!next.content.trim())throw Error(T('生成的 Skill 内容不完整，请重试。'));name.value=next.name;description.value=next.description;rules.value=next.content;files=next.files;renderReferences();status.textContent=T('草稿已生成，确认后保存。');}catch(error){if(!closed&&active===sequence)status.textContent=T(error.message);}finally{if(!closed&&active===sequence){generating=false;controls();}}
  }
  controls();dialog.showModal();promptSize=window.WriterTextareaAutosize?.attach(prompt,{container:dialog});(name.value?rules:name).focus();return dialog;
}
function confirmWritingSkillChange(skill,perform){
  closeWritingSkillViewer({restoreFocus:false});
  const reset=skill.builtin===true,dialog=el('dialog','writing-skill-confirm'),heading=el('h2',null,T(reset?'恢复内置 Skill？':'删除 Skill？')),buttons=el('div','dialog-actions'),status=el('p','subtle');let pending=false;
  dialog.id='writing-skill-confirm';dialog.setAttribute('aria-labelledby','writing-skill-confirm-title');heading.id='writing-skill-confirm-title';dialog.append(heading,el('p','subtle',T(reset?'本机修改将被移除，恢复软件内置规则。':'此 Skill 将从本机和默认选择中移除。')),status,buttons);const cancel=action(T('取消'),'secondary-button',close),confirm=action(T(reset?'恢复':'删除'),'primary-button',async()=>{if(pending)return;pending=true;cancel.disabled=confirm.disabled=true;try{await perform();pending=false;close();}catch(error){status.textContent=T(error.message);}finally{pending=false;cancel.disabled=confirm.disabled=false;}});buttons.append(cancel,confirm);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});function close(){if(pending)return;dialog.close();dialog.remove();}document.body.append(dialog);dialog.showModal();return dialog;
}
function appendWritingSkillSettings(content){
  const section=el('details','ai-settings writing-skill-settings'),body=el('div','ai-settings-body'),status=el('p','subtle writing-skill-status'),list=el('div','writing-skill-list'),mode=writingSkillModeSelect('writing-skill-default-mode'),toolbar=el('div','writing-skill-toolbar');
  section.append(el('summary',null,T('写作 Skill')),body);content.append(section);status.setAttribute('role','status');body.append(toolbar,status,list);addField(body,T('默认写作任务'),mode);
  let skills=[],selection=new Set(),pending=false,ready=false,detailSeq=0,listSeq=0;
  const current=()=>content.contains(section),fileInput=el('input');fileInput.type='file';fileInput.accept='.md,.json';fileInput.hidden=true;fileInput.id='writing-skill-import-file';
  const add=writingSkillIcon('新增 Skill','add',()=>openEditor({})),importFile=writingSkillIcon('导入 Skill 文件','upload',()=>fileInput.click()),refresh=writingSkillIcon('刷新 Skill','reset',load),save=writingSkillIcon('保存默认选择','save',persist);add.id='writing-skill-add';importFile.id='writing-skill-import';save.id='writing-skill-save-defaults';toolbar.append(el('span','writing-skill-toolbar-label',T('写作规则')),add,importFile,refresh,save,fileInput);
  const local=el('details','writing-skill-local-import'),localBody=el('div','writing-skill-local-import-body'),importLocal=action(T('导入本机写作 Skill'),'text-button',importSkills);local.append(el('summary',null,T('本机 Codex Skill')),localBody);localBody.append(importLocal);body.append(local);fileInput.addEventListener('change',importSelectedFile);
  function controls(){mode.disabled=pending||!ready;save.disabled=pending||!ready;refresh.disabled=importLocal.disabled=add.disabled=importFile.disabled=pending;}
  function fill(value){if(!current())return;skills=writingSkillList(value);selection=new Set((value.defaults?.skillIds||[]).filter(id=>skills.some(skill=>skill.id===id&&skill.imported)));mode.value=Object.hasOwn(writingSkillModes,value.defaults?.skillMode)?value.defaults.skillMode:'auto';ready=true;render();}
  function editorAllowed(){const host=content.closest?.('#settings-dialog'),page=content.closest?.('[data-settings-page]');return current()&&(!host||host.open)&&(!page||!page.hidden)&&!document.body.querySelector('.writing-skill-editor[open],.writing-skill-confirm[open]');}
  function openEditor(draft,skill=null){if(!editorAllowed())return;++detailSeq;openWritingSkillEditor(draft,{...(skill?{skill}:{}),onSaved:acceptSaved});}
  function acceptSaved(value){++listSeq;++detailSeq;fill(value);status.textContent='';}
  function render(){
    list.replaceChildren();for(const skill of skills){
      const row=el('div','writing-skill-row'),label=el('label','checkbox-row'),box=el('input'),copy=el('span','writing-skill-copy'),tools=el('div','writing-skill-row-tools');row.dataset.skillId=skill.id;box.type='checkbox';box.id='writing-skill-default-'+skill.id;box.checked=selection.has(skill.id);box.disabled=pending||!skill.imported;box.addEventListener('change',()=>{if(pending)return;box.checked?selection.add(skill.id):selection.delete(skill.id);});
      const name=el('strong',null,writingSkillName(skill.id)),origin=el('small','writing-skill-state',writingSkillOriginName(skill));copy.append(name,origin);if(skill.description){const description=el('small','writing-skill-description',skill.description);description.title=skill.description;copy.append(description);}label.append(box,copy);
      for(const [text,icon,callback]of [['查看 Skill','view',event=>showDetail(skill,false,event?.currentTarget)],['编辑 Skill','edit',()=>showDetail(skill,true)],['导出 Skill','download',()=>exportSkill(skill)]]){const button=writingSkillIcon(text,icon,callback);button.disabled=pending||!skill.imported;tools.append(button);}
      if(skill.builtin!==true||skill.origin!=='builtin'){const remove=writingSkillIcon(skill.builtin?'恢复内置 Skill':'删除 Skill',skill.builtin?'reset':'remove',()=>confirmWritingSkillChange(skill,()=>removeSkill(skill)));remove.disabled=pending;tools.append(remove);}row.append(label,tools);list.append(row);
    }controls();
  }
  async function showDetail(skill,edit,opener){
    if(pending||!editorAllowed())return;
    if(!edit){
      ++detailSeq;const host=content.closest?.('#settings-dialog'),viewer=openWritingSkillViewer(skill,{opener,host,current:()=>{const page=content.closest?.('[data-settings-page]');return current()&&(!host||host.open)&&(!page||!page.hidden);},load:()=>api('/api/skills/'+encodeURIComponent(skill.id))});return viewer.loaded;
    }
    closeWritingSkillViewer({restoreFocus:false});const sequence=++detailSeq;
    try{const detail=await api('/api/skills/'+encodeURIComponent(skill.id));if(sequence!==detailSeq||!current())return;openEditor(detail,{...skill,...detail});}
    catch(error){if(sequence===detailSeq&&current())status.textContent=T(error.message);}
  }
  async function exportSkill(skill){if(pending)return;pending=true;render();try{const value=await api('/api/skills/'+encodeURIComponent(skill.id)+'/export');if(!current())return;const filename=(skill.name||skill.id).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)+'.writer-skill.json';download(filename,JSON.stringify(value,null,2)+'\n','application/json;charset=utf-8');status.textContent='';}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())render();}}
  async function removeSkill(skill){pending=true;++detailSeq;closeWritingSkillViewer({restoreFocus:false});render();try{const value=await api('/api/skills/'+encodeURIComponent(skill.id),'DELETE',skill.revision?{revision:skill.revision}:{});if(current()){fill(value);status.textContent='';}writingSkillsChanged();}finally{pending=false;if(current())render();}}
  async function importSelectedFile(){const file=fileInput.files?.[0];fileInput.value='';if(!file||pending)return;pending=true;controls();status.textContent='';try{if(file.size>8*1024*1024)throw Error(T('Skill 文件过大。'));const value=await api('/api/skills/import-file','POST',{fileName:file.name,content:await file.text(),preview:true});if(!current())return;if(!value.draft)throw Error(T('无法读取 Skill 文件。'));openEditor(value.draft);}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())controls();}}
  async function load(){if(pending)return;pending=true;const sequence=++listSeq;controls();status.textContent=T('正在读取写作 Skill…');try{const value=await api('/api/skills');if(sequence===listSeq&&current()){fill(value);status.textContent='';}}catch(error){if(sequence===listSeq&&current())status.textContent=T(error.message);}finally{pending=false;if(current())render();}}
  async function importSkills(){if(pending)return;pending=true;++listSeq;++detailSeq;closeWritingSkillViewer({restoreFocus:false});render();status.textContent=T('正在导入本机写作 Skill…');try{const fresh=await api('/api/skills');if(!current())return;const ids=writingSkillList(fresh).filter(skill=>skill.available).map(skill=>skill.id),value=ids.length?await api('/api/skills/import','POST',{skillIds:ids}):fresh;if(!current())return;fill(value);status.textContent=ids.length?T('本机写作 Skill 已导入。原文件未修改。'):T('未找到可导入的本机写作 Skill。内置 Skill 仍可使用。');writingSkillsChanged();}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())render();}}
  async function persist(){if(pending||!ready)return;pending=true;++listSeq;render();try{const value=await api('/api/skills/settings','PUT',{skillIds:skills.filter(skill=>selection.has(skill.id)&&skill.imported).map(skill=>skill.id),skillMode:mode.value});if(!current())return;fill(value);status.textContent=T('默认选择已保存。');writingSkillsChanged();}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())render();}}
  // An explicit refresh/import may supersede the initial scan.
  controls();const initialSeq=++listSeq;api('/api/skills').then(value=>{if(initialSeq===listSeq&&current()){fill(value);status.textContent='';}}).catch(error=>{if(initialSeq===listSeq&&current())status.textContent=T(error.message);});return section;
}

function appendAISettings(content){
  const section=el('details','ai-settings'),summary=el('summary',null,T('AI 辅助')),body=el('div','ai-settings-body');section.append(summary,body);content.append(section);
  const status=el('p','subtle',T('正在读取 AI 设置…')),enabled=el('input'),endpoint=el('input','text-field'),model=el('input','text-field'),imageModel=el('input','text-field'),key=el('input','text-field'),clear=el('input'),manual=el('input'),limit=el('input','text-field'),timeout=el('input','text-field');
  enabled.type='checkbox';enabled.id='ai-enabled';endpoint.type='url';endpoint.id='ai-endpoint';endpoint.placeholder='https://api.openai.com/v1';model.id='ai-model';model.placeholder=T('填写服务支持的模型名称');key.type='password';key.id='ai-api-key';key.autocomplete='new-password';clear.type='checkbox';clear.id='ai-clear-key';manual.type='checkbox';manual.id='ai-context-manual';limit.type='number';limit.id='ai-context-limit';limit.min='1';limit.max='26214400';limit.step='1';timeout.type='number';timeout.id='ai-timeout';timeout.min='1';timeout.max='180';
  const enableRow=el('label','checkbox-row');enableRow.append(enabled,el('span',null,T('启用 AI 辅助')));body.append(status,enableRow);
  const profileChoice=el('select','text-field'),profileName=el('input','text-field'),profileTools=el('div','ai-profile-tools'),createProfile=action(T('新增服务'),'text-button',()=>profileOperation('create')),removeProfile=action(T('删除服务'),'text-button',()=>profileOperation('delete'));profileChoice.id='ai-profile-choice';profileName.id='ai-profile-name';profileName.maxLength=100;profileTools.append(createProfile,removeProfile);addField(body,T('服务配置'),profileChoice);addField(body,T('服务名称'),profileName);body.append(profileTools);
  const pricing=el('details','ai-advanced'),priceBody=el('div','ai-price-fields'),priceInputs={};pricing.append(el('summary',null,T('费用单价')),priceBody);for(const [name,text]of [['input','输入 / 百万 Token'],['output','输出 / 百万 Token'],['cachedInput','缓存输入 / 百万 Token']]){const input=el('input','text-field');input.id='ai-price-'+name;input.type='number';input.min='0';input.max='1000000';input.step='any';input.placeholder=T('未知');priceInputs[name]=input;addField(priceBody,T(text),input);}const currency=el('input','text-field');currency.id='ai-price-currency';currency.maxLength=3;currency.placeholder='USD';addField(priceBody,T('币种'),currency);priceBody.append(el('p','subtle',T('按服务返回的 Token 与此处单价计算。留空时费用不可用。')));body.append(pricing,action(T('AI 用量记录'),'text-button',()=>showAIUsage(state.book)));

  imageModel.id='ai-image-model';imageModel.maxLength=200;imageModel.placeholder=T('选填，填写服务支持的图像模型');
  const modelGroup=el('div','ai-model-settings'),modelChoice=el('select','text-field'),modelStatus=el('span','ai-model-status'),modelTools=el('div','ai-model-tools'),refreshModels=action(T('刷新模型'),'text-button',()=>loadModels(true,true));modelChoice.id='ai-model-choice';modelChoice.setAttribute('aria-label',T('模型'));modelTools.append(refreshModels,modelStatus);modelGroup.append(modelChoice,model,modelTools);
  [[T('服务地址'),endpoint],[T('模型'),modelGroup],[T('图像模型'),imageModel],[T('API Key（本机服务可留空）'),key]].forEach(([label,input])=>addField(body,label,input));
  const requestUsage=el('input');requestUsage.type='checkbox';requestUsage.id='ai-stream-usage';const requestUsageRow=el('label','checkbox-row');requestUsageRow.append(requestUsage,el('span',null,T('请求流式 Token 用量')));pricing.append(requestUsageRow,el('p','subtle',T('服务须支持 stream_options；不支持时保持关闭。')));
  const advanced=el('details','ai-advanced'),advancedBody=el('div','ai-advanced-body'),manualRow=el('label','checkbox-row'),limitField=el('div'),clearRow=el('label','checkbox-row');advanced.append(el('summary',null,T('高级')),advancedBody);manualRow.append(manual,el('span',null,T('手动限制资料字符数')));addField(limitField,T('字符上限'),limit);clearRow.append(clear,el('span',null,T('清除已保存密钥')));advancedBody.append(manualRow,limitField);addField(advancedBody,T('请求超时（秒）'),timeout);advancedBody.append(clearRow);body.append(advanced);
  const buttons=el('div','dialog-actions'),save=action(T('保存 AI 设置'),'primary-button',persist),test=action(T('测试连接'),'secondary-button',testConnection);buttons.append(test,save);body.append(buttons);let pending=false,ready=false,modelLoading=false,modelSeq=0,modelDelay=null,modelIds=[],manualModel=true,settingsSnapshot=null;
  const current=()=>content.contains(section);
  function controls(){[enabled,endpoint,model,imageModel,key,clear,manual,timeout,save,test,modelChoice,profileChoice,profileName,createProfile,removeProfile,currency,requestUsage,...Object.values(priceInputs)].forEach(input=>input.disabled=pending||!ready);refreshModels.disabled=pending||!ready||modelLoading||!endpoint.value.trim();limit.disabled=pending||!ready||!manual.checked;limitField.hidden=!manual.checked;model.hidden=!manualModel;}
  manual.addEventListener('change',controls);
  function renderModels(){modelChoice.replaceChildren();if(!model.value&&modelIds.length){const placeholder=el('option',null,T('选择模型'));placeholder.value='';modelChoice.append(placeholder);}modelIds.forEach(id=>{const option=el('option',null,id);option.value=id;modelChoice.append(option);});const custom=el('option',null,T('自定义模型'));custom.value='';modelChoice.append(custom);manualModel=model.value?!modelIds.includes(model.value):!modelIds.length;modelChoice.value=modelIds.includes(model.value)?model.value:'';controls();}
  function fill(settings){settingsSnapshot=settings;profileChoice.replaceChildren();for(const profile of settings.profiles||[{id:'default',name:'默认服务'}]){const option=el('option',null,T(profile.name));option.value=profile.id;profileChoice.append(option);}profileChoice.value=settings.activeProfileId||'default';profileName.value=settings.name||'默认服务';for(const [name,input]of Object.entries(priceInputs))input.value=settings.pricing?.[name]===null||settings.pricing?.[name]===undefined?'':String(settings.pricing[name]);currency.value=settings.pricing?.currency||'USD';requestUsage.checked=!!settings.requestStreamUsage;removeProfile.textContent=T('删除服务');enabled.checked=settings.enabled;endpoint.value=settings.endpoint;model.value=settings.model;imageModel.value=settings.imageModel||'';manual.checked=settings.contextMode==='manual';limit.value=settings.maxContextChars;timeout.value=settings.timeoutSeconds;key.value='';clear.checked=false;key.placeholder=settings.hasKey?T('已保存；留空保留原密钥'):T('未保存密钥');status.textContent='';ready=true;renderModels();}
  async function loadModels(refresh=false,draft=false){
    clearTimeout(modelDelay);const sequence=++modelSeq;if(!ready||!endpoint.value.trim()){modelIds=[];modelStatus.textContent='';renderModels();return;}
    modelLoading=true;modelStatus.textContent=T('正在读取模型…');controls();
    try{const ids=draft?aiValidateModels(await api('/api/ai/models','POST',{endpoint:endpoint.value,apiKey:key.value,clearKey:clear.checked,timeoutSeconds:Number(timeout.value),...(settingsSnapshot?.activeProfileId?{profileId:settingsSnapshot.activeProfileId}:{})})):await aiReadModels(settingsSnapshot,refresh);if(sequence!==modelSeq||!current())return;modelIds=ids;modelStatus.textContent=ids.length?'':T('暂无可用模型，可手动填写。');renderModels();}
    catch(error){if(sequence===modelSeq&&current()){modelIds=[];modelStatus.textContent=T(error.message);renderModels();}}
    finally{if(sequence===modelSeq&&current()){modelLoading=false;controls();}}
  }
  function changedService(){++modelSeq;clearTimeout(modelDelay);modelLoading=false;modelIds=[];modelStatus.textContent='';renderModels();if(endpoint.value.trim())modelDelay=setTimeout(()=>loadModels(true,true),350);}
  [endpoint,key,clear].forEach(input=>input.addEventListener('change',changedService));
  modelChoice.addEventListener('change',()=>{if(pending)return;manualModel=!modelChoice.value;if(!manualModel)model.value=modelChoice.value;controls();if(manualModel)model.focus();});
  function payload(){return{...(settingsSnapshot?.activeProfileId?{requestStreamUsage:requestUsage.checked}:{}),...(settingsSnapshot?.activeProfileId?{profileId:settingsSnapshot.activeProfileId,name:profileName.value,pricing:{currency:currency.value,...Object.fromEntries(Object.entries(priceInputs).map(([name,input])=>[name,input.value.trim()===''?null:Number(input.value)]))}}:{}),enabled:enabled.checked,endpoint:endpoint.value,model:model.value,imageModel:imageModel.value,apiKey:key.value,clearKey:clear.checked,contextMode:manual.checked?'manual':'auto',...(manual.checked?{maxContextChars:Number(limit.value)}:{}),timeoutSeconds:Number(timeout.value)};}
  async function persist(){if(pending||!ready)return false;pending=true;++modelSeq;clearTimeout(modelDelay);modelLoading=false;controls();try{const settings=await aiMutateSettings('/api/ai/settings','PUT',payload());if(!current())return false;fill(settings);aiModelCatalog=null;await loadModels(true);if(current())toast(T('AI 设置已保存。'));return true;}catch(error){status.textContent=T(error.message);return false;}finally{pending=false;controls();}}
  async function profileOperation(kind){
    if(pending||!ready||!current())return;
    if(kind==='delete'&&removeProfile.textContent!==T('确认删除服务')){removeProfile.textContent=T('确认删除服务');return;}
    if(kind!=='delete'&&!await persist())return;
    pending=true;++modelSeq;clearTimeout(modelDelay);controls();
    try{const settings=kind==='create'?await aiMutateSettings('/api/ai/profiles','POST',{name:T('新服务')}):await aiMutateSettings('/api/ai/profiles/'+encodeURIComponent(settingsSnapshot.activeProfileId),'DELETE',{});if(!current())return;modelIds=[];fill(settings);aiModelCatalog=null;await loadModels(true);}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())controls();}
  }
  profileChoice.addEventListener('change',async()=>{const selected=profileChoice.value;if(pending||!ready){profileChoice.value=settingsSnapshot?.activeProfileId||'default';return;}if(selected===settingsSnapshot.activeProfileId)return;if(!await persist())return;pending=true;++modelSeq;controls();try{const settings=await aiSaveProfileChoice(selected);if(!current())return;modelIds=[];fill(settings);aiModelCatalog=null;await loadModels(true);}catch(error){if(current()){profileChoice.value=settingsSnapshot.activeProfileId;status.textContent=T(error.message);}}finally{pending=false;if(current())controls();}});
  async function testConnection(){if(!await persist())return;pending=true;controls();status.textContent=T('正在测试连接…');try{await api('/api/ai/test','POST',{});status.textContent=T('连接成功。测试未发送作品内容。');}catch(error){status.textContent=T(error.message);}finally{pending=false;controls();}}
  controls();(async()=>{if(aiModelChangePending)await aiModelChangePending.catch(()=>{});return api('/api/ai/settings');})().then(settings=>{if(current()){fill(settings);loadModels();}}).catch(error=>{status.textContent=T(error.message);});
  return section;
}

async function showAIAssistant(initialAction='draft'){
  if(!state.book){toast(T('请先打开作品。'));return;}
  if(state.composing||state.transitioning||$('dialog').open||$('settings-dialog')?.open)return;
  if(!await requireSaved())return;
  const book=state.book,bookId=book.id,sourceOutline=state.view==='outline'?currentOutline():null,chapters=activeChapters(),content=el('div','ai-assistant'),form=el('div','ai-request-form'),result=el('div','ai-results'),status=el('p','ai-status'),scope=el('p','ai-scope'),mode=el('select','text-field'),instruction=el('textarea','text-field'),choices=el('div','ai-chapter-choices'),selected=new Set(sourceOutline?.chapterIds?.filter(id=>chapters.some(c=>c.id===id))||[]);
  if(!sourceOutline&&!selected.size&&chapters.some(c=>c.id===state.chapterId))selected.add(state.chapterId);if(!sourceOutline&&!selected.size&&chapters.length)selected.add(chapters[0].id);
  if(book.kind==='short'){selected.clear();chapters.forEach(chapter=>selected.add(chapter.id));}
  let settings=null,preview=null,previewKey='',previewSeq=0,pending=false,delay=null,skillReady=false,skills=[];
  const selectedSkills=new Set(),skillSection=el('details','ai-writing-skills'),skillSummary=el('summary'),skillBody=el('div','ai-writing-skill-body'),skillChoices=el('div','writing-skill-list'),skillMode=writingSkillModeSelect('ai-skill-mode'),skillScope=el('p','ai-scope'),skillFiles=el('div','ai-skill-files');skillSection.append(skillSummary,skillBody);skillBody.append(skillChoices);addField(skillBody,T('写作任务'),skillMode);
  const modes={relationships:T('提取人物与关系'),draft:T('生成写作草稿'),outline:T('生成大纲'),consistency:T('检查人物与剧情一致性'),custom:T('其他 / 自定义'),book_cover:T('生成封面与书名')};Object.entries(modes).forEach(([id,title])=>{const option=el('option',null,title);option.value=id;mode.append(option);});mode.value=Object.hasOwn(modes,initialAction)?initialAction:'draft';mode.id='ai-action';instruction.id='ai-instruction';instruction.rows=7;instruction.maxLength=10000;instruction.placeholder=T('可直接修改提示词，写明题材、风格、篇幅或具体问题。');
  const prompts=Object.fromEntries(Object.keys(modes).map(id=>[id,aiDefaultPrompt(id)]));let activeAction=mode.value;
  if(sourceOutline){const focus=T('依据当前大纲生成草稿：')+'\n'+sourceOutline.title+'\n'+sourceOutline.body;prompts.draft+='\n\n'+(prompts.draft.length+focus.length+2<=10000?focus:T('当前大纲：{0}',sourceOutline.title));}
  const defaultPrompts={...prompts};instruction.value=prompts[activeAction];addField(form,T('操作'),mode);addField(form,T('提示词'),instruction);
  const resetPrompt=action(T('恢复默认提示词'),'text-button',()=>{if(pending)return;prompts[activeAction]=defaultPrompts[activeAction];instruction.value=prompts[activeAction];result.replaceChildren();return updatePreview();});form.append(resetPrompt);
  const material=el('details','ai-material'),materialSummary=el('summary'),materialBody=el('div','ai-material-body'),choiceHeader=el('div','section-label'),all=action(T('全选'),'text-button',()=>{if(pending)return;chapters.forEach(c=>selected.add(c.id));renderChoices();updatePreview();}),clearChoices=action(T('清空'),'text-button',()=>{if(pending)return;selected.clear();renderChoices();updatePreview();});choiceHeader.append(all,clearChoices);material.append(materialSummary,materialBody);materialBody.append(choiceHeader,choices,scope,skillScope,skillFiles);form.append(material);
  function renderChoices(){materialSummary.textContent=selected.size?(book.kind==='short'?T('资料 · 正文'):T('资料 · {0} 章',selected.size)):T('资料');all.disabled=clearChoices.disabled=pending;choiceHeader.hidden=choices.hidden=book.kind==='short'||!chapters.length;choices.replaceChildren();if(book.kind==='short')return;chapters.forEach(chapter=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=selected.has(chapter.id);box.disabled=pending;box.addEventListener('change',()=>{if(pending)return;box.checked?selected.add(chapter.id):selected.delete(chapter.id);materialSummary.textContent=selected.size?T('资料 · {0} 章',selected.size):T('资料');updatePreview();});row.append(box,el('span',null,chapter.title||T('未命名章节')));choices.append(row);});}
  function renderSkillChoices(){skillSummary.textContent=selectedSkills.size?T('写作 Skill · {0}',selectedSkills.size):T('写作 Skill');skillChoices.replaceChildren();skills.forEach(skill=>{const label=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.id='ai-skill-'+skill.id;box.checked=selectedSkills.has(skill.id);box.disabled=pending||!skill.imported;box.addEventListener('change',()=>{if(pending)return;box.checked?selectedSkills.add(skill.id):selectedSkills.delete(skill.id);skillSummary.textContent=selectedSkills.size?T('写作 Skill · {0}',selectedSkills.size):T('写作 Skill');updatePreview();});label.append(box,el('span',null,writingSkillName(skill.id)),el('small',null,writingSkillOriginName(skill)));skillChoices.append(label);});skillMode.disabled=pending||!skillReady;}
  const send=action(T('发送所选资料'),'primary-button',run),configure=action(T('打开 AI 设置'),'secondary-button',()=>{closeDialog();showAppSettings();}),buttons=el('div','dialog-actions');send.disabled=true;buttons.append(configure,send);form.append(skillSection,status,buttons);content.append(form,result);showDialog(T('AI 辅助'),content);renderChoices();renderSkillChoices();
  const current=()=>state.book===book&&state.book?.id===bookId&&$('dialog').open&&$('dialog-body').contains(content);
  function request(){return{...(settings?.activeProfileId?{profileId:settings.activeProfileId}:{}),action:mode.value,chapterIds:chapters.filter(c=>selected.has(c.id)).map(c=>c.id),instruction:instruction.value,skillIds:skills.filter(skill=>skill.imported&&selectedSkills.has(skill.id)).map(skill=>skill.id),skillMode:skillMode.value};}
  function canSend(){send.disabled=pending||!skillReady||!settings?.enabled||!settings.endpoint||!settings.model||!preview||previewKey!==JSON.stringify(request())||preview.overLimit||(['relationships','consistency'].includes(mode.value)&&!selected.size)||(mode.value==='custom'&&!instruction.value.trim());}
  function invalidatePreview(){++previewSeq;preview=null;previewKey='';status.textContent=T('正在更新资料预览…');scope.textContent=skillScope.textContent='';skillFiles.replaceChildren();canSend();}
  async function updatePreview(){invalidatePreview();const sequence=previewSeq,payload=request();if(!current()||!skillReady)return;try{const value=await api('/api/books/'+encodeURIComponent(bookId)+'/ai/preview','POST',payload);if(sequence!==previewSeq||!current())return;if(!Array.isArray(value.selectedSkillIds)||value.skillMode!==payload.skillMode||JSON.stringify([...value.selectedSkillIds].sort())!==JSON.stringify([...payload.skillIds].sort()))throw new Error(T('写作 Skill 预览与当前选择不匹配，请重试。'));if(!value.counts||!Number.isSafeInteger(value.contextChars)||value.contextChars<0||!['auto','manual'].includes(value.contextMode)||(value.contextMode==='auto'?(value.maxContextChars!==null||value.overLimit!==false):(!Number.isSafeInteger(value.maxContextChars)||value.maxContextChars<1||typeof value.overLimit!=='boolean')))throw new Error(T('资料预览无效，请重试。'));scope.textContent=T('共 {0} 字符',value.contextChars.toLocaleString())+(value.contextMode==='manual'?' · '+T('手动上限 {0}',value.maxContextChars.toLocaleString()):'');skillScope.textContent=payload.skillIds.length?T('Skill：{0} 字符（计入总数）',(value.skillChars||0).toLocaleString()):'';skillFiles.replaceChildren();(value.skills||[]).forEach(skill=>{skillFiles.append(el('p',null,writingSkillName(skill.id)+' · '+writingSkillModeName(skill.mode,book)+' · '+(skill.files||[]).join('、')));});if(value.overLimit)status.textContent=book.kind==='short'?T('资料超过手动上限，请调整设置。'):T('资料超过手动上限，请减少章节或调整设置。');else status.textContent=!settings?.enabled||!settings.endpoint||!settings.model?T('请先在设置中启用并配置 AI。'):'';preview=value;previewKey=JSON.stringify(payload);}catch(error){if(sequence===previewSeq&&current()){preview=null;previewKey='';status.textContent=error.message;}}canSend();}
  mode.addEventListener('change',()=>{if(pending){mode.value=activeAction;return;}prompts[activeAction]=instruction.value;activeAction=mode.value;instruction.value=prompts[activeAction];result.replaceChildren();clearTimeout(delay);return updatePreview();});skillMode.addEventListener('change',()=>{if(!pending)return updatePreview();});instruction.addEventListener('input',()=>{if(pending)return;prompts[activeAction]=instruction.value;clearTimeout(delay);invalidatePreview();if(mode.value==='custom'&&!instruction.value.trim())status.textContent=T('请填写自定义提示词。');delay=setTimeout(updatePreview,200);});
  try{const [configuration,skillList]=await Promise.all([api('/api/ai/settings'),api('/api/skills')]);if(!current())return;settings=configuration;skills=writingSkillList(skillList);(skillList.defaults?.skillIds||[]).forEach(id=>{if(skills.some(skill=>skill.id===id&&skill.imported))selectedSkills.add(id);});skillMode.value=Object.hasOwn(writingSkillModes,skillList.defaults?.skillMode)?skillList.defaults.skillMode:'auto';skillReady=true;renderSkillChoices();await updatePreview();}catch(error){if(current())status.textContent=error.message;}
  async function run(){canSend();if(pending||send.disabled||!current())return;pending=true;canSend();mode.disabled=instruction.disabled=configure.disabled=resetPrompt.disabled=true;renderChoices();renderSkillChoices();const payload=request();status.textContent=T('AI 正在处理所选资料…');try{if(!await requireSaved()||!current())return;const response=await api('/api/books/'+encodeURIComponent(bookId)+'/ai','POST',payload);if(!current())return;if(response.bookId!==bookId||response.action!==payload.action)throw new Error(T('AI 结果与当前作品不匹配。'));result.replaceChildren();status.textContent='';renderAIResult(result,response,{book,chapters,chapterIds:payload.chapterIds,sourceOutline,current,settings:()=>settings,onAdopt:target=>{closeDialog();if(target.view==='write'){state.view='write';state.chapterId=target.chapterId;}else if(target.view==='outline'){state.view='outline';state.outlineId=target.outlineId;state.outlineMode='read';state.outlineCategory='all';state.outlineKindFilter='';state.outlineVolumeFilter='';$('outline-search').value='';}renderShell();}});result.scrollIntoView({block:'nearest'});}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;mode.disabled=instruction.disabled=configure.disabled=resetPrompt.disabled=false;if(current()){renderChoices();renderSkillChoices();canSend();}}}
}

function renderAIResult(result,response,options={}){
  const book=options.book,bookId=book?.id,chapters=options.chapters||book?.chapters.filter(chapter=>!chapter.deletedAt)||[],sourceOutline=options.sourceOutline;
  if(!bookId||response?.bookId!==bookId||!['relationships','draft','outline','custom','book_cover','consistency','memory'].includes(response.action))throw new Error(T('AI 结果与当前作品不匹配。'));
  let disposed=false,anchor=null;
  const decisions=new Set(),current=()=>!disposed&&(!anchor||result.contains(anchor))&&state.book===book&&state.book?.id===bookId&&(typeof options.current!=='function'||options.current()),settings=()=>typeof options.settings==='function'?options.settings():options.settings;
  const fieldId=id=>(options.idPrefix||'')+id;
  function finish(target){return options.onAdopt?.(target||{});}
  function renderBookCover(data){
    const decision={applied:false,busy:false,buttons:[]};
    let editor;editor=renderAIBookCoverResult(result,data,{current,settings,idPrefix:options.idPrefix,
      addApply:(label,host,selection)=>adoption(label,host,()=>{const value=selection();if(!value)return false;try{const cover=value.cover!==undefined?value.cover:book.coverTemplate?window.WriterCovers.render(book.coverTemplate,value.title,book.kind):book.cover;book.title=value.title;book.cover=cover;if(value.cover!==undefined)book.coverTemplate='';}catch(error){editor.unlock();throw error;}},null,decision)});
  }
  function citations(evidence,container){const list=el('div','ai-evidence');evidence.forEach(item=>{const chapter=chapters.find(c=>c.id===item.chapterId);list.append(action((book.kind==='short'?T('正文'):chapter?.title||T('未命名章节'))+' · '+item.quote,'ai-evidence-link',()=>{if(current())(options.onNavigate||jumpToChapter)(item.chapterId,item.quote);}));});container.append(list);}
  function sourceText(item){return item.description+'\n\n'+T('AI 来源')+'\n'+item.evidence.map(cite=>(book.kind==='short'?T('正文'):chapters.find(c=>c.id===cite.chapterId)?.title||'')+' · '+cite.quote).join('\n');}
  function adoption(label,container,mutate,target,shared=null){
    const decision=shared||{applied:false,busy:false,buttons:[]};decisions.add(decision);
    const button=action(label,'primary-button',async()=>{
      if(decision.busy||decision.saved)return;if(!current()){toast(T('作品已切换，请重新生成建议。'));return;}
      decision.busy=true;decision.buttons.forEach(entry=>entry.button.disabled=true);
      try{
        if(!decision.applied){
          if(!await requireSaved()||!current())return;if(mutate()===false)return;
          decision.applied=true;markDirty();container.querySelectorAll('input,textarea,select').forEach(input=>input.disabled=true);
          decision.buttons.forEach(entry=>entry.button.textContent=T('重试保存'));options.onApplied?.(target?.()||{});
        }
        if(!await requireSaved()||!current())return;
        decision.saved=true;await finish(target?.());toast(T('AI 建议已保存到作品。'));
      }catch(error){if(current())toast(T(error.message));}
      finally{decision.busy=false;decision.buttons.forEach(entry=>entry.button.disabled=decision.saved||disposed||!!entry.unavailable);}
    });
    decision.buttons.push({button,unavailable:false});container.append(button);return button;
  }
  function renderRelationships(data){
    result.append(el('h3',null,T('人物与关系建议')));const entries=[],relationEntries=[],list=el('div','ai-suggestion-list');
    data.people.forEach(person=>{const card=el('section','ai-suggestion'),box=el('input'),label=el('label','checkbox-row');box.type='checkbox';label.append(box,el('strong',null,person.name),el('small',null,person.group));card.append(label,el('p',null,person.description));citations(person.evidence,card);entries.push({box,person});list.append(card);});
    data.relationships.forEach(relation=>{const card=el('section','ai-suggestion'),box=el('input'),label=el('label','checkbox-row');box.type='checkbox';label.append(box,el('strong',null,relation.from+' → '+relation.to+' · '+relation.label));card.append(label,el('p',null,relation.description));citations(relation.evidence,card);relationEntries.push({box,relation});list.append(card);});result.append(list);
    if(!entries.length&&!relationEntries.length){result.append(el('p','subtle',T('没有可确认的新建议。')));return;}
    adoption(T('采用勾选的人物与关系'),result,()=>{
      const chosen=entries.filter(entry=>entry.box.checked),relations=relationEntries.filter(entry=>entry.box.checked);if(!chosen.length&&!relations.length){toast(T('请先勾选要采用的建议。'));return false;}
      const known=new Map();people().forEach(person=>{if(known.has(person.title))known.set(person.title,null);else known.set(person.title,person);});
      const approved=new Set(chosen.map(entry=>entry.person.name));for(const {relation} of relations){if([relation.from,relation.to].some(name=>known.has(name)?!known.get(name):!approved.has(name))){toast(T('请先勾选关系涉及的新人物，重名人物请先在档案中区分。'));return false;}}
      for(const {person} of chosen){if(known.has(person.name)&&!known.get(person.name)){toast(T('请先勾选关系涉及的新人物，重名人物请先在档案中区分。'));return false;}}
      chosen.forEach(({person})=>{let note=known.get(person.name);if(!note){note={id:uid(),type:'人物',title:person.name,body:sourceText(person),aliases:[],profile:{...emptyProfile(),group:person.group},chapterIds:[],deletedAt:null};book.notes.push(note);known.set(person.name,note);}note.chapterIds=[...new Set([...note.chapterIds,...person.evidence.map(cite=>book.kind==='short'?resolveShortManuscriptId(cite.chapterId,book):cite.chapterId)])];});
      relations.forEach(({relation})=>{const fromId=known.get(relation.from).id,toId=known.get(relation.to).id;let item=book.relations.find(existing=>!existing.deletedAt&&existing.fromId===fromId&&existing.toId===toId&&existing.label===relation.label);if(!item){item={id:uid(),fromId,toId,type:relation.type,label:relation.label,body:sourceText(relation),stage:'',volumeIds:[],chapterIds:[],deletedAt:null};book.relations.push(item);}item.chapterIds=[...new Set([...item.chapterIds,...relation.evidence.map(cite=>book.kind==='short'?resolveShortManuscriptId(cite.chapterId,book):cite.chapterId)])];});
    });
  }
  function renderDraft(data,chapterIds){
    if(book.kind==='short')return renderShortDraft(data);
    result.append(el('h3',null,T('草稿预览')));const title=el('input','text-field'),body=el('textarea','text-field'),target=el('select','text-field');title.value=data.title;title.maxLength=200;title.id=fieldId('ai-draft-title');body.value=data.body;body.rows=14;body.maxLength=100000;body.id=fieldId('ai-draft-body');target.id=fieldId('ai-draft-target');chapters.forEach(chapter=>{const option=el('option',null,chapter.title||T('未命名章节'));option.value=chapter.id;target.append(option);});target.value=chapterIds[0]||chapters[0]?.id||'';addField(result,T('草稿标题'),title);addField(result,T('草稿正文'),body);addField(result,T('追加目标章节'),target);
    let targetId=null;const actions=el('div','ai-draft-actions');result.append(actions);
    function apply(kind){if(!title.value.trim()||!body.value.trim()){toast(T('草稿标题与正文不能为空。'));return false;}const existing=book.chapters.find(chapter=>chapter.id===target.value&&!chapter.deletedAt);if(kind==='append'&&!existing){toast(T('请选择有效的目标章节。'));return false;}if(kind==='append'&&existing.body.length+body.value.length+2>5000000){toast(T('追加后正文过长，请保存为新章节。'));return false;}if(kind==='append'){existing.body+=(existing.body.trim()?'\n\n':'')+body.value;targetId=existing.id;}else{const outline=book.outline.find(item=>item.id===sourceOutline?.id&&!item.deletedAt)||null,volumeId=outline?chapterOutlineVolume(outline)?.id||null:book.kind==='short'?null:existing?.volumeId||activeVolumes()[0]?.id||null;const chapter={id:uid(),title:title.value.trim(),body:body.value,volumeId,deletedAt:null};if(outline){insertOutlineChapter(outline,chapter);outline.chapterIds=[...new Set([...outline.chapterIds,chapter.id])];}else book.chapters.push(chapter);targetId=chapter.id;}title.disabled=body.disabled=target.disabled=true;}
    const done=()=>({view:'write',chapterId:targetId}),decision={applied:false,busy:false,buttons:[]};
    const append=adoption(T('追加到目标章节'),actions,()=>apply('append'),done,decision);adoption(T('保存为新章节'),actions,()=>apply('new'),done,decision);
    if(!chapters.length){append.disabled=true;decision.buttons[0].unavailable=true;}
  }
  function renderShortDraft(data){
    result.append(el('h3',null,T('草稿预览')));const body=el('textarea','text-field');body.value=data.body;body.rows=14;body.maxLength=100000;body.id=fieldId('ai-draft-body');addField(result,T('草稿正文'),body);
    let targetId=null;const actions=el('div','ai-draft-actions'),decision={applied:false,busy:false,buttons:[]};result.append(actions);
    function apply(append){
      if(!body.value.trim()){toast(T('草稿正文不能为空。'));return false;}
      const existing=book.chapters.find(item=>!item.deletedAt),previous=existing?.body||'',next=append?previous+(previous.trim()?'\n\n':'')+body.value:body.value;
      if(next.length>5000000){toast(T('正文过长，请减少草稿内容。'));return false;}
      const manuscript=ensureShortManuscript();if(!manuscript){toast(T('请先打开作品。'));return false;}
      manuscript.body=next;targetId=manuscript.id;body.disabled=true;
      const outline=book.outline.find(item=>item.id===sourceOutline?.id&&!item.deletedAt);if(outline)outline.chapterIds=[...new Set([...outline.chapterIds,manuscript.id])];
    }
    const done=()=>({view:'write',chapterId:targetId});adoption(T('追加到正文'),actions,()=>apply(true),done,decision);adoption(T('替换正文'),actions,()=>apply(false),done,decision);
  }
  function renderOutlineSuggestions(data){
    if(!Array.isArray(data?.nodes)||!data.nodes.length||data.nodes.length>200)throw new Error(T('AI 大纲结构不正确，请重新生成。'));
    let adoptedOutlineId=null;
    const byKey=new Map(),ordered=[],entries=new Map(),labels=book.kind==='short'?{story:T('总纲'),setting:T('情节 / 设定')}:{story:T('总纲'),volume:T('分卷'),chapter:T('章纲'),setting:T('设定')};
    data.nodes.forEach(node=>{if(!node||typeof node.key!=='string'||byKey.has(node.key)||!Object.hasOwn(labels,node.kind)||typeof node.title!=='string'||typeof node.body!=='string')throw new Error(T('AI 大纲结构不正确，请重新生成。'));byKey.set(node.key,node);});
    function visit(node,path=new Set()){if(path.has(node.key))throw new Error(T('AI 大纲结构不正确，请重新生成。'));if(ordered.includes(node))return;const parent=node.parentKey==null?null:byKey.get(node.parentKey);if(node.parentKey!=null&&!parent)throw new Error(T('AI 大纲结构不正确，请重新生成。'));if(parent)visit(parent,new Set([...path,node.key]));ordered.push(node);}
    data.nodes.forEach(node=>visit(node));
    result.append(el('h3',null,T('大纲预览')));
    const list=el('div','ai-outline-document'),chooseAll=action(T('全选大纲'),'text-button',()=>{entries.forEach(entry=>{if(!entry.box.disabled)entry.box.checked=true;});});result.append(chooseAll,list);
    ordered.forEach((node,index)=>{
      const section=el('section','ai-outline-section'),heading=el('label','checkbox-row'),box=el('input'),title=el('input','text-field ai-outline-title'),body=el('textarea','text-field ai-outline-body');box.type='checkbox';box.id=fieldId('ai-outline-select-'+index);title.id=fieldId('ai-outline-title-'+index);title.value=node.title;title.maxLength=200;body.id=fieldId('ai-outline-body-'+index);body.value=node.body;body.rows=node.kind==='story'?5:3;body.maxLength=10000;
      let depth=0,parent=byKey.get(node.parentKey);while(parent){depth++;parent=byKey.get(parent.parentKey);}section.style.setProperty('--outline-depth',String(depth));heading.append(box,el('span',null,labels[node.kind]));section.append(heading,title,body);list.append(section);entries.set(node.key,{node,box,title,body});
      box.addEventListener('change',()=>{if(box.disabled)return;if(box.checked){let parent=entries.get(node.parentKey);while(parent){parent.box.checked=true;parent=entries.get(parent.node.parentKey);}}else entries.forEach(entry=>{let parent=byKey.get(entry.node.parentKey);while(parent){if(parent.key===node.key){entry.box.checked=false;break;}parent=byKey.get(parent.parentKey);}});});
    });
    adoption(T('追加勾选的大纲'),result,()=>{
      const selectedKeys=new Set([...entries].filter(([,entry])=>entry.box.checked).map(([key])=>key));if(!selectedKeys.size){toast(T('请先勾选要采用的建议。'));return false;}
      for(const key of [...selectedKeys]){let parent=byKey.get(byKey.get(key).parentKey);while(parent){selectedKeys.add(parent.key);parent=byKey.get(parent.parentKey);}}
      const selected=ordered.filter(node=>selectedKeys.has(node.key));if(selected.some(node=>{const entry=entries.get(node.key);return !entry.title.value.trim()||entry.title.value.length>200||!entry.body.value.trim()||entry.body.value.length>10000;})){toast(T('大纲标题与内容不能为空，且需在长度限制内。'));return false;}
      const firstVolume=selected.find(node=>node.kind==='volume'),emptyVolume=firstVolume?aiEmptyDefaultPlanningVolume(book):null,ids=new Map(selected.map(node=>[node.key,uid()]));
      if(emptyVolume)ids.set(firstVolume.key,emptyVolume.id);
      const created=selected.map(node=>{const entry=entries.get(node.key);return{id:ids.get(node.key),title:entry.title.value.trim(),body:entry.body.value,kind:node.kind==='setting'?'scene':node.kind,category:node.kind==='setting'?(book.kind==='short'?'情节与设定':'世界设定'):node.kind==='story'?'故事主线':'分卷剧情',parentId:ids.get(node.parentKey)||null,volumeId:emptyVolume&&node===firstVolume?emptyVolume.volumeId:null,chapterIds:[],deletedAt:null};});
      if(emptyVolume)Object.assign(emptyVolume,created.find(node=>node.id===emptyVolume.id));
      book.outline.push(...created.filter(node=>node.id!==emptyVolume?.id));adoptedOutlineId=created[0].id;entries.forEach(entry=>{entry.box.disabled=entry.title.disabled=entry.body.disabled=true;});chooseAll.disabled=true;
    },()=>({view:'outline',outlineId:adoptedOutlineId}));
  }
  function renderCustom(data){
    if(typeof data?.text!=='string'||!data.text.trim())throw new Error(T('AI 未返回有效文本。'));
    result.append(el('h3',null,T('自定义结果')));const body=el('textarea','text-field ai-custom-result');body.id=fieldId('ai-custom-result');body.value=data.text;body.rows=14;body.maxLength=100000;result.append(body,action(T('复制结果'),'secondary-button',async()=>{try{await navigator.clipboard.writeText(body.value);toast(T('结果已复制。'));}catch{body.focus();body.select();toast(T('请按 Ctrl+C 或 Command+C 复制选中文字。'));}}));
  }
  function renderConsistency(data){result.append(el('h3',null,T('一致性检查结果')));if(!data.issues.length){result.append(el('p','subtle',T('所选资料中没有返回待核查问题。')));return;}data.issues.forEach(issue=>{const card=el('section','ai-suggestion');card.append(el('h4',null,issue.title),el('p',null,issue.description));citations(issue.evidence,card);result.append(card);});}
  function renderMemory(data){
    if(!Array.isArray(data?.entries)||!data.entries.length||data.entries.length>500)throw Error(T('长篇记忆无效，请重试。'));
    const entries=[],seen=new Set();result.append(el('h3',null,T('长篇记忆预览')));
    data.entries.forEach((entry,index)=>{
      const chapter=chapters.find(item=>item.id===entry?.chapterId),fields={};
      if(!chapter||seen.has(entry.chapterId)||typeof entry.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(entry.sourceHash)||['summary','characterStates','settingNotes'].some(key=>typeof entry[key]!=='string'||entry[key].length>4000))throw Error(T('长篇记忆无效，请重试。'));seen.add(entry.chapterId);
      const card=el('section','ai-suggestion'),box=el('input'),label=el('label','checkbox-row');box.type='checkbox';label.append(box,el('strong',null,book.kind==='short'?T('正文'):chapter.title));card.append(label);
      for(const [name,title] of [['summary','章节摘要'],['characterStates','人物状态'],['settingNotes','设定与规则']]){const input=el('textarea','text-field');input.id=fieldId('ai-memory-'+index+'-'+name);input.value=entry[name];input.maxLength=4000;input.rows=name==='summary'?5:3;fields[name]=input;addField(card,T(title),input);}
      const sourceBody=chapter.body,sourceTitle=chapter.title,record={entry,box,fields,sourceBody,sourceTitle,verified:false};box.disabled=true;entries.push(record);result.append(card);
      window.WriterStoryMemory?.sourceHash(chapter).then(hash=>{if(!current())return;record.verified=hash===entry.sourceHash;box.disabled=!record.verified;if(!record.verified)card.append(el('p','ai-chat-message-error',T('来源正文已变化，请重新整理记忆。')));}).catch(()=>{if(current())card.append(el('p','ai-chat-message-error',T('无法核对记忆来源，请重试。')));});
    });
    adoption(T('采用勾选的记忆'),result,()=>{
      const chosen=entries.filter(item=>item.box.checked);if(!chosen.length){toast(T('请先勾选要采用的建议。'));return false;}
      for(const item of chosen){const chapter=book.chapters.find(chapter=>chapter.id===item.entry.chapterId&&!chapter.deletedAt);if(!item.verified||!chapter||chapter.body!==item.sourceBody||chapter.title!==item.sourceTitle){toast(T('来源正文已变化，请重新整理记忆。'));return false;}if(!item.fields.summary.value.trim()){toast(T('章节摘要不能为空。'));return false;}}
      const replaced=new Set(chosen.map(item=>item.entry.chapterId));book.storyMemory={version:1,enabled:book.storyMemory?.enabled!==false,entries:[...(book.storyMemory?.entries||[]).filter(item=>!replaced.has(item.chapterId)),...chosen.map(item=>({chapterId:item.entry.chapterId,sourceHash:item.entry.sourceHash,...Object.fromEntries(Object.entries(item.fields).map(([key,input])=>[key,input.value]))}))]};
    });
  }
  if(!current())return{dispose(){disposed=true;},hasUnsavedAdoption(){return false;}};
  if(response.action==='relationships')renderRelationships(response.data);
  else if(response.action==='draft')renderDraft(response.data,options.chapterIds||response.chapterIds||[]);
  else if(response.action==='outline')renderOutlineSuggestions(response.data);
  else if(response.action==='custom')renderCustom(response.data);
  else if(response.action==='book_cover')renderBookCover(response.data);
  else if(response.action==='memory')renderMemory(response.data);
  else renderConsistency(response.data);
  anchor=result.children[result.children.length-1]||null;
  return{
    dispose(){disposed=true;decisions.forEach(decision=>decision.buttons.forEach(entry=>entry.button.disabled=true));},
    hasUnsavedAdoption(){return [...decisions].some(decision=>decision.applied&&!decision.saved);}
  };
}

function aiRasterDataURL(value){return typeof value==='string'&&value.length<=16*1024*1024&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);}
function aiValidPreview(value,payload,bookId){return value?.action==='book_cover'&&(!bookId||value.bookId===bookId&&Array.isArray(value.chapterIds)&&value.chapterIds.length===0)&&value.counts&&['chapters','outlines','people','relationships'].every(key=>Number.isSafeInteger(value.counts[key])&&value.counts[key]>=0)&&Array.isArray(value.selectedSkillIds)&&value.skillMode===payload.skillMode&&JSON.stringify([...value.selectedSkillIds].sort())===JSON.stringify([...payload.skillIds].sort())&&Number.isSafeInteger(value.contextChars)&&value.contextChars>=0&&['auto','manual'].includes(value.contextMode)&&(value.contextMode==='auto'?value.maxContextChars===null&&value.overLimit===false:Number.isSafeInteger(value.maxContextChars)&&value.maxContextChars>0&&typeof value.overLimit==='boolean');}

function renderAIBookCoverResult(container,data,options){
  if(!Array.isArray(data?.titles)||!data.titles.length||data.titles.length>8||data.titles.some(title=>typeof title!=='string'||!title.trim()||title.length>200)||new Set(data.titles).size!==data.titles.length||typeof data.coverPrompt!=='string'||!data.coverPrompt.trim()||data.coverPrompt.length>10000)throw new Error(T('AI 封面与书名结果无效，请重新生成。'));
  const panel=el('section','ai-book-cover-result'),names=el('div','ai-cover-name-options'),title=el('input','text-field'),prompt=el('textarea','text-field'),preview=el('img','ai-cover-preview'),status=el('p','ai-status'),imageActions=el('div','ai-cover-image-actions'),applyActions=el('div','ai-draft-actions');
  title.id=(options.idPrefix||'')+'ai-cover-title';title.maxLength=200;title.value=data.titles[0];prompt.id=(options.idPrefix||'')+'ai-cover-prompt';prompt.rows=5;prompt.maxLength=10000;prompt.value=data.coverPrompt;preview.alt=T('封面预览');preview.hidden=true;
  const current=()=>options.current()&&container.contains(panel),validTitle=()=>title.value.trim().length>0&&title.value.length<=200;
  let rawImage='',cover='',coverTitle='',busy=false,composing=false,locked=false,composeSeq=0;
  const chooseButtons=data.titles.map(name=>{const button=action(name,'secondary-button ai-cover-name-option',()=>{if(locked||busy||!current())return;title.value=name;return compose();});names.append(button);return button;});
  const generate=action(T('生成封面'),'secondary-button',generateImage);
  imageActions.append(generate,el('small','subtle',T('仅点击生成封面时调用图像模型，可能产生费用。')));
  panel.append(el('h3',null,T('封面与书名预览')),names);addField(panel,T('书名'),title);addField(panel,T('图像提示词'),prompt);panel.append(imageActions,status,preview,applyActions);container.append(panel);
  function selection(withCover){if(!current()||busy||composing||!validTitle()||(withCover&&(!cover||coverTitle!==title.value.trim())))return false;locked=true;controls();return{title:title.value.trim(),...(withCover?{cover,coverTemplate:''}:{})};}
  const nameApply=options.addApply(T('采用书名'),applyActions,()=>selection(false)),coverApply=options.addApply(T('采用书名与封面'),applyActions,()=>selection(true));
  function controls(){title.disabled=prompt.disabled=locked||busy;chooseButtons.forEach(button=>button.disabled=locked||busy);generate.disabled=locked||busy||composing;nameApply.disabled=busy||composing||!validTitle();coverApply.disabled=busy||composing||!validTitle()||!cover||coverTitle!==title.value.trim();}
  async function compose(){const sequence=++composeSeq,image=rawImage,name=title.value.trim();cover='';coverTitle='';preview.hidden=true;if(!image||!validTitle()){composing=false;controls();return;}composing=true;controls();try{if(typeof window.WriterCovers?.composeImage!=='function')throw new Error(T('无法绘制封面，请重试。'));const value=await window.WriterCovers.composeImage(image,name);if(sequence!==composeSeq||!current())return;if(!aiRasterDataURL(value)||value.length>2*1024*1024)throw new Error(T('封面图片无效或过大，请重新生成。'));cover=value;coverTitle=name;preview.src=value;preview.hidden=false;status.textContent='';}catch(error){if(sequence===composeSeq&&current())status.textContent=T(error.message);}finally{if(sequence===composeSeq){composing=false;if(current())controls();}}}
  async function generateImage(){if(locked||busy||!current())return;const settings=options.settings();if(!settings?.imageModel?.trim()){status.textContent=T('请先在设置中填写图像模型。');return;}if(!prompt.value.trim()||prompt.value.length>10000||/data:image/i.test(prompt.value)){status.textContent=T('请填写有效的图像提示词。');return;}busy=true;controls();status.textContent=T('正在生成封面…');try{const response=await api('/api/ai/cover-image','POST',{prompt:prompt.value});if(!current())return;if(!aiRasterDataURL(response.image))throw new Error(T('封面图片无效或过大，请重新生成。'));rawImage=response.image;await compose();}catch(error){if(current())status.textContent=T(error.message);}finally{busy=false;if(current())controls();}}
  title.addEventListener('input',()=>{if(!locked&&!busy)return compose();});controls();
  return{unlock(){locked=false;controls();},current};
}

let aiBookCoverDialog=null;
async function showAIBookCover(options){
  if(!options||typeof options.onApply!=='function'||!['long','short'].includes(options.kind))return;
  const bookId=typeof options.bookId==='string'&&options.bookId?options.bookId:null;
  const parentCurrent=()=>typeof options.isCurrent==='function'?options.isCurrent():$('dialog').open;
  if(!parentCurrent())return;aiBookCoverDialog?.close();
  const dialog=el('dialog','ai-cover-dialog'),header=el('div','ai-cover-dialog-header'),heading=el('h2',null,T('生成封面与书名')),body=el('div','ai-cover-dialog-body'),form=el('div','ai-request-form'),result=el('div','ai-results'),instruction=el('textarea','text-field'),status=el('p','ai-status'),scope=el('p','ai-scope'),skillsSection=el('details','ai-writing-skills'),skillChoices=el('div','writing-skill-list'),skillMode=writingSkillModeSelect('ai-book-cover-skill-mode');
  heading.id='ai-cover-heading-'+uid();dialog.setAttribute('aria-labelledby',heading.id);header.append(heading,action(T('关闭'),'text-button',()=>close()));dialog.append(header,body);body.append(form,result);document.body.append(dialog);
  const title=typeof options.title==='string'?options.title.slice(0,200):'',defaultPrompt=aiDefaultPrompt('book_cover');instruction.id='ai-book-cover-instruction';instruction.rows=7;instruction.maxLength=bookId?9700:10000;instruction.value=defaultPrompt;if(bookId)form.append(el('p','ai-scope',T('待采用书名：{0}',title)));addField(form,T('提示词'),instruction);
  let closed=false,applied=false,pending=false,applying=false,settings=null,skills=[],preview=null,previewKey='',previewSeq=0,delay=null;
  const selectedSkills=new Set(),current=()=>!closed&&dialog.open&&parentCurrent()&&aiBookCoverDialog===dialog;
  function close(){if(closed)return;closed=true;clearTimeout(delay);++previewSeq;dialog.close();dialog.remove();if(aiBookCoverDialog===dialog)aiBookCoverDialog=null;if(!applied)options.onCancel?.();}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);aiBookCoverDialog=dialog;dialog.showModal();
  const reset=action(T('恢复默认提示词'),'text-button',()=>{if(pending)return;instruction.value=defaultPrompt;result.replaceChildren();return updatePreview();}),send=action(T('生成候选'),'primary-button',run),footer=el('div','dialog-actions');
  skillsSection.append(el('summary',null,T('写作 Skill')),skillChoices);addField(skillsSection,T('写作任务'),skillMode);footer.append(action(T('取消'),'secondary-button',close),send);form.append(reset,skillsSection,scope,status,footer);
  function payload(){const choice={skillIds:skills.filter(skill=>skill.imported&&selectedSkills.has(skill.id)).map(skill=>skill.id),skillMode:skillMode.value};return bookId?{...choice,action:'book_cover',chapterIds:[],instruction:instruction.value+'\n\n'+T('待采用书名：{0}',title)}:{...choice,title,kind:options.kind,prompt:instruction.value};}
  function controls(){const blocked=pending||applying;instruction.disabled=reset.disabled=skillMode.disabled=blocked;skillChoices.querySelectorAll('input').forEach(box=>box.disabled=blocked||!skills.find(skill=>skill.id===box.dataset.skill)?.imported);send.disabled=blocked||!settings?.enabled||!settings.endpoint||!settings.model||!preview||previewKey!==JSON.stringify(payload())||preview.overLimit;}
  function renderSkills(){skillChoices.replaceChildren();skills.forEach(skill=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.dataset.skill=skill.id;box.checked=selectedSkills.has(skill.id);box.disabled=pending||!skill.imported;box.addEventListener('change',()=>{if(pending)return;box.checked?selectedSkills.add(skill.id):selectedSkills.delete(skill.id);return updatePreview();});row.append(box,el('span',null,writingSkillName(skill.id)));skillChoices.append(row);});controls();}
  function invalidate(){++previewSeq;preview=null;previewKey='';scope.textContent='';controls();}
  async function updatePreview(){invalidate();const sequence=previewSeq,request=payload();if(!current()||!settings)return;try{const value=await api(bookId?'/api/books/'+encodeURIComponent(bookId)+'/ai/preview':'/api/ai/book-cover','POST',bookId?request:{...request,preview:true});if(sequence!==previewSeq||!current())return;if(!aiValidPreview(value,request,bookId))throw new Error(T('资料预览无效，请重试。'));preview=value;previewKey=JSON.stringify(request);scope.textContent=T('共 {0} 字符',value.contextChars.toLocaleString());status.textContent=value.overLimit?T('资料超过手动上限，请减少章节或调整设置。'):!settings.enabled||!settings.endpoint||!settings.model?T('请先在设置中启用并配置 AI。'):'';}catch(error){if(sequence===previewSeq&&current())status.textContent=T(error.message);}controls();}
  instruction.addEventListener('input',()=>{if(pending)return;clearTimeout(delay);invalidate();delay=setTimeout(updatePreview,200);});skillMode.addEventListener('change',()=>{if(!pending)return updatePreview();});
  async function run(){controls();if(send.disabled||!current())return;pending=true;controls();status.textContent=T('AI 正在处理所选资料…');try{const response=await api(bookId?'/api/books/'+encodeURIComponent(bookId)+'/ai':'/api/ai/book-cover','POST',payload());if(!current())return;if(bookId&&response.bookId!==bookId)throw new Error(T('AI 结果与当前作品不匹配。'));if(response.action!=='book_cover')throw new Error(T('AI 封面与书名结果无效，请重新生成。'));result.replaceChildren();status.textContent='';let editor;editor=renderAIBookCoverResult(result,response.data,{current,settings:()=>settings,addApply:(label,host,selection)=>{const button=action(label,'primary-button',async()=>{if(applying||!current())return;const value=selection();if(!value)return;applying=true;controls();host.querySelectorAll('button').forEach(item=>item.disabled=true);try{const accepted=await options.onApply(value);if(accepted===false){if(current())editor.unlock();return;}applied=true;close();}catch(error){if(current()){status.textContent=T(error.message);editor.unlock();}}finally{applying=false;if(current()){editor.unlock();controls();}}});host.append(button);return button;}});result.scrollIntoView({block:'nearest'});}catch(error){if(current())status.textContent=T(error.message);}finally{pending=false;if(current())controls();}}
  controls();try{const [configuration,value]=await Promise.all([api('/api/ai/settings'),api('/api/skills')]);if(!current())return;settings=configuration;skills=writingSkillList(value);(value.defaults?.skillIds||[]).forEach(id=>{if(skills.some(skill=>skill.id===id&&skill.imported))selectedSkills.add(id);});skillMode.value=Object.hasOwn(writingSkillModes,value.defaults?.skillMode)?value.defaults.skillMode:'auto';renderSkills();await updatePreview();}catch(error){if(current())status.textContent=T(error.message);}
}
window.showAIBookCover=showAIBookCover;

async function showAIUsage(book=null){
  const content=el('section','ai-usage'),scope=el('select','text-field'),status=el('p','subtle'),summary=el('div','ai-usage-summary'),list=el('div','ai-usage-list');
  for(const [value,text]of [...(book?.id?[[book.id,'当前作品']]:[]),['','全部作品']]){const option=el('option',null,T(text));option.value=value;scope.append(option);}scope.setAttribute('aria-label',T('用量范围'));content.append(scope,status,summary,list);
  let sequence=0;const current=()=>$('dialog').open&&$('dialog-body').contains(content),unavailable=()=>T('不可用');
  function tokens(value){return Number.isSafeInteger(value)?value.toLocaleString():unavailable();}
  async function load(){const request=++sequence;status.textContent=T('正在读取用量…');try{const value=await api('/api/ai/usage'+(scope.value?'?bookId='+encodeURIComponent(scope.value):''));if(!current()||request!==sequence)return;const totals=value.totals;summary.replaceChildren(el('strong',null,T('{0} 次请求',totals.requests)),el('span',null,T('已知 Token：{0}',tokens(totals.totalTokens))),el('span',null,T('用量未知：{0} 次',totals.unknownUsageRequests)),el('span',null,T('已知费用：{0}',Object.entries(totals.costs).map(([currency,amount])=>currency+' '+amount).join(' · ')||unavailable())),el('span',null,T('费用未知：{0} 次',totals.unknownCostRequests)));list.replaceChildren();for(const row of value.entries){const article=el('article','ai-usage-row');article.append(el('strong',null,row.profileName+' · '+row.model),el('small',null,new Date(row.createdAt).toLocaleString()+' · '+T(row.action)+' · '+T(row.result)),el('span',null,T('输入 {0} · 输出 {1} · 共 {2} Token',tokens(row.usage?.inputTokens),tokens(row.usage?.outputTokens),tokens(row.usage?.totalTokens))),el('span',null,T('{0} 秒',(row.durationMs/1000).toFixed(2))+' · '+(row.cost===null?unavailable():row.currency+' '+row.cost)));list.append(article);}status.textContent=value.truncated?T('显示最近 500 条记录，统计包含全部记录。'):T('仅保存在本机，不包含提示词、正文和密钥。');}catch(error){if(current()&&request===sequence)status.textContent=error.message;}}
  scope.addEventListener('change',load);content.append(action(T('关闭'),'secondary-button',closeDialog));if($('settings-dialog')?.open)$('settings-dialog').close();showDialog(T('AI 用量记录'),content);await load();
}
