'use strict';

const outlineKinds={story:T('全书总纲'),volume:T('分卷大纲'),chapter:T('章节大纲'),scene:T('情节 / 设定')};
const relationTypes={friend:T('友谊与信任'),mentor:T('师承'),family:T('亲属'),conflict:T('冲突'),cooperate:T('合作'),fate:T('命运与研究'),other:T('其他'),automatic:T('同章提及')};
const activeVolumes=()=>state.book?.volumes.filter(v=>!v.deletedAt)||[];
function emptyProfile(){return{group:'',role:'',desire:'',flaw:'',ending:'',arcs:[]};}
function normalizeWorkspaceBook(book){
  book.kind??='long';book.cover??='';book.volumes??=[];book.outline??=[];book.relations??=[];book.atlasViews??=[];
  book.chapters.forEach(c=>c.volumeId??=null);
  book.notes.forEach(n=>{n.chapterIds??=[];n.aliases??=[];n.profile={...emptyProfile(),...n.profile};});
  book.outline.forEach(o=>{o.kind??='scene';o.volumeId??=null;});
  book.relations.forEach(r=>{r.type??='other';r.stage??='';r.volumeIds??=[];});
}
function analyzeWorkspace(){
  if(!state.book)return{appearances:{},cooccurrences:[],candidates:[],ambiguous:[]};
  if(!state.analysis||state.analysisSeq!==state.seq){state.analysis=WriterAnalysis.analyzeBook(state.book);state.analysisSeq=state.seq;}
  return state.analysis;
}
function personChapterIds(person){return [...new Set([...person.chapterIds,...(analyzeWorkspace().appearances[person.id]||[])])];}
function combinedRelations(){return [...activeRelations(),...analyzeWorkspace().cooccurrences.map(r=>({...r,id:'auto:'+r.fromId+':'+r.toId,label:T('同章提及'),body:T('姓名或别名在同一章正文中被提及，不代表已确认的人物关系。'),type:'automatic',automatic:true,volumeIds:[],stage:''}))];}
function populateSelect(select,items,emptyLabel,value=''){
  select.replaceChildren();if(emptyLabel!==null){const option=el('option',null,emptyLabel);option.value='';select.append(option);}
  items.forEach(item=>{const o=el('option',null,item.title);o.value=item.id;select.append(o);});
  select.value=Array.from(select.options).some(o=>o.value===value)?value:(emptyLabel!==null?'':items[0]?.id||'');
}
function addField(form,title,control){const label=el('label','field-label',title);if(control.id)label.htmlFor=control.id;form.append(label,control);}
function buildBookCover(book,size=''){
  const cover=el('div','shelf-cover '+size);cover.setAttribute('aria-label',book.title+T('的封面'));
  if(book.cover){const image=el('img');image.src=book.cover;image.alt=book.title+T('封面');cover.append(image);}
  else{let hash=0;for(const ch of book.title)hash=(hash*31+ch.charCodeAt(0))>>>0;cover.classList.add('cover-tone-'+hash%5);cover.append(el('span','cover-category',kindName(book.kind)),el('strong','cover-book-title',book.title));}
  return cover;
}
async function showCollection(target='shelf',kind=state.kind){
  return transition(async()=>{if(!await requireSaved())return false;try{await refreshBooks();if(state.book&&state.book.kind!==kind)clearBook();state.kind=kind;preference('yejian.kind',kind);state.view='shelf';state.collection=null;state.trail=null;closeDialog();closeNav();exitFocus();renderShell();return true;}catch(e){toast(e.message);return false;}});
}
async function openBookFolder(bookId){
  return transition(async()=>{
    if(!await requireSaved())return false;
    try{
      if(typeof window.WriterDesktop?.openBookFolder==='function')await window.WriterDesktop.openBookFolder(bookId);
      else{
        const result=await api('/api/books/'+encodeURIComponent(bookId)+'/folder','POST',{}),input=el('input','text-field book-folder-path');
        input.value=result.folder;input.readOnly=true;input.setAttribute('aria-label',T('作品文件夹路径'));
        const buttons=el('div','dialog-actions');
        buttons.append(action(T('复制路径'),'secondary-button',async()=>{try{await navigator.clipboard.writeText(input.value);toast(T('路径已复制。'));}catch{input.focus();input.select();toast(T('请按 Ctrl+C 复制选中的路径。'));}}),action(T('关闭'),'primary-button',closeDialog));
        showDialog(T('作品文件夹'),el('p','dialog-description',T('浏览器中请复制路径，在文件管理器中打开。')),input,buttons);
      }
      if(state.book?.id===bookId)state.folderWarning=null;
      return true;
    }catch(error){toast(T(error.message||'无法打开作品文件夹。'));return false;}
  });
}
function renderWorkspaceShell(){
  const missing=!state.book&&state.view!=='shelf';
  ['shelf','outline','people','write'].forEach(view=>{$(view+'-view').hidden=missing||state.view!==view;});
  $('no-book').hidden=!missing;$('no-book-title').textContent=T('还没有{0}作品',kindName());$('empty-new-book').textContent=T('＋ 新建{0}',kindName());
  const names={shelf:T('书架'),outline:T('故事大纲'),people:T('人物脉络'),write:T('{0}写作台',kindName())};
  $('page-title').textContent=names[state.view];$('book-name').textContent=state.book?.title||'';$('book-name').hidden=state.view==='shelf'||!state.book;
  document.title=state.view==='shelf'?T('作家工作台 · {0}书架',kindName()):(state.book?.title||'')+T(' · 作家工作台');
  if(state.book)renderStats();
  ['shelf','outline','people'].forEach(view=>{const active=state.view===view;$('nav-'+view).classList.toggle('active',active);$('nav-'+view).setAttribute('aria-current',active?'page':'false');});
  ['long','short'].forEach(kind=>{const active=state.view==='write'&&state.kind===kind;$('nav-write-'+kind).classList.toggle('active',active);$('nav-write-'+kind).setAttribute('aria-current',active?'page':'false');});
  $('link-current-chapter').disabled=!currentChapter();$('backlinks-edit').disabled=!currentChapter();$('toggle-notes').hidden=state.view!=='write'||missing;$('toggle-focus').hidden=state.view!=='write'||missing||!currentChapter();$('open-trash').disabled=!state.book;$('open-backup').disabled=!state.book;
  $('chapter-list-label').textContent=state.kind==='short'?T('篇章'):T('卷与章节');$('add-volume').hidden=state.kind==='short';
  $('return-source').hidden=!state.trail;$('return-source').textContent=state.trail?.view==='outline'?T('返回大纲'):T('返回人物脉络');
  preference('yejian.view',state.view);preference('yejian.collection','');
  if(state.view==='shelf')renderShelf();
  if(state.book&&state.view==='outline')renderOutline();
  if(state.book&&state.view==='people')renderPeople();
  if(state.book&&state.view==='write'){selectChapter(state.chapterId||activeChapters()[0]?.id);renderBacklinks();requestAnimationFrame(resizeEditor);}
}
function renderCollection(){
  const books=state.books.filter(b=>b.kind===state.kind);
  $('shelf-title').textContent=state.kind==='long'?T('长篇书架'):T('短篇书架');$('new-book').textContent=T('＋ 新建{0}',kindName());
  ['long','short'].forEach(kind=>{$('shelf-'+kind).classList.toggle('active',state.kind===kind);$('shelf-'+kind).setAttribute('aria-pressed',String(state.kind===kind));$(kind+'-count').textContent=state.books.filter(b=>b.kind===kind).length;});
  const grid=$('shelf-grid');grid.replaceChildren();
  books.forEach(book=>{
    const card=el('article','shelf-book'),coverButton=action('','cover-open',()=>openBook(book.id,'outline'));coverButton.setAttribute('aria-label',T('打开')+book.title);coverButton.append(buildBookCover(book));
    const info=el('div','shelf-book-info'),titleButton=action(book.title,'shelf-book-title',()=>openBook(book.id,'outline'));
    const meta=(book.kind==='long'?T`${book.volumeCount||0} 卷 · `:'')+T`${book.chapterCount} ${book.kind==='short'?T('篇章'):T('章')} · ${book.charCount.toLocaleString()} 字`;
    info.append(titleButton,el('p','shelf-book-progress',book.latestChapterTitle?T('最近章节：')+book.latestChapterTitle:T('构思中')));
    const bottom=el('div','shelf-book-bottom');bottom.append(el('span',null,meta));
    info.append(bottom,el('p','shelf-book-updated',T('最近编辑 ')+new Date(book.updatedAt).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})));
    const actions=el('div','shelf-book-actions');
    [[T('大纲'),'outline'],[T('人物脉络'),'people'],[book.chapterCount?T('继续写作'):T('开始正文'),'write']].forEach(([label,view])=>actions.append(action(label,view==='write'?'primary-button':'secondary-button',()=>openBook(book.id,view))));
    const tools=el('div','shelf-book-tools'),folder=action('','text-button book-folder-button',()=>openBookFolder(book.id));
    folder.innerHTML=svgIcon('folder');folder.append(el('span',null,T('打开文件夹')));folder.setAttribute('aria-label',T('打开{0}的文件夹',book.title));
    tools.append(action(T('封面与书名'),'text-button',async()=>{if(await openBook(book.id,'outline')&&state.book?.id===book.id)showBookSettings(true);}),folder);
    actions.append(tools);card.append(coverButton,info,actions);grid.append(card);
  });
  if(!books.length){const empty=el('div','shelf-empty');empty.append(el('span',null,T('还没有{0}作品',kindName())),action(T('新建作品，从大纲开始'),'primary-button',()=>showBookName(false)));grid.append(empty);}
}
function showBookSettings(rename,kind=state.kind){
  if(rename&&!state.book)return;const book=rename?state.book:{title:T('未命名作品'),kind,cover:''};let cover=book.cover;
  const form=el('form'),input=el('input','text-field');input.id='book-title-input';input.maxLength=200;input.required=true;input.value=rename?book.title:'';input.placeholder=T('给这部作品起一个名字');addField(form,T('{0}作品名称',kindName(kind)),input);
  const coverRow=el('div','cover-editor'),preview=el('div'),tools=el('div'),file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;file.setAttribute('aria-label',T('上传作品封面'));
  function updatePreview(){preview.replaceChildren(buildBookCover({title:input.value.trim()||T('未命名作品'),kind,cover},'cover-preview'));}
  tools.append(action(T('上传封面'),'secondary-button',()=>file.click()),action(T('使用文字封面'),'text-button',()=>{cover='';updatePreview();}),el('p','subtle',T('支持 PNG、JPG、WebP，封面只保存在本机。')));coverRow.append(preview,tools,file);form.append(el('label','field-label',T('作品封面')),coverRow);
  input.addEventListener('input',updatePreview);file.addEventListener('change',async()=>{const selected=file.files[0];if(!selected)return;try{if(!['image/png','image/jpeg','image/webp'].includes(selected.type)||selected.size>12*1024*1024)throw new Error(T('请选择 12 MB 以内的 PNG、JPG 或 WebP 图片。'));const bitmap=await createImageBitmap(selected);const canvas=document.createElement('canvas');canvas.width=600;canvas.height=800;const context=canvas.getContext('2d'),scale=Math.max(600/bitmap.width,800/bitmap.height);context.fillStyle='#fff';context.fillRect(0,0,600,800);context.drawImage(bitmap,(600-bitmap.width*scale)/2,(800-bitmap.height*scale)/2,bitmap.width*scale,bitmap.height*scale);bitmap.close();cover=canvas.toDataURL('image/jpeg',.88);updatePreview();}catch(e){toast(e.message||T('这张图片无法读取。'));}finally{file.value='';}});
  const buttons=el('div','dialog-actions'),submit=el('button','primary-button',rename?T('保存作品信息'):T('创建作品，开始构思'));submit.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),submit);form.append(buttons);updatePreview();
  form.addEventListener('submit',async event=>{event.preventDefault();const title=input.value.trim();if(!title)return;submit.disabled=true;try{
    if(rename){book.title=title;book.cover=cover;markDirty();if(await saveNow()){closeDialog();await refreshBooks();renderShell();}}
    else await transition(async()=>{if(!await requireSaved())return;setBook(await api('/api/books','POST',{title,kind}));state.book.cover=cover;createOutlineTemplate();state.view='outline';state.collection=null;markDirty();await saveNow();closeDialog();await refreshBooks();renderShell();});
  }catch(e){toast(e.message);}finally{submit.disabled=false;}});showDialog(rename?T('封面与书名'):T('新建{0}',kindName(kind)),form);input.focus();
}
function renderVolumeChapters(){
  const container=$('chapter-list');container.replaceChildren();if(!state.book)return;
  const chapters=activeChapters(),volumes=activeVolumes(),ids=new Set(volumes.map(v=>v.id)),query=$('chapter-search').value.trim().toLocaleLowerCase();
  const groups=state.kind==='short'?[{id:null,title:''}]:[...volumes,...(chapters.some(c=>!ids.has(c.volumeId))?[{id:null,title:T('未分卷')}]:[])];
  groups.forEach(volume=>{
    const group=el('section','volume-group'),all=chapters.filter(c=>state.kind==='short'||(volume.id?c.volumeId===volume.id:!ids.has(c.volumeId))),list=query?all.filter(c=>(c.title+' '+c.body).toLocaleLowerCase().includes(query)):all;if(query&&!list.length)return;
    if(state.kind==='long'){
      const heading=el('div','volume-heading'),pick=action('','volume-select'+(state.volumeId===volume.id?' active':''),()=>{state.volumeId=volume.id;renderChapters();if(list[0])selectChapter(list[0].id);});
      pick.append(el('strong',null,volume.title),el('small',null,query?T('{0} / {1} 章',list.length,all.length):list.length+T(' 章')));const collapsed=!query&&state.collapsedVolumes?.has(volume.id),fold=action(collapsed?'▸':'▾','volume-fold',()=>{state.collapsedVolumes??=new Set();if(state.collapsedVolumes.has(volume.id))state.collapsedVolumes.delete(volume.id);else state.collapsedVolumes.add(volume.id);renderChapters();});fold.setAttribute('aria-label',T('展开或收起卷')+' '+volume.title);fold.setAttribute('aria-expanded',String(!collapsed));heading.append(fold,pick);
      if(volume.id){const edit=action('','volume-edit',()=>showVolumeEditor(volume));edit.innerHTML=svgIcon('pen');edit.setAttribute('aria-label',T('编辑卷 ')+volume.title);heading.append(edit);}group.append(heading);
    }
    if(!query&&state.collapsedVolumes?.has(volume.id)){container.append(group);return;}
    list.forEach((chapter,index)=>{const button=action('','chapter-item'+(chapter.id===state.chapterId?' active':''),()=>selectChapter(chapter.id));button.dataset.chapter=chapter.id;button.setAttribute('aria-current',String(chapter.id===state.chapterId));const top=el('span','chapter-item-top');top.append(el('span','chapter-index',String(all.indexOf(chapter)+1)),el('span','chapter-item-title',chapter.title||T('未命名章节')));button.append(top,el('span','chapter-item-count',chapter.body?T`${count(chapter.body).toLocaleString()} 字`:T('尚未动笔')));group.append(button);});
    if(!list.length){group.append(action(state.kind==='short'?T('＋ 新建章节'):T('＋ 在此卷新建章节'),'volume-new-chapter',()=>{state.volumeId=volume.id;addChapter();}));}container.append(group);
  });
  if(!container.children.length)container.append(el('p','empty-hint',query?T('没有匹配的章节。'):T('先建立卷，再添加章节。')));
}
function renderChapterVolumeSelect(){populateSelect($('chapter-volume'),activeVolumes(),T('未分卷'),currentChapter()?.volumeId||'');}
function showVolumeEditor(volume=null){
  if(!state.book||state.kind!=='long')return;const fresh=!volume,item=volume||{id:uid(),title:T`第${activeVolumes().length+1}卷`,summary:'',deletedAt:null},form=el('form'),title=el('input','text-field'),summary=el('textarea','text-field');title.id='volume-title-input';title.maxLength=200;title.required=true;title.value=item.title;summary.id='volume-summary-input';summary.value=item.summary;summary.rows=5;summary.placeholder=T('这一卷的核心冲突、走向与收束');addField(form,T('卷名'),title);addField(form,T('分卷说明'),summary);
  const buttons=el('div','dialog-actions');if(!fresh){buttons.append(action(T('前移一卷'),'secondary-button',()=>moveVolume(item,-1)),action(T('后移一卷'),'secondary-button',()=>moveVolume(item,1)),action(T('移入回收站'),'text-button',()=>{if(activeChapters().some(c=>c.volumeId===item.id)){toast(T('请先把本卷章节移到其他卷，再移入回收站。'));return;}item.deletedAt=new Date().toISOString();markDirty();renderChapters();closeDialog();renderShell();}));}
  const submit=el('button','primary-button',fresh?T('建立卷'):T('保存卷'));submit.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),submit);form.append(buttons);let busy=false;form.addEventListener('submit',async event=>{event.preventDefault();if(busy||!title.value.trim())return;busy=true;submit.disabled=true;try{item.title=title.value.trim();item.summary=summary.value;if(fresh&&!state.book.volumes.some(v=>v.id===item.id))state.book.volumes.push(item);activeOutline().filter(o=>o.kind==='volume'&&o.volumeId===item.id).forEach(o=>{o.title=item.title;o.body=item.summary;});state.volumeId=item.id;markDirty();if(await saveNow()){closeDialog();renderShell();renderChapters();}}finally{busy=false;submit.disabled=false;}});showDialog(fresh?T('新建卷'):T('编辑卷'),form);title.focus();
}
function moveVolume(volume,delta){const list=activeVolumes(),other=list[list.indexOf(volume)+delta];if(!other)return;const a=state.book.volumes.indexOf(volume),b=state.book.volumes.indexOf(other);[state.book.volumes[a],state.book.volumes[b]]=[state.book.volumes[b],state.book.volumes[a]];markDirty();renderChapters();toast(T('卷的顺序已更新。'));}
function createOutlineTemplate(){
  if(activeOutline().length)return;const root={id:uid(),title:T('全书总纲'),kind:'story',category:'故事主线',body:'',parentId:null,volumeId:null,chapterIds:[],deletedAt:null};state.book.outline.push(root);
  if(state.kind==='long')activeVolumes().forEach(v=>state.book.outline.push({id:uid(),title:v.title,kind:'volume',category:'分卷剧情',body:v.summary,parentId:root.id,volumeId:v.id,chapterIds:[],deletedAt:null}));
  [[T('世界观与规则'),'世界设定'],[T('伏笔与回收'),'伏笔回收'],[T('连续性检查'),'连续性检查']].forEach(([title,category])=>state.book.outline.push({id:uid(),title,kind:'scene',category,body:'',parentId:null,volumeId:null,chapterIds:[],deletedAt:null}));state.outlineId=root.id;
}
function showNewOutline(parentId=null,preset={}){
  const form=el('form'),title=el('input','text-field'),kind=el('select','text-field'),volume=el('select','text-field'),category=el('input','text-field'),parent=activeOutline().find(o=>o.id===parentId);
  title.id='new-outline-title';title.maxLength=200;title.required=true;title.value=preset.title||'';title.placeholder=T('例如：第一卷 归来，或第一章 潮声');
  kind.id='new-outline-kind';Object.entries(outlineKinds).forEach(([id,text])=>{const option=el('option',null,text);option.value=id;kind.append(option);});
  kind.value=preset.kind||(parent?.kind==='volume'?'chapter':state.outlineKindFilter||'scene');
  category.id='new-outline-category';category.maxLength=200;category.setAttribute('list','outline-topic-options');category.value=outlineTopicLabel(preset.category||(state.outlineCategory&&state.outlineCategory!=='all'?state.outlineCategory:parent?outlineTopic(parent):outlineTopic({kind:kind.value,title:''})));category.placeholder=T('选择分类，或输入自定义分类');
  addField(form,T('大纲标题'),title);addField(form,T('主题分类'),category);addField(form,T('大纲层级'),kind);
  volume.id='new-outline-volume';populateSelect(volume,activeVolumes(),T('全书 / 未指定卷'),preset.volumeId||outlineVolume(parent)?.id||state.outlineVolumeFilter||'');
  if(state.kind==='long')addField(form,T('所属卷'),volume);
  if(parent)form.append(el('p','dialog-description',T('所属节点')+' · '+(parent.title||T('未命名节点'))));
  const buttons=el('div','dialog-actions'),submit=el('button','primary-button',T('建立大纲'));submit.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),submit);form.append(buttons);
  form.addEventListener('submit',event=>{event.preventDefault();if(!title.value.trim())return;const topic=outlineTopicValue(category.value)||outlineTopic({kind:kind.value,title:title.value});state.outlineCategory=topic;state.outlineKindFilter='';state.outlineVolumeFilter=volume.value||'';$('outline-search').value='';addOutline(parentId,kind.value,volume.value||null);currentOutline().title=title.value.trim();currentOutline().category=topic;markDirty();closeDialog();renderOutline();$('outline-body').focus();});
  showDialog(parent?T('新建子大纲'):T('新建大纲'),form);title.focus();
}
function outlineTopicNames(){return['故事主线','世界设定','人物设定','分卷剧情','伏笔回收','连续性检查','结局场景','参考资料','情节与设定'];}
function outlineTopic(item){
  if(typeof item?.category==='string'&&item.category.trim())return item.category.trim();
  const title=item?.title||'';
  if(/主线|叙事|时间.*表|成长总表/.test(title))return'故事主线';
  if(/伏笔|线索|回收/.test(title))return'伏笔回收';
  if(/连续|一致性|检查|校验/.test(title))return'连续性检查';
  if(/结局|尾声|终局/.test(title))return'结局场景';
  if(/参考|资料|来源|原著/.test(title))return'参考资料';
  if(/人物|主角|配角|角色|家族/.test(title))return'人物设定';
  if(/世界|系统|魔法|规则|历史|遗迹|地理|宗教|力量|背景/.test(title))return'世界设定';
  if(['volume','chapter'].includes(item?.kind)||(item?.volumeId||item?.parentId)&&outlineVolume(item))return'分卷剧情';
  return item?.kind==='story'?'故事主线':'情节与设定';
}
function outlineTopicLabel(value){return outlineTopicNames().includes(value)?T(value):value;}
function outlineTopicValue(value){const text=value.trim();return outlineTopicNames().find(topic=>outlineTopicLabel(topic)===text)||text;}
function outlineTopicGroups(rows=outlineRows()){return[...outlineTopicNames(),...new Set(rows.map(({o})=>outlineTopic(o)).filter(topic=>!outlineTopicNames().includes(topic)))];}
function outlineFilteredRows(rows=outlineRows()){
  const query=$('outline-search').value.trim().toLocaleLowerCase(),category=state.outlineCategory||'all',volume=state.outlineVolumeFilter||'',kind=state.outlineKindFilter||'';
  const matches=rows.filter(({o})=>(category==='all'||outlineTopic(o)===category)&&(!kind||o.kind===kind)&&(!volume||outlineVolume(o)?.id===volume)&&(!query||(o.title+' '+o.body).toLocaleLowerCase().includes(query)));
  const parents=new Map(rows.map(({o})=>[o.id,o.parentId])),visible=new Set();
  matches.forEach(({o})=>{let id=o.id;while(id&&!visible.has(id)){visible.add(id);id=parents.get(id);}});
  return{matches,visible,query};
}
function revealOutlinePath(id){
  const map=new Map(activeOutline().map(item=>[item.id,item])),seen=new Set();let parent=map.get(id)?.parentId;
  while(parent&&!seen.has(parent)){seen.add(parent);state.outlineCollapsed?.delete(parent);parent=map.get(parent)?.parentId;}
}
function selectOutlineNode(id){
  state.outlineId=id;revealOutlinePath(id);renderOutlineNavigation();
  if(state.outlineMode==='read'){
    document.getElementById('read-'+id)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
    $('outline-tree').querySelectorAll('.outline-node').forEach(button=>{const selected=button.dataset.outline===id;button.classList.toggle('active',selected);button.setAttribute('aria-current',String(selected));});
    requestAnimationFrame(()=>{
      if(state.outlineMode!=='read')return;const tree=$('outline-tree'),node=tree.querySelector('.outline-node.active'),nav=tree.parentElement;if(!node||!nav)return;
      const bounds=nav.getBoundingClientRect(),target=node.getBoundingClientRect(),top=bounds.top+nav.clientTop,bottom=top+nav.clientHeight;
      if(target.top<top)nav.scrollTop+=target.top-top;else if(target.bottom>bottom)nav.scrollTop+=target.bottom-bottom;
    });
  }else{
    renderOutline();requestAnimationFrame(()=>{if(state.outlineMode!=='read')$('outline-tree').querySelector('.outline-node.active')?.scrollIntoView({block:'nearest'});});
  }
}
function outlineTextLink(text,className,href,handler){
  const link=el('a',className,text);link.href=href;link.addEventListener('click',event=>{if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.altKey)return;event?.preventDefault();handler();});return link;
}
function renderOutlineNavigation(){
  const rows=outlineRows(),filtered=outlineFilteredRows(rows),reading=state.outlineMode==='read',matchIds=new Set(filtered.matches.map(({o})=>o.id)),map=new Map(rows.map(({o})=>[o.id,o])),parents=new Map(rows.map(({o})=>[o.id,o.parentId])),branches=new Set(rows.filter(({o})=>map.has(o.parentId)&&outlineTopic(o)===outlineTopic(map.get(o.parentId))).map(({o})=>o.parentId)),tree=$('outline-tree');
  state.outlineCollapsed??=new Set();tree.replaceChildren();
  outlineTopicGroups(rows).forEach(topic=>{
    const topicMatches=filtered.matches.filter(({o})=>outlineTopic(o)===topic);if(!topicMatches.length)return;const section=el('section','outline-toc-group'),heading=el('div','outline-toc-group-heading');heading.append(el('strong',null,outlineTopicLabel(topic)));if(!reading)heading.append(el('span',null,String(topicMatches.length)));section.append(heading);
    rows.filter(({o})=>(reading?matchIds:filtered.visible).has(o.id)&&outlineTopic(o)===topic).forEach(({o})=>{
    let parentId=o.parentId,hidden=false,remaining=parents.size,depth=0;
    while(parentId&&remaining--){if(outlineTopic(map.get(parentId))===topic){depth++;if(!reading&&!filtered.query&&state.outlineCollapsed.has(parentId)){hidden=true;break;}}parentId=parents.get(parentId);}
    if(hidden)return;
    const context=!matchIds.has(o.id),row=el('div','outline-tree-row'+(context?' outline-context-row':''));row.style.setProperty('--outline-depth',Math.min(depth,6));
    if(!reading&&branches.has(o.id)){
      const collapsed=!filtered.query&&state.outlineCollapsed.has(o.id),fold=action(collapsed?'▸':'▾','outline-fold',()=>{if(state.outlineCollapsed.has(o.id))state.outlineCollapsed.delete(o.id);else state.outlineCollapsed.add(o.id);renderOutlineNavigation();});
      fold.setAttribute('aria-label',T('展开或收起大纲')+' '+(o.title||T('未命名节点')));fold.setAttribute('aria-expanded',String(!collapsed));row.append(fold);
    }else if(!reading)row.append(el('span','outline-fold-spacer'));
    const onSelect=()=>{
      if(context){state.outlineCategory='all';state.outlineKindFilter='';state.outlineVolumeFilter='';$('outline-search').value='';state.outlineId=o.id;renderOutline();if(state.outlineMode==='read')selectOutlineNode(o.id);}
      else selectOutlineNode(o.id);
    },className='outline-node'+(o.id===state.outlineId?' active':''),button=reading?outlineTextLink('',className,'#read-'+o.id,onSelect):action('',className,onSelect);button.dataset.outline=o.id;button.dataset.kind=o.kind;button.setAttribute('aria-current',String(o.id===state.outlineId));
    button.append(el('span','outline-node-title',o.title||T('未命名节点')));if(!reading)button.append(el('small',null,outlineKinds[o.kind]+(o.chapterIds.length?' · '+o.chapterIds.length+T(' 章'):'')));row.append(button);section.append(row);
    });tree.append(section);
  });
  $('outline-filter-count').textContent=T('{0} 个大纲节点',filtered.matches.length);$('outline-tree-empty').hidden=!!filtered.matches.length;
  const tools=$('outline-tree-tools');tools.replaceChildren();if(reading)return;const allCollapsed=branches.size>0&&[...branches].every(id=>state.outlineCollapsed.has(id)),foldAll=action(allCollapsed?T('全部展开'):T('全部收起'),'text-button',()=>{state.outlineCollapsed=allCollapsed?new Set():new Set(branches);renderOutlineNavigation();});foldAll.disabled=!branches.size||!!filtered.query;tools.append(foldAll);
}
function renderOutlineCategories(){
  const rows=outlineRows(),reading=state.outlineMode==='read',container=$('outline-categories');container.replaceChildren();
  const topics=outlineTopicGroups(rows);[['all',T('全部大纲')],...topics.map(topic=>[topic,outlineTopicLabel(topic)])].forEach(([topic,label],index)=>{
    const amount=topic==='all'?rows.length:rows.filter(({o})=>outlineTopic(o)===topic).length,button=action('','outline-category'+((state.outlineCategory||'all')===topic?' active':''),()=>{state.outlineCategory=topic;state.outlineId=outlineFilteredRows().matches[0]?.o.id||null;renderOutline();});
    button.dataset.topic=topic;button.dataset.tone=String(index%5);button.setAttribute('aria-pressed',String((state.outlineCategory||'all')===topic));button.append(el('span',null,label),el('strong',null,String(amount)));container.append(button);
  });
  const options=$('outline-topic-options');options.replaceChildren();topics.forEach(topic=>{const option=el('option');option.value=outlineTopicLabel(topic);options.append(option);});
  const controls=$('outline-filter-controls');controls.replaceChildren();let host=controls;
  if(reading){
    const details=el('details','outline-filter-disclosure'),selected=[state.outlineCategory&&state.outlineCategory!=='all'?outlineTopicLabel(state.outlineCategory):'',outlineKinds[state.outlineKindFilter]||'',activeVolumes().find(v=>v.id===state.outlineVolumeFilter)?.title||''].filter(Boolean);details.open=!!state.outlineFilterOpen;details.append(el('summary',null,T('大纲分类')+(selected.length?' · '+selected.join(' / '):'')));details.addEventListener('toggle',()=>{state.outlineFilterOpen=details.open;});host=el('div','outline-filter-fields');details.append(host);controls.append(details);
    const label=el('label','field-label',T('主题分类')),topic=el('select','text-field');topic.id='outline-filter-topic';label.htmlFor=topic.id;populateSelect(topic,topics.map(value=>({id:value,title:outlineTopicLabel(value)})),T('全部大纲'),state.outlineCategory==='all'?'':state.outlineCategory||'');topic.addEventListener('change',()=>{state.outlineCategory=topic.value||'all';state.outlineId=outlineFilteredRows().matches[0]?.o.id||null;renderOutline();});host.append(label,topic);
  }
  const kindLabel=el('label','field-label',T('大纲层级')),kind=el('select','text-field');kind.id='outline-filter-kind';kindLabel.htmlFor=kind.id;populateSelect(kind,Object.entries(outlineKinds).map(([id,title])=>({id,title})),T('全部层级'),state.outlineKindFilter||'');kind.addEventListener('change',()=>{state.outlineKindFilter=kind.value;state.outlineId=outlineFilteredRows().matches[0]?.o.id||null;renderOutline();});host.append(kindLabel,kind);
  if(state.kind==='long'){
    const label=el('label','field-label',T('按卷查看')),select=el('select','text-field');select.id='outline-filter-volume';label.htmlFor=select.id;populateSelect(select,activeVolumes(),T('全部卷'),state.outlineVolumeFilter||'');state.outlineVolumeFilter=select.value;
    select.addEventListener('change',()=>{state.outlineVolumeFilter=select.value;state.outlineId=outlineFilteredRows().matches[0]?.o.id||null;renderOutline();});host.append(label,select);
  }
}
function renderOutlineWorkspace(){
  if(!state.book)return;
  if(state.outlineFilterBook!==state.book.id){state.outlineFilterBook=state.book.id;state.outlineCategory='all';state.outlineKindFilter='';state.outlineVolumeFilter='';state.outlineCollapsed=new Set();state.outlineFilterOpen=false;$('outline-search').value='';}
  const rows=outlineRows(),reading=state.outlineMode==='read';if(!rows.some(({o})=>o.id===state.outlineId))state.outlineId=outlineFilteredRows(rows).matches[0]?.o.id||null;
  $('outline-read-toggle').textContent=reading?T('返回编辑'):T('完整阅读');$('outline-build').hidden=state.kind==='short';$('outline-view').classList.toggle('outline-reading-mode',reading);
  renderOutlineCategories();renderOutlineNavigation();const item=currentOutline();$('outline-empty').hidden=reading?!!rows.length:!!item;$('outline-template').hidden=!!rows.length;$('outline-empty-description').textContent=rows.length?T('这个分类还没有大纲，可以新建一个节点。'):T('先建立总纲、分卷与章节构思，再开始正文。');$('outline-detail').hidden=!item||reading;$('outline-reading').hidden=!reading||!rows.length;
  if(reading&&rows.length){renderOutlineReading();return;}if(!item)return;
  $('outline-title').value=item.title;$('outline-body').value=item.body;$('outline-path').textContent=outlineTopicLabel(outlineTopic(item))+' · '+outlineKinds[item.kind];$('outline-path').dataset.kind=item.kind;$('outline-kind').value=item.kind;
  const categoryInput=$('outline-category-input');categoryInput.value=outlineTopicLabel(outlineTopic(item));categoryInput.oninput=()=>{item.category=outlineTopicValue(categoryInput.value);markDirty();};categoryInput.onchange=()=>{if(state.outlineCategory!=='all')state.outlineCategory=outlineTopic(item);renderOutlineCategories();renderOutlineNavigation();$('outline-path').textContent=outlineTopicLabel(outlineTopic(item))+' · '+outlineKinds[item.kind];};
  const crumbs=$('outline-breadcrumbs');crumbs.replaceChildren();const ancestors=[],map=new Map(rows.map(({o})=>[o.id,o]));let cursor=map.get(item.parentId),remaining=map.size;while(cursor&&remaining--){ancestors.unshift(cursor);cursor=map.get(cursor.parentId);}ancestors.forEach(ancestor=>{crumbs.append(action(ancestor.title||T('未命名节点'),'text-button',()=>{state.outlineCategory='all';state.outlineKindFilter='';state.outlineVolumeFilter='';state.outlineId=ancestor.id;renderOutline();}),el('span','outline-crumb-divider','/'));});crumbs.append(el('span',null,item.title||T('未命名节点')));
  $('outline-volume-field').hidden=state.kind==='short';populateSelect($('outline-volume'),activeVolumes(),T('全书 / 未指定卷'),item.volumeId||'');
  populateSelect($('outline-parent'),rows.filter(({o})=>o.id!==item.id&&!isDescendant(o.id,item.id)).map(({o,depth})=>({id:o.id,title:'　'.repeat(Math.min(depth,5))+(o.title||T('未命名节点'))})),T('顶层节点'),item.parentId||'');
  const siblings=rows.filter(({o})=>o.parentId===item.parentId).map(({o})=>o),index=siblings.indexOf(item);$('outline-up').disabled=index<=0;$('outline-down').disabled=index>=siblings.length-1;
  $('outline-create-chapter').textContent=item.kind==='volume'?T('建立对应卷'):item.kind==='story'?T('生成卷章目录'):item.chapterIds.length?T('打开关联章节'):T('按此大纲创建章节');renderChapterLinks($('outline-links'),item);
}
function filterOutlineTree(){renderOutlineNavigation();if(state.outlineMode==='read')renderOutlineReading();}
function renderOutlineReading(){
  const rows=outlineRows(),filtered=outlineFilteredRows(rows),parents=new Map(rows.map(({o})=>[o.id,o])),reader=$('outline-reading'),header=el('header','outline-reader-header');reader.replaceChildren();
  header.append(el('h1',null,state.book.title));reader.append(header);
  if(!filtered.matches.length){reader.append(el('p','outline-reader-empty',T('没有符合筛选条件的大纲。')));return;}
  outlineTopicGroups(rows).forEach(topic=>{
    const topicRows=filtered.matches.filter(({o})=>outlineTopic(o)===topic);if(!topicRows.length)return;const visibleIds=new Set(topicRows.map(({o})=>o.id));
    const groupRows=topicRows.filter(({o})=>o.kind==='volume'||!outlineHasVisibleVolumeAncestor(o,visibleIds,parents));
    groupRows.forEach(entry=>{reader.append(outlineReadingSection(entry));if(entry.o.kind==='volume')topicRows.filter(({o})=>o.kind!=='volume'&&outlineHasVisibleVolumeAncestor(o,visibleIds,parents)===entry.o.id).forEach(child=>reader.append(outlineReadingSection(child,true)));});
  });
}
function outlineHasVisibleVolumeAncestor(item,visibleIds,parentMap=null){
  const map=parentMap||new Map(activeOutline().map(o=>[o.id,o]));let cursor=map.get(item.parentId),remaining=map.size;while(cursor&&remaining--){if(cursor.kind==='volume'&&visibleIds.has(cursor.id))return cursor.id;cursor=map.get(cursor.parentId);}return null;
}
function outlineReadingSection({o,depth},nested=false){
  const section=el('section','outline-read-section'+(nested?' outline-read-nested':''));section.id='read-'+o.id;section.dataset.kind=o.kind;
  const heading=el(o.kind==='volume'||!nested&&!depth?'h2':'h3'),edit=action(o.title||T('未命名节点'),'outline-heading-link',()=>{state.outlineMode='edit';state.outlineId=o.id;revealOutlinePath(o.id);state.outlineCategory='all';state.outlineKindFilter='';state.outlineVolumeFilter='';$('outline-search').value='';renderOutline();});heading.append(edit);
  section.append(heading,el('div','outline-read-body',o.body||T('这一部分还没有填写。')));
  if(o.chapterIds.length){const links=el('p','outline-reader-links');links.append(el('span','outline-links-label',T('关联正文')+' '));o.chapterIds.forEach(id=>{const chapter=state.book.chapters.find(c=>c.id===id);if(!chapter)return;const link=outlineTextLink((chapter.title||T('未命名章节'))+(chapter.deletedAt?' ('+T('已在回收站')+')':''),'outline-manuscript-link'+(chapter.deletedAt?' archived':''),'#manuscript',()=>{state.outlineId=o.id;jumpToChapter(id);});link.dataset.chapter=id;links.append(link);});section.append(links);}return section;
}
function outlineVolume(item){let cursor=item,limit=state.book.outline.length;while(cursor&&limit--){const volume=activeVolumes().find(v=>v.id===cursor.volumeId);if(volume)return volume;cursor=state.book.outline.find(o=>o.id===cursor.parentId);}return null;}
function syncOutlineVolume(item){
  if(item.kind!=='volume')return;const volume=activeVolumes().find(v=>v.id===item.volumeId);if(!volume)return;
  if(item.title.trim())volume.title=item.title.trim();volume.summary=item.body;
}
function ensureOutlineVolume(item){
  let volume=activeVolumes().find(v=>v.id===item.volumeId);if(!volume){volume={id:uid(),title:item.title||T`第${activeVolumes().length+1}卷`,summary:item.body,deletedAt:null};state.book.volumes.push(volume);item.volumeId=volume.id;}else syncOutlineVolume(item);return volume;
}
function chapterFromOutline(item,open=true){
  if(!item)return null;const existing=activeChapters().find(c=>item.chapterIds.includes(c.id));if(existing){if(open)jumpToChapter(existing.id);return existing;}
  const volume=state.kind==='long'?outlineVolume(item):null,chapter={id:uid(),title:item.title||T('未命名章节'),body:'',volumeId:volume?.id||activeVolumes()[0]?.id||null,deletedAt:null};if(state.kind==='short')chapter.volumeId=null;
  state.book.chapters.push(chapter);item.chapterIds.push(chapter.id);markDirty();if(open){const trail={view:'outline',outlineId:item.id,personId:state.personId};state.view='write';state.trail=trail;renderShell();selectChapter(chapter.id);$('editor').focus();toast(T('已建立空白正文，章纲保留在大纲中。'));}return chapter;
}
function buildOutlineStructure(){
  const rows=outlineRows(),volumes=rows.filter(({o})=>o.kind==='volume'),chapters=rows.filter(({o})=>o.kind==='chapter'),newVolumes=volumes.filter(({o})=>!activeVolumes().some(v=>v.id===o.volumeId)).length,newChapters=chapters.filter(({o})=>!activeChapters().some(c=>o.chapterIds.includes(c.id))).length;
  const message=el('p','dialog-description',T`将按大纲建立 ${newVolumes} 卷、${newChapters} 个空白章节。已有的卷、章节与正文会保留，重复执行不会再建一次。大纲内容仍保留为策划。`),buttons=el('div','dialog-actions');
  buttons.append(action(T('取消'),'secondary-button',closeDialog),action(T('生成目录'),'primary-button',async()=>{volumes.forEach(({o})=>ensureOutlineVolume(o));chapters.forEach(({o})=>chapterFromOutline(o,false));markDirty();await saveNow();closeDialog();renderOutline();renderChapters();renderStats();toast(newChapters||newVolumes?T('卷章目录已建立。'):T('目录已完整，无需重复建立。'));}));showDialog(T('从大纲生成卷章目录'),message,buttons);
}
function renderLinkedBacklinks(){
  if(!state.book)return;const container=$('chapter-links');container.replaceChildren();if(!state.chapterId){container.append(el('p','empty-hint',T('创建章节后，这里会显示本章的大纲与人物。')));return;}
  const owners=allOwners().filter(o=>o.item.chapterIds.includes(state.chapterId)),manualPeople=new Set(owners.filter(o=>o.type==='person').map(o=>o.item.id));
  owners.forEach(owner=>{const button=action('','chapter-link',()=>jumpToOwner(owner));button.append(el('small',null,owner.kind),el('span',null,owner.name),el('small',null,T('查看')));container.append(button);});
  const analysis=analyzeWorkspace();people().filter(p=>!manualPeople.has(p.id)&&analysis.appearances[p.id]?.includes(state.chapterId)).forEach(person=>{const button=action('','chapter-link automatic-link',()=>jumpToOwner({type:'person',item:person}));button.append(el('small',null,T('提及')),el('span',null,person.title),el('small',null,T('人物档案')));container.append(button);});
  if(!container.children.length)container.append(el('p','empty-hint',T('还没有关联。可连接大纲、人物或关系；登记人物后也会按正文姓名自动索引。')));
}
function showAutomaticRelation(relation){
  const body=el('div'),links=el('div');body.append(el('p','dialog-description',T('这两个人物的姓名或别名出现在同一章中。这只是文本提及记录，具体关系需要你确认和编写。')));renderChapterLinks(links,relation);body.append(links,action(T('编写他们的关系'),'primary-button',()=>showRelation({id:uid(),fromId:relation.fromId,toId:relation.toId,label:'',type:'other',stage:'',body:'',volumeIds:[],chapterIds:[...relation.chapterIds],deletedAt:null})));showDialog(personName(relation.fromId)+T(' 与 ')+personName(relation.toId)+T(' · 同章提及'),body);
}
function renderPersonArc(){const person=currentPerson();if(!person)return;$('person-arc-body').value=person.profile.arcs.find(a=>a.volumeId===state.arcVolume)?.body||'';const timeline=$('person-timeline');timeline.replaceChildren();activeVolumes().forEach(volume=>{const body=person.profile.arcs.find(a=>a.volumeId===volume.id)?.body;if(!body)return;const card=el('article');card.append(el('strong',null,volume.title),el('p',null,body));timeline.append(card);});}
function showCandidatePeople(){
  const analysis=analyzeWorkspace(),content=el('div'),checks=[];content.append(el('p','dialog-description',T('本地规则会找出部分“姓名＋说／问”等对白写法，可能遗漏或误认。确认后建立人物档案，正文提及与同章提及会自动更新；人物关系含义仍由你填写。')));
  if(analysis.ambiguous.length)content.append(el('p','analysis-warning',T('以下称呼对应多位人物，未自动归属：')+analysis.ambiguous.map(a=>a.name).join('、')+T('。请在人物档案中调整别名。')));
  analysis.candidates.forEach(candidate=>{const row=el('div','candidate-person'),label=el('label','checkbox-row'),box=el('input'),name=el('input','text-field');box.type='checkbox';box.checked=true;name.value=candidate.name;name.maxLength=200;name.setAttribute('aria-label',T('确认人名 ')+candidate.name);label.append(box,el('span',null,T('登记为人物')));row.append(label,name);candidate.excerpts.slice(0,2).forEach(excerpt=>row.append(el('p','subtle',excerpt.text)));content.append(row);checks.push({box,name});});
  if(!analysis.candidates.length)content.append(el('p','empty-hint',T('没有新的待确认人名。也可以先手动建立人物，填写姓名与别名；正文会自动按这些称呼索引。')));
  const buttons=el('div','dialog-actions');buttons.append(action(T('关闭'),'secondary-button',closeDialog));if(checks.length)buttons.append(action(T('确认并建立人物'),'primary-button',async()=>{let added=0;checks.filter(c=>c.box.checked).forEach(({name})=>{const title=name.value.trim();if(!title||people().some(p=>p.title===title))return;state.book.notes.push({id:uid(),type:'人物',title,body:'',aliases:[],profile:emptyProfile(),chapterIds:[],deletedAt:null});added++;});if(added){markDirty();await saveNow();}closeDialog();renderPeople();toast(T('已建立 ')+added+T(' 位人物，正文提及已更新。'));}));content.append(buttons);showDialog(T('从正文识别人名'),content);
}
function bindWorkspaceEvents(){
  $('outline-search').addEventListener('input',filterOutlineTree);$('chapter-search').addEventListener('input',renderChapters);$('graph-auto').addEventListener('change',()=>{state.showAutomatic=$('graph-auto').checked;renderPeople();});$('relation-index').addEventListener('toggle',renderRelationIndex);$('load-example').addEventListener('click',showExampleLibrary);
  $('add-volume').addEventListener('click',()=>showVolumeEditor());$('chapter-volume').addEventListener('change',()=>{const chapter=currentChapter();if(!chapter)return;chapter.volumeId=$('chapter-volume').value||null;state.volumeId=chapter.volumeId;markDirty();selectChapter(chapter.id);});
  $('empty-open-outline').addEventListener('click',()=>{state.view='outline';renderShell();});$('empty-add-chapter').addEventListener('click',()=>addChapter());
  $('outline-template').addEventListener('click',()=>{createOutlineTemplate();markDirty();renderOutline();});$('outline-read-toggle').addEventListener('click',()=>{state.outlineMode=state.outlineMode==='read'?'edit':'read';renderOutline();});$('outline-build').addEventListener('click',buildOutlineStructure);
  $('outline-kind').addEventListener('change',()=>{const item=currentOutline();if(!item)return;item.kind=$('outline-kind').value;markDirty();renderOutline();});$('outline-volume').addEventListener('change',()=>{if(!currentOutline())return;currentOutline().volumeId=$('outline-volume').value||null;markDirty();renderOutline();});
  $('outline-create-chapter').addEventListener('click',()=>{const item=currentOutline();if(!item)return;if(item.kind==='story'){buildOutlineStructure();return;}if(item.kind==='volume'){ensureOutlineVolume(item);markDirty();renderOutline();toast(T('对应卷已建立，可以继续添加章纲。'));return;}chapterFromOutline(item);});
  $('person-aliases').addEventListener('input',()=>{if(!currentPerson())return;currentPerson().aliases=$('person-aliases').value.split(/[,，、;；\n]+/).map(s=>s.trim()).filter(Boolean);markDirty();renderGraph();renderBacklinks();});
  ['group','role','desire','flaw','ending'].forEach(key=>$('profile-'+key).addEventListener('input',()=>{if(!currentPerson())return;currentPerson().profile[key]=$('profile-'+key).value;markDirty();if(key==='group'){populateSelect($('graph-group'),[...new Set(people().map(p=>p.profile.group).filter(Boolean))].map(group=>({id:group,title:group})),T('全部分组'),state.graphGroup||'');state.graphGroup=$('graph-group').value;renderGraph();}}));
  $('person-arc-volume').addEventListener('change',()=>{state.arcVolume=$('person-arc-volume').value;renderPersonArc();});$('person-arc-body').addEventListener('input',()=>{const person=currentPerson();if(!person||!state.arcVolume)return;let arc=person.profile.arcs.find(a=>a.volumeId===state.arcVolume);if(!arc){arc={volumeId:state.arcVolume,body:''};person.profile.arcs.push(arc);}arc.body=$('person-arc-body').value;markDirty();});
  bindAtlasEvents();
  $('review-candidates').addEventListener('click',showCandidatePeople);$('relation-search').addEventListener('input',renderRelationIndex);$('relation-type-filter').addEventListener('change',renderRelationIndex);
}
async function showExampleLibrary(){
  try{const examples=(await api('/api/examples')).examples,body=el('div');
    if(!examples.length)body.append(el('p','dialog-description',T('示例小说尚未安装')));
    for(const example of examples){const card=el('article','example-card');card.append(el('h3',null,example.title),el('p',null,T('{0} 卷 · {1} 章 · {2} 位人物 · {3} 字',example.volumeCount,example.chapterCount,example.personCount,example.charCount.toLocaleString())),el('p','dialog-description',T('原创群像小说，包含完整大纲、人物档案、关系与正文。载入会新建一份可编辑副本。')),action(T('载入示例副本'),'primary-button',()=>transition(async()=>{if(!await requireSaved())return;try{setBook(await api('/api/examples/'+example.id,'POST',{}));state.view='outline';closeDialog();await refreshBooks();renderShell();toast(T('示例小说已载入，可以自由编辑。'));}catch(error){toast(error.message);}})));body.append(card);}
    showDialog(T('长篇示例小说'),body);
  }catch(error){toast(error.message);}
}
initialize();
