'use strict';
(function(global){
  // Preserve separators in the tokens: choosing a change must reproduce exact
  // newlines, including a deleted last paragraph and empty manuscripts.
  const paragraphs=text=>text.match(/[^\n]+(?:\n+|$)|\n+/g)||[];
  function diff(previous,current){
    const old=paragraphs(previous),now=paragraphs(current),parts=[];
    function push(kind,text){if(!text)return;const last=parts.at(-1);if(last?.kind===kind)last.text+=text;else parts.push({kind,text});}
    let start=0,endOld=old.length,endNow=now.length;
    while(start<endOld&&start<endNow&&old[start]===now[start])start++;
    while(endOld>start&&endNow>start&&old[endOld-1]===now[endNow-1]){endOld--;endNow--;}
    push('equal',old.slice(0,start).join(''));
    const a=old.slice(start,endOld),b=now.slice(start,endNow);
    if(a.length*b.length>2000000){push('removed',a.join(''));push('added',b.join(''));}
    else{
      const widths=b.length+1,table=Array.from({length:a.length+1},()=>new Uint32Array(widths));
      for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i][j]=a[i]===b[j]?1+table[i+1][j+1]:Math.max(table[i+1][j],table[i][j+1]);
      let i=0,j=0;while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){push('equal',a[i]);i++;j++;}else if(i<a.length&&(j===b.length||table[i+1][j]>=table[i][j+1]))push('removed',a[i++]);else push('added',b[j++]);}
    }
    push('equal',old.slice(endOld).join(''));
    const hunks=[];let offset=0;
    for(const part of parts){if(part.kind==='equal'){hunks.push({equal:part.text});offset+=part.text.length;}else{let hunk=hunks.at(-1);if(!hunk||hunk.equal!==undefined){hunk={id:offset+':'+hunks.length,before:'',after:''};hunks.push(hunk);}hunk[part.kind==='removed'?'before':'after']+=part.text;if(part.kind==='added')offset+=part.text.length;}}
    return hunks.flatMap((h,index)=>{if(h.equal!==undefined)return[h];const before=paragraphs(h.before),after=paragraphs(h.after);return Array.from({length:Math.max(before.length,after.length)},(_,part)=>({id:index+':'+part,before:before[part]||'',after:after[part]||''}));});
  }
  function codepoints(text){let n=0;for(const char of text)n++;return n;}
  function restore(hunks,selected){const ids=new Set(selected);return hunks.map(h=>h.equal!==undefined?h.equal:ids.has(h.id)?h.before:h.after).join('');}
  function open(snapshot,bookId,preferredChapterId){
    if(state.book?.id!==bookId){toast(T('请先从书架打开这部作品，再对比正文。'));return;}
    const root=el('div','version-diff-tools'),selector=el('select','text-field'),list=el('div','version-diff-list'),info=el('p','subtle'),buttons=el('div','dialog-actions');
    const active=state.book.chapters.filter(c=>!c.deletedAt),oldActive=snapshot.book.chapters.filter(c=>!c.deletedAt),shared=active.filter(c=>oldActive.some(o=>o.id===c.id));
    if(!shared.length){toast(T('这版没有可以对比的当前正文。'));return;}
    for(const chapter of shared){const option=el('option',null,state.book.kind==='short'?T('正文'):chapter.title||T('未命名章节'));option.value=chapter.id;selector.append(option);}
    selector.setAttribute('aria-label',T('对比章节'));const preferred=preferredChapterId||state.chapterId;if(shared.some(c=>c.id===preferred))selector.value=preferred;selector.hidden=state.book.kind==='short';
    const applyButton=action(T('恢复选中段落'),'primary-button',applySelected);buttons.append(applyButton);root.append(selector,info,list,buttons);showDialog(T('版本差异对比'),root);
    let source='',hunks=[],selected=new Set(),chapterId;
    const visible=()=>root.isConnected&&$('dialog').open&&state.book?.id===bookId;
    function render(){
      if(!visible())return;chapterId=selector.value;source=state.book.chapters.find(c=>c.id===chapterId).body;const old=oldActive.find(c=>c.id===chapterId).body;hunks=diff(old,source);selected.clear();list.replaceChildren();
      const changes=hunks.filter(h=>h.equal===undefined);info.textContent=changes.length?T('{0} 处变化 · 红色为旧稿，绿色为当前稿',changes.length):T('两版正文相同。');
      for(const hunk of hunks){if(hunk.equal!==undefined){list.append(el('p','version-diff-equal',hunk.equal));continue;}const row=el('section','version-diff-change'),check=el('input'),label=el('label','checkbox-row');check.type='checkbox';label.append(check,el('span',null,T('恢复这一处旧稿')));row.append(label);if(hunk.before)row.append(el('del',null,hunk.before));if(hunk.after)row.append(el('ins',null,hunk.after));check.addEventListener('change',()=>{check.checked?selected.add(hunk.id):selected.delete(hunk.id);applyButton.disabled=!selected.size;});list.append(row);}
      applyButton.disabled=true;
    }
    async function applySelected(){
      if(!visible()||!selected.size||state.composing)return;applyButton.disabled=true;const confirmed={chapterId,source,hunks,selected:[...selected]};
      try{await transition(async()=>{if(!visible()||!await requireSaved()||!visible())return;const chapter=state.book.chapters.find(c=>c.id===confirmed.chapterId&&!c.deletedAt);if(!chapter||chapter.body!==confirmed.source)throw new Error('正文已变化，请重新预览。');const body=restore(confirmed.hunks,confirmed.selected),candidate={...state.book,chapters:state.book.chapters.map(item=>item===chapter?{...item,body}:item)};
      if(codepoints(body)>(state.book.kind==='short'?25000000:5000000)||new TextEncoder().encode(JSON.stringify(candidate)).length>25*1024*1024)throw new Error('恢复后的正文过长，请减少勾选段落。');chapter.body=body;markDirty('restore');if(state.chapterId===confirmed.chapterId){$('editor').value=chapter.body;resizeEditor();}renderChapters();renderStats();if(await saveNow()){toast(T('选中段落已恢复，恢复前的稿件已保留。'));render();}});}catch(error){toast(T(error.message));render();}finally{if(visible())applyButton.disabled=!selected.size;}
    }
    selector.addEventListener('change',render);render();
  }
  const model={paragraphs,diff,restore};if(typeof module==='object'&&module.exports)module.exports=model;
  else global.WriterVersionDiff={...model,open};
})(typeof window==='undefined'?globalThis:window);
