'use strict';

const outlineKinds={story:T('全书总纲'),volume:T('分卷大纲'),chapter:T('章节大纲'),scene:T('情节 / 设定')};
const relationTypes={friend:T('友谊与信任'),mentor:T('师承'),family:T('亲属'),conflict:T('冲突'),cooperate:T('合作'),fate:T('命运与研究'),other:T('其他'),automatic:T('同章提及')};
const activeVolumes=()=>state.book?.volumes.filter(v=>!v.deletedAt)||[];
function emptyProfile(){return{group:'',role:'',desire:'',flaw:'',ending:'',arcs:[]};}
function normalizeWorkspaceBook(book){
  book.kind??='long';book.cover??='';book.volumes??=[];book.outline??=[];book.relations??=[];
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
  else{let hash=0;for(const ch of book.title)hash=(hash*31+ch.charCodeAt(0))>>>0;cover.classList.add('cover-tone-'+hash%5);cover.append(el('span','cover-category',kindName(book.kind)),el('strong','cover-book-title',book.title),el('span','cover-foot',T('作家工作台 · ')+(book.kind==='short'?T('短篇故事'):T('长篇小说'))));}
  return cover;
}
async function showCollection(target='shelf',kind=state.kind){
  await transition(async()=>{if(!await requireSaved())return;try{await refreshBooks();await loadKind(kind);state.view='shelf';state.collection=target;state.trail=null;closeDialog();closeNav();exitFocus();renderShell();}catch(e){toast(e.message);}});
}
function renderWorkspaceShell(){
  const missing=!state.book&&state.view!=='shelf';
  ['shelf','outline','people','write'].forEach(view=>{$(view+'-view').hidden=missing||state.view!==view;});
  $('no-book').hidden=!missing;$('no-book-title').textContent=T('还没有{0}作品',kindName());$('empty-new-book').textContent=T('＋ 新建{0}',kindName());
  const collection=state.collection||'shelf',titles={shelf:T('书架'),outline:T('大纲库'),people:T('人物档案库'),write:T('{0}写作',kindName())},names={shelf:titles[collection],outline:T('故事大纲'),people:T('人物脉络'),write:T('{0}写作台',kindName())};
  $('page-title').textContent=names[state.view];$('mobile-context').textContent=state.view==='shelf'?T('{0}作品',kindName()):state.book?.title||'';
  $('breadcrumb').textContent=state.view==='shelf'?'':state.book?kindName()+' / '+state.book.title:'';$('book-kind').textContent=kindName();
  if(state.book){$('book-name').textContent=state.book.title;document.title=state.book.title+T(' · 作家工作台');renderStats();}
  ['shelf','outline','people'].forEach(view=>{const active=(state.view==='shelf'?collection:state.view)===view;$('nav-'+view).classList.toggle('active',active);$('nav-'+view).setAttribute('aria-current',active?'page':'false');});
  ['long','short'].forEach(kind=>{const active=(state.view==='write'||state.view==='shelf'&&collection==='write')&&state.kind===kind;$('nav-write-'+kind).classList.toggle('active',active);$('nav-write-'+kind).setAttribute('aria-current',active?'page':'false');});
  $('link-current-chapter').disabled=!currentChapter();$('backlinks-edit').disabled=!currentChapter();$('toggle-notes').hidden=state.view!=='write'||missing;$('toggle-focus').hidden=state.view!=='write'||missing||!currentChapter();$('open-trash').disabled=!state.book;$('open-backup').disabled=!state.book;
  $('chapter-panel-kind').textContent=T('{0}写作',kindName());$('chapter-list-label').textContent=state.kind==='short'?T('篇章'):T('卷与章节');$('add-volume').hidden=state.kind==='short';
  $('return-source').hidden=!state.trail;$('return-source').textContent=state.trail?.view==='outline'?T('返回大纲'):T('返回人物脉络');
  $('book-context').hidden=state.view==='shelf'||missing;
  if(state.book&&state.view!=='shelf'){
    const contextBooks=state.books.some(b=>b.id===state.book.id)?state.books:[{id:state.book.id,title:state.book.title},...state.books];populateSelect($('context-book'),contextBooks,null,state.book.id);
    $('context-count').textContent=state.kind==='long'?T`${activeVolumes().length} 卷 · ${activeChapters().length} 章`:T`${activeChapters().length} 篇章`;
    ['outline','people','write'].forEach(view=>{$('context-'+view).classList.toggle('active',state.view===view);$('context-'+view).setAttribute('aria-current',state.view===view?'page':'false');});
  }
  preference('yejian.view',state.view);preference('yejian.collection',state.collection||'');
  if(state.view==='shelf')renderShelf();
  if(state.book&&state.view==='outline')renderOutline();
  if(state.book&&state.view==='people')renderPeople();
  if(state.book&&state.view==='write'){selectChapter(state.chapterId||activeChapters()[0]?.id);renderBacklinks();requestAnimationFrame(resizeEditor);}
}
function renderCollection(){
  const target=state.collection||'shelf',books=state.books.filter(b=>b.kind===state.kind),suffix={shelf:T('书架'),outline:T('大纲'),people:T('人物档案'),write:T('写作')}[target];
  $('shelf-title').textContent=target==='shelf'?(state.kind==='long'?T('长篇书架'):T('短篇书架')):T('{0} · {1}',kindName(),suffix);$('shelf-meta').textContent=target==='shelf'?T`${books.length} 部作品 · ${books.reduce((sum,b)=>sum+b.charCount,0).toLocaleString()} 字`:T('选择一本书，打开它独立的{0}。',suffix);$('new-book').textContent=T('＋ 新建{0}',kindName());
  ['long','short'].forEach(kind=>{$('shelf-'+kind).classList.toggle('active',state.kind===kind);$('shelf-'+kind).setAttribute('aria-pressed',String(state.kind===kind));$(kind+'-count').textContent=state.books.filter(b=>b.kind===kind).length;});
  const grid=$('shelf-grid');grid.replaceChildren();
  books.forEach(book=>{
    const card=el('article','shelf-book'),coverButton=action('','cover-open',()=>openBook(book.id,target==='shelf'?'outline':target));coverButton.setAttribute('aria-label',T('打开')+book.title);coverButton.append(buildBookCover(book));
    const info=el('div','shelf-book-info'),titleButton=action(book.title,'shelf-book-title',()=>openBook(book.id,target==='shelf'?'outline':target));
    const meta=(book.kind==='long'?T`${book.volumeCount||0} 卷 · `:'')+T`${book.chapterCount} ${book.kind==='short'?T('篇章'):T('章')} · ${book.charCount.toLocaleString()} 字`;
    info.append(titleButton,el('p','shelf-book-progress',book.latestChapterTitle?T('最近章节：')+book.latestChapterTitle:T('构思中 · 先写大纲，再开始正文')),el('p','shelf-book-excerpt',book.excerpt?.replace(/\n+/g,' ').slice(0,95)||T('把故事的想法放在这里，慢慢写成一本书。')));
    const bottom=el('div','shelf-book-bottom');bottom.append(el('span',null,meta),el('span','shelf-book-plan',T`${book.outlineCount||0} 条大纲 · ${book.personCount||0} 位人物`));
    info.append(bottom,el('p','shelf-book-updated',T('最近编辑 ')+new Date(book.updatedAt).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})));
    const actions=el('div','shelf-book-actions');
    [[T('大纲'),'outline'],[T('人物脉络'),'people'],[book.chapterCount?T('继续写作'):T('开始正文'),'write']].forEach(([label,view])=>actions.append(action(label,(target===view||target==='shelf'&&view==='write')?'primary-button':'secondary-button',()=>openBook(book.id,view))));
    actions.append(action(T('封面与书名'),'text-button',async()=>{if(await openBook(book.id,'outline')&&state.book?.id===book.id)showBookSettings(true);}));card.append(coverButton,info,actions);grid.append(card);
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
  if(activeOutline().length)return;const root={id:uid(),title:T('全书总纲'),kind:'story',body:'',parentId:null,volumeId:null,chapterIds:[],deletedAt:null};state.book.outline.push(root);
  if(state.kind==='long')activeVolumes().forEach(v=>state.book.outline.push({id:uid(),title:v.title,kind:'volume',body:v.summary,parentId:root.id,volumeId:v.id,chapterIds:[],deletedAt:null}));
  [T('世界观与规则'),T('伏笔与回收'),T('连续性检查')].forEach(title=>state.book.outline.push({id:uid(),title,kind:'scene',body:'',parentId:null,volumeId:null,chapterIds:[],deletedAt:null}));state.outlineId=root.id;
}
function showNewOutline(parentId=null){
  const form=el('form'),title=el('input','text-field'),kind=el('select','text-field'),parent=activeOutline().find(o=>o.id===parentId);title.id='new-outline-title';title.maxLength=200;title.required=true;title.placeholder=T('例如：第一卷 归来，或第一章 潮声');kind.id='new-outline-kind';Object.entries(outlineKinds).forEach(([id,text])=>{const option=el('option',null,text);option.value=id;kind.append(option);});kind.value=parent?.kind==='volume'?'chapter':'scene';addField(form,T('大纲标题'),title);addField(form,T('大纲层级'),kind);const buttons=el('div','dialog-actions'),submit=el('button','primary-button',T('建立大纲'));submit.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),submit);form.append(buttons);form.addEventListener('submit',event=>{event.preventDefault();if(!title.value.trim())return;addOutline(parentId,kind.value,parent?.volumeId||null);currentOutline().title=title.value.trim();markDirty();closeDialog();renderOutline();$('outline-body').focus();});showDialog(parent?T('新建子大纲'):T('新建大纲'),form);title.focus();
}
function renderOutlineWorkspace(){
  if(!state.book)return;const rows=outlineRows(),reading=state.outlineMode==='read';if(!rows.some(({o})=>o.id===state.outlineId))state.outlineId=rows[0]?.o.id||null;
  $('outline-book-title').textContent=state.book.title+T(' · 大纲');$('outline-read-toggle').textContent=reading?T('返回编辑'):T('完整阅读');$('outline-build').hidden=state.kind==='short';
  const tree=$('outline-tree');tree.replaceChildren();rows.forEach(({o,depth})=>{const button=action('','outline-node'+(o.id===state.outlineId?' active':''),()=>{state.outlineId=o.id;if(state.outlineMode==='read'){document.getElementById('read-'+o.id)?.scrollIntoView({behavior:'smooth',block:'start'});tree.querySelectorAll('.outline-node').forEach(b=>b.classList.toggle('active',b.dataset.outline===o.id));}else renderOutline();});button.dataset.outline=o.id;button.style.paddingLeft=12+Math.min(depth,5)*15+'px';button.append(el('span','outline-node-title',o.title||T('未命名节点')),el('small',null,outlineKinds[o.kind]+(o.chapterIds.length?' · '+o.chapterIds.length+T(' 章'):'')));tree.append(button);});
  filterOutlineTree();const item=currentOutline();$('outline-empty').hidden=!!item;$('outline-detail').hidden=!item||reading;$('outline-reading').hidden=!item||!reading;
  if(!item)return;if(reading){renderOutlineReading();return;}
  $('outline-title').value=item.title;$('outline-body').value=item.body;$('outline-path').textContent=outlineKinds[item.kind]+' · '+state.book.title;$('outline-kind').value=item.kind;
  $('outline-volume-field').hidden=state.kind==='short';populateSelect($('outline-volume'),activeVolumes(),T('全书 / 未指定卷'),item.volumeId||'');
  populateSelect($('outline-parent'),rows.filter(({o})=>o.id!==item.id&&!isDescendant(o.id,item.id)).map(({o,depth})=>({id:o.id,title:'　'.repeat(Math.min(depth,5))+(o.title||T('未命名节点'))})),T('顶层节点'),item.parentId||'');
  const siblings=rows.filter(({o})=>o.parentId===item.parentId).map(({o})=>o),index=siblings.indexOf(item);$('outline-up').disabled=index<=0;$('outline-down').disabled=index>=siblings.length-1;
  $('outline-create-chapter').textContent=item.kind==='volume'?T('建立对应卷'):item.kind==='story'?T('生成卷章目录'):item.chapterIds.length?T('打开关联章节'):T('按此大纲创建章节');renderChapterLinks($('outline-links'),item);
}
function filterOutlineTree(){const query=$('outline-search').value.trim().toLocaleLowerCase(),items=activeOutline(),visible=new Set();if(query)items.filter(o=>(o.title+' '+o.body).toLocaleLowerCase().includes(query)).forEach(o=>{let cursor=o;while(cursor&&!visible.has(cursor.id)){visible.add(cursor.id);cursor=items.find(p=>p.id===cursor.parentId);}});$('outline-tree').querySelectorAll('[data-outline]').forEach(row=>row.hidden=!!query&&!visible.has(row.dataset.outline));}
function renderOutlineReading(){
  const reader=$('outline-reading');reader.replaceChildren(el('h1',null,state.book.title),el('p','subtle',T('完整大纲 · ')+activeOutline().length+T(' 个节点')));
  outlineRows().forEach(({o,depth})=>{const section=el('section','outline-read-section');section.id='read-'+o.id;section.append(el('span','outline-read-kind',outlineKinds[o.kind]),el(depth?'h3':'h2',null,o.title||T('未命名节点')),el('div','outline-read-body',o.body||T('这一部分还没有填写。')));const links=el('div');if(o.chapterIds.length)renderChapterLinks(links,o);section.append(links,action(T('编辑这一节'),'text-button',()=>{state.outlineMode='edit';state.outlineId=o.id;renderOutline();}));reader.append(section);});
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
function graphRelations(){
  const relations=combinedRelations().filter(r=>state.showAutomatic||!r.automatic),volumeId=state.graphVolume;if(!volumeId)return relations;
  const chapterIds=new Set(activeChapters().filter(c=>c.volumeId===volumeId).map(c=>c.id));
  return relations.filter(r=>r.automatic?r.chapterIds.some(id=>chapterIds.has(id)):r.volumeIds.length?r.volumeIds.includes(volumeId):!r.chapterIds.length||r.chapterIds.some(id=>chapterIds.has(id)));
}
function filteredGraphPeople(){
  let list=people(),relations=graphRelations();const volumeId=state.graphVolume||'',group=state.graphGroup||'';
  if(volumeId){const chapterIds=new Set(activeChapters().filter(c=>c.volumeId===volumeId).map(c=>c.id)),plannedIds=new Set(relations.filter(r=>r.volumeIds.includes(volumeId)).flatMap(r=>[r.fromId,r.toId]));list=list.filter(p=>plannedIds.has(p.id)||personChapterIds(p).some(id=>chapterIds.has(id))||p.profile.arcs.some(a=>a.volumeId===volumeId&&a.body));}
  if(group)list=list.filter(p=>p.profile.group===group);
  if(state.graphScope==='neighbors'&&state.personId){const neighbors=new Set([state.personId]);relations.filter(r=>r.fromId===state.personId||r.toId===state.personId).forEach(r=>{neighbors.add(r.fromId);neighbors.add(r.toId);});list=list.filter(p=>neighbors.has(p.id));}
  return list;
}
function renderAtlas(){
  if(!state.book)return;const list=filteredGraphPeople(),ids=new Set(list.map(p=>p.id)),relations=graphRelations().filter(r=>ids.has(r.fromId)&&ids.has(r.toId)),graph=$('people-graph'),height=list.length<=2?360:list.length>12?Math.max(580,Math.ceil(list.length/4)*175+90):580;
  graph.replaceChildren();graph.setAttribute('viewBox',`0 0 880 ${height}`);graph.setAttribute('width',880);graph.setAttribute('height',height);state.graphHeight=height;
  $('graph-empty').hidden=!!list.length;$('graph-empty').textContent=people().length?T('这个视图还没有人物，可调整分组或卷的筛选。'):T('先建立人物档案，或从正文识别人名。');
  $('graph-count').textContent=T`${list.length} 位人物 · ${relations.filter(r=>!r.automatic).length} 条关系 · ${relations.filter(r=>r.automatic).length} 条同章提及`;
  const positions=new Map();list.forEach((p,i)=>{let x,y;if(list.length===1){x=440;y=180;}else if(list.length===2){x=i?650:230;y=180;}else if(list.length<=12){const angle=-Math.PI/2+i*2*Math.PI/list.length;x=440+345*Math.cos(angle);y=280+197*Math.sin(angle);}else{x=110+i%4*220;y=110+Math.floor(i/4)*175;}positions.set(p.id,{x,y});});
  const pairs=new Map();relations.forEach(r=>{const key=[r.fromId,r.toId].sort().join('|');if(!pairs.has(key))pairs.set(key,[]);pairs.get(key).push(r.id);});
  relations.forEach(r=>{
    const a=positions.get(r.fromId),b=positions.get(r.toId),dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1,ux=dx/length,uy=dy/length,key=[r.fromId,r.toId].sort().join('|'),siblings=pairs.get(key),offset=(siblings.indexOf(r.id)-(siblings.length-1)/2)*65;
    const sx=a.x+ux*55,sy=a.y+uy*55,ex=b.x-ux*55,ey=b.y-uy*55,cx=(sx+ex)/2-uy*offset,cy=(sy+ey)/2+ux*offset,lx=(sx+2*cx+ex)/4,ly=(sy+2*cy+ey)/4;
    const group=svgElement('g',{class:'graph-edge'+(r.automatic?' automatic':'')+([r.fromId,r.toId].includes(state.personId)?' active':''),role:'button',tabindex:0,'aria-label':T`查看${r.automatic?T('同章提及'):T('关系')} ${personName(r.fromId)} 与 ${personName(r.toId)}：${r.label||T('未命名关系')}`});
    const path=`M${sx} ${sy} Q${cx} ${cy} ${ex} ${ey}`;group.append(svgElement('path',{d:path,stroke:'transparent','stroke-width':22,fill:'none'}),svgElement('path',{d:path,class:'edge-line'}));const label=Array.from(r.label||T('未命名关系')).slice(0,12).join(''),width=Math.max(75,Array.from(label).length*19+24);group.append(svgElement('rect',{x:lx-width/2,y:ly-17,width,height:34,rx:5}),svgElement('text',{x:lx,y:ly+6,'text-anchor':'middle'},label));graphActivate(group,()=>r.automatic?showAutomaticRelation(r):showRelation(r));graph.append(group);
  });
  list.forEach(person=>{const {x,y}=positions.get(person.id),group=svgElement('g',{class:'graph-node'+(person.id===state.personId?' selected':''),role:'button',tabindex:0,'aria-label':T('查看人物 ')+(person.title||T('未命名人物'))});const mentions=personChapterIds(person).length;group.append(svgElement('rect',{x:x-86,y:y-39,width:172,height:78,rx:10,class:'person-node-card'}),svgElement('text',{x,y:y-1,'text-anchor':'middle'},Array.from(person.title||T('未命名')).slice(0,7).join('')),svgElement('text',{x,y:y+24,'text-anchor':'middle',class:'node-meta'},person.profile.group||(mentions?mentions+T(' 个相关章节'):T('人物'))));graphActivate(group,()=>{state.personId=person.id;renderPeople();});graph.append(group);});
  if(!state.graphZoom)state.graphZoom=Math.max(.45,Math.min(1,graph.parentElement.clientWidth/880||1));applyGraphZoom();renderRelationIndex();
}
function applyGraphZoom(){const graph=$('people-graph'),zoom=state.graphZoom||1;graph.style.width=880*zoom+'px';graph.style.height=(state.graphHeight||580)*zoom+'px';$('graph-zoom-label').textContent=Math.round(zoom*100)+'%';}
function showAutomaticRelation(relation){
  const body=el('div'),links=el('div');body.append(el('p','dialog-description',T('这两个人物的姓名或别名出现在同一章中。这只是文本提及记录，具体关系需要你确认和编写。')));renderChapterLinks(links,relation);body.append(links,action(T('编写他们的关系'),'primary-button',()=>showRelation({id:uid(),fromId:relation.fromId,toId:relation.toId,label:'',type:'other',stage:'',body:'',volumeIds:[],chapterIds:[...relation.chapterIds],deletedAt:null})));showDialog(personName(relation.fromId)+T(' 与 ')+personName(relation.toId)+T(' · 同章提及'),body);
}
function renderRelationsForPerson(){
  const container=$('person-relations');container.replaceChildren();const person=currentPerson();if(!person)return;combinedRelations().filter(r=>r.fromId===person.id||r.toId===person.id).forEach(r=>{const other=r.fromId===person.id?r.toId:r.fromId,button=action('','relation-row'+(r.automatic?' automatic-link':''),()=>r.automatic?showAutomaticRelation(r):showRelation(r));button.append(el('span',null,(r.label||T('未命名关系'))+' · '+personName(other)),el('small',null,(r.automatic?T('自动索引'):T('手动编写'))+' · '+r.chapterIds.length+T(' 个关联章节')));container.append(button);});if(!container.children.length)container.append(el('p','empty-hint',T('先写好人物关系也可以，正文完成后会自动补充姓名提及。')));
}
function renderPersonWorkspace(){
  if(!state.book)return;const list=people();if(!list.some(p=>p.id===state.personId))state.personId=list[0]?.id||null;
  populateSelect($('graph-volume'),activeVolumes(),T('全部卷'),state.graphVolume||'');$('graph-volume').hidden=state.kind==='short';state.graphVolume=$('graph-volume').value;
  populateSelect($('graph-group'),[...new Set(list.map(p=>p.profile.group).filter(Boolean))].map(group=>({id:group,title:group})),T('全部分组'),state.graphGroup||'');state.graphGroup=$('graph-group').value;
  $('graph-scope').value=state.graphScope||'all';$('graph-auto').checked=!!state.showAutomatic;const analysis=analyzeWorkspace();$('review-candidates').textContent=analysis.candidates.length?T`待确认人名 ${analysis.candidates.length}`:T('正文识别人名');
  renderGraph();const person=currentPerson();$('person-detail').hidden=!person;$('add-relation').disabled=list.length<2;
  if(person){$('person-title').value=person.title;$('person-body').value=person.body;$('person-aliases').value=person.aliases.join('，');['group','role','desire','flaw','ending'].forEach(key=>$('profile-'+key).value=person.profile[key]||'');$('character-arcs').hidden=state.kind==='short'||!activeVolumes().length;
    populateSelect($('person-arc-volume'),activeVolumes(),null,state.arcVolume||activeVolumes()[0]?.id||'');state.arcVolume=$('person-arc-volume').value;renderPersonArc();renderPersonRelations();renderChapterLinks($('person-links'),person);renderChapterLinks($('person-auto-links'),{chapterIds:analysis.appearances[person.id]||[]});}
  renderPersonSearch();
}
function renderPersonArc(){const person=currentPerson();if(!person)return;$('person-arc-body').value=person.profile.arcs.find(a=>a.volumeId===state.arcVolume)?.body||'';const timeline=$('person-timeline');timeline.replaceChildren();activeVolumes().forEach(volume=>{const body=person.profile.arcs.find(a=>a.volumeId===volume.id)?.body;if(!body)return;const card=el('article');card.append(el('strong',null,volume.title),el('p',null,body));timeline.append(card);});}
function renderRelationIndex(){
  const query=$('relation-search').value.trim().toLocaleLowerCase(),type=$('relation-type-filter').value,all=combinedRelations(),relations=all.filter(r=>(!type||r.type===type)&&(!query||[personName(r.fromId),personName(r.toId),r.label,r.body,r.stage].join(' ').toLocaleLowerCase().includes(query))),container=$('relation-index-list');container.replaceChildren();$('relation-index-count').textContent=T`${all.length} 条`;
  if(!$('relation-index').open)return;
  relations.forEach(r=>{const row=action('','relation-index-row',()=>r.automatic?showAutomaticRelation(r):showRelation(r));row.append(el('span',null,personName(r.fromId)+' ↔ '+personName(r.toId)),el('strong',null,r.label||T('未命名关系')),el('small',null,(relationTypes[r.type]||T('其他'))+(r.stage?' · '+r.stage:'')));container.append(row);});if(!relations.length)container.append(el('p','empty-hint',T('没有符合条件的关系。')));
}
function showCandidatePeople(){
  const analysis=analyzeWorkspace(),content=el('div'),checks=[];content.append(el('p','dialog-description',T('本地规则会找出部分“姓名＋说／问”等对白写法，可能遗漏或误认。确认后建立人物档案，正文提及与同章提及会自动更新；人物关系含义仍由你填写。')));
  if(analysis.ambiguous.length)content.append(el('p','analysis-warning',T('以下称呼对应多位人物，未自动归属：')+analysis.ambiguous.map(a=>a.name).join('、')+T('。请在人物档案中调整别名。')));
  analysis.candidates.forEach(candidate=>{const row=el('div','candidate-person'),label=el('label','checkbox-row'),box=el('input'),name=el('input','text-field');box.type='checkbox';box.checked=true;name.value=candidate.name;name.maxLength=200;name.setAttribute('aria-label',T('确认人名 ')+candidate.name);label.append(box,el('span',null,T('登记为人物')));row.append(label,name);candidate.excerpts.slice(0,2).forEach(excerpt=>row.append(el('p','subtle',excerpt.text)));content.append(row);checks.push({box,name});});
  if(!analysis.candidates.length)content.append(el('p','empty-hint',T('没有新的待确认人名。也可以先手动建立人物，填写姓名与别名；正文会自动按这些称呼索引。')));
  const buttons=el('div','dialog-actions');buttons.append(action(T('关闭'),'secondary-button',closeDialog));if(checks.length)buttons.append(action(T('确认并建立人物'),'primary-button',async()=>{let added=0;checks.filter(c=>c.box.checked).forEach(({name})=>{const title=name.value.trim();if(!title||people().some(p=>p.title===title))return;state.book.notes.push({id:uid(),type:'人物',title,body:'',aliases:[],profile:emptyProfile(),chapterIds:[],deletedAt:null});added++;});if(added){markDirty();await saveNow();}closeDialog();renderPeople();toast(T('已建立 ')+added+T(' 位人物，正文提及已更新。'));}));content.append(buttons);showDialog(T('从正文识别人名'),content);
}
function bindWorkspaceEvents(){
  $('outline-search').addEventListener('input',filterOutlineTree);$('chapter-search').addEventListener('input',renderChapters);$('graph-auto').addEventListener('change',()=>{state.showAutomatic=$('graph-auto').checked;renderGraph();});$('relation-index').addEventListener('toggle',renderRelationIndex);$('load-example').addEventListener('click',showExampleLibrary);
  $('context-book').addEventListener('change',async event=>{const target=event.target.value;if(!await openBook(target,state.view))$('context-book').value=state.book?.id||'';});['outline','people','write'].forEach(view=>$('context-'+view).addEventListener('click',async()=>{if(!await requireSaved())return;state.view=view;state.trail=null;renderShell();}));
  $('add-volume').addEventListener('click',()=>showVolumeEditor());$('chapter-volume').addEventListener('change',()=>{const chapter=currentChapter();if(!chapter)return;chapter.volumeId=$('chapter-volume').value||null;state.volumeId=chapter.volumeId;markDirty();selectChapter(chapter.id);});
  $('empty-open-outline').addEventListener('click',()=>{state.view='outline';renderShell();});$('empty-add-chapter').addEventListener('click',()=>addChapter());
  $('outline-template').addEventListener('click',()=>{createOutlineTemplate();markDirty();renderOutline();});$('outline-read-toggle').addEventListener('click',()=>{state.outlineMode=state.outlineMode==='read'?'edit':'read';renderOutline();});$('outline-build').addEventListener('click',buildOutlineStructure);
  $('outline-kind').addEventListener('change',()=>{const item=currentOutline();if(!item)return;item.kind=$('outline-kind').value;markDirty();renderOutline();});$('outline-volume').addEventListener('change',()=>{if(!currentOutline())return;currentOutline().volumeId=$('outline-volume').value||null;markDirty();renderOutline();});
  $('outline-create-chapter').addEventListener('click',()=>{const item=currentOutline();if(!item)return;if(item.kind==='story'){buildOutlineStructure();return;}if(item.kind==='volume'){ensureOutlineVolume(item);markDirty();renderOutline();toast(T('对应卷已建立，可以继续添加章纲。'));return;}chapterFromOutline(item);});
  $('person-aliases').addEventListener('input',()=>{if(!currentPerson())return;currentPerson().aliases=$('person-aliases').value.split(/[,，、;；\n]+/).map(s=>s.trim()).filter(Boolean);markDirty();renderGraph();renderBacklinks();});
  ['group','role','desire','flaw','ending'].forEach(key=>$('profile-'+key).addEventListener('input',()=>{if(!currentPerson())return;currentPerson().profile[key]=$('profile-'+key).value;markDirty();if(key==='group'){populateSelect($('graph-group'),[...new Set(people().map(p=>p.profile.group).filter(Boolean))].map(group=>({id:group,title:group})),T('全部分组'),state.graphGroup||'');state.graphGroup=$('graph-group').value;renderGraph();}}));
  $('person-arc-volume').addEventListener('change',()=>{state.arcVolume=$('person-arc-volume').value;renderPersonArc();});$('person-arc-body').addEventListener('input',()=>{const person=currentPerson();if(!person||!state.arcVolume)return;let arc=person.profile.arcs.find(a=>a.volumeId===state.arcVolume);if(!arc){arc={volumeId:state.arcVolume,body:''};person.profile.arcs.push(arc);}arc.body=$('person-arc-body').value;markDirty();});
  [['graph-scope','graphScope'],['graph-volume','graphVolume'],['graph-group','graphGroup']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state[key]=$(id).value;renderGraph();}));
  $('graph-zoom-in').addEventListener('click',()=>{state.graphZoom=Math.min(2.5,(state.graphZoom||1)*1.2);applyGraphZoom();});$('graph-zoom-out').addEventListener('click',()=>{state.graphZoom=Math.max(.25,(state.graphZoom||1)/1.2);applyGraphZoom();});$('graph-fit').addEventListener('click',()=>{const scroll=$('people-graph').parentElement;state.graphZoom=Math.min(scroll.clientWidth/880,scroll.clientHeight/(state.graphHeight||580));applyGraphZoom();scroll.scrollTop=0;scroll.scrollLeft=0;});
  const scroll=$('people-graph').parentElement;let drag=null;scroll.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('[role=button]'))return;drag={x:event.clientX,y:event.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};scroll.setPointerCapture(event.pointerId);scroll.classList.add('panning');});scroll.addEventListener('pointermove',event=>{if(!drag)return;scroll.scrollLeft=drag.left+drag.x-event.clientX;scroll.scrollTop=drag.top+drag.y-event.clientY;});function endDrag(){drag=null;scroll.classList.remove('panning');}scroll.addEventListener('pointerup',endDrag);scroll.addEventListener('pointercancel',endDrag);
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
