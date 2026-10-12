'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=name=>fs.readFileSync(path.join(root,'public',name),'utf8');

class Element{
  constructor(){this.listeners={};this.attributes={};this.hidden=false;this.open=false;this.clientWidth=600;this.clientHeight=400;this.scrollWidth=600;this.scrollLeft=0;this.scrollTop=0;this.style={};this.classList={add(){},remove(){}};}
  addEventListener(name,callback,options){this.listeners[name]={callback,options};}
  setAttribute(name,value){this.attributes[name]=value;}
  closest(){return this.reserved?this:null;}
  getBoundingClientRect(){return{left:100,top:80};}
  fire(name,value={}){const event={target:this,prevented:false,preventDefault(){this.prevented=true;},...value};this.listeners[name]?.callback(event);return event;}
}
function navigation(platform='darwin'){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const body=new Element(),state={book:{id:'one',kind:'long'},books:[{id:'one',kind:'long'}],kind:'long',view:'write',dirty:true,composing:false,transitioning:false};
  const calls={refresh:0,saves:0,render:0};let time=0,saved=true;
  const context={window:null,document:{body,readyState:'complete',hidden:false,getElementById:get},$:get,state,performance:{now:()=>time},getComputedStyle:node=>({overflowX:node.overflowX||'visible'}),
    WriterDesktop:{isDesktop:true,platform},addEventListener:()=>{},
    transition:async task=>task(),requireSaved:async()=>{calls.saves++;return saved;},refreshBooks:async()=>{calls.refresh++;},clearBook:()=>{state.book=null;},
    preference(){},closeDialog(){},closeNav(){},exitFocus(){},renderShell:()=>{calls.render++;},toast(){}};
  context.window=context;context.addEventListener=(name,callback)=>{context[name]=callback;};
  vm.createContext(context);
  const actual=source('workspace.js').match(/async function showCollection\([\s\S]*?(?=async function openBookFolder)/)[0];
  vm.runInContext(actual,context);vm.runInContext(source('gestures.js'),context);
  const wheel=(value={})=>{time+=20;return get('workspace').fire('wheel',{deltaX:-60,deltaY:1,deltaMode:0,...value});};
  return{context,state,calls,get,body,wheel,setSaved:value=>{saved=value;},pause:ms=>{time+=ms;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('ordinary vertical, diagonal, pinch and horizontal-list scrolling remain native',async()=>{
  const h=navigation(),list=new Element();list.scrollWidth=900;list.overflowX='auto';
  for(const values of [{deltaX:0,deltaY:80},{deltaX:-30,deltaY:40},{ctrlKey:true},{deltaMode:1},{target:list}]){
    for(let i=0;i<8;i++)assert.equal(h.wheel(values).prevented,false);
  }
  await settle();assert.equal(h.calls.saves,0);assert.equal(h.state.view,'write');
});
test('editing, graph pan, dialogs, IME and active transitions cannot navigate away',async()=>{
  const h=navigation(),reserved=new Element();reserved.reserved=true;
  for(let i=0;i<8;i++)h.wheel({target:reserved});
  for(const [owner,key] of [[h.get('dialog'),'open'],[h.get('settings-dialog'),'open'],[h.state,'composing'],[h.state,'transitioning']]){
    owner[key]=true;for(let i=0;i<8;i++)h.wheel();owner[key]=false;
  }
  await settle();assert.equal(h.calls.saves,0);
});
test('deliberate horizontal Mac stroke uses actual save-gated bookshelf transition once',async()=>{
  const h=navigation();h.setSaved(false);
  for(let i=0;i<4;i++)h.wheel();await settle();
  assert.equal(h.calls.saves,1);assert.equal(h.calls.refresh,0);assert.equal(h.state.view,'write');assert.equal(h.state.dirty,true);
  for(let i=0;i<10;i++)h.wheel();await settle();assert.equal(h.calls.saves,1,'inertial tail must not trigger another return');
  h.pause(900);h.setSaved(true);for(let i=0;i<4;i++)h.wheel();await settle();
  assert.equal(h.calls.saves,2);assert.equal(h.calls.refresh,1);assert.equal(h.state.view,'shelf');assert.equal(h.state.book.id,'one');
});
test('opposite direction and separated short strokes never accumulate into a back gesture',async()=>{
  const h=navigation();
  for(let i=0;i<5;i++){h.wheel();h.pause(220);}
  for(let i=0;i<8;i++)h.wheel({deltaX:60});
  await settle();assert.equal(h.calls.saves,0);
});
test('Mac Command+[ uses the same save gate and platform detection never relies on user agent',async()=>{
  const h=navigation();const event={key:'[',metaKey:true,preventDefault(){this.prevented=true;}};
  h.context.keydown(event);await settle();assert.equal(event.prevented,true);assert.equal(h.calls.saves,1);
  for(const platform of ['linux','win32','']){const other=navigation(platform);assert.equal(other.get('workspace').listeners.wheel,undefined);assert.equal(other.context.keydown,undefined);}
});

function graphHarness(){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},panel=new Element(),graph=get('people-graph');
  panel.scrollLeft=220;panel.scrollTop=140;graph.parentElement=panel;
  graph.getBoundingClientRect=()=>({left:100+24-panel.scrollLeft,top:80+24-panel.scrollTop});
  const state={graphZoom:1,graphWidth:1800,graphHeight:1400};
  const context={window:null,state,$:get,T:x=>x};context.window=context;vm.createContext(context);vm.runInContext(source('atlas-ui.js'),context);vm.runInContext('bindAtlasEvents()',context);
  return{get,panel,graph,state,run:expression=>vm.runInContext(expression,context)};
}
test('graph pinch keeps the content under the gesture point fixed and clamps the canvas zoom',()=>{
  const h=graphHarness(),point={x:480,y:290},before=h.graph.getBoundingClientRect();
  const local={x:(point.x-before.left)/h.state.graphZoom,y:(point.y-before.top)/h.state.graphZoom};
  const pinch=h.panel.fire('wheel',{ctrlKey:true,deltaY:-20,deltaMode:0,clientX:point.x,clientY:point.y,cancelable:true});
  assert.equal(pinch.prevented,true);assert.ok(h.state.graphZoom>1);assert.equal(h.panel.listeners.wheel.options.passive,false);
  const after=h.graph.getBoundingClientRect();assert.ok(Math.abs(after.left+local.x*h.state.graphZoom-point.x)<1e-7);assert.ok(Math.abs(after.top+local.y*h.state.graphZoom-point.y)<1e-7);
  h.run('zoomAtlasAt(100)');assert.equal(h.state.graphZoom,2.5);h.run('zoomAtlasAt(.001)');assert.equal(h.state.graphZoom,.1);
});
test('two-finger graph pan and inertia are not canceled or remapped to zoom',()=>{
  const h=graphHarness();
  for(const values of [{deltaX:38,deltaY:14},{deltaX:-12,deltaY:50},{deltaY:1},{ctrlKey:true,deltaY:2,cancelable:false}]){
    assert.equal(h.panel.fire('wheel',values).prevented,false);assert.equal(h.state.graphZoom,1);
  }
});
test('canvas zoom buttons anchor on viewport center; normal document has no pinch listener',()=>{
  const h=graphHarness(),before=h.graph.getBoundingClientRect(),x=400,y=280,localX=x-before.left,localY=y-before.top;
  h.get('graph-zoom-in').fire('click');const after=h.graph.getBoundingClientRect();
  assert.ok(Math.abs(after.left+localX*h.state.graphZoom-x)<1e-7);assert.ok(Math.abs(after.top+localY*h.state.graphZoom-y)<1e-7);
  assert.equal(h.get('editor').listeners.wheel,undefined);
});
