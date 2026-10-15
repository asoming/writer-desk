'use strict';

// Literal matching uses RegExp only for Unicode case folding; replacement text
// is returned by a callback so "$&" and "$1" stay exactly as the author typed.
(function(global){
  function codepoints(text){let n=0;for(const char of text)n++;return n;}
  function expression(query,caseSensitive){return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),caseSensitive?'gu':'giu');}
  function preview(book,query,replacement='',caseSensitive=true){
    if(typeof query!=='string'||!query.length)throw new Error('请输入查找文字。');
    if(query.length>10000||typeof replacement!=='string'||replacement.length>10000)throw new Error('查找或替换文字不能超过 10000 字。');
    const encoder=new TextEncoder(),jsonSize=text=>encoder.encode(JSON.stringify(text)).length-2;
    let projected=encoder.encode(JSON.stringify(book)).length;
    const replacementBytes=jsonSize(replacement),sources=book.chapters.filter(c=>!c.deletedAt).map(c=>({id:c.id,body:c.body})),groups=[];
    for(const source of sources){
      let total=0,removedUnits=0,removedBytes=0;const samples=[],sizes=new Map();
      for(const match of source.body.matchAll(expression(query,caseSensitive))){
        const text=match[0],offset=match.index;total++;removedUnits+=codepoints(text);
        if(!sizes.has(text))sizes.set(text,jsonSize(text));removedBytes+=sizes.get(text);
        if(samples.length<6)samples.push({start:offset,end:offset+text.length,text,before:source.body.slice(Math.max(0,offset-35),offset),after:source.body.slice(offset+text.length,offset+text.length+35)});
      }
      if(total){
        const length=codepoints(source.body)-removedUnits+total*codepoints(replacement);
        if(length>(book.kind==='short'?25000000:5000000))throw new Error('替换后正文过长，请缩小替换范围。');
        projected+=total*replacementBytes-removedBytes;
        groups.push({id:source.id,before:source.body,total,samples});
      }
    }
    // Budget the entire operation before allocating even one expanded draft.
    if(projected>25*1024*1024)throw new Error('替换后作品超过 25 MB，请缩小替换范围。');
    for(const group of groups)group.after=group.before.replace(expression(query,caseSensitive),()=>replacement);
    return{bookId:book.id,sources,groups,total:groups.reduce((n,g)=>n+g.total,0)};
  }
  function apply(book,plan,selected){
    const active=book.chapters.filter(c=>!c.deletedAt);
    if(book.id!==plan.bookId||active.length!==plan.sources.length||plan.sources.some(s=>!active.some(c=>c.id===s.id&&c.body===s.body)))throw new Error('正文已变化，请重新预览。');
    const ids=new Set(selected),changes=plan.groups.filter(g=>ids.has(g.id));
    const byId=new Map(changes.map(group=>[group.id,group.after])),candidate={...book,chapters:book.chapters.map(chapter=>byId.has(chapter.id)?{...chapter,body:byId.get(chapter.id)}:chapter)};
    if(new TextEncoder().encode(JSON.stringify(candidate)).length>25*1024*1024)throw new Error('替换后作品超过 25 MB，请缩小替换范围。');
    for(const group of changes)active.find(c=>c.id===group.id).body=group.after;
    return changes.reduce((n,g)=>n+g.total,0);
  }
  async function open(){
    if(!state.book||state.composing||state.transitioning||!await requireSaved())return;
    const bookId=state.book.id,root=el('div','book-search-tools'),fields=el('div','book-search-fields'),query=el('input','text-field'),replacement=el('input','text-field');
    query.maxLength=replacement.maxLength=10000;query.type='search';query.setAttribute('aria-label',T('查找文字'));query.placeholder=T('查找文字');replacement.setAttribute('aria-label',T('替换为'));replacement.placeholder=T('替换为');
    const sensitive=el('input'),label=el('label','checkbox-row');sensitive.type='checkbox';sensitive.checked=true;label.append(sensitive,el('span',null,T('区分大小写')));
    const status=el('p','subtle'),list=el('div','book-search-results'),buttons=el('div','dialog-actions'),replace=action(T('替换选中章节'),'primary-button',replaceSelected);replace.disabled=true;
    fields.append(query,replacement,label);buttons.append(replace);root.append(fields,status,list,buttons);showDialog(T('全书查找与替换'),root);
    let plan=null,selected=new Set(),timer;
    const visible=()=>root.isConnected&&$('dialog').open&&state.book?.id===bookId;
    function render(){
      if(!visible())return;plan=null;selected.clear();list.replaceChildren();replace.disabled=true;
      if(!query.value){status.textContent='';return;}
      try{plan=preview(state.book,query.value,replacement.value,sensitive.checked);}catch(error){status.textContent=T(error.message);return;}
      status.textContent=T('{0} 处匹配 · {1} 章',plan.total.toLocaleString(),plan.groups.length);
      for(const group of plan.groups){
        selected.add(group.id);const chapter=state.book.chapters.find(c=>c.id===group.id),row=el('section','book-search-group'),check=el('input'),heading=el('label','checkbox-row');check.type='checkbox';check.checked=true;
        heading.append(check,el('strong',null,state.book.kind==='short'?T('正文'):chapter.title||T('未命名章节')),el('small',null,T('{0} 处',group.total)));check.addEventListener('change',()=>{check.checked?selected.add(group.id):selected.delete(group.id);replace.disabled=!selected.size;});row.append(heading);
        for(const sample of group.samples){const snippet=action('','book-search-match',()=>locate(group.id,sample));snippet.append(document.createTextNode(sample.before),el('mark',null,sample.text));if(replacement.value!==sample.text)snippet.append(el('span','search-replacement',replacement.value?' → '+replacement.value.slice(0,200)+(replacement.value.length>200?'…':''):' → '+T('删除')));snippet.append(document.createTextNode(sample.after));row.append(snippet);}
        if(group.total>group.samples.length)row.append(el('small','subtle',T('预览前 {0} 处，替换会包含本章全部匹配。',group.samples.length)));
        list.append(row);
      }
      replace.disabled=!plan.total;
    }
    function changed(event){clearTimeout(timer);plan=null;replace.disabled=true;if(!event.isComposing)timer=setTimeout(render,180);}
    for(const control of [query,replacement,sensitive]){control.addEventListener('input',changed);control.addEventListener('compositionend',()=>{clearTimeout(timer);timer=setTimeout(render,0);});}
    async function locate(id,sample){
      if(!visible()||!plan)return;const chapter=state.book.chapters.find(c=>c.id===id),source=plan.sources.find(s=>s.id===id);if(!chapter||chapter.body!==source.body){render();toast(T('正文已变化，请重新预览。'));return;}
      await jumpToChapter(id);if(state.book?.id!==bookId||state.chapterId!==id||$('dialog').open)return;
      const editor=$('editor');editor.focus({preventScroll:true});editor.setSelectionRange(sample.start,sample.end);
      // A hidden prefix uses the editor's real wrapping and font to locate long
      // chapters without resetting the live text area or its undo history.
      const marker=el('div');marker.style.cssText='position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none;';const css=getComputedStyle(editor);
      for(const key of ['font','letterSpacing','lineHeight','padding','boxSizing','wordBreak'])marker.style[key]=css[key];marker.style.width=editor.getBoundingClientRect().width+'px';marker.textContent=editor.value.slice(0,sample.start)+'\u200b';editor.parentElement.append(marker);
      const area=$('writing-area'),behavior=area.style.scrollBehavior;area.style.scrollBehavior='auto';area.scrollTop=Math.max(0,editor.offsetTop+marker.offsetHeight-area.clientHeight/3);area.style.scrollBehavior=behavior;marker.remove();
    }
    async function replaceSelected(){
      if(!visible()||!plan||!selected.size||state.composing)return;replace.disabled=true;clearTimeout(timer);const confirmedPlan=plan,confirmedSelection=[...selected];
      try{await transition(async()=>{if(!visible()||!await requireSaved()||!visible())return;const total=apply(state.book,confirmedPlan,confirmedSelection);markDirty();if(currentChapter()){$('editor').value=currentChapter().body;resizeEditor();}renderChapters();renderStats();if(await saveNow()){toast(T('已替换 {0} 处，原稿已保留在历史版本。',total));render();}});}catch(error){toast(T(error.message));render();}finally{if(visible())replace.disabled=!plan?.total||!selected.size;}
    }
    query.focus();
  }
  const model={preview,apply,expression};if(typeof module==='object'&&module.exports)module.exports=model;
  else global.WriterBookSearch={...model,open};
})(typeof window==='undefined'?globalThis:window);
