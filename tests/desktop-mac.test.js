'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..');

test('Mac native chrome, system menu, activation and quit preserve the authenticated save gate',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'writer-mac-contract-'));
  try{
    const app=new EventEmitter(),ipc=new EventEmitter(),menus=[],dialogs=[],kills=[];let win,child,pipeClosed=0,finishService;
    Object.assign(app,{isPackaged:false,getPath:()=>temp,setPath(){},setName(){},getVersion:()=> 'test',requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){const event={preventDefault(){this.prevented=true;}};this.emit('before-quit',event);assert.equal(event.prevented,undefined,'The final explicit quit must not be blocked');assert.notEqual(child?.exitCode,null,'The service must finish before Electron quits');this.quitCalled=true;this.emit('quit');}});
    ipc.handle=(name,callback)=>{ipc[name]=callback;};
    const trusted=()=>({sender:win.webContents,senderFrame:win.webContents.mainFrame});
    class FakeWindow extends EventEmitter{
      constructor(options){super();win=this;this.options=options;this.webContents=new EventEmitter();this.webContents.mainFrame={url:''};this.webContents.setWindowOpenHandler=()=>{};this.webContents.send=(channel,token)=>{if(channel==='writer:before-close')queueMicrotask(()=>ipc.emit('writer:save-result',trusted(),{token,saved:true}));};}
      loadURL(url){this.webContents.mainFrame.url=url;return Promise.resolve();}
      setMenu(){}setMenuBarVisibility(){}show(){this.shown=true;}focus(){this.focused=true;}isMinimized(){return this.minimized;}
      restore(){this.minimized=false;this.restored=true;}isDestroyed(){return this.destroyed===true;}destroy(){this.destroyed=true;this.emit('closed');app.emit('window-all-closed');}
    }
    const session=new EventEmitter();session.setPermissionRequestHandler=()=>{};session.setPermissionCheckHandler=()=>{};session.webRequest={onBeforeRequest(){},onBeforeSendHeaders(){}};
    const electron={app,ipcMain:ipc,BrowserWindow:FakeWindow,Menu:{buildFromTemplate:template=>template,setApplicationMenu:menu=>menus.push(menu)},session:{fromPartition:()=>session},shell:{},dialog:{showMessageBox:async(_win,options)=>{dialogs.push(options);return{response:0};},showErrorBox:()=>assert.fail('Unexpected Mac startup error')}};
    const spawn=()=>{child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;child.kill=signal=>{kills.push(signal);};child.stdin={end(){pipeClosed++;finishService=()=>{child.exitCode=0;child.emit('exit',0);};}};queueMicrotask(()=>child.stdout.emit('data','WRITER_READY {"url":"http://127.0.0.1:38123"}\n'));return child;};
    vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8'),{require:name=>name==='electron'?electron:name==='node:child_process'?{spawn}:name.startsWith('./')?require(path.join(root,'desktop',name)):require(name),__dirname:path.join(root,'desktop'),process:{...process,platform:'darwin',argv:[],env:{...process.env,WRITER_DESK_USER_DATA:temp}},console:{info(){},error(){}},setTimeout,clearTimeout,URL,Buffer});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(win.options.frame,true);assert.equal(win.options.titleBarStyle,'hiddenInset');assert.deepEqual(JSON.parse(JSON.stringify(win.options.trafficLightPosition)),{x:18,y:24});
    assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.contextIsolation,true);assert.equal(win.options.webPreferences.nodeIntegration,false);
    const boot=trusted();ipc.emit('writer:bootstrap',boot);assert.equal(boot.returnValue.platform,'darwin');
    const untrusted={sender:win.webContents,senderFrame:{url:'https://example.org'}};ipc.emit('writer:bootstrap',untrusted);assert.deepEqual(Object.keys(untrusted.returnValue),[]);
    const menu=menus.at(-1),items=menu.flatMap(group=>group.submenu),roles=items.map(item=>item.role);
    for(const role of ['hide','hideOthers','unhide','undo','redo','cut','copy','paste','selectAll','minimize','togglefullscreen','front'])assert.ok(roles.includes(role));
    assert.equal(win.listenerCount('swipe'),0,'OS three/four-finger gestures must remain reserved');
    win.minimized=true;app.emit('activate');assert.equal(win.restored,true);assert.equal(win.shown,true);assert.equal(win.focused,true);
    const quit=items.find(item=>item.accelerator==='Command+Q');quit.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dialogs.length,1);assert.equal(win.destroyed,undefined);assert.equal(pipeClosed,0);assert.equal(app.quitCalled,undefined);
    ipc.emit('writer:save-ready',trusted());quit.click();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(win.destroyed,true);assert.equal(pipeClosed,1);assert.equal(child.exitCode,null);assert.equal(app.quitCalled,undefined,'window-all-closed must wait for the asynchronous service shutdown');
    const pendingQuit={preventDefault(){this.prevented=true;}};app.emit('before-quit',pendingQuit);assert.equal(pendingQuit.prevented,true,'An OS quit must not interrupt pending service shutdown');
    finishService();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.quitCalled,true);assert.equal(pipeClosed,1);assert.deepEqual(kills,[],'A normal exit closes the parent pipe before any forced termination');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('preload exposes only validated platform data from bootstrap',()=>{
  for(const platform of ['darwin','linux','win32','arbitrary',undefined]){
    let bridge;const ipc=new EventEmitter();ipc.sendSync=()=>({platform});
    vm.runInNewContext(fs.readFileSync(path.join(root,'desktop/preload.cjs'),'utf8'),{require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}}})});
    assert.equal(bridge.platform,['darwin','linux','win32'].includes(platform)?platform:'');
    assert.equal(bridge.send,undefined);assert.equal(bridge.navigate,undefined);
  }
});
