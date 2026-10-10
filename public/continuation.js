'use strict';

const updateSettingsState={pendingVersion:'',installedVersion:'',installPath:'',updateSupported:true,busy:false};

function updateContinuationSettings(info={}){
  const section=$('settings-updates');
  if(!section)return;
  if(typeof info.updateSupported==='boolean')updateSettingsState.updateSupported=info.updateSupported;
  const supported=typeof window.WriterDesktop?.installUpdate==='function'&&updateSettingsState.updateSupported;
  section.hidden=!supported;
  for(const key of ['pendingVersion','installedVersion','installPath'])if(typeof info[key]==='string')updateSettingsState[key]=info[key];
  const pending=updateSettingsState.pendingVersion;
  $('settings-update-status').textContent=pending?T('版本 {0} 已就绪，重启后生效。',pending):T('当前版本 {0}',updateSettingsState.installedVersion||appSettingsState.version||'—');
  $('settings-restart-update').hidden=!pending;
  $('settings-install-update').disabled=updateSettingsState.busy;
  $('settings-restart-update').disabled=updateSettingsState.busy;
}

async function buildContinuationSettings(){
  const builds=[['settings-protection',typeof appendProtectionSettings==='function'?appendProtectionSettings:null],['settings-ai',typeof appendAISettings==='function'?appendAISettings:null],['settings-skills',typeof appendWritingSkillSettings==='function'?appendWritingSkillSettings:null]];
  await Promise.allSettled(builds.map(async([id,build])=>{
    const host=$(id);if(!host||!build)return;host.replaceChildren();
    try{await build(host);}catch(error){host.append(el('p','subtle',error.message||T('无法读取设置。')));}
  }));
  updateContinuationSettings();
}

function bindContinuationEvents(){
  for(const [id,kind]of [['outline-ai','outline'],['people-ai','relationships'],['writing-ai',null]]){
    $(id)?.addEventListener('click',()=>showAIAssistant(kind));
  }
  $('settings-install-update')?.addEventListener('click',async()=>{
    if(updateSettingsState.busy||!window.WriterDesktop?.installUpdate)return;
    if(!await requireSaved())return;
    updateSettingsState.busy=true;updateContinuationSettings();
    try{
      const result=await window.WriterDesktop.installUpdate();
      if(!result?.canceled){updateContinuationSettings(result);toast(T('升级包已校验。重启后完成升级。'));}
    }catch(error){toast(T(error.message||'暂时无法完成操作'));}
    finally{updateSettingsState.busy=false;updateContinuationSettings();}
  });
  $('settings-restart-update')?.addEventListener('click',async()=>{
    if(updateSettingsState.busy||!window.WriterDesktop?.restartAfterUpdate||!await requireSaved())return;
    updateSettingsState.busy=true;updateContinuationSettings();
    try{await window.WriterDesktop.restartAfterUpdate();}
    catch(error){toast(T(error.message||'暂时无法完成操作'));}
    finally{updateSettingsState.busy=false;updateContinuationSettings();}
  });
}
