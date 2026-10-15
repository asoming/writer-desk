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
