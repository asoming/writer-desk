'use strict';

const atlasColors=['#526bd1','#4b8e79','#8c73ae','#b28a58','#b76e78','#4e939d','#788696'];
const atlasEdgeColors={friend:'#6e9c82',mentor:'#8d7aaf',family:'#b59160',conflict:'#bc727c',cooperate:'#7792bc',fate:'#5b9ba3',other:'#8c99ab',automatic:'#b9c9ce'};
function atlasRelationTypeLabel(type){return state.kind==='short'&&type==='automatic'?T('正文共同提及'):relationTypes[type]||T('其他');}

function atlasGroups(){return [...new Set(people().map(p=>p.profile.group||T('未分组')))];}
function atlasColor(person){return atlasColors[Math.max(0,atlasGroups().indexOf(person.profile.group||T('未分组')))%atlasColors.length];}
function atlasCorePerson(){return people().find(p=>/主角|主视角|主人公|protagonist/i.test(p.profile.role))||people()[0];}
function atlasViews(){
  return [{id:'core',title:T('核心关系'),description:T('以主角和直接关系展开。点选人物突出相关连线，查看右侧档案。')},
    ...state.book.atlasViews.map(v=>({...v,id:'view:'+v.id})),
    {id:'all',title:T('全部人物'),description:state.kind==='short'?T('查看全篇的人物网络。可按分组或关系类型缩小范围。'):T('查看整本书的人物网络。可按分组、关系类型或卷缩小范围。')}];
}
function graphRelations({showAutomatic=state.showAutomatic,type=state.graphRelationType}={}){
  let relations=combinedRelations().filter(r=>showAutomatic||!r.automatic);
  if(type)relations=relations.filter(r=>r.type===type);
  if(state.kind==='short'||!state.graphVolume)return relations;
  const chapters=new Set(activeChapters().filter(c=>c.volumeId===state.graphVolume).map(c=>c.id));
  return relations.filter(r=>r.volumeIds?.length?r.volumeIds.includes(state.graphVolume):!r.chapterIds.length||r.chapterIds.some(id=>chapters.has(id)));
}
function filteredGraphPeople(relations=graphRelations({showAutomatic:state.atlasMode==='index'||state.showAutomatic,type:state.atlasMode==='index'?'':state.graphRelationType})){
  let list=people();const view=state.atlasView||'core';
  if(view==='core'){
    const center=atlasCorePerson()?.id,ids=new Set([center]);
    relations.filter(r=>r.fromId===center||r.toId===center).forEach(r=>{ids.add(r.fromId);ids.add(r.toId);});
    list=list.filter(p=>ids.has(p.id));
  }else if(view.startsWith('view:')){
    const saved=state.book.atlasViews.find(v=>'view:'+v.id===view);if(saved)list=list.filter(p=>saved.personIds.includes(p.id));
  }
  if(state.kind==='long'&&state.graphVolume){
    const chapterIds=new Set(activeChapters().filter(c=>c.volumeId===state.graphVolume).map(c=>c.id));
    const planned=new Set(relations.filter(r=>r.volumeIds?.includes(state.graphVolume)).flatMap(r=>[r.fromId,r.toId]));
    list=list.filter(p=>planned.has(p.id)||personChapterIds(p).some(id=>chapterIds.has(id))||p.profile.arcs.some(a=>a.volumeId===state.graphVolume&&a.body));
  }
  if(state.graphGroup){
    const seeds=new Set(people().filter(p=>(p.profile.group||T('未分组'))===state.graphGroup).map(p=>p.id)),ids=new Set(seeds);
    relations.filter(r=>!r.automatic&&(seeds.has(r.fromId)||seeds.has(r.toId))).forEach(r=>{ids.add(r.fromId);ids.add(r.toId);});
    list=list.filter(p=>ids.has(p.id));
  }
  if(state.graphScope==='neighbors'&&state.personId){
    const ids=new Set([state.personId]);relations.filter(r=>r.fromId===state.personId||r.toId===state.personId).forEach(r=>{ids.add(r.fromId);ids.add(r.toId);});list=list.filter(p=>ids.has(p.id));
  }
  return list;
}
function setAtlasView(id){
  state.atlasView=id;state.graphGroup='';state.graphScope='all';state.graphZoom=null;state.atlasFocusId=null;state.personEditing=false;
  renderPeople();
}
function renderAtlasNavigation(){
  const tabs=$('atlas-views');tabs.replaceChildren();
  atlasViews().forEach(view=>{
    const button=action(view.title,'atlas-view-tab'+(view.id===state.atlasView?' active':''),()=>setAtlasView(view.id));
    button.setAttribute('aria-pressed',String(view.id===state.atlasView));tabs.append(button);
  });
  const groups=$('atlas-group-tabs');groups.replaceChildren();
  const all=action(T('全部分组'),'atlas-group-chip'+(!state.graphGroup?' active':''),()=>{state.graphGroup='';state.graphZoom=null;renderPeople();});all.setAttribute('aria-pressed',String(!state.graphGroup));groups.append(all);
  atlasGroups().forEach((name,index)=>{
    const count=people().filter(p=>(p.profile.group||T('未分组'))===name).length;
    const button=action('','atlas-group-chip'+(state.graphGroup===name?' active':''),()=>{state.graphGroup=state.graphGroup===name?'':name;state.atlasView='all';state.graphScope='all';state.atlasFocusId=null;state.graphZoom=null;renderPeople();});
    button.style.setProperty('--group-color',atlasColors[index%atlasColors.length]);button.append(el('i'),el('span',null,name),el('small',null,String(count)));button.setAttribute('aria-pressed',String(state.graphGroup===name));groups.append(button);
  });
  const view=atlasViews().find(v=>v.id===state.atlasView)||atlasViews()[0];
  $('atlas-view-title').textContent=state.graphGroup||view.title;
  $('atlas-description').textContent=view.id.startsWith('view:')?view.description||'':'';$('atlas-description').hidden=!$('atlas-description').textContent;
  $('atlas-edit-view').hidden=!state.atlasView.startsWith('view:');
  $('graph-type').value=state.graphRelationType||'';$('graph-type').hidden=state.atlasMode==='index';
  const automaticControl=$('graph-auto-control');if(automaticControl)automaticControl.hidden=state.atlasMode==='index';
  const automaticLabel=$('graph-auto-label');if(automaticLabel)automaticLabel.textContent=state.kind==='short'?T('显示正文共同提及'):T('显示同章提及');
  const automaticOption=$('relation-automatic-option');if(automaticOption)automaticOption.textContent=atlasRelationTypeLabel('automatic');
  $('atlas-map-button').classList.toggle('active',state.atlasMode!=='index');$('atlas-index-button').classList.toggle('active',state.atlasMode==='index');
  $('people-layout').hidden=state.atlasMode==='index';$('atlas-timeline-section').hidden=state.kind==='short'||state.atlasMode==='index';
  $('relation-index').classList.toggle('atlas-index-active',state.atlasMode==='index');
  if(state.atlasMode==='index')$('relation-index').open=true;
}

function atlasFocusLayout(list,relations,centerId){
  const center=list.find(p=>p.id===centerId);if(!center)return null;
  const sides=[[],[]],groups=new Map();list.filter(p=>p!==center).forEach(p=>{const key=p.profile.group||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);});
  [...groups.values()].sort((a,b)=>b.length-a.length).forEach(group=>{const side=sides[0].length<=sides[1].length?0:1;sides[side].push(...group);});
  const rows=Math.max(1,...sides.map(s=>s.length)),height=Math.max(370,rows*112+70),width=1000;
  const nodes=[{id:center.id,x:500,y:height/2,width:174,height:76}];
  sides.forEach((side,index)=>side.forEach((p,row)=>nodes.push({id:p.id,x:index?850:150,y:height/2+(row-(side.length-1)/2)*112,width:174,height:70})));
  const positions=new Map(nodes.map(n=>[n.id,n]));
  const edges=relations.map((r,index)=>{
    const a=positions.get(r.fromId),b=positions.get(r.toId),hub=a.id===centerId?a:b,other=hub===a?b:a;
    let points,labelX,labelY;
    if(hub.id===centerId){
      const sign=other.x<hub.x?-1:1,hubPoint={x:hub.x+sign*hub.width/2,y:hub.y},otherPoint={x:other.x-sign*other.width/2,y:other.y};
      points=[hubPoint,{x:hub.x+sign*150,y:other.y},otherPoint];if(a!==hub)points.reverse();labelX=hub.x+sign*190;labelY=other.y-17;
    }else if(a.x===b.x){
      const sign=a.x<width/2?-1:1,outer=sign<0?18:width-18,ax=a.x+sign*a.width/2,bx=b.x+sign*b.width/2;
      points=[{x:ax,y:a.y},{x:outer,y:a.y},{x:outer,y:b.y},{x:bx,y:b.y}];labelX=(outer+ax)/2;labelY=(a.y+b.y)/2;
    }else{
      const top=Math.max(25,Math.min(a.y,b.y)-52-index*5);points=[{x:a.x,y:a.y-a.height/2},{x:a.x,y:top},{x:b.x,y:top},{x:b.x,y:b.y-b.height/2}];labelX=(a.x+b.x)/2;labelY=Math.max(14,top-12);
    }
    return{id:r.id,points,labelX,labelY};
  });
  return{width,height,nodes,edges};
}
function atlasPath(points){
  if(points.length===3){const[a,b,c]=points;return`M ${a.x} ${a.y} Q ${b.x} ${b.y} ${c.x} ${c.y}`;}
  return points.map((p,i)=>(i?'L ':'M ')+p.x+' '+p.y).join(' ');
}
function renderAtlas(){
  if(!state.book)return;
  const list=filteredGraphPeople(),ids=new Set(list.map(p=>p.id)),relations=graphRelations().filter(r=>ids.has(r.fromId)&&ids.has(r.toId)),manual=relations.filter(r=>!r.automatic);
  const graph=$('people-graph');graph.replaceChildren();
  const nodes=list.map(p=>({id:p.id,width:174,height:70})),edges=manual.map(r=>({id:r.id,fromId:r.fromId,toId:r.toId,label:r.label,width:Math.min(190,Array.from(r.label||'').length*16+22)}));
  const key=JSON.stringify([state.atlasView,state.graphScope,state.graphVolume,state.graphGroup,state.graphRelationType,nodes.map(n=>n.id),edges,state.seq]);
  if(state.atlasLayoutKey!==key){
    const pairs=new Set(),parallel=manual.some(r=>{const pair=[r.fromId,r.toId].sort().join('\0');if(pairs.has(pair))return true;pairs.add(pair);return false;});
    state.atlasLayout=(state.atlasView==='core'&&list.length<=16&&!parallel?atlasFocusLayout(list,manual,atlasCorePerson()?.id):null)||WriterAtlasLayout.layout({nodes,edges,direction:'LR'});
    state.atlasLayoutKey=key;
  }
  const layout=state.atlasLayout;state.graphWidth=Math.max(400,layout.width);state.graphHeight=Math.max(300,layout.height);
  graph.setAttribute('viewBox',`0 0 ${state.graphWidth} ${state.graphHeight}`);graph.setAttribute('width',state.graphWidth);graph.setAttribute('height',state.graphHeight);
  $('graph-empty').hidden=!!list.length;$('graph-empty').textContent=people().length?(state.kind==='short'?T('这个视图还没有人物，可调整分组筛选。'):T('这个视图还没有人物，可调整分组或卷的筛选。')):T('先建立人物档案，或从正文识别人名。');
  $('graph-count').textContent=T('{0} 人 · {1} 条关系',list.length,manual.length)+(relations.length> manual.length?(state.kind==='short'?T(' · {0} 条正文共同提及',relations.length-manual.length):T(' · {0} 条同章提及',relations.length-manual.length)):'');$('atlas-clear-focus').hidden=!state.atlasFocusId;
  const positions=new Map(layout.nodes.map(n=>[n.id,n])),routes=new Map(layout.edges.map(e=>[e.id,e]));
  const focus=state.atlasFocusId,neighbors=new Set([focus]);relations.filter(r=>r.fromId===focus||r.toId===focus).forEach(r=>{neighbors.add(r.fromId);neighbors.add(r.toId);});
  const defs=svgElement('defs');Object.entries(atlasEdgeColors).forEach(([type,color])=>{const marker=svgElement('marker',{id:'atlas-arrow-'+type,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(svgElement('path',{d:'M 0 1 L 9 5 L 0 9 z',fill:color}));defs.append(marker);});graph.append(defs);
  [...relations].sort((a,b)=>Number(!!b.automatic)-Number(!!a.automatic)).forEach(r=>{
    const a=positions.get(r.fromId),b=positions.get(r.toId);if(!a||!b)return;
    const route=routes.get(r.id)||{points:[{x:a.x,y:a.y},{x:(a.x+b.x)/2+22,y:(a.y+b.y)/2-35},{x:b.x,y:b.y}],labelX:(a.x+b.x)/2,labelY:(a.y+b.y)/2};
    const relevant=!focus||r.fromId===focus||r.toId===focus,color=atlasEdgeColors[r.type]||atlasEdgeColors.other;
    const group=svgElement('g',{class:'graph-edge'+(r.automatic?' automatic':'')+(relevant?'':' dimmed'),role:'button',tabindex:0,'aria-label':T('查看关系 ')+personName(r.fromId)+T(' 与 ')+personName(r.toId)+'：'+r.label});
    const path=atlasPath(route.points);group.append(svgElement('path',{d:path,stroke:'transparent','stroke-width':20,fill:'none'}),svgElement('path',{d:path,class:'edge-line',style:'stroke:'+color,'marker-end':r.automatic?'':'url(#atlas-arrow-'+(r.type||'other')+')'}));
    if(!r.automatic){const label=Array.from(r.label||T('未命名关系')).slice(0,13).join(''),width=Math.max(48,Array.from(label).length*16+18);group.append(svgElement('rect',{x:route.labelX-width/2,y:route.labelY-14,width,height:28,rx:5}),svgElement('text',{x:route.labelX,y:route.labelY+5,'text-anchor':'middle'},label));}
    graphActivate(group,()=>r.automatic?showAutomaticRelation(r):showRelation(r));graph.append(group);
  });
  list.forEach(person=>{
    const box=positions.get(person.id);if(!box)return;const color=atlasColor(person),outside=state.graphGroup&&(person.profile.group||T('未分组'))!==state.graphGroup;
    const node=svgElement('g',{class:'graph-node'+(person.id===state.personId?' selected':'')+(focus&&!neighbors.has(person.id)?' dimmed':'')+(outside?' context-node':''),role:'button',tabindex:0,'aria-label':T('查看人物 ')+(person.title||T('未命名人物'))});
    node.style.setProperty('--group-color',color);
    node.append(svgElement('title',{},person.title),svgElement('rect',{x:box.x-box.width/2,y:box.y-box.height/2,width:box.width,height:box.height,rx:10,class:'person-node-card',style:'stroke:'+color}),svgElement('rect',{x:box.x-box.width/2+1,y:box.y-box.height/2+12,width:4,height:box.height-24,rx:2,fill:color}),svgElement('text',{x:box.x,y:box.y-4,'text-anchor':'middle',style:'fill:'+color},Array.from(person.title||T('未命名')).slice(0,9).join('')),svgElement('text',{x:box.x,y:box.y+19,'text-anchor':'middle',class:'node-meta'},person.profile.group||T('未分组')));
    graphActivate(node,()=>selectAtlasPerson(person.id));graph.append(node);
  });
  if(state.graphZoom===null||!state.graphZoom){const panel=graph.parentElement;state.graphZoom=Math.max(.66,Math.min(1,panel.clientWidth/state.graphWidth,(panel.clientHeight||450)/state.graphHeight));panel.scrollTop=0;panel.scrollLeft=0;}
  applyGraphZoom();renderAtlasNavigation();renderRelationIndex();
}
function applyGraphZoom(){const zoom=state.graphZoom||1;$('people-graph').style.width=state.graphWidth*zoom+'px';$('people-graph').style.height=state.graphHeight*zoom+'px';$('graph-zoom-label').textContent=Math.round(zoom*100)+'%';}
function resetAtlasForPerson(){state.atlasView='all';state.atlasMode='graph';state.graphScope='all';state.graphVolume='';state.graphGroup='';state.graphRelationType='';state.graphZoom=null;state.personEditing=false;state.atlasFocusId=state.personId;}
function selectAtlasPerson(id){state.personId=id;state.personEditing=false;state.atlasFocusId=id;state.atlasMode='graph';renderPeople();}
function renderPersonWorkspace(){
  if(!state.book)return;const list=people();state.book.atlasViews??=[];state.atlasView??='core';
  if(state.kind==='short')state.graphVolume='';
  if(!atlasViews().some(v=>v.id===state.atlasView))state.atlasView='core';
  if(!list.some(p=>p.id===state.personId))state.personId=list[0]?.id||null;
  const visible=filteredGraphPeople();if(visible.length&&!visible.some(p=>p.id===state.personId))state.personId=visible[0].id;
  if(state.atlasFocusId&&!visible.some(p=>p.id===state.atlasFocusId))state.atlasFocusId=null;
  populateSelect($('graph-volume'),activeVolumes(),T('全部卷'),state.graphVolume||'');$('graph-volume').hidden=state.kind==='short';state.graphVolume=$('graph-volume').value;
  populateSelect($('graph-group'),atlasGroups().map(group=>({id:group,title:group})),T('全部分组'),state.graphGroup||'');
  $('graph-scope').value=state.graphScope||'all';$('graph-auto').checked=!!state.showAutomatic;
  const linkLabel=$('person-link-label');if(linkLabel)linkLabel.textContent=state.kind==='short'?T('手动关联正文'):T('手动关联章节');$('person-link').textContent=state.kind==='short'?T('＋ 关联正文'):T('＋ 关联章节');
  const analysis=analyzeWorkspace();$('review-candidates').textContent=analysis.candidates.length?T('待确认人名 {0}',analysis.candidates.length):T('正文识别人名');
  renderAtlas();const person=currentPerson();$('person-detail').hidden=!person;$('add-relation').disabled=list.length<2;
  if(person){
    $('person-title').value=person.title;$('person-body').value=person.body;$('person-aliases').value=person.aliases.join('，');
    ['group','role','desire','flaw','ending'].forEach(key=>$('profile-'+key).value=person.profile[key]||'');
    $('character-arcs').hidden=state.kind==='short'||!activeVolumes().length;populateSelect($('person-arc-volume'),activeVolumes(),null,state.arcVolume||activeVolumes()[0]?.id||'');state.arcVolume=$('person-arc-volume').value;
    renderPersonArc();renderPersonOverview(person);renderRelationsForPerson();renderChapterLinks($('person-links'),person);renderChapterLinks($('person-auto-links'),{chapterIds:analysis.appearances[person.id]||[]});
    $('person-link-count').textContent=String(person.chapterIds.length);$('person-auto-count').textContent=String((analysis.appearances[person.id]||[]).length);
  }
  renderAtlasTimeline();renderPersonSearch();
}
function renderPersonOverview(person){
  const reader=$('person-overview');reader.replaceChildren();$('person-editor-fields').hidden=!state.personEditing;reader.hidden=!!state.personEditing;$('person-edit').textContent=state.personEditing?T('完成编辑'):T('编辑人物');
  reader.append(el('h2','profile-name',person.title||T('未命名人物')));
  const tags=el('div','profile-tags');if(person.profile.group){const tag=el('span',null,person.profile.group);tag.style.setProperty('--group-color',atlasColor(person));tags.append(tag);}if(person.aliases.length)tags.append(el('small',null,T('又名 ')+person.aliases.join('、')));reader.append(tags);
  const fields=[['role',T('身份与定位')],['desire',T('愿望与目标')],['flaw',T('矛盾与弱点')],['ending',T('最终去向')]];
  if(!fields.some(([key])=>person.profile[key]))reader.append(el('p','profile-prose',person.body||T('还没有人物介绍，点击编辑补充。')));
  fields.forEach(([key,label])=>{if(person.profile[key]){const block=el('section','profile-read-field');block.append(el('h3',null,label),el('p','profile-prose',person.profile[key]));reader.append(block);}});
  if(person.body&&fields.some(([key])=>person.profile[key])){const details=el('details','profile-background');details.append(el('summary',null,T('人物介绍')),el('p','profile-prose',person.body));reader.append(details);}
  const arcs=state.kind==='short'?[]:person.profile.arcs.filter(a=>a.body&&activeVolumes().some(v=>v.id===a.volumeId)&&(!state.graphVolume||a.volumeId===state.graphVolume));
  if(arcs.length){const details=el('details','profile-arcs-read');details.open=!!state.graphVolume;details.append(el('summary',null,state.graphVolume?T('本卷人物变化'):T('分卷人物变化')));arcs.forEach(arc=>{const block=el('section','profile-read-field');block.append(el('h3',null,activeVolumes().find(v=>v.id===arc.volumeId).title),el('p','profile-prose',arc.body));details.append(block);});reader.append(details);}
}
function renderRelationsForPerson(){
  const container=$('person-relations');container.replaceChildren();const person=currentPerson();if(!person)return;
  combinedRelations().filter(r=>(state.showAutomatic||!r.automatic)&&(r.fromId===person.id||r.toId===person.id)).forEach(r=>{
    const other=r.fromId===person.id?r.toId:r.fromId,button=action('','relation-row'+(r.automatic?' automatic-link':''),()=>r.automatic?showAutomaticRelation(r):showRelation(r));
    button.append(el('span',null,personName(other)),el('strong',null,r.label||T('未命名关系')),el('small',null,(r.stage?r.stage+' · ':'')+atlasRelationTypeLabel(r.type)));container.append(button);
  });
  if(!container.children.length)container.append(el('p','empty-hint',T('先写好人物关系也可以，正文完成后会自动补充姓名提及。')));
}
function renderAtlasTimeline(){
  const container=$('atlas-timeline');container.replaceChildren();if(state.kind==='short')return;activeVolumes().forEach((volume,index)=>{
    const button=action('','atlas-time-card'+(state.graphVolume===volume.id?' active':''),()=>{state.graphVolume=state.graphVolume===volume.id?'':volume.id;state.graphZoom=null;renderPeople();$('people-layout').scrollIntoView({block:'start',behavior:'smooth'});});
    button.append(el('small',null,String(index+1).padStart(2,'0')),el('strong',null,volume.title),el('p',null,volume.summary||T('补充分卷梗概，记录这一卷的关系推进。')));container.append(button);
  });
}
function renderRelationIndex(){
  const ids=new Set(filteredGraphPeople().map(p=>p.id));
  const all=graphRelations({showAutomatic:true,type:state.atlasMode==='index'?'':state.graphRelationType}).filter(r=>ids.has(r.fromId)&&ids.has(r.toId));
  const heading=$('relation-index-title');if(heading){const view=atlasViews().find(v=>v.id===state.atlasView)||atlasViews()[0];heading.textContent=state.graphGroup?state.graphGroup+' · '+T('关系索引'):view.id==='all'?T('全部关系索引'):view.title+' · '+T('关系索引');}
  $('relation-index-count').textContent=state.kind==='short'?T('{0} 条手动关系 · {1} 条正文共同提及',all.filter(r=>!r.automatic).length,all.filter(r=>r.automatic).length):T('{0} 条手动关系 · {1} 条同章提及',all.filter(r=>!r.automatic).length,all.filter(r=>r.automatic).length);
  const list=$('relation-index-list');list.replaceChildren();if(!$('relation-index').open)return;
  const query=$('relation-search').value.trim().toLocaleLowerCase(),type=$('relation-type-filter').value;
  const rows=all.filter(r=>(!type||(type==='manual'?!r.automatic:r.type===type))&&(!query||[personName(r.fromId),personName(r.toId),r.label,r.stage,r.body].join(' ').toLocaleLowerCase().includes(query)));
  const table=el('table','atlas-relation-table'),head=el('thead'),tr=el('tr');[T('人物一'),T('人物二'),T('关系与阶段'),T('具体变化')].forEach(label=>tr.append(el('th',null,label)));head.append(tr);table.append(head);const body=el('tbody');
  rows.forEach(r=>{const row=el('tr');[r.fromId,r.toId].forEach(id=>{const cell=el('td');cell.append(action(personName(id),'atlas-person-link',()=>{state.personId=id;resetAtlasForPerson();renderPeople();$('people-layout').scrollIntoView({block:'start'});}));row.append(cell);});
    const label=el('td'),button=action(r.label||T('未命名关系'),'atlas-relation-link',()=>r.automatic?showAutomaticRelation(r):showRelation(r));label.append(button,el('small',null,(r.stage?r.stage+' · ':'')+atlasRelationTypeLabel(r.type)));const detail=el('td','atlas-relation-description',r.body||T('尚未填写关系变化'));row.append(label,detail);body.append(row);});
  table.append(body);list.append(table);if(!rows.length)list.append(el('p','empty-hint',T('没有匹配的关系。')));
}
function showAtlasViewEditor(existing=null){
  const form=el('form'),title=el('input','text-field'),description=el('textarea','text-field'),search=el('input','text-field'),choices=el('div','atlas-view-members'),selected=new Set(existing?.personIds||filteredGraphPeople().map(p=>p.id));
  title.id='atlas-view-name';title.maxLength=200;title.required=true;title.value=existing?.title||'';description.id='atlas-view-description';description.maxLength=50000;description.rows=3;description.value=existing?.description||'';search.type='search';search.placeholder=T('搜索分图成员');search.setAttribute('aria-label',T('搜索分图成员'));addField(form,T('分图名称'),title);addField(form,T('分图说明'),description);form.append(el('p','dialog-description',T('同一人物可以出现在多个主题分图中。选择这张图要展示的人物。')),search,choices);
  function renderChoices(){const query=search.value.trim().toLocaleLowerCase();choices.replaceChildren();people().filter(p=>[p.title,p.profile.group,...p.aliases].join(' ').toLocaleLowerCase().includes(query)).forEach(person=>{const row=el('label','checkbox-row'),box=el('input');box.type='checkbox';box.checked=selected.has(person.id);box.addEventListener('change',()=>box.checked?selected.add(person.id):selected.delete(person.id));row.append(box,el('span',null,person.title),el('small',null,person.profile.group));choices.append(row);});}search.addEventListener('input',renderChoices);renderChoices();
  const view=existing||{id:uid(),title:'',description:'',personIds:[]};
  const buttons=el('div','dialog-actions'),save=el('button','primary-button',T('保存分图'));save.type='submit';buttons.append(action(T('取消'),'secondary-button',closeDialog),save);form.append(buttons);
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(save.disabled||!title.value.trim())return;
    const added=state.book.atlasViews.some(item=>item.id===view.id);
    if(!added&&state.book.atlasViews.length>=100){toast(T('每部作品最多建立 100 个主题分图。'));return;}
    save.disabled=true;
    try{
      view.title=title.value.trim();view.description=description.value;view.personIds=[...selected];
      if(!added)state.book.atlasViews.push(view);markDirty();
      if(!await requireSaved())return;
      closeDialog();setAtlasView('view:'+view.id);
    }finally{save.disabled=false;}
  });showDialog(existing?T('编辑主题分图'):T('新建主题分图'),form);title.focus();
}
function bindAtlasEvents(){
  $('atlas-new-view').addEventListener('click',()=>showAtlasViewEditor());$('atlas-edit-view').addEventListener('click',()=>showAtlasViewEditor(state.book.atlasViews.find(v=>'view:'+v.id===state.atlasView)));
  $('person-edit').addEventListener('click',()=>{state.personEditing=!state.personEditing;renderPersonOverview(currentPerson());if(state.personEditing)$('person-title').focus();});
  $('atlas-clear-focus').addEventListener('click',()=>{state.atlasFocusId=null;renderAtlas();});
  $('atlas-map-button').addEventListener('click',()=>{state.atlasMode='graph';renderPeople();});$('atlas-index-button').addEventListener('click',()=>{state.atlasMode='index';renderPeople();});
  [['graph-scope','graphScope'],['graph-volume','graphVolume'],['graph-group','graphGroup'],['graph-type','graphRelationType']].forEach(([id,key])=>$(id).addEventListener('change',()=>{state[key]=$(id).value;state.graphZoom=null;renderPeople();}));
  $('graph-zoom-in').addEventListener('click',()=>{state.graphZoom=Math.min(2.5,(state.graphZoom||1)*1.2);applyGraphZoom();});$('graph-zoom-out').addEventListener('click',()=>{state.graphZoom=Math.max(.1,(state.graphZoom||1)/1.2);applyGraphZoom();});$('graph-fit').addEventListener('click',()=>{const panel=$('people-graph').parentElement;state.graphZoom=Math.min(panel.clientWidth/state.graphWidth,panel.clientHeight/state.graphHeight,1.25);applyGraphZoom();panel.scrollTop=0;panel.scrollLeft=0;});
  const panel=$('people-graph').parentElement;let drag=null;panel.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('[role=button]'))return;drag={x:event.clientX,y:event.clientY,left:panel.scrollLeft,top:panel.scrollTop};panel.setPointerCapture(event.pointerId);panel.classList.add('panning');});panel.addEventListener('pointermove',event=>{if(!drag)return;panel.scrollLeft=drag.left+drag.x-event.clientX;panel.scrollTop=drag.top+drag.y-event.clientY;});function endDrag(){drag=null;panel.classList.remove('panning');}panel.addEventListener('pointerup',endDrag);panel.addEventListener('pointercancel',endDrag);
}
