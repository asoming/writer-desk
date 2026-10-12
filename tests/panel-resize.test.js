'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {calculateLayout,readPreferences,createController,STORAGE_KEY}=require('../public/panel-resize.js');

test('default desktop columns fit around a usable manuscript',()=>{
  for(const view of ['outline','write']){
    const layout=calculateLayout({view,width:1238,viewport:1450,visible:{outline:true,chapters:true,notes:true,ai:true}});
    const docked=Object.values(layout).filter(panel=>!panel.overlay);
    assert.ok(docked.reduce((sum,panel)=>sum+panel.width,0)<=1238-320);
    for(const panel of docked)assert.ok(panel.width>=panel.min&&panel.width<=panel.max);
  }
});
test('adjusting one divider takes precedence without allowing neighbouring panes to disappear',()=>{
  const layout=calculateLayout({view:'outline',width:1040,viewport:1300,preferences:{outline:500,ai:540,priority:'ai'},visible:{outline:true,ai:true}});
  assert.equal(layout.ai.width,540);assert.equal(layout.outline.width,180);assert.equal(1040-layout.ai.width-layout.outline.width,320);
});
test('narrow layouts retain drawers and leave their underlying manuscript width alone',()=>{
  const layout=calculateLayout({view:'write',width:800,viewport:1000,preferences:{chapters:350,ai:650,notes:600},visible:{chapters:true,ai:true,notes:true}});
  assert.equal(layout.ai.overlay,true);assert.equal(layout.notes.overlay,true);assert.equal(layout.chapters.width,350);
  assert.equal(layout.ai.width,650);assert.equal(layout.notes.width,600);
  assert.deepEqual(calculateLayout({view:'outline',width:540,viewport:540,visible:{outline:true,ai:true}}),{});
  assert.deepEqual(calculateLayout({view:'write',width:540,viewport:540,visible:{chapters:true,notes:true,ai:true}}),{});
});
test('saved preferences reject unknown, malformed and out-of-range values',()=>{
  assert.deepEqual(readPreferences('{broken'),{version:1,outline:{},write:{}});
  const result=readPreferences(JSON.stringify({version:1,outline:{outline:9999,ai:'400',priority:'notes',unknown:1},write:{chapters:-100,notes:null,ai:500,priority:'ai'}}));
  assert.deepEqual(result,{version:1,outline:{outline:620},write:{chapters:160,ai:500,priority:'ai'}});
});

class Element{
  constructor(id=''){this.id=id;this.hidden=false;this.children=[];this.listeners={};this.attributes={};this.props={};this.className='';this.tabIndex=-1;this.capture=null;
    const classes=new Set();this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name)};
    this.style={setProperty:(key,value)=>this.props[key]=value,getPropertyValue:key=>this.props[key]||''};
  }
  append(child){child.parent=this;this.children.push(child);}
  addEventListener(type,handler){this.listeners[type]=handler;}
  setAttribute(key,value){this.attributes[key]=value;}
  setPointerCapture(id){this.capture=id;}
  hasPointerCapture(id){return this.capture===id;}
  releasePointerCapture(){this.capture=null;}
  remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
  fire(type,extra={}){const event={button:0,pointerId:7,clientX:500,prevented:false,preventDefault(){this.prevented=true;},...extra};this.listeners[type]?.(event);return event;}
}
function harness(existing=new Map()){
  const ids=['workspace','workspace-body','outline-view','write-view','outline-tree','sidebar','notes-panel','ai-chat-panel'],elements=Object.fromEntries(ids.map(id=>[id,new Element(id)])),outlineLayout=new Element(),frames=new Map(),events={},observations=[];let nextFrame=0;
  elements['outline-view'].querySelector=selector=>selector==='.outline-layout'?outlineLayout:null;elements['write-view'].hidden=true;elements['notes-panel'].hidden=true;
  const h={width:1238,viewport:1450,writes:0,layouts:0,frames,observations,elements,storage:existing};elements['workspace-body'].getBoundingClientRect=()=>({width:h.width});
  const observerInstances=[];class Observer{constructor(callback){this.callback=callback;observerInstances.push(this);}observe(node,options){observations.push({node,options});}disconnect(){this.disconnected=true;}}
  const win={get innerWidth(){return h.viewport;},requestAnimationFrame(callback){const id=++nextFrame;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),MutationObserver:Observer,ResizeObserver:Observer,addEventListener(type,handler){events[type]=handler;},removeEventListener(type){delete events[type];}};
  const storage={getItem:key=>existing.get(key)??null,setItem(key,value){if(h.storageFails)throw Error('quota');h.writes++;existing.set(key,value);}};
  h.controller=createController({window:win,document:{getElementById:id=>elements[id],createElement:()=>new Element()},storage,translate:(text,...args)=>text.replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),onLayout:()=>h.layouts++});
  h.handle=name=>[outlineLayout,elements['write-view'],elements['workspace-body']].flatMap(node=>node.children).find(node=>node.className==='panel-resize-handle panel-resize-'+name);
  h.flush=()=>{for(const [id,callback] of [...frames]){frames.delete(id);callback();}};
  h.mutation=()=>observerInstances[0].callback();h.resize=()=>events.resize();
  h.switch=view=>{elements['outline-view'].hidden=view!=='outline';elements['write-view'].hidden=view!=='write';h.mutation();h.flush();};
  h.profile=()=>h.controller.getPreferences();h.outlineLayout=outlineLayout;return h;
}
test('pointer capture changes the selected border and persists only a completed user drag',()=>{
  const h=harness(),handle=h.handle('outline');assert.equal(handle.attributes.role,'separator');assert.equal(handle.attributes['aria-controls'],'outline-tree');assert.equal(handle.attributes['aria-valuenow'],'276');assert.equal(handle.attributes['aria-valuetext'],'276 像素');
  handle.fire('pointerdown');assert.equal(handle.capture,7);handle.fire('pointermove',{clientX:580});
  assert.equal(h.profile().outline.outline,356);assert.equal(h.outlineLayout.props['--outline-panel-width'],'356px');assert.equal(h.writes,0);
  handle.fire('pointerup',{clientX:580});assert.equal(h.writes,1);assert.equal(handle.capture,null);assert.equal(h.elements.workspace.classList.contains('panel-resize-active'),false);
  const restarted=harness(h.storage);assert.equal(restarted.handle('outline').attributes['aria-valuenow'],'356');
});
test('right-side drag grows towards the manuscript and cannot cross its minimum width',()=>{
  const h=harness(),handle=h.handle('ai');handle.fire('pointerdown');handle.fire('pointermove',{clientX:0});handle.fire('pointerup');
  assert.equal(h.profile().outline.ai,720);assert.equal(handle.attributes['aria-valuenow'],'720');
  assert.ok(h.width-Number(h.handle('outline').attributes['aria-valuenow'])-Number(handle.attributes['aria-valuenow'])>=320);
});
test('pointer cancellation restores the prior preference and does not persist a partial drag',()=>{
  const h=harness(),handle=h.handle('outline');handle.fire('pointerdown');handle.fire('pointermove',{clientX:580});handle.fire('pointercancel');
  assert.equal(h.profile().outline.outline,undefined);assert.equal(h.writes,0);assert.equal(handle.attributes['aria-valuenow'],'276');
  handle.fire('pointerdown',{button:2});assert.equal(handle.capture,null);
});
test('keyboard resizing, limits and default restoration work without a mouse',()=>{
  const h=harness(),handle=h.handle('outline');assert.equal(handle.tabIndex,0);assert.equal(handle.fire('keydown',{key:'ArrowRight'}).prevented,true);assert.equal(h.profile().outline.outline,286);
  handle.fire('keydown',{key:'ArrowLeft',shiftKey:true});assert.equal(h.profile().outline.outline,246);
  handle.fire('keydown',{key:'Home'});assert.equal(h.profile().outline.outline,180);
  handle.fire('keydown',{key:'End'});assert.equal(h.profile().outline.outline,Number(handle.attributes['aria-valuemax']));
  handle.fire('keydown',{key:'Enter'});assert.equal(h.profile().outline.outline,undefined);assert.equal(handle.attributes['aria-valuenow'],'276');
  h.handle('ai').fire('keydown',{key:'ArrowLeft'});assert.equal(h.profile().outline.ai,370);
  h.handle('ai').fire('dblclick');assert.equal(h.profile().outline.ai,undefined);
});
test('outline and writing widths are isolated, including their AI conversation panes',()=>{
  const h=harness();h.handle('outline').fire('keydown',{key:'ArrowRight'});h.handle('ai').fire('keydown',{key:'ArrowLeft'});h.switch('write');
  assert.equal(h.handle('outline').hidden,true);assert.equal(h.handle('chapters').hidden,false);assert.equal(h.handle('ai').attributes['aria-valuenow'],'360');
  h.handle('chapters').fire('keydown',{key:'ArrowRight'});h.handle('ai').fire('keydown',{key:'ArrowRight'});
  assert.equal(h.profile().write.chapters,238);assert.equal(h.profile().write.ai,350);h.switch('outline');assert.equal(h.handle('outline').attributes['aria-valuenow'],'286');assert.equal(h.handle('ai').attributes['aria-valuenow'],'370');
});
test('window resizing clamps displayed widths without overwriting preferences, then restores them',()=>{
  const h=harness();h.handle('outline').fire('keydown',{key:'End'});const preferred=h.profile().outline.outline,writes=h.writes;
  h.width=850;h.viewport=1300;h.resize();h.flush();assert.ok(Number(h.handle('outline').attributes['aria-valuenow'])<preferred);assert.equal(h.profile().outline.outline,preferred);assert.equal(h.writes,writes);
  h.width=1238;h.viewport=1450;h.resize();h.flush();assert.equal(h.handle('outline').attributes['aria-valuenow'],String(preferred));
});
test('hidden panes, focus mode and mobile layouts have no active invisible separator',()=>{
  const h=harness();h.elements['ai-chat-panel'].hidden=true;h.mutation();h.flush();assert.equal(h.handle('ai').hidden,true);
  h.elements.workspace.classList.add('focus');h.mutation();h.flush();assert.equal(h.handle('outline').hidden,true);
  h.elements.workspace.classList.remove('focus');h.width=530;h.viewport=530;h.resize();h.flush();assert.equal(h.handle('outline').hidden,true);h.switch('write');assert.equal(h.handle('chapters').hidden,true);assert.equal(h.handle('notes').hidden,true);
});
test('notes use the same resizing controls when opened and mutations are coalesced without observing own style writes',()=>{
  const h=harness();h.switch('write');assert.equal(h.handle('notes').hidden,true);h.elements['ai-chat-panel'].hidden=true;h.elements['notes-panel'].hidden=false;
  h.mutation();h.mutation();h.mutation();assert.equal(h.frames.size,1);h.flush();assert.equal(h.handle('notes').hidden,false);
  h.handle('notes').fire('keydown',{key:'ArrowLeft'});assert.equal(h.profile().write.notes,310);
  assert.ok(h.observations.filter(entry=>entry.options).every(entry=>entry.options.attributeFilter.join(',')==='hidden,class'));
});
test('storage failure leaves resizing usable, and destroying the controller removes listeners and handles',()=>{
  const h=harness();h.storageFails=true;assert.doesNotThrow(()=>h.handle('outline').fire('keydown',{key:'ArrowRight'}));assert.equal(h.handle('outline').attributes['aria-valuenow'],'286');
  h.mutation();h.controller.destroy();assert.equal(h.frames.size,0);assert.equal(h.outlineLayout.children.length,0);assert.equal(h.elements['workspace-body'].children.length,0);
});
