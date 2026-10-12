'use strict';

// This sidebar edits the book's existing outline records. Empty prompts are
// presentation only: opening the panel never adds text or creates a record.
window.WriterWorkPlan=(()=>{
  const worldHint='世界背景\n描述世界的基本历史、风土人情\n\n金手指\n主角独有的能力或特质，能够起到推动剧情，解决矛盾危机的作用\n\n背景事件\n非当下、直接发生在主角身上，但对后续剧情走向，有重要作用的全文大事件';
  const characterHint=['主角','配角','反派1'].map(role=>role+'\n姓名：\n性别：\n性格：\n外貌：\n人物简介：\n人物关系：').join('\n\n');
  const plotHint='主线\n主角的主要目标，主线故事的起因、经过、结果\n\n支线\n主角的次要目标，支线故事的起因、经过、结果。\n支线通常是依附于主线目标，将主线目标拆分成若干个小目标，即是支线内容。';
  const volumeHint='一句话概括内容：人物，世界观，金手指，主要目标。\n什么人，在什么地方，凭借什么，做什么。\n故事1：\n故事2：\n故事3：';
  const sections=[
    {key:'world',label:'世界观',category:'世界设定',titles:['世界观','世界观与规则','世界背景','Worldbuilding','World and rules'],hint:()=>T(worldHint)},
    {key:'characters',label:'角色',category:'人物设定',titles:['角色','人物设定','人物群像与分组','Characters','Character profiles'],hint:()=>T(characterHint)},
    {key:'plot',label:'剧情大纲',category:'故事主线',titles:['剧情大纲','全书总纲','全篇构思','Plot outline','Story overview','Story concept'],hint:()=>T(plotHint)+'\n\n'+(state.kind==='short'?T('主要情节\n一句话概括内容：人物，世界观，金手指，主要目标。\n什么人，在什么地方，凭借什么，做什么。\n开端：\n发展：\n转折：\n高潮：\n结局：'):T('主要情节')+'\n'+T('第一卷（卷名）')+'\n'+T(volumeHint)+'\n\n'+T('第二卷（卷名）')+'\n'+T(volumeHint))},
    {key:'synopsis',label:'故事梗概',category:'参考资料',titles:['故事梗概','故事摘要','Synopsis','Story summary'],hint:()=>T('故事的梗概')},
  ];
  let bound=false,view=null;
  const panel=()=>$('work-plan-panel');
  const enabled=()=>!!state.book&&state.view==='write';
  const language=()=>typeof uiLanguage==='string'?uiLanguage:document.documentElement.lang;
  const records=()=>state.book?.outline?.filter(item=>!item.deletedAt)||[];
  function findRecord(section){
    const items=records(),titles=new Set([...section.titles,T(section.label)]);
    const exact=items.find(item=>titles.has(item.title));if(exact)return exact;
    if(section.key==='synopsis')return items.find(item=>/梗概|摘要|synopsis|story summary/i.test(item.title||''))||null;
    const matches=items.filter(item=>outlineTopic(item)===section.category);
    return matches.find(item=>!item.parentId&&!item.volumeId&&item.kind!=='chapter')||matches.find(item=>item.kind!=='chapter')||matches[0]||null;
  }
  function setEmpty(field){
    const empty=field.input.value.length===0;field.hint.hidden=!empty;
    field.shell.classList.toggle('is-empty',empty);
  }
  function current(candidate){return view===candidate&&state.book===candidate.book&&enabled();}
  function saveField(candidate,field){
    if(!current(candidate))return;
    setEmpty(field);
    let record=records().find(item=>item.id===field.recordId);
    if(!record){
      if(!field.input.value)return;
      record=findRecord(field.section);
      if(!record){record={id:uid(),title:T(field.section.label),category:field.section.category,kind:field.section.key==='plot'?'story':'scene',body:'',parentId:null,volumeId:null,chapterIds:[],deletedAt:null};state.book.outline.push(record);}
      field.recordId=record.id;
    }
    if(record.body===field.input.value)return;
    record.body=field.input.value;candidate.outlineButton.disabled=false;markDirty();
  }
  function build(){
    const target=panel(),book=state.book,candidate={book,kind:state.kind,language:language(),fields:[],tab:'outline'};
    view=candidate;
    const header=el('header','work-plan-header'),tabs=el('div','work-plan-tabs'),tools=el('div','work-plan-tools');
    tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',T('写作资料'));
    const outline=el('div','work-plan-outline'),characters=el('div','work-plan-characters');
    outline.id='work-plan-outline';characters.id='work-plan-characters';outline.setAttribute('role','tabpanel');characters.setAttribute('role','tabpanel');
    const tabButtons=new Map();
    function selectTab(tab){
      if(!current(candidate))return;candidate.tab=tab;outline.hidden=tab!=='outline';characters.hidden=tab!=='characters';
      for(const [key,button]of tabButtons){button.setAttribute('aria-selected',String(key===tab));button.tabIndex=key===tab?0:-1;}
      if(tab==='characters')renderCharacters(candidate);
    }
    [['outline','作品大纲'],['characters','人物卡片']].forEach(([key,label])=>{
      const button=action(T(label),'work-plan-tab',()=>selectTab(key));button.id='work-plan-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-controls',key==='outline'?outline.id:characters.id);
      button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'outline':event.key==='End'?'characters':key==='outline'?'characters':'outline';selectTab(next);tabButtons.get(next).focus();});
      tabButtons.set(key,button);tabs.append(button);
    });
    outline.setAttribute('aria-labelledby','work-plan-tab-outline');characters.setAttribute('aria-labelledby','work-plan-tab-characters');
    const full=action('↗','icon-button work-plan-open-outline',()=>{
      const record=candidate.fields.map(field=>records().find(item=>item.id===field.recordId)).find(Boolean)||records()[0];
      if(current(candidate)&&record)jumpToOwner({type:'outline',item:record});
    });
    full.title=T('打开完整大纲');full.setAttribute('aria-label',T('打开完整大纲'));candidate.outlineButton=full;full.disabled=!records().length;
    const dismiss=action('×','icon-button',()=>close(true));dismiss.title=T('关闭作品大纲');dismiss.setAttribute('aria-label',T('关闭作品大纲'));
    tools.append(full,dismiss);header.append(tabs,tools);
    sections.forEach(section=>{
      const group=el('section','work-plan-section work-plan-section-'+section.key),label=el('label','work-plan-section-title',T(section.label)),shell=el('div','work-plan-field'),input=el('textarea','work-plan-input'),hint=el('div','work-plan-hint'),text=el('div','work-plan-hint-text',section.hint()),record=findRecord(section);
      input.id='work-plan-'+section.key;input.rows=8;input.value=record?.body||'';input.spellcheck=false;input.setAttribute('aria-label',T(section.label));label.htmlFor=input.id;
      hint.id=input.id+'-hint';hint.setAttribute('aria-label',T('填写参考'));hint.tabIndex=0;input.setAttribute('aria-describedby',hint.id);hint.append(text);
      const field={section,shell,input,hint,recordId:record?.id||null,composing:false};candidate.fields.push(field);
      input.addEventListener('input',()=>saveField(candidate,field));
      input.addEventListener('compositionstart',()=>{if(!current(candidate))return;field.composing=true;state.composing=true;clearTimeout(state.timer);});
      input.addEventListener('compositionend',()=>{if(!current(candidate))return;field.composing=false;state.composing=false;saveField(candidate,field);});
      hint.addEventListener('click',()=>input.focus());hint.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.focus();}});
      shell.append(input,hint);group.append(label,shell);outline.append(group);setEmpty(field);
    });
    target.replaceChildren(header,outline,characters);candidate.characters=characters;
    selectTab('outline');
  }
  function renderCharacters(candidate){
    const list=candidate.characters;list.replaceChildren();
    const items=people();
    if(!items.length){list.append(el('p','work-plan-empty',T('还没有人物卡片。')));return;}
    items.forEach(person=>{
      const card=action('','work-plan-person',()=>{if(current(candidate))jumpToOwner({type:'person',item:person});});
      card.append(el('strong',null,person.title||T('未命名人物')));
      const meta=[person.profile?.group,person.profile?.role].filter(Boolean).join(' · ');if(meta)card.append(el('small','work-plan-person-meta',meta));
      if(person.body)card.append(el('p','work-plan-person-body',person.body));
      const details=[['目标',person.profile?.desire],['弱点',person.profile?.flaw],['结局',person.profile?.ending]].filter(([,value])=>value);
      details.forEach(([label,value])=>{const row=el('div','work-plan-person-detail');row.append(el('span',null,T(label)),el('span',null,value));card.append(row);});list.append(card);
    });
  }
  function sync(){
    const button=$('writing-plan'),target=panel();if(!button||!target)return;button.disabled=!enabled();
    if(!enabled()){close();return;}
    if(target.hidden)return;
    if(!view||view.book!==state.book||view.kind!==state.kind||view.language!==language())build();
    else{
      for(const field of view.fields){
        if(field.composing||document.activeElement===field.input)continue;
        const record=findRecord(field.section);field.recordId=record?.id||null;const value=record?.body||'';
        if(field.input.value!==value){field.input.value=value;setEmpty(field);}
      }
      view.outlineButton.disabled=!records().length;if(view.tab==='characters')renderCharacters(view);
    }
  }
  function open(){
    if(!enabled()||!panel())return;toggleNotes(false);if(typeof closeAIChat==='function')closeAIChat();
    panel().hidden=false;$('writing-plan')?.setAttribute('aria-expanded','true');$('workspace')?.classList.add('work-plan-open');sync();requestAnimationFrame(resizeEditor);
  }
  function close(focus=false){
    if(!panel())return;const wasOpen=!panel().hidden;panel().hidden=true;$('writing-plan')?.setAttribute('aria-expanded','false');$('workspace')?.classList.remove('work-plan-open');
    if(wasOpen){if(focus)$('writing-plan')?.focus();requestAnimationFrame(resizeEditor);}
  }
  function bind(){
    if(bound||!$('writing-plan')||!panel())return;bound=true;
    $('writing-plan').addEventListener('click',()=>panel().hidden?open():close(true));
    panel().addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('dialog')?.open){event.preventDefault();close(true);}});
    sync();
  }
  return{bind,sync,open,close,isOpen:()=>!!panel()&&!panel().hidden};
})();
