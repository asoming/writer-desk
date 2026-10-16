'use strict';

// Execute the production main-process save gate and network-install IPC with
// controlled promises. No Electron window, installer, network or user data is used.
const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const networkUpdater=require('../desktop/network-updater.cjs');
const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
function region(start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,'Production lifecycle region exists: '+start);return source.slice(first,last);}
const installSource=region('async function installNetworkUpdate()','function atomicWrite(');
const saveSource=region("ipcMain.on('writer:save-ready'",'async function stopService()');
const ipcSource=region('for (const [operation, action] of Object.entries({ info:',"ipcMain.handle('writer:network-settings'");
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

function harness(){
  const ipc=new EventEmitter(),handlers=new Map(),timers=new Map(),events=[],saves=[];
  let timerId=0,tokenId=0;
  const h={events,saves,timers,prepareCalls:0,launchCalls:0,cancelCalls:0,destroyCalls:0,quitCalls:0,stopCalls:0,relaunchCalls:[],serviceStopped:false,draft:'原稿',canonical:'原稿'};
  h.prepare=async()=>({mode:'nsis',file:'C:\\cache\\WriterDesk-0.8.6-windows-x64.exe',sha256:'a'.repeat(64)});
  h.helper={helperStarted:true,cancel(){h.cancelCalls++;events.push('cancel-helper');}};
  h.launch=async()=>h.helper;
  h.stop=async()=>{};
  const window={destroyed:false,isDestroyed(){return this.destroyed;},destroy(){h.destroyCalls++;events.push('destroy-window');this.destroyed=true;},webContents:{send(channel,token){assert.equal(channel,'writer:before-close');saves.push(token);events.push('request-save');}}};
  h.window=window;ipc.handle=(name,callback)=>handlers.set(name,callback);
  const context=vm.createContext({
    __window:window,Buffer,URL,process:{platform:'win32',pid:1234},language:'zh',trusted:event=>event?.trusted===true,ipcMain:ipc,
    randomBytes:()=>Buffer.alloc(16,++tokenId),setTimeout(callback,ms){const id=++timerId;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id),
    networkUpdater,networkService:()=>({async prepareInstall(){h.prepareCalls++;events.push('prepare');return h.prepare();}}),
    updateInstaller:{async launch(options){h.launchCalls++;h.launchOptions=options;events.push('launch-helper');return h.launch(options);}},
    async stopService(){h.stopCalls++;events.push('stop-service');await h.stop();h.serviceStopped=true;events.push('service-stopped');},
    app:{quit(){assert.equal(window.destroyed,true,'Window closes before the final quit');assert.equal(h.serviceStopped,true,'Service shutdown completes before the final quit');h.quitCalls++;events.push('quit');},relaunch(options){h.relaunchCalls.push(options);}},
    updater:{planRestart:async()=>({executable:'managed-next',token:'activation-token'}),errorMessage:error=>error?.code||'update-failed'},updateOptions:()=>({currentVersion:'0.8.5'}),
    shell:{openPath:async()=>''},dialog:{showMessageBox:async()=>({response:0})},text:zh=>zh,title:()=> '作家工作台',
  });
  vm.runInContext('let window=__window,closeRequest=null,saveReady=true,updateBusy=false,closing=false,allowQuit=false;'+installSource+saveSource+ipcSource,context,{filename:'desktop/main.cjs lifecycle'});
  h.run=code=>vm.runInContext(code,context);h.context=context;
  h.invokeAs=(event,...args)=>handlers.get('writer:network-install')(event,...args);
  h.invoke=(...args)=>h.invokeAs({trusted:true},...args);
  h.ack=(token,saved=true,trusted=true)=>{if(saved&&trusted&&h.run('closeRequest?.token')===token){h.canonical=h.draft;events.push('saved:'+h.canonical);}ipc.emit('writer:save-result',{trusted},{token,saved});};
  h.ackLatest=(saved=true)=>h.ack(saves.at(-1),saved);
  h.tick=()=>new Promise(resolve=>setImmediate(resolve));
  h.flags=()=>h.run('({updateBusy,closing,allowQuit,token:closeRequest?.token})');
  h.timeout=()=>{const active=[...timers.values()].find(timer=>timer.ms===15000);assert.ok(active,'A save timeout is pending');active.callback();};
  return h;
}

function assertKeptApp(h){assert.equal(h.destroyCalls,0);assert.equal(h.quitCalls,0);assert.equal(h.stopCalls,0);assert.equal(h.flags().allowQuit,false);assert.equal(h.flags().updateBusy,false);}

test('network install IPC rejects unauthorized callers and renderer arguments before save or preparation',async()=>{
  const h=harness();
  const untrusted=await h.invokeAs({trusted:false});assert.equal(untrusted.code,'network-invalid-request');
  const response=await h.invoke('C:\\renderer-selected.exe');assert.equal(response.code,'network-invalid-request');assert.equal(h.saves.length,0);assert.equal(h.prepareCalls,0);
  assertKeptApp(h);
});

test('one install locks before the first save and through verification, helper readiness, final save and service shutdown',async()=>{
  const h=harness(),verify=deferred(),helper=deferred(),stopped=deferred();h.prepare=()=>verify.promise;h.launch=()=>helper.promise;h.stop=()=>stopped.promise;
  const installing=h.invoke();assert.equal(h.flags().updateBusy,true);assert.equal(h.saves.length,1);
  const duplicate=await h.invoke();assert.equal(duplicate.code,'network-busy');assert.equal(h.saves.length,1,'A second install cannot overwrite the save token');
  await h.run('requestClose()');assert.equal(h.saves.length,1);assert.equal(h.quitCalls,0);
  h.ackLatest();await h.tick();assert.equal(h.prepareCalls,1);await h.run('requestClose()');assert.equal(h.saves.length,1);
  verify.resolve({mode:'nsis',file:'C:\\cache\\WriterDesk-0.8.6-windows-x64.exe',sha256:'a'.repeat(64)});await h.tick();assert.equal(h.launchCalls,1);assert.equal(h.flags().updateBusy,true);await h.run('requestClose()');assert.equal(h.saves.length,1);assert.equal(h.destroyCalls,0);
  helper.resolve(h.helper);await h.tick();assert.equal(h.saves.length,2);assert.equal(h.flags().updateBusy,true);await h.run('requestClose()');assert.equal(h.saves.length,2);assert.equal(h.quitCalls,0);
  h.ackLatest();await h.tick();assert.equal(h.destroyCalls,1);assert.equal(h.stopCalls,1);assert.equal(h.quitCalls,0);assert.equal(h.flags().updateBusy,true,'The install remains locked while the service is exiting');
  await h.run('requestClose()');assert.equal(h.stopCalls,1);stopped.resolve();const result=await installing;
  assert.equal(result.installerOpened,true);assert.equal(result.cancel,undefined,'The local helper handle is never returned over IPC');assert.equal(h.quitCalls,1);assert.equal(h.cancelCalls,0);assert.ok(h.events.indexOf('service-stopped')<h.events.indexOf('quit'));
  assert.equal(h.launchOptions.pid,1234);assert.equal(h.launchOptions.sha256,'a'.repeat(64));
});

test('changes made during package verification are saved again after helper readiness and before the window is destroyed',async()=>{
  const h=harness(),verify=deferred();h.prepare=()=>verify.promise;
  const installing=h.invoke();h.ackLatest();await h.tick();h.draft='校验期间刚输入的正文';
  verify.resolve({mode:'nsis',file:'C:\\cache\\WriterDesk-0.8.6-windows-x64.exe',sha256:'b'.repeat(64)});await h.tick();
  assert.equal(h.canonical,'原稿');assert.equal(h.saves.length,2);assert.equal(h.destroyCalls,0);h.ackLatest();const result=await installing;
  assert.equal(result.installerOpened,true);assert.equal(h.canonical,'校验期间刚输入的正文');assert.ok(h.events.indexOf('saved:校验期间刚输入的正文')<h.events.indexOf('destroy-window'));
});

test('a failed final save cancels the waiting helper, retains the app and draft, and permits a later explicit retry',async()=>{
  const h=harness();const first=h.invoke();h.ackLatest();await h.tick();assert.equal(h.saves.length,2);h.draft='尚未保存的新内容';h.ackLatest(false);
  const failed=await first;assert.equal(failed.code,'network-save-failed');assert.equal(h.cancelCalls,1);assert.equal(h.canonical,'原稿');assert.equal(h.draft,'尚未保存的新内容');assertKeptApp(h);
  h.helper={helperStarted:true,cancel(){h.cancelCalls++;}};const retry=h.invoke();assert.equal(h.saves.length,3);h.ackLatest();await h.tick();assert.equal(h.saves.length,4);h.ackLatest();assert.equal((await retry).installerOpened,true);assert.equal(h.cancelCalls,1);assert.equal(h.quitCalls,1);assert.equal(h.canonical,'尚未保存的新内容');
});

test('a timed-out final save cancels its helper without consuming a late success acknowledgement',async()=>{
  const h=harness(),installing=h.invoke();h.ackLatest();await h.tick();assert.equal(h.saves.length,2);const finalToken=h.saves.at(-1);h.timeout();const result=await installing;
  assert.equal(result.code,'network-save-failed');assert.equal(h.cancelCalls,1);assertKeptApp(h);h.ack(finalToken);await h.tick();assertKeptApp(h);assert.equal(h.cancelCalls,1);
});

test('an initial failed or timed-out save never verifies or launches the installer and releases the lock',async()=>{
  for(const failure of ['rejected','timeout']){
    const h=harness(),installing=h.invoke();if(failure==='timeout')h.timeout();else h.ackLatest(false);
    const result=await installing;assert.equal(result.code,'network-save-failed');assert.equal(h.prepareCalls,0);assert.equal(h.launchCalls,0);assert.equal(h.cancelCalls,0);assertKeptApp(h);
  }
});

test('verification and helper-start failures preserve the window and unlock without pretending an installer opened',async()=>{
  for(const phase of ['verify','helper']){
    const h=harness(),code=phase==='verify'?'network-hash-mismatch':'network-installer-blocked';
    if(phase==='verify')h.prepare=async()=>{throw Object.assign(Error(code),{code});};else h.launch=async()=>{throw Object.assign(Error(code),{code});};
    const installing=h.invoke();h.ackLatest();const result=await installing;assert.equal(result.code,code);assert.ok(result.error);assert.notEqual(result.installerOpened,true);assert.equal(h.saves.length,1);assert.equal(h.cancelCalls,0);assert.equal(h.launchCalls,phase==='verify'?0:1);assertKeptApp(h);
  }
});

test('simultaneous save callers share a single authenticated token and cannot be resolved by stale or untrusted acknowledgements',async()=>{
  const h=harness(),first=h.run('waitForSave()'),second=h.run('waitForSave()');assert.equal(first,second);assert.equal(h.saves.length,1);assert.equal(h.timers.size,1);let settled=false;first.then(()=>{settled=true;});
  h.ack('unrelated-token');h.ack(h.saves[0],true,false);await h.tick();assert.equal(settled,false);assert.equal(h.flags().token,h.saves[0]);
  h.ackLatest();assert.equal(await first,true);assert.equal(await second,true);assert.equal(h.timers.size,0);assert.equal(h.flags().token,undefined);
});

test('a completed save timeout and old acknowledgement cannot erase or resolve the next save request',async()=>{
  const h=harness(),first=h.run('waitForSave()'),oldToken=h.saves[0],oldTimeout=[...h.timers.values()][0].callback;
  h.ack(oldToken);assert.equal(await first,true);const second=h.run('waitForSave()'),newToken=h.saves[1];assert.notEqual(oldToken,newToken);
  oldTimeout();h.ack(oldToken);await h.tick();assert.equal(h.flags().token,newToken);assert.equal(h.timers.size,1);
  h.ack(newToken);assert.equal(await second,true);assert.equal(h.flags().token,undefined);assert.equal(h.timers.size,0);
});

test('managed Linux installation hands off to the existing restart lock without reporting a self-induced busy failure',async()=>{
  const h=harness();h.context.process.platform='linux';h.prepare=async()=>({mode:'managed',version:'0.8.6'});
  const installing=h.invoke();h.ackLatest();await h.tick();assert.equal(h.saves.length,2);assert.equal(h.flags().updateBusy,true);assert.equal(h.flags().closing,true);h.ackLatest();const result=await installing;
  assert.equal(result.restarting,true);assert.equal(h.launchCalls,0);assert.equal(h.relaunchCalls.length,1);assert.equal(h.relaunchCalls[0].execPath,'managed-next');assert.equal(h.quitCalls,1);
});
