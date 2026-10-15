'use strict';

// All analysis runs in this window. This controller never calls an AI or a
// remote endpoint; saveNow follows the same local history/draft path as typing.
window.LocalProofreading=(()=>{
  const model=window.LocalProofreadingModel;
  async function show({chapterId=state.chapterId}={}){
    const requestedBook=state.book;if(!requestedBook||state.composing||state.transitioning||!await requireSaved()||state.book!==requestedBook)return;
    const owner=requestedBook,bookId=owner.id,root=el('div','local-proofreading'),toolbar=el('div','proofreading-toolbar'),scope=el('select','text-field'),status=el('p','subtle proofreading-status'),list=el('div','proofreading-results'),footer=el('div','dialog-actions');
    for(const [value,label]of [['chapter','当前章'],['book','全书']]){const option=el('option',null,T(owner.kind==='short'&&value==='chapter'?'正文':label));option.value=value;scope.append(option);}
    scope.value=chapterId?'chapter':'book';scope.setAttribute('aria-label',T('校对范围'));
    const scan=action(T('重新校对'),'secondary-button',scanAgain),selectAll=el('input'),selectLabel=el('label','checkbox-row'),apply=action(T('修正选中'),'primary-button',applyChanges);
    selectAll.type='checkbox';selectAll.setAttribute('aria-label',T('选择可修正项'));selectLabel.append(selectAll,el('span',null,T('选择可修正项')));
    toolbar.append(scope,scan,selectLabel);footer.append(apply);root.append(toolbar,status,list,dictionaryPanel(),footer);showDialog(T('本地校对'),root);
    let plan=null,selected=new Set(),ignored=new Set(),checks=new Map(),busy=false;
    const visible=()=>root.isConnected&&$('dialog').open&&state.book===owner&&state.book?.id===bookId;
    function updateSelection(){const available=plan?.findings.filter(item=>item.fixable&&!ignored.has(item.id))||[];selectAll.checked=!!available.length&&available.every(item=>selected.has(item.id));selectAll.indeterminate=!!selected.size&&!selectAll.checked;selectAll.disabled=busy||!available.length;apply.disabled=busy||!selected.size;for(const [id,check]of checks)check.disabled=busy||!plan?.findings.some(item=>item.id===id&&item.fixable);}
    selectAll.addEventListener('change',()=>{for(const item of plan?.findings||[])if(item.fixable&&!ignored.has(item.id))selectAll.checked?selected.add(item.id):selected.delete(item.id);renderResults();});
    scope.addEventListener('change',()=>{ignored.clear();scanAgain();});
    function renderResults(){
      if(!visible())return;list.replaceChildren();checks.clear();
      const results=plan?.findings.filter(item=>!ignored.has(item.id))||[],fixable=results.filter(item=>item.fixable).length;
      status.textContent=plan?T('{0} 处提示 · {1} 处可修正',results.length.toLocaleString(),fixable.toLocaleString())+(plan.truncated?' · '+T('仅显示前 {0} 处，请缩小范围。',plan.limit.toLocaleString()):''):'';
      if(plan&&!results.length)list.append(el('p','proofreading-empty',T('未发现规则内的问题。')));
      let previous=null;
      for(const finding of results){
        if(previous!==finding.chapterId){previous=finding.chapterId;const chapter=owner.chapters.find(item=>item.id===previous);list.append(el('h3','proofreading-chapter',owner.kind==='short'?T('正文'):chapter.title||T('未命名章节')));}
        const row=el('section','proofreading-result'),heading=el('div','proofreading-result-heading'),check=el('input');check.type='checkbox';check.checked=selected.has(finding.id);check.disabled=busy||!finding.fixable;checks.set(finding.id,check);check.setAttribute('aria-label',T('选择修正：{0}',finding.text));check.addEventListener('change',()=>{check.checked?selected.add(finding.id):selected.delete(finding.id);updateSelection();});
        heading.append(check,el('strong',null,T(finding.label)),el('span','subtle',finding.fixable?finding.text+' → '+finding.replacement:T('仅提示')));
        const context=action('','proofreading-context',()=>locate(finding));context.append(document.createTextNode(finding.before),el('mark',null,finding.text),document.createTextNode(finding.after));
        const actions=el('div','proofreading-result-actions');actions.append(action(T('忽略'),'text-button',()=>{ignored.add(finding.id);selected.delete(finding.id);renderResults();}),action(T('加入词典'),'text-button',()=>addWord(finding.text)));
        row.append(heading,context,actions);list.append(row);
      }
      updateSelection();
    }
    async function scanAgain(){
      if(!visible()||busy||state.composing)return;busy=true;apply.disabled=scan.disabled=true;
      try{if(!await requireSaved()||!visible())return;ignored.clear();plan=model.preview(owner,{chapterId:scope.value==='chapter'?chapterId:null,revision:state.revision});selected.clear();renderResults();}catch(error){if(visible()){status.textContent=T(error.message);plan=null;list.replaceChildren();}}finally{busy=false;if(visible()){scan.disabled=false;updateSelection();}}
    }
    async function applyChanges(){
      if(!visible()||busy||state.composing||!plan||!selected.size)return;
      const confirmed=plan,ids=[...selected];busy=true;scan.disabled=apply.disabled=true;
      try{await transition(async()=>{
        if(!visible()||!await requireSaved()||!visible())return;
        const total=model.applySelected(owner,confirmed,ids,{revision:state.revision});
        // Invalidate immediately: persistence failure retains one dirty draft,
        // and a second click cannot apply the original replacements twice.
        plan=null;selected.clear();ignored.clear();
        if(!total)return;markDirty();const chapter=currentChapter();if(chapter){$('editor').value=chapter.body;resizeEditor();}renderChapters();renderStats();
        if(await saveNow()){if(visible()){plan=model.preview(owner,{chapterId:scope.value==='chapter'?chapterId:null,revision:state.revision});renderResults();}toast(T('已修正 {0} 处，原稿已保留在历史版本。',total));}
        else if(visible()){list.replaceChildren();status.textContent=T('修正已保留在当前稿，请重试保存后重新校对。');}
      });}catch(error){if(visible()){toast(T(error.message));plan=null;list.replaceChildren();status.textContent=T('请重新校对。');}}finally{busy=false;if(visible()){scan.disabled=false;updateSelection();}}
    }
    async function locate(finding){
      if(!visible()||busy||!plan)return;
      try{model.assertCurrent(owner,plan,state.revision);}catch(error){toast(T(error.message));return;}
      if(await jumpToChapter(finding.chapterId)===false)return;if(state.book!==owner||state.chapterId!==finding.chapterId||$('dialog').open)return;
      const editor=$('editor');editor.focus({preventScroll:true});editor.setSelectionRange(finding.start,finding.end);
      const marker=el('div');marker.style.cssText='position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none;';const css=getComputedStyle(editor);
      for(const key of ['font','letterSpacing','lineHeight','padding','boxSizing','wordBreak'])marker.style[key]=css[key];marker.style.width=editor.getBoundingClientRect().width+'px';marker.textContent=editor.value.slice(0,finding.start)+'\u200b';editor.parentElement.append(marker);
      const area=$('writing-area'),behavior=area.style.scrollBehavior;area.style.scrollBehavior='auto';area.scrollTop=Math.max(0,editor.offsetTop+marker.offsetHeight-area.clientHeight/3);area.style.scrollBehavior=behavior;marker.remove();
    }
    function dictionaryPanel(){
      const details=el('details','proofreading-dictionary');details.append(el('summary',null,T('规则与词典')));
      details.append(el('p','subtle',T('离线检查少量常见错词、重复词和标点配对。人物姓名与词典内的词受保护；提示不会自动修改。')));
      const form=el('form','proofreading-dictionary-form'),input=el('input','text-field'),add=el('button','secondary-button',T('添加'));input.setAttribute('aria-label',T('自定义词语'));input.placeholder=T('自定义词语');input.maxLength=200;add.type='submit';form.append(input,add);
      form.addEventListener('submit',async event=>{event.preventDefault();if(await addWord(input.value))input.value='';});details.append(form,el('div','proofreading-dictionary-words'));return details;
    }
    function renderDictionary(){
      const words=owner.reviewTools?.dictionary||[],container=root.querySelector('.proofreading-dictionary-words');container.replaceChildren();
      for(const word of words){const chip=action(word+' ×','proofreading-word',()=>changeDictionary(word,false));chip.setAttribute('aria-label',T('从词典移除：{0}',word));container.append(chip);}
    }
    async function addWord(raw){return changeDictionary(String(raw).trim(),true);}
    async function changeDictionary(word,adding){
      if(!visible()||busy||state.composing||!word)return false;
      if(Array.from(word).length>100){toast(T('词语不能超过 100 字。'));return false;}
      const words=owner.reviewTools?.dictionary||[];if(adding&&words.includes(word))return true;
      if(adding&&words.length>=model.MAX_DICTIONARY){toast(T('词典最多保存 500 个词语。'));return false;}
      busy=true;scan.disabled=apply.disabled=true;let changed=false;
      try{await transition(async()=>{if(!visible()||!await requireSaved()||!visible())return;
        const latest=owner.reviewTools?.dictionary||[];if(adding&&latest.includes(word))return;if(adding&&latest.length>=model.MAX_DICTIONARY){toast(T('词典最多保存 500 个词语。'));return;}owner.reviewTools??={dictionary:[],annotations:[],bookmarks:[]};owner.reviewTools.dictionary=adding?[...latest,word]:latest.filter(item=>item!==word);changed=true;plan=null;selected.clear();ignored.clear();markDirty();renderDictionary();list.replaceChildren();
        if(await saveNow()){if(visible()){plan=model.preview(owner,{chapterId:scope.value==='chapter'?chapterId:null,revision:state.revision});renderResults();}}
        else if(visible())status.textContent=T('词典修改已保留，请重试保存。');
      });}catch(error){toast(T(error.message));}finally{busy=false;if(visible()){scan.disabled=false;updateSelection();}}return changed;
    }
    renderDictionary();await scanAgain();
  }
  return{show};
})();
