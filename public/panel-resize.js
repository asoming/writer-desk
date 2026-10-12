'use strict';

(function(global){
  const STORAGE_KEY='yejian.panel-widths',NAMES={outline:['outline','ai'],write:['chapters','notes','ai']};
  const LIMITS={outline:[180,620],chapters:[160,520],notes:[240,640],ai:[280,720]};
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function readPreferences(raw){
    const result={version:1,outline:{},write:{}};let value;
    try{value=JSON.parse(raw||'null');}catch{return result;}
    if(!value||value.version!==1)return result;
    for(const [view,names] of Object.entries(NAMES)){
      if(!value[view]||typeof value[view]!=='object')continue;
      for(const name of names){const width=value[view][name];if(typeof width==='number'&&Number.isFinite(width))result[view][name]=clamp(width,...LIMITS[name]);}
      if(names.includes(value[view].priority))result[view].priority=value[view].priority;
    }
    return result;
  }
  function defaultWidth(name,viewport){
    if(name==='outline')return viewport>1100?276:viewport>850?236:210;
    if(name==='chapters')return viewport>=1600?248:viewport>1320?228:viewport>1100?208:190;
    if(name==='notes')return viewport<=1320?320:viewport>=1600?330:300;
    return viewport<=1250?350:viewport>=1800?390:360;
  }
  // Allocate the sidebars inside one workspace. A user's most recently adjusted
  // sidebar takes precedence; narrowing the window never changes their choices.
  function calculateLayout({view,width,viewport,preferences={},visible={}}){
    const result={},docked=[];
    if(!NAMES[view]||!(width>0))return result;
    for(const name of NAMES[view]){
      if(!visible[name]||viewport<=(name==='outline'?680:540))continue;
      const [min,max]=LIMITS[name],overlay=name==='ai'&&viewport<=1250||name==='notes'&&viewport<=1320;
      const desired=clamp(preferences[name]??defaultWidth(name,viewport),min,max);
      result[name]={min,max,desired,width:desired,overlay};
      if(overlay){result[name].max=Math.max(min,Math.min(max,width-60));result[name].width=clamp(desired,min,result[name].max);}
      else docked.push(name);
    }
    const minimums=docked.reduce((sum,name)=>sum+result[name].min,0),mainMin=Math.min(320,Math.max(0,width-minimums));
    let extra=Math.max(0,width-mainMin-minimums);
    const ordered=[...docked].sort((a,b)=>Number(b===preferences.priority)-Number(a===preferences.priority));
    for(const name of ordered){const panel=result[name],growth=Math.min(extra,panel.desired-panel.min);panel.width=panel.min+growth;extra-=growth;panel.max=Math.max(panel.min,Math.min(panel.max,width-mainMin-(minimums-panel.min)));}
    return result;
  }
  function createController({window:win,document:doc,storage,translate=text=>text,onLayout=()=>{}}){
    const byId=id=>doc.getElementById(id),workspace=byId('workspace'),body=byId('workspace-body'),outlineView=byId('outline-view'),writeView=byId('write-view');
    if(!workspace||!body||!outlineView||!writeView)return null;
    let preferences;try{preferences=readPreferences(storage?.getItem(STORAGE_KEY));}catch{preferences=readPreferences(null);}
    let frame=null,drag=null,disposed=false,currentView=null,layout={};
    const outlineLayout=outlineView.querySelector('.outline-layout');
    const definitions=[
      {name:'outline',parent:outlineLayout,panel:byId('outline-tree'),side:'left',label:'调整大纲目录宽度',view:'outline'},
      {name:'chapters',parent:writeView,panel:byId('sidebar'),side:'left',label:'调整章节目录宽度',view:'write'},
      {name:'notes',parent:writeView,panel:byId('notes-panel'),side:'right',label:'调整资料栏宽度',view:'write'},
      {name:'ai',parent:body,panel:byId('ai-chat-panel'),side:'right',label:'调整 AI 对话栏宽度'},
    ].filter(item=>item.parent&&item.panel);
    for(const item of definitions){
      const handle=doc.createElement('div');item.handle=handle;handle.className='panel-resize-handle panel-resize-'+item.name;handle.tabIndex=0;handle.hidden=true;
      handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-controls',item.panel.id);item.parent.append(handle);
      handle.addEventListener('pointerdown',event=>startDrag(item,event));handle.addEventListener('pointermove',moveDrag);handle.addEventListener('pointerup',event=>finishDrag(event,true));
      handle.addEventListener('pointercancel',event=>finishDrag(event,false));handle.addEventListener('lostpointercapture',event=>finishDrag(event,false));
      handle.addEventListener('keydown',event=>keyboardResize(item,event));handle.addEventListener('dblclick',event=>{event.preventDefault();reset(item);});
    }
    outlineLayout?.classList.add('panels-resizable');writeView.classList.add('panels-resizable');body.classList.add('panels-resizable');
    function view(){return !outlineView.hidden?'outline':!writeView.hidden?'write':null;}
    function persist(){try{storage?.setItem(STORAGE_KEY,JSON.stringify(preferences));}catch{/* Layout remains usable when local storage is unavailable. */}}
    function setStyle(node,name,value){if(node.style.getPropertyValue(name)===value)return false;node.style.setProperty(name,value);return true;}
    function sync(){
      if(disposed)return;currentView=view();const focused=workspace.classList.contains('focus'),viewport=win.innerWidth;
      const visible={outline:currentView==='outline',chapters:currentView==='write'&&!byId('sidebar')?.hidden&&!workspace.classList.contains('sidebar-hidden'),notes:currentView==='write'&&!byId('notes-panel')?.hidden,ai:!byId('ai-chat-panel')?.hidden};
      layout=focused?{}:calculateLayout({view:currentView,width:body.getBoundingClientRect().width,viewport,preferences:preferences[currentView],visible});
      let changed=false;
      for(const item of definitions){
        const entry=(!item.view||item.view===currentView)&&layout[item.name];item.handle.hidden=!entry;
        if(!entry)continue;
        const value=String(Math.round(entry.width));changed=setStyle(item.parent,'--'+item.name+'-panel-width',value+'px')||changed;
        item.handle.setAttribute('aria-label',translate(item.label));item.handle.title=translate('拖动或方向键调整，双击或 Enter 恢复默认');
        item.handle.setAttribute('aria-valuemin',String(Math.round(entry.min)));item.handle.setAttribute('aria-valuemax',String(Math.round(entry.max)));item.handle.setAttribute('aria-valuenow',value);item.handle.setAttribute('aria-valuetext',translate('{0} 像素',value));
      }
      if(drag&&(drag.view!==currentView||!layout[drag.item.name]))finishDrag({pointerId:drag.pointerId},false);
      if(changed)onLayout();
    }
    function schedule(){if(!disposed&&frame===null)frame=win.requestAnimationFrame(()=>{frame=null;sync();});}
    function update(item,width){const entry=layout[item.name];if(!entry||!currentView)return;preferences[currentView][item.name]=clamp(width,entry.min,entry.max);preferences[currentView].priority=item.name;sync();}
    function reset(item){if(!currentView||!layout[item.name])return;delete preferences[currentView][item.name];delete preferences[currentView].priority;persist();sync();}
    function keyboardResize(item,event){
      const entry=layout[item.name];if(!entry||drag)return;
      if(event.key==='Enter'){event.preventDefault();reset(item);return;}
      const step=event.shiftKey?40:10,direction=item.side==='left'?1:-1;
      const width=event.key==='Home'?entry.min:event.key==='End'?entry.max:event.key==='ArrowLeft'?entry.width-step*direction:event.key==='ArrowRight'?entry.width+step*direction:null;
      if(width===null)return;event.preventDefault();update(item,width);persist();
    }
    function startDrag(item,event){
      if(drag||event.button!==0||!layout[item.name])return;event.preventDefault();
      drag={item,view:currentView,pointerId:event.pointerId,x:event.clientX,width:layout[item.name].width,before:{...preferences[currentView]},moved:false};
      try{item.handle.setPointerCapture(event.pointerId);}catch{drag=null;return;}
      workspace.classList.add('panel-resize-active');item.handle.classList.add('is-dragging');
    }
    function moveDrag(event){
      if(!drag||event.pointerId!==drag.pointerId)return;event.preventDefault();
      const delta=(event.clientX-drag.x)*(drag.item.side==='left'?1:-1);if(delta!==0)drag.moved=true;update(drag.item,drag.width+delta);
    }
    function finishDrag(event,commit){
      if(!drag||event.pointerId!==drag.pointerId)return;const finished=drag;drag=null;
      if(commit&&finished.moved)persist();else preferences[finished.view]=finished.before;
      workspace.classList.remove('panel-resize-active');finished.item.handle.classList.remove('is-dragging');
      if(finished.item.handle.hasPointerCapture?.(finished.pointerId))finished.item.handle.releasePointerCapture(finished.pointerId);sync();
    }
    const observer=new win.MutationObserver(schedule);
    for(const node of [workspace,outlineView,writeView,byId('notes-panel'),byId('ai-chat-panel')])if(node)observer.observe(node,{attributes:true,attributeFilter:['hidden','class']});
    const resizeObserver=typeof win.ResizeObserver==='function'?new win.ResizeObserver(schedule):null;resizeObserver?.observe(body);
    win.addEventListener('resize',schedule);win.addEventListener('languagechange',schedule);sync();
    return{sync,schedule,destroy(){if(disposed)return;if(drag)finishDrag({pointerId:drag.pointerId},false);disposed=true;if(frame!==null)win.cancelAnimationFrame(frame);observer.disconnect();resizeObserver?.disconnect();win.removeEventListener('resize',schedule);win.removeEventListener('languagechange',schedule);for(const item of definitions)item.handle.remove();},getPreferences:()=>JSON.parse(JSON.stringify(preferences))};
  }
  const api={calculateLayout,readPreferences,createController,STORAGE_KEY};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{
    let controller;global.WriterPanelResize={sync:()=>controller?.sync(),schedule:()=>controller?.schedule()};
    const start=()=>{let storage;try{storage=typeof clientStorage!=='undefined'?clientStorage:global.localStorage;}catch{}controller=createController({window:global,document:global.document,storage,translate:(text,...args)=>typeof T==='function'?T(text,...args):text,onLayout:()=>{if(typeof resizeEditor==='function')global.requestAnimationFrame(resizeEditor);}});};
    if(global.document.readyState==='loading')global.document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }
})(typeof window==='object'?window:globalThis);
