'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,tick,deferred}=require('./app-settings-ui.test.js');
const root=path.resolve(__dirname,'..');
function attachAI(h){
  vm.runInContext(fs.readFileSync(path.join(root,'public/ai.js'),'utf8'),h.context,{filename:'public/ai.js'});
  h.context.api=async url=>{assert.equal(url,'/api/ai/settings');return{enabled:false,endpoint:'',model:'local-model',imageModel:'',hasKey:false,contextMode:'auto',maxContextChars:null,timeoutSeconds:60};};
  h.builds=0;h.context.buildContinuationSettings=()=>{h.builds++;h.get('settings-ai').replaceChildren();h.run("appendAISettings($('settings-ai'))");};
}
test('the real layout groups every existing setting without adding fabricated features',()=>{
  const h=harness(),pages=['general','ai','skills','protection','shortcuts','updates','about'];
  for(const page of pages){const button=h.get('settings-tab-'+page),panel=h.get('settings-page-'+page);assert.equal(button.getAttribute('role'),'tab');assert.equal(panel.getAttribute('role'),'tabpanel');assert.equal(button.getAttribute('aria-controls'),panel.id);assert.equal(panel.getAttribute('aria-labelledby'),button.id);}
  for(const id of ['language-select','settings-display'])assert.equal(h.get(id).closest('[data-settings-page]').dataset.settingsPage,'general');
  for(const [id,page] of [['settings-ai','ai'],['settings-skills','skills'],['settings-protection','protection'],['settings-edit-actions','shortcuts'],['settings-updates','updates'],['settings-quit','about'],['settings-data-path','about']])assert.equal(h.get(id).closest('[data-settings-page]').dataset.settingsPage,page);
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');assert.ok(html.indexOf('/settings.js')<html.indexOf('/workspace.js'));assert.ok(html.includes('href="/settings.css"'));assert.ok(!html.includes('启动时回到书架'));
});
test('direct AI opening and changing categories keep the original unsaved key, listeners and form instance',async()=>{
  const h=harness();attachAI(h);await h.run("showAppSettings('ai')");await tick();
  const key=h.get('ai-api-key'),model=h.get('ai-model'),section=h.get('settings-ai').querySelector('details'),listeners=key.listeners.get('change');key.value='unsubmitted-local-key';model.value='unsaved-model';
  assert.equal(section.open,true);assert.equal(h.get('settings-page-ai').hidden,false);assert.equal(h.get('settings-page-general').hidden,true);
  assert.equal(h.get('settings-ai').querySelectorAll('.settings-form-group').length,2);assert.equal(key.closest('.settings-card'),h.get('ai-endpoint').closest('.settings-card'));assert.notEqual(key.closest('.settings-card'),model.closest('.settings-card'));
  h.run("selectSettingsPage('skills');selectSettingsPage('general')");await h.run("showAppSettings('ai')");h.run('syncSettingsLayout();syncSettingsLayout()');
  assert.equal(h.builds,1);assert.equal(h.get('ai-api-key'),key);assert.equal(key.value,'unsubmitted-local-key');assert.equal(model.value,'unsaved-model');assert.equal(key.listeners.get('change'),listeners);assert.equal(h.get('settings-ai').querySelector('details'),section);assert.equal(section.querySelector('details').open,false);assert.equal(h.get('settings-ai').querySelectorAll('.settings-form-group').length,2);
});
test('a late settings response fills its existing form without switching the selected page',async()=>{
  const h=harness();attachAI(h);const response=deferred();h.context.api=()=>response.promise;
  await h.run("showAppSettings('ai')");const original=h.get('ai-api-key');h.run("selectSettingsPage('general')");response.resolve({enabled:false,endpoint:'',model:'ready-model',imageModel:'',hasKey:true,contextMode:'auto',maxContextChars:null,timeoutSeconds:45});await tick();
  assert.equal(h.get('settings-page-general').hidden,false);assert.equal(h.get('settings-page-ai').hidden,true);assert.equal(h.get('ai-api-key'),original);assert.equal(h.get('ai-model').value,'ready-model');assert.equal(original.disabled,false);
});
test('category keyboard navigation skips unavailable upgrades and uses roving focus',async()=>{
  const h=harness({desktop:false});await h.run('showAppSettings()');assert.equal(h.get('settings-tab-updates').hidden,true);
  await h.get('settings-tab-general').emit('keydown',{key:'ArrowDown'});assert.equal(h.document.activeElement,h.get('settings-tab-ai'));assert.equal(h.get('settings-page-ai').hidden,false);
  await h.get('settings-tab-ai').emit('keydown',{key:'End'});assert.equal(h.document.activeElement,h.get('settings-tab-about'));
  await h.get('settings-tab-about').emit('keydown',{key:'ArrowUp'});assert.equal(h.document.activeElement,h.get('settings-tab-shortcuts'));
  const selected=h.get('settings-nav').querySelectorAll('[data-settings-page-target]').filter(button=>button.getAttribute('aria-selected')==='true');assert.equal(selected.length,1);assert.equal(selected[0].tabIndex,0);assert.ok(h.get('settings-nav').querySelectorAll('[data-settings-page-target]').filter(button=>button!==selected[0]).every(button=>button.tabIndex===-1));
});
test('changing categories preserves per-page scroll without mutating the book or revision',async()=>{
  const h=harness(),before=JSON.stringify(h.book);await h.run('showAppSettings()');h.get('settings-content').scrollTop=123;h.run("selectSettingsPage('skills')");assert.equal(h.get('settings-content').scrollTop,0);h.get('settings-content').scrollTop=240;h.run("selectSettingsPage('general')");assert.equal(h.get('settings-content').scrollTop,123);h.run("selectSettingsPage('skills')");assert.equal(h.get('settings-content').scrollTop,240);
  assert.equal(JSON.stringify(h.book),before);assert.equal(h.state.revision,7);assert.equal(h.state.dirty,false);assert.deepEqual(h.nativeCalls,[]);
});
test('IME and an in-progress save block page changes and unsupported destinations remain hidden',async()=>{
  const h=harness({desktop:false});await h.run('showAppSettings()');h.state.composing=true;assert.equal(h.run("selectSettingsPage('ai')"),false);await h.get('settings-tab-general').emit('keydown',{key:'ArrowDown',isComposing:true});assert.equal(h.get('settings-page-general').hidden,false);
  h.state.composing=false;h.state.transitioning=true;assert.equal(h.run("selectSettingsPage('skills')"),false);h.state.transitioning=false;assert.equal(h.run("selectSettingsPage('updates')"),false);assert.equal(h.run("selectSettingsPage('__proto__')"),false);assert.equal(h.get('settings-page-general').hidden,false);
});
test('upgrade availability can change without rebuilding other forms or leaving an inaccessible selected tab',async()=>{
  const h=harness();await h.run('showAppSettings()');h.get('settings-updates').hidden=false;h.run('syncSettingsLayout()');assert.equal(h.get('settings-tab-updates').hidden,false);assert.equal(h.run("selectSettingsPage('updates')"),true);h.get('settings-updates').hidden=true;h.run('syncSettingsLayout()');assert.equal(h.get('settings-tab-updates').hidden,true);assert.equal(h.get('settings-page-general').hidden,false);
  h.run('bindSettingsLayout();bindSettingsLayout()');assert.equal(h.get('settings-tab-ai').listeners.get('click').length,1);
});
test('Windows and Mac network updates remain reachable when Linux archive updates are unavailable',async()=>{
  const h=harness();await h.run('showAppSettings()');
  h.get('settings-updates').hidden=true;
  h.context.window.WriterDesktop.networkInfo=async()=>({});
  h.context.window.WriterDesktop.networkCheck=async()=>({});
  h.run('syncSettingsLayout()');
  assert.equal(h.get('settings-tab-updates').hidden,false);
  assert.equal(h.run("selectSettingsPage('updates')"),true);
  assert.equal(h.get('settings-page-updates').hidden,false);
  delete h.context.window.WriterDesktop.networkCheck;h.run('syncSettingsLayout()');
  assert.equal(h.get('settings-tab-updates').hidden,true);
  assert.equal(h.get('settings-page-general').hidden,false);
});


function reachable(node){
  for(let parent=node;parent;parent=parent.parentElement){if(parent.hidden)return false;if(parent.tagName==='DETAILS'&&!parent.open){const summary=parent.children.find(item=>item.tagName==='SUMMARY');if(!summary?.contains(node))return false;}}
  return true;
}
function attachUpdates(h,{network=true,local=true,pendingVersion=''}={}){
  const calls=[],settings={autoCheck:false,autoDownload:false,includePrerelease:false};let notify,subscriptions=0;
  h.updateCalls=calls;h.updateState={phase:'idle',currentVersion:'0.8.6',installKind:local?'managed':'nsis',settings};h.localInfo={version:'0.8.6',dataPath:'/isolated/data',updateSupported:local,installedVersion:'0.8.6',pendingVersion};h.native.getAppSettings=async()=>({...h.localInfo});
  h.native.installUpdate=async()=>{calls.push('local-install');return{canceled:true};};h.native.restartAfterUpdate=async()=>{calls.push('local-restart');return{restarting:true};};
  if(network){Object.assign(h.native,{networkInfo:async()=>{calls.push('network-info');return structuredClone(h.updateState);},networkCheck:async()=>{calls.push('network-check');return structuredClone(h.updateState);},networkDownload:async()=>{calls.push('network-download');return structuredClone(h.updateState);},networkInstall:async()=>{calls.push('network-install');return{installerOpened:true};},networkSettings:async value=>{calls.push('network-settings');h.updateState.settings=value;return structuredClone(h.updateState);},onNetworkUpdate:callback=>{subscriptions++;notify=callback;return()=>{};}});}
  for(const file of ['public/continuation.js','public/network-updater.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),h.context,{filename:file});
  h.run('bindContinuationEvents()');h.notifyUpdate=value=>{h.updateState={...h.updateState,...value};notify?.(structuredClone(h.updateState));};h.updateSubscriptions=()=>subscriptions;
}

test('network updates are the first reachable action and the package fallback follows platform capabilities',async()=>{
  for(const capability of [{network:true,local:true},{network:true,local:false},{network:false,local:true},{network:false,local:false}]){
    const h=harness();attachUpdates(h,capability);await h.run("showAppSettings('updates')");await tick();const page=h.get('settings-page-updates'),fallback=h.get('settings-update-fallback'),local=h.get('settings-install-update'),network=page.querySelector('.network-update-settings'),link=fallback.querySelector('a');
    assert.equal(h.get('settings-tab-updates').hidden,!capability.network&&!capability.local);assert.equal(fallback.hidden,!capability.network&&!capability.local);assert.equal(fallback.open,false,'The alternative package route starts collapsed');assert.equal(h.get('settings-updates').hidden,!capability.local);assert.equal(!!network,capability.network);assert.equal(reachable(local),false);assert.equal(reachable(link),false);assert.equal(link.getAttribute('href'),'https://github.com/asoming/writer-desk/releases');
    if(capability.network){const first=page.querySelectorAll('button').filter(reachable)[0];assert.equal(first.textContent,'检查更新');assert.equal(first.disabled,false);assert.ok(!fallback.contains(first));assert.deepEqual(h.updateCalls,['network-info']);}
    if(capability.network||capability.local){fallback.open=true;assert.equal(reachable(link),true);assert.equal(reachable(local),capability.local);}
    assert.ok(!h.updateCalls.some(call=>/install|restart|download/.test(call)),'Merely opening settings or the backup route cannot install anything');
  }
});

test('a pending local package exposes its restart action while retaining the existing successful-save gate',async()=>{
  const h=harness();attachUpdates(h,{network:false,local:true,pendingVersion:'0.8.7'});let saved=false;h.context.requireSaved=async()=>{h.updateCalls.push('save');return saved;};await h.run("showAppSettings('updates')");await tick();const fallback=h.get('settings-update-fallback'),restart=h.get('settings-restart-update');assert.equal(fallback.open,true);assert.equal(reachable(restart),true);assert.equal(h.get('settings-update-status').hidden,false);assert.match(h.get('settings-update-status').textContent,/0\.8\.7/);await restart.emit('click');assert.deepEqual(h.updateCalls,['save']);saved=true;await restart.emit('click');assert.deepEqual(h.updateCalls,['save','save','local-restart']);assert.equal(h.state.dirty,false);assert.equal(h.state.revision,7);
});

test('category switching and reopening preserve network preferences, progress and the downloaded installer without remounting',async()=>{
  const h=harness(),before=JSON.stringify(h.book);attachUpdates(h);await h.run("showAppSettings('updates')");await tick();const host=h.get('settings-network-updates'),panel=host.querySelector('.network-update-settings'),preference=panel.querySelectorAll('input').find(input=>input.getAttribute('aria-label')==='接收预览版');preference.checked=true;await preference.emit('change');const candidate={version:'0.8.7',size:100,notes:'fixture release'};h.notifyUpdate({phase:'downloading',candidate,received:40,total:100});const progress=panel.querySelector('progress');assert.equal(progress.hidden,false);assert.equal(progress.value,40);h.run("selectSettingsPage('general')");h.notifyUpdate({phase:'downloaded',downloadedVersion:'0.8.7',received:100,total:100});assert.equal(h.get('settings-page-general').hidden,false,'A background update must not steal the selected settings page');h.run('closeAppSettings()');await h.run("showAppSettings('updates')");await tick();assert.equal(host.querySelector('.network-update-settings'),panel);assert.equal(panel.querySelectorAll('input').find(input=>input.getAttribute('aria-label')==='接收预览版'),preference);assert.equal(preference.checked,true);const install=panel.querySelectorAll('button').find(button=>button.textContent==='保存并重启更新');assert.equal(reachable(install),true);assert.equal(install.disabled,false);assert.equal(h.get('settings-update-fallback').open,false);assert.equal(h.updateSubscriptions(),1);assert.deepEqual(h.updateCalls,['network-info','network-settings']);assert.equal(JSON.stringify(h.book),before);assert.equal(h.state.revision,7);assert.equal(h.state.dirty,false);
});
