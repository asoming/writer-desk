'use strict';
// Native main owns URLs, destinations, hashes, receipts and installer execution.
// This renderer can only request predefined actions and author-controlled saves.
window.WriterNetworkUpdates=(()=>{
  let state=null,initialized=false,initializing=null,unsubscribe=null,pending=false,settingsPending=false;
  const views=new Set(),native=()=>window.WriterDesktop;
  function supported(){return typeof native()?.networkInfo==='function'&&typeof native()?.networkCheck==='function';}
  function current(view){return view.content.contains(view.section);}
  function apply(value){if(!value||typeof value!=='object'||typeof value.phase!=='string')return;state=value;for(const view of views){if(current(view))render(view);else views.delete(view);}}
  function render(view){
    const value=state,phase=value?.phase||'idle',busy=pending||settingsPending||['checking','downloading','staging'].includes(phase),candidate=value?.candidate,downloaded=!!candidate&&value?.downloadedVersion===candidate.version;
    const messages={checking:T('正在检查更新…'),downloading:T('正在下载更新…'),staging:T('正在校验安装文件…'),staged:T('版本 {0} 已就绪，保存后重启完成更新。',value?.pendingVersion||candidate?.version||''),downloaded:T('版本 {0} 已下载并校验。',candidate?.version||''),available:T('发现新版本 {0}',candidate?.version||''),cancelled:T('已取消更新下载。'),installer:T('已打开安装器，请按系统提示完成安装。')};
    view.status.textContent=phase==='error'?T(value?.error||'更新失败，请重试。'):messages[phase]||(value?.upToDate?T('已是最新版本。'):T('当前版本 {0}',value?.currentVersion||native()?.version||'—'));
    view.status.setAttribute('role',phase==='error'?'alert':'status');
    view.check.disabled=busy;view.download.disabled=busy||!candidate||!['available','error','cancelled'].includes(phase);view.download.hidden=!candidate||downloaded||['downloaded','staged'].includes(phase);view.cancel.hidden=!['checking','downloading'].includes(phase);view.cancel.disabled=settingsPending;
    view.install.hidden=!downloaded&&!['downloaded','staged'].includes(phase);view.install.disabled=busy;
    view.install.textContent=T(value?.installKind==='managed'?'保存并重启更新':'保存并打开安装器');
    view.progress.hidden=phase!=='downloading';view.progress.max=Number.isFinite(value?.total)&&value.total>0?value.total:1;view.progress.value=Number.isFinite(value?.received)?Math.min(value.received,view.progress.max):0;
    view.progressText.hidden=view.progress.hidden;view.progressText.textContent=view.progress.hidden?'':T('已下载 {0} / {1} MB',((value.received||0)/1048576).toFixed(1),((value.total||candidate?.size||0)/1048576).toFixed(1));
    view.notes.hidden=!candidate;view.notes.textContent=candidate?T('版本 {0}',candidate.version)+(candidate.prerelease?' · '+T('预览版'):'')+'\n\n'+(candidate.notes||T('此版本没有发布说明。')):'';
    for(const [key,input]of Object.entries(view.preferences)){input.checked=!!value?.settings?.[key];input.disabled=busy;}
  }
  async function initialize(){
    if(!supported())return null;if(initializing)return initializing;
    initializing=(async()=>{
      if(!initialized){initialized=true;unsubscribe=native().onNetworkUpdate?.(apply)||null;}
      try{apply(await native().networkInfo());if(state?.settings?.autoCheck&&!pending){pending=true;apply(state);try{apply(await native().networkCheck());if(state?.phase==='available'&&state.settings.autoDownload)apply(await native().networkDownload());}finally{pending=false;if(state)apply(state);}}return state;}
      catch(error){apply({...state,phase:'error',error:error.message});return state;}
    })();return initializing;
  }
  async function operate(action){
    if(!supported()||pending||settingsPending)return;pending=true;if(state)apply(state);
    try{
      if(action==='install'&&typeof requireSaved==='function'&&!await requireSaved())return;
      const result=await native()[{check:'networkCheck',download:'networkDownload',install:'networkInstall'}[action]]();
      if(result?.phase)apply(result);else if(result?.installerOpened)apply({...state,phase:'installer',error:null});
      if(action==='check'&&state?.phase==='available'&&state.settings?.autoDownload)apply(await native().networkDownload());
      if(action==='install'&&result?.installerOpened)for(const view of views)if(current(view))view.status.textContent=T('已打开安装器，请按系统提示完成安装。');
    }catch(error){apply({...state,phase:'error',error:error.message});}
    finally{pending=false;if(state)apply(state);}
  }
  function append(content){
    if(!supported())return null;
    const section=el('details','network-update-settings'),body=el('div','network-update-body'),status=el('p','subtle',T('正在读取更新设置…')),buttons=el('div','network-update-actions'),check=action(T('检查更新'),'secondary-button',()=>operate('check')),download=action(T('下载更新'),'primary-button',()=>operate('download')),cancel=action(T('取消下载'),'text-button',async()=>{try{await native().networkCancel();}catch(error){toast(error.message);}}),install=action(T('保存并重启更新'),'primary-button',()=>operate('install')),progress=el('progress'),progressText=el('small'),notes=el('pre','network-update-notes'),preferences={};
    section.append(el('summary',null,T('联网更新')),body);body.append(status);buttons.append(check,download,cancel,install);body.append(buttons,progress,progressText);
    for(const [key,text]of [['autoCheck','启动时检查更新'],['autoDownload','自动下载更新'],['includePrerelease','接收预览版']]){const row=el('label','checkbox-row'),input=el('input');input.type='checkbox';input.setAttribute('aria-label',T(text));preferences[key]=input;row.append(input,el('span',null,T(text)));body.append(row);input.addEventListener('change',async()=>{if(pending||settingsPending){if(state)apply(state);return;}const checked=input.checked;settingsPending=true;if(state)apply(state);try{const next={...state.settings,[key]:checked};apply(await native().networkSettings(next));}catch(error){toast(error.message);}finally{settingsPending=false;if(state)apply(state);}});}
    body.append(notes);content.append(section);const view={content,section,status,check,download,cancel,install,progress,progressText,notes,preferences};views.add(view);if(state)render(view);else initialize();return section;
  }
  window.addEventListener('pagehide',()=>{unsubscribe?.();unsubscribe=null;views.clear();},{once:true});
  return Object.freeze({initialize,append});
})();
function appendNetworkUpdateSettings(content){return window.WriterNetworkUpdates.append(content);}
function initializeNetworkUpdates(){return window.WriterNetworkUpdates.initialize();}
