'use strict';

// This destination supplements the normal local snapshots. The service owns
// its subdirectory; choosing a location never grants arbitrary file deletion.
window.appendExternalBackupSettings=(()=>{
  const generations=new WeakMap();
  return async function appendExternalBackupSettings(content){
    const generation=(generations.get(content)||0)+1;generations.set(content,generation);
    content.querySelector('.external-backup-settings')?.remove();
    const section=el('section','settings-section settings-group external-backup-settings'),heading=el('h3',null,T('外部备份')),card=el('div','settings-card'),enabled=el('input'),toggle=el('label','settings-row'),path=el('input','text-field'),destination=el('div','external-backup-destination'),status=el('p','subtle external-backup-status'),last=el('p','subtle external-backup-last'),buttons=el('div','external-backup-actions');
    enabled.type='checkbox';enabled.setAttribute('role','switch');enabled.setAttribute('aria-label',T('外部自动备份'));toggle.append(el('span',null,T('外部自动备份')),enabled);path.setAttribute('aria-label',T('外部备份文件夹'));path.placeholder=T('备份文件夹的绝对路径');path.maxLength=4096;
    const choose=action(T('选择文件夹'),'secondary-button',chooseDirectory),save=action(T('保存'),'secondary-button',saveSettings),run=action(T('立即备份'),'primary-button',runBackup);choose.hidden=typeof window.WriterDesktop?.chooseBackupDirectory!=='function';destination.append(path,choose);buttons.append(save,run);card.append(toggle,destination,last,buttons,status);section.append(heading,card);content.append(section);
    let settings=null,busy=false;const valid=()=>content.isConnected&&section.isConnected&&generations.get(content)===generation;const visible=()=>valid()&&$('settings-dialog').open;
    function setBusy(value){busy=value;for(const control of [enabled,path,choose,save,run])control.disabled=value;}
    function draw(value){settings=value;enabled.checked=!!value.enabled;enabled.setAttribute('aria-checked',String(enabled.checked));path.value=value.destination||'';last.textContent=value.lastSuccess?T('最近备份：{0}',new Date(value.lastSuccess).toLocaleString()):T('尚未备份');run.disabled=busy||!value.enabled||!value.destination;}
    function stalePath(){return !settings||settings.enabled!==enabled.checked||settings.destination!==path.value.trim();}
    async function chooseDirectory(){if(busy||!visible())return;setBusy(true);try{const value=await window.WriterDesktop.chooseBackupDirectory();if(value&&visible()){path.value=value;status.textContent='';}}catch(error){if(visible())status.textContent=T(error.message);}finally{if(valid()){setBusy(false);run.disabled=!settings?.enabled||!settings?.destination;}}}
    async function saveSettings(){
      if(busy||!visible())return false;setBusy(true);status.textContent='';
      try{if(!await requireSaved()||!visible())return false;const result=await api('/api/external-backups/settings','PUT',{enabled:enabled.checked,destination:path.value.trim()});if(!visible())return false;draw(result.settings);status.textContent=T('已保存');return true;}catch(error){if(visible())status.textContent=T(error.message);return false;}finally{if(valid()){setBusy(false);run.disabled=!settings?.enabled||!settings?.destination;}}
    }
    async function runBackup(){
      if(busy||!visible())return;if(stalePath()&&!await saveSettings())return;if(!settings?.enabled||!settings?.destination||!visible())return;setBusy(true);status.textContent=T('正在备份…');
      try{if(!await requireSaved()||!visible())return;const result=await api('/api/external-backups/run','POST',{});if(!visible())return;status.textContent=result.warning?T(result.warning):T('已备份 {0} 本作品',result.count);const current=await api('/api/external-backups/settings');if(visible())draw(current.settings);}catch(error){if(visible())status.textContent=T(error.message);}finally{if(valid()){setBusy(false);run.disabled=!settings?.enabled||!settings?.destination;}}
    }
    enabled.addEventListener('change',()=>{enabled.setAttribute('aria-checked',String(enabled.checked));run.disabled=busy||!enabled.checked||!path.value.trim();});path.addEventListener('input',()=>{run.disabled=busy||!enabled.checked||!path.value.trim();status.textContent='';});
    setBusy(true);try{const result=await api('/api/external-backups/settings');if(valid())draw(result.settings);}catch(error){if(valid())status.textContent=T(error.message);}finally{if(valid()){setBusy(false);run.disabled=!settings?.enabled||!settings?.destination;}}
  };
})();
