'use strict';

// Structural edits are planned on a copy. Their literal source fingerprint is
// checked after the pre-save gate, before a single live field is changed.
(function(global){
  const copy=value=>JSON.parse(JSON.stringify(value));
  const active=items=>(items||[]).filter(item=>!item.deletedAt);
  const unique=values=>[...new Set(values)];
  function boundary(text,index){return Number.isInteger(index)&&index>=0&&index<=text.length&&!(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]));}
  function ensureLong(book){if(!book||book.kind!=='long')throw new Error('短篇保留一份连续正文。');}
  function exactIds(items,ids){if(!Array.isArray(ids)||ids.length!==items.length||unique(ids).length!==ids.length||ids.some(id=>!items.some(item=>item.id===id)))throw new Error('卷章顺序已变化，请重新打开。');}
  function owners(book){return[...(book.notes||[]),...(book.outline||[]),...(book.relations||[]),...(book.storyTools?.foreshadows||[]),...(book.storyTools?.timeline||[]),...(book.assetLibrary?.items||[])];}
  function remapOwners(book,mapping){for(const owner of owners(book))if(Array.isArray(owner.chapterIds))owner.chapterIds=unique(owner.chapterIds.flatMap(id=>mapping.get(id)||[id]));}
  function context(text,start,end){let left=Math.max(0,start-64),right=Math.min(text.length,end+64);if(!boundary(text,left))left++;if(!boundary(text,right))right--;return{prefix:text.slice(left,start),suffix:text.slice(end,right)};}
  function anchor(mark,chapter,start,end){return{...mark,chapterId:chapter.id,start,end,quote:chapter.body.slice(start,end),...context(chapter.body,start,end)};}
  function checkCapacity(book){
    if((book.chapters||[]).length>10000)throw new Error('作品最多保留 10000 章，请先整理历史章节。');
    for(const key of ['annotations','bookmarks'])if((book.reviewTools?.[key]||[]).length>5000)throw new Error('拆分后批注或书签超过 5000 条，请先整理。');
    if((book.chapters||[]).some(chapter=>Array.from(chapter.body).length>5000000))throw new Error('合并后正文过长，请减少章节。');
    if(new TextEncoder().encode(JSON.stringify(book)).length>25*1024*1024)throw new Error('整理后作品超过 25 MB，请减少章节。');
  }
  function plan(book,operation,...args){const before=JSON.stringify(book),candidate=copy(book),result=operation(candidate,...args);checkCapacity(candidate);return{bookId:book.id,before,candidate,result};}
  function apply(book,prepared){if(book?.id!==prepared.bookId||JSON.stringify(book)!==prepared.before)throw new Error('作品已变化，请重新操作。');for(const key of Object.keys(book))if(!Object.hasOwn(prepared.candidate,key))delete book[key];Object.assign(book,copy(prepared.candidate));return prepared.result;}
  function reorder(book,key,ids){ensureLong(book);if(!['chapters','volumes'].includes(key))throw new Error('卷章顺序已变化，请重新打开。');const list=active(book[key]);exactIds(list,ids);const map=new Map(list.map(item=>[item.id,item]));let index=0;book[key]=book[key].map(item=>item.deletedAt?item:map.get(ids[index++]));return{chapterId:null};}
  function moveChapters(book,ids,volumeId,beforeId=null){
    ensureLong(book);const chapters=active(book.chapters),selection=new Set(ids);
    if(!selection.size||selection.size!==ids.length||ids.some(id=>!chapters.some(chapter=>chapter.id===id))||(volumeId!==null&&!active(book.volumes).some(volume=>volume.id===volumeId)))throw new Error('请选择有效的章节与卷。');
    const moved=chapters.filter(chapter=>selection.has(chapter.id)),remaining=book.chapters.filter(chapter=>!selection.has(chapter.id)),volumeIds=new Set(active(book.volumes).map(volume=>volume.id));
    const inTarget=chapter=>volumeId===null?!volumeIds.has(chapter.volumeId):chapter.volumeId===volumeId;
    if(beforeId!==null&&!remaining.some(chapter=>chapter.id===beforeId&&!chapter.deletedAt&&inTarget(chapter)))throw new Error('目标章节已变化，请重新操作。');
    for(const chapter of moved)chapter.volumeId=volumeId;
    let position=beforeId===null?-1:remaining.findIndex(chapter=>chapter.id===beforeId);
    if(position<0){for(let i=0;i<remaining.length;i++)if(!remaining[i].deletedAt&&inTarget(remaining[i]))position=i+1;if(position<0)position=remaining.length;}
    remaining.splice(position,0,...moved);book.chapters=remaining;return{chapterId:moved[0].id};
  }
  function splitChapter(book,id,start,end=start,{uid=()=>global.crypto.randomUUID()}={}){
    ensureLong(book);const chapter=active(book.chapters).find(item=>item.id===id);
    if(!chapter||!boundary(chapter.body,start)||!boundary(chapter.body,end)||start>end)throw new Error('拆分位置已变化，请重新选择。');
    const original=chapter.body,spans=(start===end?[[0,start],[start,original.length]]:[[0,start],[start,end],[end,original.length]]).filter(([left,right])=>left<right);
    if(spans.length<2)throw new Error('请将光标放在正文中间，或选择需要独立成章的文字。');
    const occupied=new Set([...book.chapters.map(item=>item.id),...(book.reviewTools?.annotations||[]).map(item=>item.id),...(book.reviewTools?.bookmarks||[]).map(item=>item.id)]);
    const fresh=()=>{const value=uid();if(typeof value!=='string'||!value||value.length>100||occupied.has(value))throw new Error('新章节编号冲突，请重试。');occupied.add(value);return value;};
    const pieces=spans.map(([left,right],index)=>({...chapter,id:index?fresh():chapter.id,title:index?Array.from(chapter.title+' · '+(index+1)).slice(0,200).join(''):chapter.title,body:original.slice(left,right)}));
    book.chapters.splice(book.chapters.indexOf(chapter),1,...pieces);remapOwners(book,new Map([[id,pieces.map(piece=>piece.id)]]));
    for(const key of ['annotations','bookmarks'])if(book.reviewTools?.[key])book.reviewTools[key]=book.reviewTools[key].flatMap(mark=>{
      if(mark.chapterId!==id)return[mark];
      if(mark.status==='orphaned'||original.slice(mark.start,mark.end)!==mark.quote)return[{...mark,chapterId:pieces[0].id,status:'orphaned',prefix:'',suffix:''}];
      const fragments=[];
      spans.forEach(([left,right],index)=>{const from=Math.max(left,mark.start),to=Math.min(right,mark.end);if(from<to)fragments.push(anchor({...mark,id:fragments.length?fresh():mark.id},pieces[index],from-left,to-left));});
      return fragments.length?fragments:[{...mark,status:'orphaned',prefix:'',suffix:''}];
    });
    if(book.storyMemory?.entries){const memory=book.storyMemory.entries.find(entry=>entry.chapterId===id);if(memory)book.storyMemory.entries.push(...pieces.slice(1).map(piece=>({...copy(memory),chapterId:piece.id})));}
    return{chapterId:pieces[Math.min(start===end?1:spans.findIndex(([left,right])=>left===start&&right===end),pieces.length-1)]?.id||pieces[0].id,ids:pieces.map(piece=>piece.id)};
  }
  function mergeChapters(book,ids,{separator='\n\n',stamp=new Date().toISOString()}={}){
    ensureLong(book);const list=active(book.chapters),chosen=list.filter(chapter=>ids.includes(chapter.id));
    if(chosen.length<2||chosen.length!==unique(ids).length||chosen.length!==ids.length||typeof separator!=='string'||separator.length>10)throw new Error('请选择至少两个连续章节。');
    const volume=chosen[0].volumeId,group=list.filter(chapter=>chapter.volumeId===volume),positions=chosen.map(chapter=>group.indexOf(chapter));
    if(chosen.some(chapter=>chapter.volumeId!==volume)||positions.some((position,index)=>index&&position!==positions[index-1]+1))throw new Error('只能合并同一卷内的连续章节。');
    const target=chosen[0],offsets=new Map();let offset=0;
    for(const chapter of chosen){offsets.set(chapter.id,offset);offset+=chapter.body.length+separator.length;}
    const sourceBodies=new Map(chosen.map(chapter=>[chapter.id,chapter.body])),mergedBody=chosen.map(chapter=>chapter.body).join(separator),mapping=new Map(chosen.map(chapter=>[chapter.id,[target.id]]));
    // Preserve authored memory notes. Refuse an overlong combination instead
    // of silently dropping text or copying it into an unrelated chapter.
    if(book.storyMemory?.entries){const memories=chosen.map(chapter=>book.storyMemory.entries.find(entry=>entry.chapterId===chapter.id)).filter(Boolean);if(memories.length){const combined={...copy(memories[0]),chapterId:target.id};for(const key of ['summary','characterStates','settingNotes']){combined[key]=memories.map(entry=>entry[key]).filter(Boolean).join('\n\n');if(Array.from(combined[key]).length>4000)throw new Error('合并后的作者记忆超过 4000 字，请先整理记忆。');}book.storyMemory.entries=book.storyMemory.entries.filter(entry=>entry.chapterId!==target.id);book.storyMemory.entries.push(combined);}}
    target.body=mergedBody;for(const chapter of chosen.slice(1))chapter.deletedAt=stamp;
    remapOwners(book,mapping);
    for(const key of ['annotations','bookmarks'])for(const mark of book.reviewTools?.[key]||[]){if(!offsets.has(mark.chapterId))continue;const source=mark.chapterId,delta=offsets.get(source);mark.chapterId=target.id;if(mark.status==='orphaned'||sourceBodies.get(source).slice(mark.start,mark.end)!==mark.quote){mark.status='orphaned';mark.prefix='';mark.suffix='';continue;}Object.assign(mark,anchor(mark,target,mark.start+delta,mark.end+delta));}
    return{chapterId:target.id,ids:chosen.map(chapter=>chapter.id)};
  }
  // Diff code points, with a fixed work budget. Common edges and unique text
  // anchors keep ordinary edits precise without a quadratic matrix for novels.
  function compareParts(previous,current){
    const parts=[],budget={left:750000};
    const push=(kind,text)=>{if(!text)return;const last=parts.at(-1);if(last?.kind===kind)last.text+=text;else parts.push({kind,text});};
    function myers(a,b){
      const trace=[],front=new Map([[1,0]]);
      for(let depth=0;depth<=Math.min(128,a.length+b.length);depth++){
        trace.push(new Map(front));
        for(let diagonal=-depth;diagonal<=depth;diagonal+=2){
          if(--budget.left<0)return null;
          let x=diagonal===-depth||diagonal!==depth&&(front.get(diagonal-1)??-1)<(front.get(diagonal+1)??-1)?front.get(diagonal+1)||0:(front.get(diagonal-1)||0)+1,y=x-diagonal;
          while(x<a.length&&y<b.length&&a[x]===b[y]){if(--budget.left<0)return null;x++;y++;}front.set(diagonal,x);
          if(x>=a.length&&y>=b.length){
            const result=[];x=a.length;y=b.length;
            for(let d=trace.length-1;d>=0;d--){const v=trace[d],k=x-y,prior=k===-d||k!==d&&(v.get(k-1)??-1)<(v.get(k+1)??-1)?k+1:k-1,px=v.get(prior)||0,py=px-prior;
              while(x>px&&y>py){result.push({kind:'equal',text:a[--x]});y--;}
              if(!d)break;if(x===px)result.push({kind:'added',text:b[--y]});else result.push({kind:'removed',text:a[--x]});
            }
            return result.reverse();
          }
        }
      }
      return null;
    }
    function anchors(a,b){
      if(a.length>100000||b.length>100000)return[];
      const width=32,positions=new Map(),candidates=[];
      for(let i=0;i+width<=b.length;i++){if(!boundary(b,i)||!boundary(b,i+width))continue;const text=b.slice(i,i+width);positions.set(text,positions.has(text)?-1:i);}
      for(let i=0;i+width<=a.length;i+=width){if(!boundary(a,i)||!boundary(a,i+width))continue;const at=positions.get(a.slice(i,i+width));if(at!==undefined&&at>=0)candidates.push({left:i,right:at,width,prior:-1});}
      const tails=[];
      candidates.forEach((candidate,index)=>{let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(candidates[tails[mid]].right+width<=candidate.right)lo=mid+1;else hi=mid;}candidate.prior=lo?tails[lo-1]:-1;tails[lo]=index;});
      const result=[];for(let at=tails.at(-1);at!==undefined&&at>=0;at=candidates[at].prior)result.push(candidates[at]);return result.reverse();
    }
    function range(a,b,depth=0){
      let start=0,endA=a.length,endB=b.length;while(start<endA&&start<endB&&a[start]===b[start])start++;if(!boundary(a,start)||!boundary(b,start))start--;
      while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}if(!boundary(a,endA)||!boundary(b,endB)){endA++;endB++;}
      push('equal',a.slice(0,start));const left=a.slice(start,endA),right=b.slice(start,endB);
      if(!left)push('added',right);else if(!right)push('removed',left);else{
        const exact=left.length+right.length<=200000?myers(Array.from(left),Array.from(right)):null;
        if(exact)for(const part of exact)push(part.kind,part.text);
        else{const shared=depth<2?anchors(left,right):[];if(shared.length){let old=0,now=0;for(const anchor of shared){range(left.slice(old,anchor.left),right.slice(now,anchor.right),depth+1);push('equal',left.slice(anchor.left,anchor.left+anchor.width));old=anchor.left+anchor.width;now=anchor.right+anchor.width;}range(left.slice(old),right.slice(now),depth+1);}else{push('removed',left);push('added',right);}}
      }
      push('equal',a.slice(endA));
    }
    range(previous,current);return parts;
  }
  const model={boundary,plan,apply,reorder,moveChapters,splitChapter,mergeChapters,compareParts};
  if(typeof module==='object'&&module.exports){module.exports=model;return;}
  global.WriterEditorToolsModel=model;
  global.WriterEditorTools=createController(global,model);

  function createController(window,model){
    let hooks={},busy=false,pane=null,splitOwner=null,splitChapterId=null,baseline=null,lastCompared=null,rootObserver=null,comparisonTimer=null;
    let pair=null,opening=false,openingSequence=0,draftTimer=null,chapterRequest=0;
    const drafts=new Map();
    const t=(text,...args)=>hooks.T?hooks.T(text,...args):text.replace(/\{(\d+)\}/g,(_,i)=>args[i]??'');
    const node=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;};
    const button=(text,className,handler)=>{const item=node('button',className,t(text));item.type='button';item.addEventListener('click',handler);return item;};
    const book=()=>hooks.getBook?.(),blocked=()=>busy||hooks.isComposing?.()||hooks.isTransitioning?.();
    const message=error=>hooks.toast?.(t(error.message||String(error)));
    async function mutate(operation,...args){
      if(blocked()||!book())return false;let prepared;const owner=book();
      try{prepared=model.plan(owner,operation,...args);}catch(error){message(error);return false;}
      busy=true;
      try{if(!await hooks.requireSaved()||book()!==owner)return false;const result=model.apply(owner,prepared);hooks.resetReviewAnchors?.();hooks.markDirty('structure');syncPrimary();hooks.renderChapters?.();hooks.renderStats?.();hooks.renderBacklinks?.();sync();const saved=await hooks.saveNow();if(!saved)hooks.toast?.(t('整理已保留在当前稿，请重试保存。'));return saved?result:false;}
      catch(error){message(error);return false;}finally{busy=false;}
    }
    function syncPrimary(){const editor=hooks.getEditor?.(),chapter=book()?.chapters.find(item=>item.id===hooks.getChapterId?.());if(editor&&chapter&&editor.value!==chapter.body){const start=editor.selectionStart,end=editor.selectionEnd,area=hooks.getWritingArea?.(),top=area?.scrollTop;editor.value=chapter.body;editor.setSelectionRange(Math.min(start,editor.value.length),Math.min(end,editor.value.length));hooks.resizeEditor?.();if(area)area.scrollTop=top;}}
    function menu(){
      if(blocked())return;const root=node('div','editor-tools-menu');
      const actions=[['全局搜索',showSearch],...(book()?.kind==='long'?[['卷章整理',showOrganizer],['拆分当前章',splitCurrent]]:[])];
      for(const [label,handler]of actions)root.append(button(label,'choice-button',handler));for(const extra of hooks.extraActions||[])root.append(button(extra.label,'choice-button',extra.run));hooks.showDialog(t('写作工具'),root);
    }
    async function splitCurrent(){
      if(blocked()||!book()||book().kind!=='long')return;const editor=hooks.getEditor(),owner=book(),id=hooks.getChapterId(),chapter=owner.chapters.find(item=>item.id===id&&!item.deletedAt);if(!chapter)return;
      const start=editor.selectionStart,end=editor.selectionEnd,original=chapter.body;
      if(editor.value!==original){hooks.toast?.(t('正文已变化，请重新选择。'));return;}
      const root=node('div','editor-split-confirm'),description=node('p','dialog-description',t(start===end?'从光标处分成两章，正文与关联会保留。':'将所选文字独立成章，前后正文与关联会保留。'));
      const preview=node('pre','editor-split-preview',original.slice(Math.max(0,start-80),start)+'\n✂\n'+original.slice(start,Math.min(original.length,start+160))),footer=node('div','dialog-actions');
      footer.append(button('取消','secondary-button',()=>hooks.closeDialog()),button('确认拆分','primary-button',async()=>{if(book()!==owner||chapter.body!==original)return;const result=await mutate(model.splitChapter,id,start,end,{uid:hooks.uid});if(result){hooks.closeDialog();hooks.selectChapter(result.chapterId);}}));root.append(description,preview,footer);hooks.showDialog(t('拆分当前章'),root);
    }
    async function showOrganizer(){
      if(blocked()||!book()||book().kind!=='long')return;const owner=book();if(!await hooks.requireSaved()||book()!==owner)return;
      const root=node('div','chapter-organizer'),toolbar=node('div','chapter-organizer-toolbar'),target=node('select','text-field'),list=node('div','chapter-organizer-list'),selected=new Set();let dragging=null;
      target.setAttribute('aria-label',t('移动到卷'));toolbar.append(target,button('移动选中','secondary-button',async()=>{const result=await mutate(model.moveChapters,[...selected],target.value||null);if(result){selected.clear();render();}}),button('合并选中','secondary-button',confirmMerge));root.append(toolbar,list);hooks.showDialog(t('卷章整理'),root);
      const visible=()=>book()===owner&&root.isConnected;
      function render(){
        if(!visible())return;const previous=target.value;target.replaceChildren();for(const volume of [...active(owner.volumes),{id:'',title:t('未分卷')}]){const option=node('option',null,volume.title);option.value=volume.id;target.append(option);}target.value=previous;
        list.replaceChildren();const volumeIds=new Set(active(owner.volumes).map(volume=>volume.id)),volumes=[...active(owner.volumes),{id:null,title:t('未分卷')}];
        for(const volume of volumes){const group=node('section','chapter-organizer-group'),heading=node('div','chapter-organizer-volume');heading.dataset.volumeId=volume.id||'';heading.draggable=!!volume.id;heading.append(node('strong',null,volume.title));
          if(volume.id)for(const [delta,label]of [[-1,'上移卷'],[1,'下移卷']]){const control=button(label,'text-button',async()=>{const ids=active(owner.volumes).map(item=>item.id),index=ids.indexOf(volume.id),other=index+delta;if(other<0||other>=ids.length)return;[ids[index],ids[other]]=[ids[other],ids[index]];if(await mutate(model.reorder,'volumes',ids))render();});control.textContent=delta<0?'↑':'↓';control.title=t(label);control.setAttribute('aria-label',t(label));heading.append(control);}
          heading.addEventListener('dragstart',event=>{dragging={type:'volume',id:volume.id};event.dataTransfer?.setData('text/plain',volume.id);});
          heading.addEventListener('dragover',event=>{if(dragging)event.preventDefault();});heading.addEventListener('drop',async event=>{event.preventDefault();event.stopPropagation();if(!dragging||!visible())return;const dragged=dragging;dragging=null;if(dragged.type==='volume'&&volume.id&&dragged.id!==volume.id){const ids=active(owner.volumes).map(item=>item.id).filter(id=>id!==dragged.id);ids.splice(ids.indexOf(volume.id),0,dragged.id);if(await mutate(model.reorder,'volumes',ids))render();}else if(dragged.type==='chapter'){if(await mutate(model.moveChapters,[dragged.id],volume.id))render();}});group.append(heading);
          const chapters=active(owner.chapters).filter(chapter=>volume.id===null?!volumeIds.has(chapter.volumeId):chapter.volumeId===volume.id);
          for(const chapter of chapters){const row=node('div','chapter-organizer-row'),check=node('input'),title=node('span',null,chapter.title||t('未命名章节'));row.dataset.chapterId=chapter.id;row.draggable=true;check.type='checkbox';check.checked=selected.has(chapter.id);check.setAttribute('aria-label',t('选择章节：{0}',chapter.title));check.addEventListener('change',()=>check.checked?selected.add(chapter.id):selected.delete(chapter.id));row.append(check,title);
            for(const [delta,label]of [[-1,'上移章节'],[1,'下移章节']]){const control=button(label,'text-button',async()=>{const index=chapters.indexOf(chapter),other=chapters[index+delta];if(!other)return;const ids=active(owner.chapters).map(item=>item.id),a=ids.indexOf(chapter.id),b=ids.indexOf(other.id);[ids[a],ids[b]]=[ids[b],ids[a]];if(await mutate(model.reorder,'chapters',ids))render();});control.textContent=delta<0?'↑':'↓';control.title=t(label);control.setAttribute('aria-label',t(label));control.disabled=!chapters[chapters.indexOf(chapter)+delta];row.append(control);}
            row.addEventListener('dragstart',event=>{dragging={type:'chapter',id:chapter.id};event.dataTransfer?.setData('text/plain',chapter.id);event.stopPropagation();});row.addEventListener('dragover',event=>{if(dragging?.type==='chapter')event.preventDefault();});row.addEventListener('drop',async event=>{event.preventDefault();event.stopPropagation();const dragged=dragging;dragging=null;if(dragged?.type==='chapter'&&dragged.id!==chapter.id&&visible()&&await mutate(model.moveChapters,[dragged.id],volume.id,chapter.id))render();});group.append(row);
          }list.append(group);
        }
      }
      function confirmMerge(){
        if(!visible()||blocked())return;try{model.plan(owner,model.mergeChapters,[...selected]);}catch(error){message(error);return;}
        const confirmation=node('div'),footer=node('div','dialog-actions');confirmation.append(node('p','dialog-description',t('合并为第一章，原章节保留在历史记录，全部正文与关联会保留。')));footer.append(button('取消','secondary-button',()=>{hooks.showDialog(t('卷章整理'),root);render();}),button('确认合并','primary-button',async()=>{const result=await mutate(model.mergeChapters,[...selected]);if(result){hooks.closeDialog();hooks.selectChapter(result.chapterId);}}));confirmation.append(footer);hooks.showDialog(t('合并章节'),confirmation);
      }
      render();
    }
    async function showSearch(){
      if(blocked())return;if(!await hooks.requireSaved())return;const root=node('div','library-search'),form=node('form','library-search-form'),input=node('input','text-field'),caseLabel=node('label','checkbox-row'),caseBox=node('input'),submit=node('button','primary-button',t('搜索')),status=node('p','subtle'),results=node('div','library-search-results');let request=0;
      input.type='search';input.maxLength=200;input.placeholder=t('查找所有作品的正文、大纲、人物和资料');input.setAttribute('aria-label',t('全局搜索文字'));caseBox.type='checkbox';caseLabel.append(caseBox,node('span',null,t('区分大小写')));submit.type='submit';form.append(input,caseLabel,submit);root.append(form,status,results);hooks.showDialog(t('全局搜索'),root);input.focus();
      form.addEventListener('submit',async event=>{event.preventDefault();const query=input.value;if(!query.trim())return;const current=++request;submit.disabled=true;try{const data=await hooks.api('/api/library-search?q='+encodeURIComponent(query)+'&caseSensitive='+(caseBox.checked?'1':'0'));if(current!==request||!root.isConnected)return;results.replaceChildren();status.textContent=t('{0} 条结果',data.results.length)+(data.truncated?' · '+t('结果较多，请缩小关键词。'):'');for(const result of data.results){const row=button('','library-search-result',()=>navigateResult(result));row.append(node('span','library-search-location',result.bookTitle+' · '+t(({book:'作品',chapter:'正文',outline:'大纲',person:'人物',note:'资料',relation:'人物关系',foreshadow:'伏笔',timeline:'时间线',asset:'素材'})[result.type]||'资料')+' · '+result.title));const excerpt=node('span','library-search-excerpt');excerpt.append(document.createTextNode(result.before),node('mark',null,result.text),document.createTextNode(result.after));row.append(excerpt);results.append(row);}}catch(error){if(current===request&&root.isConnected)status.textContent=t(error.message);}finally{if(current===request)submit.disabled=false;}});
    }
    async function navigateResult(result){
      if(blocked())return;hooks.closeDialog();const target=['book','chapter'].includes(result.type)?'write':result.type==='outline'?'outline':'people';if(book()?.id!==result.bookId&&await hooks.openBook(result.bookId,target)===false)return;if(book()?.id!==result.bookId)return;
      if(result.type==='chapter'){await hooks.jumpToChapter(result.id,result.field==='body'?result.text:'');return;}
      if(result.type==='book'){hooks.showWriting?.();return;}
      if(hooks.navigateSearchResult){await hooks.navigateSearchResult(result);return;}
      const key=result.type==='outline'?'outline':result.type==='relation'?'relations':'notes',item=book()[key]?.find(value=>value.id===result.id&&!value.deletedAt);if(item&&hooks.jumpToOwner)await hooks.jumpToOwner({type:result.type==='outline'?'outline':result.type==='relation'?'relation':'person',item});
    }
    const draftKey=(bookId,chapterId)=>JSON.stringify([bookId,chapterId]);
    const draftPath=record=>'/api/books/'+encodeURIComponent(record.bookId)+'/chapters/'+encodeURIComponent(record.chapterId)+'/comparison';
    const pending=record=>!record.invalid&&(record.savedSequence!==record.sequence||!!record.saving);
    const chapterText=chapter=>({title:chapter.title,body:chapter.body});
    const sameText=(left,right)=>left?.title===right?.title&&left?.body===right?.body;
    function hasPendingDrafts(){return[...drafts.values()].some(pending);}
    function draftStatus(text,error=false){hooks.saveStatus?.(t(text),error);}
    function captureInput(field){
      if(!isComparing())return false;
      pair.draft[field]=field==='body'?hooks.getEditor().value:document.getElementById('chapter-title').value;
      pair.sequence++;pair.error=null;draftStatus('修改稿待保存');
      clearTimeout(draftTimer);if(!hooks.isComposing?.())draftTimer=setTimeout(()=>flushDrafts(),450);
      scheduleComparison();hooks.resizeEditor?.();return true;
    }
    async function savePair(record){
      if(record.invalid)return true;
      if(hooks.isComposing?.())return !pending(record);
      if(record.saving){const saved=await record.saving;if(record.invalid)return true;if(!saved)return false;return savePair(record);}
      if(record.savedSequence===record.sequence)return true;
      const sequence=record.sequence,payload={version:record.version,canonicalFingerprint:record.canonicalFingerprint,baseline:copy(record.baseline),draft:copy(record.draft)};
      record.saving=(async()=>{
        try{
          const result=await hooks.api(draftPath(record),'PUT',payload);
          if(record.invalid)return true;
          if(!result?.draft||!Number.isInteger(result.draft.version))throw Error(t('对照稿保存结果不正确。'));
          record.version=result.draft.version;record.canonicalFingerprint=result.draft.canonicalFingerprint;
          record.canonical=copy(result.draft.canonical||record.canonical);record.savedSequence=sequence;record.error=null;
          if(pair===record)draftStatus(record.sequence===sequence?'修改稿已保存':'修改稿待保存');return true;
        }catch(error){if(record.invalid)return true;record.error=error;draftStatus('修改稿保存未完成',true);message(error);return false;}
      })();
      const result=await record.saving;record.saving=null;
      if(result&&!record.invalid&&record.savedSequence!==record.sequence)return savePair(record);
      return result;
    }
    async function flushDrafts(){
      clearTimeout(draftTimer);draftTimer=null;
      if(hooks.isComposing?.())return !hasPendingDrafts();
      for(const record of [...drafts.values()])if(!await savePair(record))return false;
      return true;
    }
    function restorePrimary(){
      const chapter=active(book()?.chapters).find(item=>item.id===hooks.getChapterId());if(!chapter)return;
      const editor=hooks.getEditor(),title=document.getElementById('chapter-title'),area=hooks.getWritingArea(),top=area?.scrollTop;
      if(editor.value!==chapter.body)editor.value=chapter.body;if(title&&title.value!==chapter.title)title.value=chapter.title;
      hooks.resizeEditor?.();if(area)area.scrollTop=top;
    }
    async function showSplit(){
      if(blocked()||opening||!book()||isComparing())return false;
      opening=true;const sequence=++openingSequence,owner=book(),id=hooks.getChapterId();
      try{
        if(!await hooks.requireSaved()||book()!==owner||hooks.getChapterId()!==id)return false;
        const chapter=active(owner.chapters).find(item=>item.id===id);if(!chapter)return false;
        const result=await hooks.api(draftPath({bookId:owner.id,chapterId:id}));
        if(sequence!==openingSequence||book()!==owner||hooks.getChapterId()!==id||hooks.getView?.()&&hooks.getView()!=='write')return false;
        if(!result?.canonical||typeof result.canonicalFingerprint!=='string')throw Error(t('对照原文读取失败。'));
        // A remote canonical change must be refreshed through the ordinary
        // book loader, never silently copied over an unsaved local manuscript.
        if(!sameText(result.canonical,chapterText(chapter)))throw Error(t('正文已发生变化，请重新打开作品后继续对照。'));
        const saved=result.draft,record={bookId:owner.id,chapterId:id,owner,version:saved?.version||0,
          baseline:copy(saved?.baseline||result.canonical),draft:copy(saved?.draft||result.canonical),
          canonical:copy(saved?.canonical||result.canonical),visibleCanonical:copy(result.canonical),canonicalFingerprint:saved?.canonicalFingerprint||result.canonicalFingerprint,
          sequence:0,savedSequence:saved?0:-1,saving:null,error:null,invalid:false};
        drafts.set(draftKey(owner.id,id),record);pair=record;
        if(!pane)buildPane();if(!pane)return false;
        splitOwner=owner;splitChapterId=id;baseline=record.baseline.body;lastCompared=null;pane.hidden=false;
        const editor=hooks.getEditor(),title=document.getElementById('chapter-title'),area=hooks.getWritingArea(),top=area.scrollTop;
        editor.value=record.draft.body;if(title)title.value=record.draft.title;
        area.classList.add('editor-dual-primary');pane.parentElement.classList.add('editor-dual-open');
        renderSplit();syncComparisonControls();hooks.closeDialog();hooks.resizeEditor?.();area.scrollTop=top;
        draftStatus('修改稿已保存');return true;
      }catch(error){message(error);return false;}finally{opening=false;syncComparisonControls();}
    }
    async function toggleComparison(){return isComparing()?closeSplit():showSplit();}
    async function closeSplit(){
      if(hooks.isComposing?.()||busy)return false;
      const record=pair;
      if(!await flushDrafts()||hooks.isComposing?.()||pair!==record)return false;
      clearComparison();restorePrimary();hooks.renderStats?.();draftStatus('已保存');return true;
    }
    function requestClose(){
      if(!isComparing()||blocked())return false;const record=pair,root=node('div','comparison-exit-dialog'),footer=node('div','dialog-actions');
      root.append(node('p','dialog-description',t('是否将修改稿保存为正文？')));
      const cancel=button('取消','secondary-button',()=>hooks.closeDialog());cancel.id='comparison-cancel';
      const keep=button('不保存退出','secondary-button',async()=>{if(pair===record&&await closeSplit())hooks.closeDialog();});keep.id='comparison-keep';
      const apply=button('保存修改','primary-button',()=>applyPair(record));apply.id='comparison-apply';
      footer.append(cancel,keep,apply);root.append(footer);hooks.showDialog(t('退出对照修改'),root);return true;
    }
    async function applyPair(record,rebase=false){
      if(pair!==record||blocked())return false;
      const run=async()=>{
        if(!await hooks.requireSaved()||pair!==record)return false;
        const latest=await hooks.api(draftPath(record));if(pair!==record)return false;
        if(latest.draft?.version!==record.version)throw Error(t('对照修改已在另一个窗口变化，请重新打开后继续。'));
        if(latest.stale&&!rebase){
          const root=node('div','comparison-exit-dialog'),footer=node('div','dialog-actions');
          root.append(node('p','dialog-description',t('正文已在其他位置修改。采用修改稿会替换当前正文，两份对照稿仍会保留。')));
          footer.append(button('取消','secondary-button',()=>hooks.closeDialog()),button('采用修改稿','primary-button',()=>applyPair(record,true)));
          root.append(footer);hooks.showDialog(t('确认修改稿'),root);return false;
        }
        const fresh=await hooks.api('/api/books/'+encodeURIComponent(record.bookId)),freshChapter=fresh.book?.chapters.find(item=>item.id===record.chapterId&&!item.deletedAt);
        if(pair!==record||fresh.book?.id!==record.bookId||!freshChapter||!sameText(chapterText(freshChapter),latest.canonical))throw Error(t('正文已发生变化，请重新打开作品后继续对照。'));
        if(latest.stale){
          const rebased=await hooks.api(draftPath(record),'PUT',{version:record.version,canonicalFingerprint:latest.canonicalFingerprint,baseline:record.baseline,draft:record.draft,rebase:true});
          record.version=rebased.draft.version;record.canonicalFingerprint=rebased.draft.canonicalFingerprint;record.canonical=copy(rebased.canonical);
        }
        const candidate=copy(fresh.book),chapter=candidate.chapters.find(item=>item.id===record.chapterId),before=chapter.body;
        chapter.title=record.draft.title;chapter.body=record.draft.body;
        window.ManuscriptMarks?.reanchorChapter(record.chapterId,before,chapter.body,candidate);
        const payload={version:record.version,canonicalFingerprint:record.canonicalFingerprint,revision:fresh.revision};
        if(candidate.reviewTools)payload.reviewTools=candidate.reviewTools;
        const result=await hooks.api(draftPath(record)+'/apply','POST',payload);
        if(pair!==record)return false;
        record.version=result.comparison.version;record.canonical=copy(result.comparison.canonical);record.canonicalFingerprint=result.comparison.canonicalFingerprint;
        clearComparison();hooks.closeDialog();hooks.acceptComparison(result);draftStatus('已保存');return true;
      };
      busy=true;try{return await(hooks.transition?hooks.transition(run):run());}catch(error){message(error);return false;}finally{busy=false;}
    }
    function buildPane(){
      const area=hooks.getWritingArea(),parent=area?.parentElement;if(!parent)return;
      pane=node('section','editor-dual-pane');pane.hidden=true;pane.setAttribute('aria-label',t('原文'));
      const divider=node('div','editor-dual-divider'),heading=node('div','chapter-heading editor-compare-heading'),label=node('span','eyebrow editor-compare-label',t('原文')),title=node('h2','editor-dual-title'),scroll=node('div','editor-dual-scroll'),original=node('div','editor-compare-original');
      const rightHeading=area.querySelector('.chapter-heading'),rightLabel=node('span','eyebrow editor-compare-right-label',t('修改稿')),exit=button('退出对照修改','icon-button editor-compare-exit',requestClose);
      exit.id='exit-comparison';exit.textContent='';exit.title=t('退出对照修改');exit.setAttribute('aria-label',t('退出对照修改'));
      const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.6');icon.setAttribute('aria-hidden','true');path.setAttribute('d','M6 6l12 12M18 6L6 18');icon.append(path);exit.append(icon);rightHeading?.prepend(rightLabel);rightHeading?.append(exit);
      divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-label',t('调整对照宽度'));
      original.setAttribute('role','document');original.setAttribute('aria-readonly','true');original.tabIndex=0;original.setAttribute('aria-label',t('原文'));
      heading.append(label);scroll.append(heading,title,original);pane.append(scroll,divider);parent.insertBefore(pane,area);pane._controls={title,scroll,original,divider,heading,rightHeading};
      let drag=null;const width=()=>Number.parseFloat(parent.style.getPropertyValue('--editor-original-width'))||50;
      const setWidth=value=>{const top=area.scrollTop,amount=Math.min(70,Math.max(25,value));parent.style.setProperty('--editor-original-width',amount+'%');hooks.preference?.('yejian.editor-compare-width',String(amount));hooks.resizeEditor?.();growSplit();area.scrollTop=top;divider.setAttribute('aria-valuenow',String(Math.round(amount)));};
      setWidth(Number(hooks.preference?.('yejian.editor-compare-width'))||50);
      divider.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={x:event.clientX,width:width(),parentWidth:parent.getBoundingClientRect().width};divider.setPointerCapture?.(event.pointerId);event.preventDefault();});
      divider.addEventListener('pointermove',event=>{if(drag)setWidth(drag.width+(event.clientX-drag.x)/drag.parentWidth*100);});for(const name of ['pointerup','pointercancel'])divider.addEventListener(name,()=>drag=null);
      divider.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setWidth(width()+(event.key==='ArrowRight'?2:-2));}});
      window.addEventListener('resize',growSplit);if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(growSplit);observer.observe(scroll);observer.observe(hooks.getEditor());}
    }
    function growSplit(){
      if(!pane||pane.hidden)return;pane.parentElement.classList.toggle('editor-dual-stacked',pane.parentElement.getBoundingClientRect().width<640);
      const {original,title,heading,rightHeading}=pane._controls,css=window.getComputedStyle(hooks.getEditor());for(const name of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','tabSize'])if(original.style[name]!==css[name])original.style[name]=css[name];
      const primaryTitle=document.getElementById(book()?.kind==='short'?'short-story-title':'chapter-title')||document.getElementById('chapter-title');
      if(primaryTitle){const titleCSS=window.getComputedStyle(primaryTitle);for(const name of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','marginTop','marginBottom'])if(title.style[name]!==titleCSS[name])title.style[name]=titleCSS[name];const height=primaryTitle.getBoundingClientRect().height+'px';if(title.style.height!==height)title.style.height=height;}
      if(rightHeading){const height=rightHeading.getBoundingClientRect().height+'px',margin=window.getComputedStyle(rightHeading).marginBottom;if(heading.style.height!==height)heading.style.height=height;if(heading.style.marginBottom!==margin)heading.style.marginBottom=margin;}
    }
    function renderSplit(){
      if(!pane||pane.hidden||book()!==splitOwner||hooks.getChapterId()!==splitChapterId)return;
      const chapter=active(splitOwner.chapters).find(item=>item.id===splitChapterId);if(!chapter)return;
      const {title,original,scroll}=pane._controls,editor=hooks.getEditor(),text=editor.value,top=scroll.scrollTop;
      title.textContent=splitOwner.kind==='short'?splitOwner.title:pair?.baseline.title||splitOwner.title;title.style.whiteSpace=splitOwner.kind==='short'?'normal':'nowrap';original.dataset.chapterId=chapter.id;
      if(lastCompared!==text){const fragment=document.createDocumentFragment();for(const part of model.compareParts(baseline,text)){
        if(part.kind==='added'){const marker=node('span','editor-compare-insertion','+');marker.title=t('新增：{0}',part.text);marker.setAttribute('aria-label',marker.title);fragment.append(marker);}
        else fragment.append(node('span',part.kind==='removed'?'editor-compare-source editor-compare-removed':'editor-compare-source',part.text));
      }original.replaceChildren(fragment);lastCompared=text;}
      growSplit();scroll.scrollTop=top;
    }
    function scheduleComparison(){
      if(!pane||pane.hidden)return;clearTimeout(comparisonTimer);
      if((baseline?.length||0)+(hooks.getEditor()?.value.length||0)<20000)sync();else comparisonTimer=setTimeout(sync,100);
    }
    function clearComparison(){
      clearTimeout(comparisonTimer);comparisonTimer=null;baseline=null;lastCompared=null;splitOwner=null;splitChapterId=null;pair=null;openingSequence++;
      if(!pane)return;const area=hooks.getWritingArea(),top=area?.scrollTop;pane.hidden=true;pane.parentElement.classList.remove('editor-dual-open','editor-dual-stacked');pane._controls.original.replaceChildren();pane._controls.title.textContent='';delete pane._controls.original.dataset.chapterId;area?.classList.remove('editor-dual-primary');hooks.resizeEditor?.();if(area)area.scrollTop=top;
      syncComparisonControls();
    }
    function forcePurge(bookId,ids=null,wholeBook=false){
      openingSequence++;
      for(const [key,record]of drafts){if(record.bookId===bookId&&(wholeBook||(ids||[]).includes(record.chapterId)||record.owner.kind==='short'&&(ids||[]).length)){record.invalid=true;drafts.delete(key);}}
      if(!splitOwner||splitOwner.id!==bookId)return false;
      // Legacy short sections share one manuscript owner. Purging an alias can
      // remove part of that owner's body without changing its chapter ID.
      if(!wholeBook&&!(ids||[]).includes(splitChapterId)&&!(splitOwner.kind==='short'&&(ids||[]).length))return false;
      clearComparison();return true;
    }
    function isComparing(){return!!pane&&!pane.hidden&&book()===splitOwner&&hooks.getChapterId()===splitChapterId;}
    function syncComparisonControls(){const control=document.getElementById('writing-compare');if(!control)return;control.setAttribute('aria-pressed',String(isComparing()));control.title=t(isComparing()?'退出对照修改':'对照修改');control.setAttribute('aria-label',control.title);control.disabled=opening||!active(book()?.chapters).some(item=>item.id===hooks.getChapterId())||!!hooks.getView?.()&&hooks.getView()!=='write';}
    function canonicalChanged(){
      if(!isComparing())return false;const chapter=active(book()?.chapters).find(item=>item.id===splitChapterId);
      if(chapter&&!sameText(chapterText(chapter),pair.visibleCanonical||pair.canonical)){clearComparison();restorePrimary();return true;}return false;
    }
    function sync(){if(pane&&!pane.hidden){if(book()!==splitOwner||hooks.getChapterId()!==splitChapterId||!active(book()?.chapters).some(item=>item.id===splitChapterId)||hooks.getView?.()&&hooks.getView()!=='write')clearComparison();else if(!canonicalChanged())renderSplit();}syncComparisonControls();}
    function configure(options){hooks=options;if(!rootObserver&&typeof MutationObserver==='function'){rootObserver=new MutationObserver(sync);const primary=hooks.getEditor?.(),title=document.getElementById('chapter-title');if(title)title.addEventListener('input',scheduleComparison);if(primary)primary.addEventListener('input',scheduleComparison);const list=document.getElementById('chapter-list');if(list)rootObserver.observe(list,{childList:true,subtree:false});}}
    function beforeSwitch(){if(hooks.isComposing?.()||hasPendingDrafts())return false;clearComparison();return true;}
    function beforeChapter(id){
      if(!isComparing())return true;
      if(id===splitChapterId){if(!canonicalChanged())return false;return true;}
      if(hooks.isComposing?.())return false;
      if(hasPendingDrafts()){
        const owner=book(),previous=hooks.getChapterId(),request=++chapterRequest;
        flushDrafts().then(saved=>{if(saved&&!hooks.isComposing?.()&&request===chapterRequest&&book()===owner&&hooks.getChapterId()===previous){clearComparison();hooks.selectChapter(id);}});return false;
      }
      clearComparison();return true;
    }
    return{configure,menu,showOrganizer,splitCurrent,showSearch,showSplit,toggleComparison,closeSplit,requestClose,isComparing,
      captureInput,flushDrafts,hasPendingDrafts,canonicalChanged,beforeChapter,forcePurge,sync,beforeSwitch,mutate,resize:growSplit};
  }
})(typeof window==='undefined'?globalThis:window);
