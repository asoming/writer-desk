'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/continuation.js'),'utf8');
function harness(desktop=true){
  const nodes=new Map(),calls=[],notices=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,children:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});return nodes.get(id);};
  const native={installUpdate:async()=>{calls.push('install');return{pendingVersion:'0.4.1',restartRequired:true,checksumVerified:true};},restartAfterUpdate:async()=>{calls.push('restart');}};
  const context=vm.createContext({window:{WriterDesktop:desktop?native:undefined},$:get,T:(s,...values)=>s.replace(/\{(\d+)\}/g,(_,i)=>values[i]),el:(_t,_c,text)=>({text}),toast:text=>notices.push(text),appSettingsState:{version:'0.4.0'},requireSaved:async()=>true,showAIAssistant:action=>calls.push(action),Promise});
  vm.runInContext(source,context);vm.runInContext('bindContinuationEvents()',context);
  return{get,calls,notices,native,context,run:code=>vm.runInContext(code,context)};
}
async function main(){
  const web=harness(false);web.run('updateContinuationSettings()');assert.equal(web.get('settings-updates').hidden,true);
  const h=harness();
  h.run('updateContinuationSettings({updateSupported:false});updateContinuationSettings()');assert.equal(h.get('settings-updates').hidden,true,'refresh preserves unsupported native state');h.run('updateContinuationSettings({updateSupported:true})');
  h.run('requireSaved=async()=>false');await h.get('settings-install-update').listeners.click();assert.deepEqual(h.calls,[],'failed save cannot open update installer');
  h.run('requireSaved=async()=>true');await h.get('settings-install-update').listeners.click();
  assert.deepEqual(h.calls,['install']);assert.equal(h.get('settings-restart-update').hidden,false);assert.match(h.get('settings-update-status').textContent,/0\.4\.1/);
  assert.equal(h.get('settings-install-update').disabled,false);
  h.run('requireSaved=async()=>false');await h.get('settings-restart-update').listeners.click();assert.deepEqual(h.calls,['install'],'failed save cannot trigger restart');
  h.run('requireSaved=async()=>true');h.native.restartAfterUpdate=async()=>{throw new Error('save handshake refused');};
  await h.get('settings-restart-update').listeners.click();assert.match(h.notices.at(-1),/save handshake/);assert.equal(h.get('settings-restart-update').hidden,false,'failed restart retains staged version');
  h.native.installUpdate=async()=>({canceled:true});await h.get('settings-install-update').listeners.click();assert.match(h.get('settings-update-status').textContent,/0\.4\.1/,'cancel keeps pending state');
  h.native.installUpdate=async()=>{assert.equal(h.get('settings-install-update').disabled,true);await h.get('settings-install-update').listeners.click();return{canceled:true};};await h.get('settings-install-update').listeners.click();
  await h.get('outline-ai').listeners.click();await h.get('people-ai').listeners.click();assert.deepEqual(h.calls.slice(-2),['draft','relationships']);
  console.log('PASS: browser visibility, save-gated update/restart, staged state, retry and AI entry actions.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
