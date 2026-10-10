'use strict';

function appendAISettings(content){
  const section=el('details','ai-settings'),summary=el('summary',null,T('AI 辅助')),body=el('div','ai-settings-body');section.append(summary,body);content.append(section);
  const status=el('p','subtle',T('正在读取 AI 设置…')),enabled=el('input'),endpoint=el('input','text-field'),model=el('input','text-field'),key=el('input','text-field'),clear=el('input'),limit=el('input','text-field'),timeout=el('input','text-field');
  enabled.type='checkbox';enabled.id='ai-enabled';endpoint.type='url';endpoint.id='ai-endpoint';endpoint.placeholder='https://api.openai.com/v1';model.id='ai-model';model.placeholder=T('填写服务支持的模型名称');key.type='password';key.id='ai-api-key';key.autocomplete='new-password';clear.type='checkbox';clear.id='ai-clear-key';limit.type='number';limit.id='ai-context-limit';limit.min='1000';limit.max='500000';timeout.type='number';timeout.id='ai-timeout';timeout.min='1';timeout.max='180';
  const enableRow=el('label','checkbox-row');enableRow.append(enabled,el('span',null,T('启用 AI 辅助')));body.append(status,enableRow);
  [[T('服务地址'),endpoint],[T('模型名称'),model],[T('API Key（本机服务可留空）'),key],[T('上下文字符上限'),limit],[T('请求超时（秒）'),timeout]].forEach(([label,input])=>addField(body,label,input));
  const clearRow=el('label','checkbox-row');clearRow.append(clear,el('span',null,T('清除已保存密钥')));body.append(clearRow,el('p','subtle',T('密钥只存本机，不进入作品与备份。只有点击发送才会将所选资料交给配置的服务。')));
  const buttons=el('div','dialog-actions'),save=action(T('保存 AI 设置'),'primary-button',persist),test=action(T('测试连接'),'secondary-button',testConnection);save.disabled=true;test.disabled=true;buttons.append(test,save);body.append(buttons);let pending=false;
  function fill(settings){enabled.checked=settings.enabled;endpoint.value=settings.endpoint;model.value=settings.model;limit.value=settings.maxContextChars;timeout.value=settings.timeoutSeconds;key.value='';clear.checked=false;key.placeholder=settings.hasKey?T('已保存；留空保留原密钥'):T('未保存密钥');status.textContent=settings.enabled?T('AI 已启用'):T('AI 未启用');}
  function payload(){return{enabled:enabled.checked,endpoint:endpoint.value,model:model.value,apiKey:key.value,clearKey:clear.checked,maxContextChars:Number(limit.value),timeoutSeconds:Number(timeout.value)};}
  async function persist(){if(pending)return false;pending=true;save.disabled=test.disabled=true;try{fill(await api('/api/ai/settings','PUT',payload()));toast(T('AI 设置已保存。'));return true;}catch(error){status.textContent=error.message;return false;}finally{pending=false;save.disabled=test.disabled=false;}}
  async function testConnection(){if(!await persist())return;pending=true;save.disabled=test.disabled=true;status.textContent=T('正在测试连接…');try{await api('/api/ai/test','POST',{});status.textContent=T('连接成功。测试未发送作品内容。');}catch(error){status.textContent=error.message;}finally{pending=false;save.disabled=test.disabled=false;}}
  api('/api/ai/settings').then(settings=>{fill(settings);save.disabled=test.disabled=false;}).catch(error=>{status.textContent=error.message;});
  return section;
}

async function showAIAssistant(initialAction='draft'){
  if(!state.book){toast(T('请先打开作品。'));return;}
  if(state.composing||state.transitioning||$('dialog').open||$('settings-dialog')?.open)return;
  if(!await requireSaved())return;
  const book=state.book,bookId=book.id,sourceOutline=state.view==='outline'?currentOutline():null,chapters=activeChapters(),content=el('div','ai-assistant'),form=el('div','ai-request-form'),result=el('div','ai-results'),status=el('p','ai-status'),scope=el('p','ai-scope'),mode=el('select','text-field'),instruction=el('textarea','text-field'),choices=el('div','ai-chapter-choices'),selected=new Set(sourceOutline?.chapterIds?.filter(id=>chapters.some(c=>c.id===id))||[]);
  if(!sourceOutline&&!selected.size&&chapters.some(c=>c.id===state.chapterId))selected.add(state.chapterId);if(!sourceOutline&&!selected.size&&chapters.length)selected.add(chapters[0].id);
  let settings=null,preview=null,previewSeq=0,pending=false,delay=null;
  const modes={relationships:T('提取人物与关系'),draft:T('生成写作草稿'),consistency:T('检查人物与剧情一致性')};Object.entries(modes).forEach(([id,title])=>{const option=el('option',null,title);option.value=id;mode.append(option);});mode.value=Object.hasOwn(modes,initialAction)?initialAction:'draft';mode.id='ai-action';instruction.id='ai-instruction';instruction.rows=3;instruction.maxLength=10000;instruction.placeholder=T('补充写作要求，可留空');if(sourceOutline&&mode.value==='draft')instruction.value=T('依据当前大纲生成草稿：')+'\n'+sourceOutline.title+'\n'+sourceOutline.body;addField(form,T('操作'),mode);addField(form,T('写作要求'),instruction);
  const choiceHeader=el('div','section-label');choiceHeader.append(el('span',null,T('选择发送的章节')),action(T('全选'),'text-button',()=>{if(pending)return;chapters.forEach(c=>selected.add(c.id));renderChoices();updatePreview();}),action(T('清空'),'text-button',()=>{if(pending)return;selected.clear();renderChoices();updatePreview();}));form.append(choiceHeader,choices);
  function renderChoices(){choices.replaceChildren();chapters.forEach(chapter=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=selected.has(chapter.id);box.disabled=pending;box.addEventListener('change',()=>{box.checked?selected.add(chapter.id):selected.delete(chapter.id);updatePreview();});row.append(box,el('span',null,chapter.title||T('未命名章节')));choices.append(row);});if(!chapters.length)choices.append(el('p','subtle',T('还没有章节。生成草稿会使用本书大纲与人物资料。')));}
  const send=action(T('发送所选资料'),'primary-button',run),configure=action(T('打开 AI 设置'),'secondary-button',()=>{closeDialog();showAppSettings();}),buttons=el('div','dialog-actions');send.disabled=true;buttons.append(configure,send);form.append(scope,status,buttons);content.append(el('p','ai-notice',T('AI 建议需核对后采用。资料不会自动发送，结果不会自动修改作品。')),form,result);showDialog(T('AI 辅助'),content);renderChoices();
  const current=()=>state.book===book&&state.book?.id===bookId&&$('dialog').open&&$('dialog-body').contains(content);
  function request(){return{action:mode.value,chapterIds:chapters.filter(c=>selected.has(c.id)).map(c=>c.id),instruction:instruction.value};}
  function canSend(){send.disabled=pending||!settings?.enabled||!settings.endpoint||!settings.model||!preview||preview.overLimit||(mode.value!=='draft'&&!selected.size);}
  async function updatePreview(){const sequence=++previewSeq;preview=null;canSend();if(!current())return;try{const value=await api('/api/books/'+encodeURIComponent(bookId)+'/ai/preview','POST',request());if(sequence!==previewSeq||!current())return;preview=value;scope.textContent=T('将发送 {0} 章、{1} 条大纲、{2} 位人物、{3} 条关系，共 {4} 字符；上限 {5}。',value.counts.chapters,value.counts.outlines,value.counts.people,value.counts.relationships,value.contextChars.toLocaleString(),value.maxContextChars.toLocaleString());if(value.overLimit)status.textContent=T('资料超过上限，请减少章节或调整 AI 设置。没有发送任何资料。');else status.textContent=settings?.enabled?T('目标服务：{0}',settings.endpoint):T('请先在设置中启用并配置 AI。');}catch(error){if(sequence===previewSeq&&current())status.textContent=error.message;}canSend();}
  mode.addEventListener('change',()=>{result.replaceChildren();updatePreview();});instruction.addEventListener('input',()=>{clearTimeout(delay);preview=null;canSend();delay=setTimeout(updatePreview,200);});
  try{settings=await api('/api/ai/settings');if(!current())return;await updatePreview();}catch(error){if(current())status.textContent=error.message;}
  async function run(){if(pending||send.disabled||!current())return;pending=true;canSend();mode.disabled=instruction.disabled=true;renderChoices();const payload=request();status.textContent=T('AI 正在处理所选资料…');try{if(!await requireSaved()||!current())return;const response=await api('/api/books/'+encodeURIComponent(bookId)+'/ai','POST',payload);if(!current())return;if(response.bookId!==bookId||response.action!==payload.action)throw new Error(T('AI 结果与当前作品不匹配。'));result.replaceChildren();status.textContent=T('结果已就绪，请核对来源后采用。');if(response.action==='relationships')renderRelationships(response.data);else if(response.action==='draft')renderDraft(response.data,payload.chapterIds);else renderConsistency(response.data);result.scrollIntoView({block:'nearest'});}catch(error){if(current())status.textContent=error.message;}finally{pending=false;mode.disabled=instruction.disabled=false;if(current()){renderChoices();canSend();}}}
  function citations(evidence,container){const list=el('div','ai-evidence');evidence.forEach(item=>{const chapter=chapters.find(c=>c.id===item.chapterId);list.append(action((chapter?.title||T('未命名章节'))+' · '+item.quote,'ai-evidence-link',()=>jumpToChapter(item.chapterId)));});container.append(list);}
  function sourceText(item){return item.description+'\n\n'+T('AI 来源')+'\n'+item.evidence.map(cite=>(chapters.find(c=>c.id===cite.chapterId)?.title||'')+' · '+cite.quote).join('\n');}
  function adoption(label,container,mutate,done,shared=null){
    const decision=shared||{applied:false,busy:false,buttons:[]};
    const button=action(label,'primary-button',async()=>{
      if(decision.busy)return;if(!current()){toast(T('作品已切换，请重新生成建议。'));return;}
      decision.busy=true;decision.buttons.forEach(entry=>entry.button.disabled=true);
      try{
        if(!decision.applied){
          if(!await requireSaved()||!current())return;if(mutate()===false)return;
          decision.applied=true;markDirty();container.querySelectorAll('input,textarea,select').forEach(input=>input.disabled=true);
          decision.buttons.forEach(entry=>entry.button.textContent=T('重试保存'));
        }
        if(!await requireSaved()||!current())return;
        closeDialog();done?.();renderShell();toast(T('AI 建议已保存到作品。'));
      }catch(error){if(current())toast(error.message);}
      finally{decision.busy=false;decision.buttons.forEach(entry=>entry.button.disabled=!!entry.unavailable);}
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
      chosen.forEach(({person})=>{let note=known.get(person.name);if(!note){note={id:uid(),type:'人物',title:person.name,body:sourceText(person),aliases:[],profile:{...emptyProfile(),group:person.group},chapterIds:[],deletedAt:null};book.notes.push(note);known.set(person.name,note);}note.chapterIds=[...new Set([...note.chapterIds,...person.evidence.map(cite=>cite.chapterId)])];});
      relations.forEach(({relation})=>{const fromId=known.get(relation.from).id,toId=known.get(relation.to).id;let item=book.relations.find(existing=>!existing.deletedAt&&existing.fromId===fromId&&existing.toId===toId&&existing.label===relation.label);if(!item){item={id:uid(),fromId,toId,type:relation.type,label:relation.label,body:sourceText(relation),stage:'',volumeIds:[],chapterIds:[],deletedAt:null};book.relations.push(item);}item.chapterIds=[...new Set([...item.chapterIds,...relation.evidence.map(cite=>cite.chapterId)])];});
    });
  }
  function renderDraft(data,chapterIds){
    result.append(el('h3',null,T('草稿预览')));const title=el('input','text-field'),body=el('textarea','text-field'),target=el('select','text-field');title.value=data.title;title.maxLength=200;title.id='ai-draft-title';body.value=data.body;body.rows=14;body.maxLength=100000;body.id='ai-draft-body';target.id='ai-draft-target';chapters.forEach(chapter=>{const option=el('option',null,chapter.title||T('未命名章节'));option.value=chapter.id;target.append(option);});target.value=chapterIds[0]||chapters[0]?.id||'';addField(result,T('草稿标题'),title);addField(result,T('草稿正文'),body);addField(result,T('追加目标章节'),target);
    let targetId=null;const actions=el('div','ai-draft-actions');result.append(actions);
    function apply(kind){if(!title.value.trim()||!body.value.trim()){toast(T('草稿标题与正文不能为空。'));return false;}const existing=chapters.find(chapter=>chapter.id===target.value&&!chapter.deletedAt);if(kind==='append'&&!existing){toast(T('请选择有效的目标章节。'));return false;}if(kind==='append'&&existing.body.length+body.value.length+2>5000000){toast(T('追加后正文过长，请保存为新章节。'));return false;}if(kind==='append'){existing.body+=(existing.body.trim()?'\n\n':'')+body.value;targetId=existing.id;}else{const outline=sourceOutline&&!sourceOutline.deletedAt?sourceOutline:null,volumeId=outline?chapterOutlineVolume(outline)?.id||null:book.kind==='short'?null:existing?.volumeId||activeVolumes()[0]?.id||null;const chapter={id:uid(),title:title.value.trim(),body:body.value,volumeId,deletedAt:null};if(outline){insertOutlineChapter(outline,chapter);outline.chapterIds=[...new Set([...outline.chapterIds,chapter.id])];}else book.chapters.push(chapter);targetId=chapter.id;}title.disabled=body.disabled=target.disabled=true;}
    const done=()=>{state.view='write';state.chapterId=targetId;},decision={applied:false,busy:false,buttons:[]};
    const append=adoption(T('追加到目标章节'),actions,()=>apply('append'),done,decision);adoption(T('保存为新章节'),actions,()=>apply('new'),done,decision);
    if(!chapters.length){append.disabled=true;decision.buttons[0].unavailable=true;}
  }
  function renderConsistency(data){result.append(el('h3',null,T('一致性检查结果')));if(!data.issues.length){result.append(el('p','subtle',T('所选资料中没有返回待核查问题。')));return;}data.issues.forEach(issue=>{const card=el('section','ai-suggestion');card.append(el('h4',null,issue.title),el('p',null,issue.description));citations(issue.evidence,card);result.append(card);});}
}
