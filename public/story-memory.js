'use strict';

window.WriterStoryMemory={async sourceHash(chapter){const bytes=new TextEncoder().encode((chapter.title||'')+'\n'+(chapter.body||''));const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');},async open(book,options={}){
  if(state.composing||state.transitioning||!await requireSaved()||state.book!==book)return;
  const content=el('div','story-memory-browser'),status=el('p','subtle',T('正在读取长篇记忆…'));content.append(status);showDialog(T('长篇记忆'),content);
  const current=()=>state.book===book&&$('dialog').open&&content.isConnected;let pending=false;
  try{
    const index=await api('/api/books/'+encodeURIComponent(book.id)+'/memory');if(!current())return;
    if(index.bookId!==book.id||typeof index.enabled!=='boolean'||!Array.isArray(index.entries))throw Error(T('长篇记忆无效，请重试。'));
    const enabled=el('input'),toggle=el('label','checkbox-row'),description=el('p','subtle',T('本地摘录，不调用 AI。续写时自动选取相关前文；已勾选正文仍完整发送。'));
    enabled.type='checkbox';enabled.checked=index.enabled;toggle.append(enabled,el('span',null,T('自动选取长篇记忆')));
    const selector=el('select','text-field'),editor=el('div','story-memory-editor'),actions=el('div','dialog-actions'),drafts=new Map(),fields={};
    selector.setAttribute('aria-label',T('记忆来源章节'));
    index.entries.forEach(entry=>{const option=el('option',null,entry.title+(entry.stale?' · '+T('已过期'):''));option.value=entry.chapterId;selector.append(option);});
    let selected=null;
    function collect(){if(!selected)return;drafts.set(selected.chapterId,{chapterId:selected.chapterId,sourceHash:selected.sourceHash,...Object.fromEntries(Object.entries(fields).map(([name,input])=>[name,input.value]))});}
    function render(){
      selected=index.entries.find(entry=>entry.chapterId===selector.value)||null;editor.replaceChildren();Object.keys(fields).forEach(key=>delete fields[key]);if(!selected){editor.append(el('p','empty-hint',T('写下正文后自动建立章节记忆。')));return;}
      const entry=selected,draft=drafts.get(entry.chapterId),heading=el('div','story-memory-heading'),source=action(T('查看来源'),'text-button',()=>{if(!current()||pending)return;collect();$('dialog').close();jumpToChapter(entry.chapterId);});
      heading.append(el('strong',null,entry.title),source);editor.append(heading,el('p','subtle',entry.stale?T('正文已变化，旧摘要已过期。AI 使用最新本地摘录；保存后可确认新的摘要。'):entry.source==='author'?T('作者维护 · 与当前正文一致'):T('本地摘录 · 人物状态仅为最近提及，需结合原文核查')));
      for(const [name,label] of [['summary','章节摘要'],['characterStates','人物状态'],['settingNotes','设定与规则']]){const input=el('textarea','text-field');input.rows=name==='summary'?7:4;input.maxLength=4000;input.value=draft?.[name]??entry[name];input.setAttribute('aria-label',T(label));fields[name]=input;addField(editor,T(label),input);}
      editor.append(action(T('恢复本地摘录'),'text-button',()=>{if(pending)return;for(const name of Object.keys(fields))fields[name].value=entry.automatic[name];collect();}));
      if(entry.stale&&entry.saved){const old=el('details','story-memory-old');old.append(el('summary',null,T('查看过期摘要')),el('p',null,entry.saved.summary),el('p',null,entry.saved.characterStates),el('p',null,entry.saved.settingNotes));editor.append(old);}
    }
    selector.addEventListener('change',()=>{collect();render();});selector.value=index.entries[0]?.chapterId||'';
    const save=action(T('保存记忆'),'primary-button',async()=>{
      if(pending||!current())return;collect();pending=true;save.disabled=selector.disabled=enabled.disabled=true;Object.values(fields).forEach(field=>field.disabled=true);
      try{
        if(!await requireSaved()||!current())return;
        const previous=book.storyMemory?.entries||[],known=new Set(index.entries.map(entry=>entry.chapterId));
        book.storyMemory={version:1,enabled:enabled.checked,entries:[...previous.filter(entry=>known.has(entry.chapterId)&&!drafts.has(entry.chapterId)),...drafts.values()]};markDirty();
        if(!await requireSaved()||!current())return;options.onChanged?.();$('dialog').close();toast(T('长篇记忆已保存。'));
      }catch(error){if(current())status.textContent=T(error.message);}
      finally{pending=false;if(current()){save.disabled=selector.disabled=enabled.disabled=false;Object.values(fields).forEach(field=>field.disabled=false);}}
    });actions.append(save);status.textContent='';content.replaceChildren(toggle,description,selector,editor,status,actions);render();
  }catch(error){if(current())status.textContent=T(error.message);}
}};
