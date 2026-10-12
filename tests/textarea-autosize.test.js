'use strict';

const assert=require('node:assert/strict'),{test}=require('node:test');
const {attach}=require('../public/textarea-autosize.js');

function harness(){
  const frames=new Map(),windowEvents=new Map(),inputEvents=new Map();let nextFrame=0,observer;
  const container={clientHeight:800};
  const win={
    requestAnimationFrame(callback){const id=++nextFrame;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
    addEventListener:(name,callback)=>windowEvents.set(name,callback),removeEventListener:name=>windowEvents.delete(name),
    getComputedStyle:()=>({minHeight:'44px',maxHeight:'240px',paddingTop:'0px',paddingBottom:'0px',borderTopWidth:'0px',borderBottomWidth:'0px',boxSizing:'border-box'}),
    ResizeObserver:class{constructor(callback){observer=this;this.callback=callback;this.targets=new Set();}observe(node){this.targets.add(node);}disconnect(){this.targets.clear();}},
  };
  const input={style:{height:'',overflowY:''},ownerDocument:{defaultView:win},parentElement:container,isConnected:true,clientWidth:320,value:'草稿',selectionStart:2,selectionEnd:2,scrollTop:0,naturalHeight:22,
    addEventListener:(name,callback)=>inputEvents.set(name,callback),removeEventListener:name=>inputEvents.delete(name),
    get clientHeight(){return Math.max(44,Math.min(240,Number.parseFloat(this.style.height)||0));},
    get scrollHeight(){return Math.max(this.naturalHeight,this.clientHeight);},
  };
  const control=attach(input,{container,window:win}),flush=()=>{for(const [id,callback] of [...frames]){frames.delete(id);callback();}};
  return{input,container,control,frames,flush,inputEvents,windowEvents,get observer(){return observer;}};
}

test('input expands and programmatic prompt replacement shrinks without editing the value or selection',()=>{
  const h=harness();h.flush();assert.equal(h.input.clientHeight,44);
  h.input.value='粘贴进来的长提示词';h.input.naturalHeight=150;h.inputEvents.get('input')();h.flush();assert.equal(h.input.clientHeight,150);assert.equal(h.input.style.overflowY,'hidden');
  h.input.value='';h.input.naturalHeight=22;h.control.refresh();h.flush();assert.equal(h.input.clientHeight,44);assert.equal(h.input.value,'');assert.equal(h.input.selectionStart,2);assert.equal(h.input.selectionEnd,2);
});

test('long prompts scroll within the height limit and leave room in smaller conversation panes',()=>{
  const h=harness();h.input.naturalHeight=2000;h.input.scrollTop=80;h.flush();assert.equal(h.input.clientHeight,240);assert.equal(h.input.style.overflowY,'auto');assert.equal(h.input.scrollTop,80);
  h.container.clientHeight=400;h.observer.callback();h.flush();assert.ok(h.input.clientHeight<=h.container.clientHeight/3);assert.equal(h.input.style.overflowY,'auto');
  h.input.naturalHeight=22;h.inputEvents.get('input')();h.flush();assert.equal(h.input.scrollTop,0);assert.equal(h.input.style.overflowY,'hidden');
});

test('pane resizing remeasures wrapping, while hidden composers wait until reopened',()=>{
  const h=harness();h.input.naturalHeight=90;h.flush();assert.equal(h.input.clientHeight,90);
  h.input.clientWidth=200;h.input.naturalHeight=180;h.observer.callback();h.flush();assert.equal(h.input.clientHeight,180);
  h.input.clientWidth=500;h.input.naturalHeight=65;h.observer.callback();h.flush();assert.equal(h.input.clientHeight,65);
  h.input.clientWidth=0;h.input.naturalHeight=160;h.control.refresh();h.flush();assert.equal(h.input.clientHeight,65);
  h.input.clientWidth=500;h.observer.callback();h.flush();assert.equal(h.input.clientHeight,160,'reopening at the same width must still resize restored text');
  h.observer.callback();assert.equal(h.frames.size,0,'height-only resize must not start an observer loop');
});

test('composition can finish resizing without keyboard handlers, synthetic input, or state writes',()=>{
  const h=harness();h.flush();assert.deepEqual([...h.inputEvents.keys()].sort(),['compositionend','input']);
  h.input.value='人物关系尚未完成输入';h.input.naturalHeight=110;h.inputEvents.get('compositionend')();h.flush();assert.equal(h.input.clientHeight,110);assert.equal(h.input.value,'人物关系尚未完成输入');assert.equal(h.input.selectionStart,2);
});

test('disposing a conversation detaches observers and events and cancels its pending measurement',()=>{
  const h=harness();assert.equal(h.observer.targets.size,2);assert.equal(h.frames.size,1);h.control.dispose();h.control.dispose();assert.equal(h.frames.size,0);assert.equal(h.observer.targets.size,0);assert.equal(h.inputEvents.size,0);assert.equal(h.windowEvents.size,0);assert.deepEqual(h.input.style,{height:'',overflowY:''});h.control.refresh();assert.equal(h.frames.size,0);
});
