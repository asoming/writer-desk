'use strict';

// Exercise the actual palette startup and controls without reading a personal
// library or calling a native action. CSS colours are reviewed in the browser.
const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {makeDOM,harness}=require('./app-settings-ui.test.js');
const root=path.resolve(__dirname,'..'),key='writer-desk.appearance';
const source=fs.readFileSync(path.join(root,'public/theme.js'),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
function storage(initial){
  const values=new Map(initial===undefined?[]:[[key,initial]]),writes=[];
  return{values,writes,getItem:name=>values.get(name)??null,setItem(name,value){writes.push({name,value});values.set(name,value);}};
}
function boot({desktop=false,saved,browserSaved,readFails=false,storageFails=false,headOnly=false}={}){
  const document=headOnly?{documentElement:{dataset:{}},getElementById(){throw Error('Body is not parsed yet');}}:makeDOM();
  const browser=storage(browserSaved??(!desktop?saved:undefined)),native=storage(saved),messages=[];
  const preferred=desktop?native:browser;
  if(readFails)preferred.getItem=()=>{throw Error('Storage unavailable');};
  if(storageFails)preferred.setItem=()=>{throw Error('Disk full');};
  const context=vm.createContext({document,localStorage:browser,T:text=>text,svgIcon:name=>'<svg data-test-icon="'+name+'"></svg>',toast:message=>messages.push(message)});
  context.window=context;if(desktop)context.WriterDesktop={storage:native};
  const run=expression=>vm.runInContext(expression,context);
  vm.runInContext(source,context,{filename:'public/theme.js'});
  return{document,context,run,browser,native,messages,get:id=>document.getElementById(id),palette:()=>copy(document.documentElement.dataset)};
}
test('saved colours apply in the head before styles and body controls exist',()=>{
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const tag=html.match(/<script\b[^>]*src="\/theme\.js"[^>]*>/)?.[0];
  assert.ok(tag);assert.ok(!/\b(?:defer|async|type)=?|\btype\s*=/i.test(tag));
  assert.ok(html.indexOf(tag)<html.indexOf('rel="stylesheet"'));
  assert.ok(html.indexOf(tag)<html.indexOf('</head>'));
  const h=boot({saved:JSON.stringify({theme:'dark',eyeComfort:true}),headOnly:true});
  assert.deepEqual(h.palette(),{theme:'dark',eyeComfort:'true'});
  assert.equal(h.browser.writes.length,0);
});
test('missing, corrupt and unsupported preferences fall back safely without writing during startup',()=>{
  for(const saved of [undefined,'{broken','null','[]','"dark"','42',JSON.stringify({theme:'system',eyeComfort:'true'})]){
    const h=boot({saved,headOnly:true});
    assert.deepEqual(h.palette(),{theme:'light',eyeComfort:'false'});
    assert.equal(h.browser.writes.length,0);
  }
  assert.deepEqual(boot({readFails:true,headOnly:true}).palette(),{theme:'light',eyeComfort:'false'});
});
test('desktop preferences override browser origin storage and survive a changed origin',async()=>{
  const h=boot({desktop:true,saved:JSON.stringify({theme:'dark',eyeComfort:true}),browserSaved:JSON.stringify({theme:'light',eyeComfort:false})});
  h.run('bindAppearanceEvents()');await h.get('theme-toggle').emit('click');
  assert.deepEqual(h.palette(),{theme:'light',eyeComfort:'true'});
  assert.equal(h.native.writes.length,1);assert.equal(h.browser.writes.length,0);
  const restarted=boot({desktop:true,saved:h.native.values.get(key),browserSaved:JSON.stringify({theme:'dark',eyeComfort:false}),headOnly:true});
  assert.deepEqual(restarted.palette(),{theme:'light',eyeComfort:'true'});
});
test('header day/night control is beside the unchanged save status and synchronizes settings',async()=>{
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  assert.ok(html.indexOf('id="theme-toggle"')<html.indexOf('id="save-status"'));
  assert.ok(!html.includes('id="theme-label"'));
  const h=boot();h.run('bindAppearanceEvents();bindAppearanceEvents()');
  const button=h.get('theme-toggle'),status=h.get('save-status'),dropdown=h.get('settings-theme');
  assert.equal(status.previousElementSibling,button);
  assert.equal(button.querySelectorAll('span').length,1);
  assert.equal(button.querySelector('span'),h.get('theme-icon'));
  assert.equal(button.textContent.trim(),'');
  assert.equal(status.getAttribute('role'),'status');assert.equal(status.getAttribute('aria-live'),'polite');
  assert.equal(button.getAttribute('aria-label'),'切换到黑夜模式');
  await button.emit('click');
  assert.equal(h.document.documentElement.dataset.theme,'dark');assert.equal(dropdown.value,'dark');
  assert.equal(button.getAttribute('aria-label'),'切换到白天模式');
  assert.equal(h.get('theme-icon').dataset.icon,'moon');assert.equal(h.browser.writes.length,1);
  await button.emit('click');
  assert.equal(dropdown.value,'light');assert.equal(h.get('theme-icon').dataset.icon,'sun');assert.equal(h.browser.writes.length,2);
});
test('General settings change the same day/night preference and reject unknown modes',async()=>{
  const h=boot();h.run('bindAppearanceEvents()');const dropdown=h.get('settings-theme');
  assert.equal(dropdown.closest('[data-settings-page]').dataset.settingsPage,'general');
  dropdown.value='dark';await dropdown.emit('change');
  assert.equal(h.get('theme-icon').dataset.icon,'moon');assert.deepEqual(JSON.parse(h.browser.values.get(key)),{theme:'dark',eyeComfort:false});
  const before=h.palette(),writes=h.browser.writes.length;dropdown.value='unexpected';await dropdown.emit('change');
  assert.deepEqual(h.palette(),before);assert.equal(h.browser.writes.length,writes);
});
test('eye comfort is independently retained across both palettes and restart',async()=>{
  const h=boot();h.run('bindAppearanceEvents()');const comfort=h.get('eye-comfort');
  assert.equal(comfort.closest('[data-settings-page]').dataset.settingsPage,'general');
  assert.equal(comfort.getAttribute('role'),'switch');assert.equal(comfort.checked,false);
  comfort.checked=true;await comfort.emit('change');
  assert.deepEqual(h.palette(),{theme:'light',eyeComfort:'true'});assert.equal(comfort.getAttribute('aria-checked'),'true');
  await h.get('theme-toggle').emit('click');assert.deepEqual(h.palette(),{theme:'dark',eyeComfort:'true'});assert.equal(comfort.checked,true);
  const restarted=boot({saved:h.browser.values.get(key)});restarted.run('bindAppearanceEvents()');
  assert.equal(restarted.get('eye-comfort').checked,true);assert.equal(restarted.get('settings-theme').value,'dark');
  comfort.checked=false;await comfort.emit('change');assert.deepEqual(h.palette(),{theme:'dark',eyeComfort:'false'});
  assert.equal(comfort.getAttribute('aria-checked'),'false');
});
test('invalid preference updates leave both the current palette and persisted value intact',()=>{
  const h=boot({saved:JSON.stringify({theme:'dark',eyeComfort:true})});h.run('bindAppearanceEvents()');
  const before=h.palette(),persisted=h.browser.values.get(key);
  for(const value of [null,{},[],{theme:'dark'},{theme:'other',eyeComfort:false},{theme:'light',eyeComfort:1}]){
    h.context.nextAppearance=value;assert.equal(h.run('setAppearance(nextAppearance)'),false);
    assert.deepEqual(h.palette(),before);assert.equal(h.browser.values.get(key),persisted);
  }
  assert.equal(h.browser.writes.length,0);
});
test('unavailable or full storage keeps the controls usable and reports only a local persistence failure',async()=>{
  for(const options of [{storageFails:true},{readFails:true,storageFails:true}]){
    const h=boot(options);h.run('bindAppearanceEvents()');
    await h.get('theme-toggle').emit('click');assert.equal(h.document.documentElement.dataset.theme,'dark');
    assert.equal(h.get('settings-theme').value,'dark');assert.equal(h.messages.length,1);
    assert.equal(h.messages[0],'外观已切换，但未能保存设置。');
    await h.get('theme-toggle').emit('click');assert.equal(h.document.documentElement.dataset.theme,'light');
  }
});
test('real dirty writing, selection, IME state and the save indicator are untouched by appearance changes',async()=>{
  for(const language of ['zh','en']){
    const h=harness({language});vm.runInContext(source,h.context,{filename:'public/theme.js'});h.run('bindAppearanceEvents()');
    h.state.dirty=true;h.state.composing=true;h.state.timer=632;
    h.get('editor').value+='未保存的输入';h.get('editor').setSelectionRange(5,10,'backward');
    const before=copy({book:h.book,state:{view:h.state.view,chapterId:h.state.chapterId,revision:h.state.revision,dirty:h.state.dirty,composing:h.state.composing,timer:h.state.timer},value:h.get('editor').value,start:h.get('editor').selectionStart,end:h.get('editor').selectionEnd,direction:h.get('editor').selectionDirection,scrollTop:h.get('editor').scrollTop,scrollLeft:h.get('editor').scrollLeft,status:h.get('save-status').textContent});
    const active=h.document.activeElement;
    h.context.fetch=()=>{throw Error('A colour change must not call a backend');};
    await h.get('theme-toggle').emit('click');h.get('eye-comfort').checked=true;await h.get('eye-comfort').emit('change');
    assert.deepEqual(copy({book:h.book,state:{view:h.state.view,chapterId:h.state.chapterId,revision:h.state.revision,dirty:h.state.dirty,composing:h.state.composing,timer:h.state.timer},value:h.get('editor').value,start:h.get('editor').selectionStart,end:h.get('editor').selectionEnd,direction:h.get('editor').selectionDirection,scrollTop:h.get('editor').scrollTop,scrollLeft:h.get('editor').scrollLeft,status:h.get('save-status').textContent}),before);
    assert.equal(h.document.activeElement,active);assert.deepEqual(h.nativeCalls,[]);
    assert.equal(h.get('theme-toggle').getAttribute('aria-label'),language==='en'?'Switch to day mode':'切换到白天模式');
    assert.equal(h.get('theme-toggle').textContent.trim(),'');
    assert.deepEqual(JSON.parse(h.values.get(key)),{theme:'dark',eyeComfort:true});
    assert.equal(h.values.get('writer-desk.language'),language);
  }
});
