'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
class Element{constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.value='';this.textContent='';this.hidden=false;this.disabled=false;}append(...items){for(const item of items){this.children.push(item);item.parent=this;}}contains(item){return this===item||this.children.some(child=>child.contains(item));}setAttribute(key,value){this[key]=value;}addEventListener(type,handler){this.listeners[type]=handler;}}
const all=node=>[node,...node.children.flatMap(all)];
const englishContext=vm.createContext({window:{localStorage:{getItem:()=> 'en'}}});
const localization=fs.readFileSync(path.join(__dirname,'../public/i18n.js'),'utf8');
vm.runInContext(localization.slice(0,localization.indexOf('function localizeStaticInterface()')),englishContext);
function setup(initial={},language='zh'){
  const state={phase:'idle',currentVersion:'0.7.0',platform:'linux',arch:'x64',installKind:'managed',settings:{autoCheck:false,autoDownload:false,includePrerelease:false},...initial},calls=[],events={},content=new Element('div');let callback;
  const h={state,calls,content,saved:true,downloaded:0};const context=vm.createContext({window:{addEventListener(){}},T:(text,...args)=>language==='en'?englishContext.T(text,...args):String(text).replace(/\{(\d+)\}/g,(_,i)=>args[i]??''),el:(tag,className,text)=>Object.assign(new Element(tag),{className,textContent:text||''}),action:(text,className,handler)=>{const item=Object.assign(new Element('button'),{textContent:text,className});item.listeners.click=handler;return item;},requireSaved:async()=>{calls.push('save');return h.saved;},toast:message=>calls.push('toast:'+message)});context.window.WriterDesktop={version:'0.7.0',networkInfo:async()=>structuredClone(state),networkCheck:async()=>{calls.push('check');Object.assign(state,{phase:'available',candidate:{version:'0.8.0',size:20,notes:'<script>literal</script>'}});return structuredClone(state);},networkDownload:async()=>{calls.push('download');h.downloaded++;Object.assign(state,{phase:'downloaded',downloadedVersion:'0.8.0'});callback?.(structuredClone(state));return structuredClone(state);},networkInstall:async()=>{calls.push('install');return{installerOpened:true};},networkCancel:async()=>{calls.push('cancel');Object.assign(state,{phase:'cancelled'});callback?.(structuredClone(state));return{cancelled:true};},networkSettings:async next=>{calls.push({settings:next});state.settings=next;return structuredClone(state);},onNetworkUpdate:listener=>{callback=listener;return()=>{};}};vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/network-updater.js'),'utf8'),context);h.context=context;h.append=()=>context.appendNetworkUpdateSettings(content);h.initialize=()=>context.initializeNetworkUpdates();h.find=text=>all(content).find(item=>item.textContent===text);h.field=text=>all(content).find(item=>item['aria-label']===text);h.notify=value=>callback(value);return h;
}
test('settings honor manual checking, escape notes as text and do not download or install on opening',async()=>{const h=setup();h.append();await h.initialize();assert.deepEqual(h.calls,[]);await h.find('检查更新').listeners.click();assert.deepEqual(h.calls,['check']);assert.equal(h.find('下载更新').hidden,false);assert.ok(all(h.content).some(item=>item.tagName==='PRE'&&item.textContent.includes('<script>literal</script>')));});
test('download progress is visible and cancellation uses only the fixed native action',async()=>{const h=setup();h.append();await h.initialize();await h.find('检查更新').listeners.click();h.notify({...h.state,phase:'downloading',received:5,total:20});const progress=all(h.content).find(item=>item.tagName==='PROGRESS');assert.equal(progress.hidden,false);assert.equal(progress.value,5);assert.equal(h.find('取消下载').hidden,false);await h.find('取消下载').listeners.click();assert.equal(h.calls.at(-1),'cancel');assert.equal(progress.hidden,true);});
test('settings retain a changed checkbox across busy re-render and send only booleans',async()=>{const h=setup();h.append();await h.initialize();const box=h.field('接收预览版');box.checked=true;await box.listeners.change();assert.equal(h.state.settings.includePrerelease,true);assert.equal(box.checked,true);assert.equal(typeof h.calls.at(-1).settings.includePrerelease,'boolean');});
test('automatic checking and optional downloading never install or close the writer',async()=>{const h=setup({settings:{autoCheck:true,autoDownload:true,includePrerelease:false}});h.append();await h.initialize();assert.deepEqual(h.calls,['check','download']);assert.equal(h.downloaded,1);assert.equal(h.find('保存并重启更新').hidden,false);});
test('installer is gated by a successful save and native manual guide never claims installed',async()=>{const h=setup({installKind:'dmg',phase:'downloaded',downloadedVersion:'0.8.0',candidate:{version:'0.8.0',size:20,notes:'changes'}});h.append();await h.initialize();h.saved=false;await h.find('保存并打开安装器').listeners.click();assert.deepEqual(h.calls,['save']);h.saved=true;await h.find('保存并打开安装器').listeners.click();assert.deepEqual(h.calls,['save','save','install']);assert.ok(h.find('已打开安装器，请按系统提示完成安装。'));assert.equal(h.field('接收预览版').disabled,false);});
test('an already verified download remains installable during a later offline check failure',async()=>{const h=setup({phase:'downloaded',downloadedVersion:'0.8.0',candidate:{version:'0.8.0',size:20}});h.append();await h.initialize();h.notify({...h.state,phase:'error',error:'离线'});assert.equal(h.find('保存并重启更新').hidden,false);assert.equal(h.find('下载更新').hidden,true);});

const downloadedWindows={platform:'win32',installKind:'nsis',phase:'downloaded',downloadedVersion:'0.8.0',candidate:{version:'0.8.0',size:20,notes:'changes'},settings:{autoCheck:false,autoDownload:false,includePrerelease:true}};
const installerFailures=[
  ['network-save-failed','保存尚未完成，请先返回写作保存后重试。','Saving has not completed. Save your writing and try again.'],
  ['network-invalid-installer','安装文件路径不正确，请重新下载更新。','The installer path is invalid. Download the update again.'],
  ['network-installer-missing','找不到 Windows 安装助手，请手动下载安装包。','The Windows update helper was not found. Download the installer manually.'],
  ['network-installer-blocked','系统阻止启动安装助手，请手动下载安装包。','The system blocked the update helper. Download the installer manually.'],
  ['network-installer-start-failed','无法启动安装助手，请重试或手动下载安装包。','Could not start the update helper. Try again or download the installer manually.'],
  ['network-installer-timeout','安装助手未响应，请重试或手动下载安装包。','The update helper did not respond. Try again or download the installer manually.'],
  ['network-installer-failed','无法打开安装器，请手动下载安装包。','Could not open the installer. Download it manually.'],
  ['network-package-missing','已下载的安装包不存在，请重新下载。','The downloaded installer is missing. Download it again.'],
  ['network-storage-permission','无法读取更新文件，请检查目录权限。','Could not read the update files. Check folder permissions.'],
];
const coded=(message,code)=>Object.assign(new Error(message),{code});

test('installer stage failures keep their short code and preferences without claiming installed or closing the app',async()=>{
  for(const [code,message]of installerFailures){
    const h=setup(structuredClone(downloadedWindows));h.context.window.WriterDesktop.networkInstall=async()=>{h.calls.push('install');throw coded(message,code);};h.append();await h.initialize();await h.find('保存并打开安装器').listeners.click();
    assert.ok(h.find(message+' ('+code+')'),code);assert.equal(h.find(message+' ('+code+')').role,'alert');assert.equal(h.find('保存并打开安装器').hidden,false);assert.equal(h.find('保存并打开安装器').disabled,false);assert.equal(h.find('下载更新').hidden,true);assert.equal(h.field('接收预览版').checked,true);assert.equal(h.field('接收预览版').disabled,false);assert.deepEqual(h.calls,['save','install']);assert.ok(!h.find('已打开安装器，请按系统提示完成安装。'));
  }
});

test('all installer stage summaries are localized to English while diagnostic codes remain unchanged',async()=>{
  for(const [code,message,english]of installerFailures){
    const h=setup(structuredClone(downloadedWindows),'en');h.context.window.WriterDesktop.networkInstall=async()=>{throw coded(message,code);};h.append();await h.initialize();await h.find('Save and open installer').listeners.click();assert.ok(h.find(english+' ('+code+')'),code);assert.equal(h.field('Include prereleases').checked,true);assert.ok(!h.find('The installer is open. Follow the system prompts to finish installation.'));
  }
});

test('an intact downloaded package can retry installer startup without downloading again',async()=>{
  const h=setup(structuredClone(downloadedWindows));let attempts=0;h.context.window.WriterDesktop.networkInstall=async()=>{h.calls.push('install');if(!attempts++)throw coded('无法启动安装助手，请重试或手动下载安装包。','network-installer-start-failed');return{installerOpened:true};};h.append();await h.initialize();await h.find('保存并打开安装器').listeners.click();assert.ok(h.find('无法启动安装助手，请重试或手动下载安装包。 (network-installer-start-failed)'));await h.find('保存并打开安装器').listeners.click();assert.deepEqual(h.calls,['save','install','save','install']);assert.equal(h.downloaded,0);assert.ok(h.find('已打开安装器，请按系统提示完成安装。'));assert.equal(h.find('已打开安装器，请按系统提示完成安装。').role,'status');assert.equal(h.field('接收预览版').checked,true);
});

test('a native missing-package event clears installation readiness and exposes download again',async()=>{
  const h=setup(structuredClone(downloadedWindows));h.context.window.WriterDesktop.networkInstall=async()=>{const error=coded('已下载的安装包不存在，请重新下载。','network-package-missing');h.notify({...h.state,phase:'error',downloadedVersion:'',error:error.message,errorCode:error.code});throw error;};h.append();await h.initialize();await h.find('保存并打开安装器').listeners.click();assert.ok(h.find('已下载的安装包不存在，请重新下载。 (network-package-missing)'));assert.equal(h.find('保存并打开安装器').hidden,true);assert.equal(h.find('下载更新').hidden,false);assert.equal(h.find('下载更新').disabled,false);assert.equal(h.field('接收预览版').checked,true);
});

test('unknown failures clear an older diagnostic code and status-only errors retain their own code',async()=>{
  const h=setup({...structuredClone(downloadedWindows),phase:'error',error:'GitHub 暂时无法提供更新，请稍后重试。',errorCode:'network-http'});h.context.window.WriterDesktop.networkInstall=async()=>{throw Error('更新失败，请重试。');};h.append();await h.initialize();assert.ok(h.find('GitHub 暂时无法提供更新，请稍后重试。 (network-http)'));await h.find('保存并打开安装器').listeners.click();assert.ok(h.find('更新失败，请重试。'));assert.ok(!all(h.content).some(node=>node.textContent.includes('network-http')));h.notify({...h.state,phase:'error',error:null,errorCode:'network-installer-timeout'});assert.ok(h.find('更新失败，请重试。 (network-installer-timeout)'));
});

test('initial update-setting failures expose their safe error code without automatic install',async()=>{
  const h=setup();h.context.window.WriterDesktop.networkInfo=async()=>{throw coded('无法读取更新文件，请检查目录权限。','network-storage-permission');};h.append();await h.initialize();assert.ok(h.find('无法读取更新文件，请检查目录权限。 (network-storage-permission)'));assert.equal(h.find('检查更新').disabled,false);assert.deepEqual(h.calls,[]);
});

test('untrusted, malformed and overlong codes are never displayed as diagnostic suffixes',async()=>{
  const h=setup();h.append();await h.initialize();for(const code of ['<img src=x onerror=alert(1)>','network-bad\nprivate-log','C:\\Users\\private','network-'+ 'x'.repeat(80),{},null,'untrusted-sender']){h.notify({...h.state,phase:'error',error:'更新失败，请重试。',errorCode:code});assert.ok(h.find('更新失败，请重试。'));}for(const code of ['ENOENT','EACCES','network-installer-start-failed','update-invalid-installer']){h.notify({...h.state,phase:'error',error:'更新失败，请重试。',errorCode:code});assert.ok(h.find('更新失败，请重试。 ('+code+')'));}
});

test('unexpected stderr and filesystem paths are replaced with a concise summary rather than exposed',async()=>{
  const h=setup();h.append();await h.initialize();for(const message of ['spawn C:\\Users\\private\\PowerShell.exe ENOENT','Cannot read /home/private/update-cache/file','file=/private/cache/package','找不到/private/cache/package','Could not run \\\\server\\private\\helper','command failed\nstderr secret details','x'.repeat(501)]){h.notify({...h.state,phase:'error',error:message,errorCode:'network-installer-start-failed'});assert.ok(h.find('更新失败，请重试。 (network-installer-start-failed)'));assert.ok(!all(h.content).some(node=>node.textContent===message));}
});

test('preference-save errors retain the previous choice and show a safe concise code in the toast',async()=>{
  const h=setup();h.append();await h.initialize();h.context.window.WriterDesktop.networkSettings=async()=>{throw coded('无法读取更新文件，请检查目录权限。','network-storage-permission');};const preference=h.field('接收预览版');preference.checked=true;await preference.listeners.change();assert.equal(preference.checked,false);assert.equal(preference.disabled,false);assert.ok(h.calls.includes('toast:无法读取更新文件，请检查目录权限。 (network-storage-permission)'));assert.equal(h.find('检查更新').disabled,false);
});

test('native cancellation remains a cancellation status instead of being reclassified as installation failure',async()=>{
  const h=setup(structuredClone(downloadedWindows));h.append();await h.initialize();h.context.window.WriterDesktop.networkInstall=async()=>{throw coded('已取消更新下载。','network-cancelled');};await h.find('保存并打开安装器').listeners.click();assert.ok(h.find('已取消更新下载。'));assert.equal(h.find('已取消更新下载。').role,'status');assert.ok(!h.find('已打开安装器，请按系统提示完成安装。'));assert.equal(h.find('保存并打开安装器').hidden,false);
});

test('a cancelled or empty native install result never claims the installer opened and exposes no path API',async()=>{
  const h=setup(structuredClone(downloadedWindows));h.append();await h.initialize();for(const result of [{cancelled:true},{}]){h.context.window.WriterDesktop.networkInstall=async()=>result;await h.find('保存并打开安装器').listeners.click();assert.ok(!h.find('已打开安装器，请按系统提示完成安装。'));assert.ok(h.find('版本 0.8.0 已下载并校验。'));}assert.deepEqual(Object.keys(h.context.window.WriterNetworkUpdates),['initialize','append']);
});


test('checking for network updates is directly reachable without opening a disclosure',async()=>{
  const h=setup(),section=h.append();await h.initialize();const check=h.find('检查更新');assert.ok(check);for(let node=check;node;node=node.parent){assert.equal(node.hidden,false);assert.ok(node.tagName!=='DETAILS'||node.open,'A closed disclosure must not hide the primary update action');}assert.equal(section['aria-label'],'联网更新');assert.equal(check.disabled,false);assert.equal(h.find('下载更新').hidden,true);assert.equal(h.find('保存并重启更新').hidden,true);assert.deepEqual(h.calls,[],'Opening the primary update panel must not download or install');
});
