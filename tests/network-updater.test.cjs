'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{createHash}=require('node:crypto'),{test}=require('node:test');
const {createNetworkUpdater,selectRelease,artifactName,sidecarName,checkedURL,checksumValue}=require('../desktop/network-updater.cjs');
const API='https://api.github.com/repos/asoming/writer-desk/releases?per_page=100',FEED='https://asoming.github.io/writer-desk/updates.json',BASE='https://github.com/asoming/writer-desk/releases/download/';
function release(version='0.8.0',platform='linux',arch='x64',kind='managed',body=Buffer.from('verified archive')){
  const name=artifactName(version,platform,arch,kind),sum=sidecarName(name),digest=createHash('sha256').update(body).digest('hex'),checksum=Buffer.from(digest+'  '+name+'\n');
  return{metadata:{tag_name:'v'+version,prerelease:false,draft:false,body:'新版本说明 <script>not HTML</script>',published_at:'2026-10-15T00:00:00Z',assets:[{name,size:body.length,state:'uploaded',browser_download_url:BASE+'v'+version+'/'+name},{name:sum,size:checksum.length,state:'uploaded',browser_download_url:BASE+'v'+version+'/'+sum}]},name,sum,digest,checksum,body};
}
function mockHTTPS(routes,calls=[]){return{get(url,options,callback){calls.push({url,options});const request=new EventEmitter();let response,timeout;request.setTimeout=(_milliseconds,handler)=>{timeout=handler;};request.destroy=error=>{request.emit('error',error||Error('destroyed'));response?.destroy(error);};setImmediate(()=>{const route=routes[url];if(!route){request.emit('error',Error('unexpected URL '+url));return;}if(route.error){request.emit('error',route.error);return;}if(route.timeout){timeout();return;}response=new PassThrough();response.statusCode=route.status||200;response.headers=route.headers||{};request.emit('response',response);callback(response);if(route.stall)return;const chunks=route.chunks||[route.body||Buffer.alloc(0)];let index=0;const write=()=>{if(response.destroyed)return;if(index===chunks.length){route.streamError?response.destroy(route.streamError):response.end();return;}response.write(chunks[index++]);setImmediate(write);};write();});return request;}};}
// macOS os.tmpdir() can contain /var -> /private/var; fixtures use its canonical
// directory so the updater's deliberate rejection of symlinked caches stays intact.
function setup(options={}){const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'writer-network-test-'))),item=release(options.version||'0.8.0',options.platform||'linux',options.arch||'x64',options.installKind||'managed'),routes={[API]:{body:Buffer.from(JSON.stringify([item.metadata]))},[BASE+'v'+item.metadata.tag_name.slice(1)+'/'+item.sum]:{body:item.checksum},[BASE+item.metadata.tag_name+'/'+item.name]:{body:item.body}},calls=[],staged=[];const updater=createNetworkUpdater({cacheDir:directory,currentVersion:'0.7.0',platform:'linux',arch:'x64',installKind:'managed',https:mockHTTPS(routes,calls),updater:{stageArchive:async(file,options)=>{staged.push({file,options});return{pendingVersion:'0.8.0',checksumVerified:true,restartRequired:true};}},...options});return{directory,item,routes,calls,staged,updater,close:()=>fs.rmSync(directory,{recursive:true,force:true})};}

test('release selection requires exact platform, sidecar, uploaded size and newer version; previews are opt in',()=>{
  const item=release(),base={currentVersion:'0.7.0',platform:'linux',arch:'x64',installKind:'managed'};assert.equal(selectRelease([item.metadata],base).version,'0.8.0');assert.equal(selectRelease([item.metadata],{...base,currentVersion:'0.8.0'}),null);assert.equal(selectRelease([item.metadata],{...base,platform:'darwin',arch:'arm64',installKind:'dmg'}),null);
  for(const bad of [{...item.metadata,draft:true},{...item.metadata,prerelease:true},{...item.metadata,assets:[item.metadata.assets[0]]},{...item.metadata,assets:[...item.metadata.assets,item.metadata.assets[0]]},{...item.metadata,assets:item.metadata.assets.map(asset=>({...asset,browser_download_url:'https://evil.test/'+asset.name}))}])assert.equal(selectRelease([bad],base),null);
  assert.equal(selectRelease([{...item.metadata,prerelease:true}],{...base,includePrerelease:true}).version,'0.8.0');assert.throws(()=>artifactName('0.8.0','darwin','x64','nsis'));assert.throws(()=>artifactName('../x','linux','x64','managed'));
});
test('TLS URLs use only fixed GitHub hosts and checksums bind the exact safe filename',()=>{
  for(const url of ['http://github.com/a','https://github.com.evil.test/a','https://user:secret@github.com/a','https://localhost/a','https://github.com:123/a','https://api.github.com/a#hash'])assert.throws(()=>checkedURL(url));
  checkedURL('https://release-assets.githubusercontent.com/github-production-release-asset/file?token=signed');checkedURL(API,true);assert.throws(()=>checkedURL('https://github.com/a',true));const item=release();assert.equal(checksumValue(item.checksum,item.name),item.digest);assert.throws(()=>checksumValue(item.checksum,'other.tar.gz'));assert.throws(()=>checksumValue(Buffer.from(item.checksum+'\nextra'),'x'));
});
test('download verifies every byte, stores a private receipt, re-verifies before managed staging, and hides paths from renderer',async()=>{
  const h=setup();try{const progress=[];h.updater.subscribe(state=>progress.push(state));assert.equal((await h.updater.check()).phase,'available');const state=await h.updater.download();assert.equal(state.phase,'downloaded');assert.equal(h.calls.length,3);assert.ok(progress.some(state=>state.received>0));assert.ok(!JSON.stringify(state).includes(h.directory));assert.ok(!JSON.stringify(state).includes('https:'));const receipt=JSON.parse(fs.readFileSync(path.join(h.directory,'download.json')));assert.equal(receipt.sha256,h.item.digest);const result=await h.updater.prepareInstall();assert.equal(result.mode,'managed');assert.equal(h.staged.length,1);assert.equal(h.staged[0].options.currentVersion,'0.7.0');assert.equal(h.staged[0].options.arch,'x64');assert.equal(fs.readFileSync(h.staged[0].file).toString(),h.item.body.toString());}finally{h.close();}
});
test('tampered or missing sidecars and mutated receipts/files can never reach installation',async()=>{
  const h=setup();try{await h.updater.check();h.routes[BASE+'v0.8.0/'+h.item.name].body=Buffer.from('modified archive');await assert.rejects(h.updater.download(),error=>error.code==='network-hash-mismatch');assert.equal(h.staged.length,0);assert.ok(!fs.existsSync(path.join(h.directory,'download.json')));h.routes[BASE+'v0.8.0/'+h.item.name].body=h.item.body;await h.updater.download();fs.writeFileSync(path.join(h.directory,'0.8.0',h.item.name),'tampered');await assert.rejects(h.updater.prepareInstall(),error=>error.code==='network-hash-mismatch');assert.equal(h.staged.length,0);}finally{h.close();}
});
test('redirects to unknown hosts, downgrade after download, and oversized bodies are rejected',async()=>{
  let installed='0.7.0';const h=setup({getInstalledVersion:()=>installed});try{await h.updater.check();h.routes[BASE+'v0.8.0/'+h.item.name]={status:302,headers:{location:'https://evil.test/payload'}};await assert.rejects(h.updater.download(),error=>error.code==='network-unsafe-url');h.routes[BASE+'v0.8.0/'+h.item.name]={body:Buffer.alloc(h.item.body.length+1)};await assert.rejects(h.updater.download(),error=>error.code==='network-too-large');h.routes[BASE+'v0.8.0/'+h.item.name]={body:h.item.body};await h.updater.download();installed='0.9.0';await assert.rejects(h.updater.prepareInstall(),error=>error.code==='network-downgrade');assert.equal(h.staged.length,0);}finally{h.close();}
});
test('cancellation closes the active response, removes partial files and cannot stage a canceled download',async()=>{
  const h=setup();try{await h.updater.check();h.routes[BASE+'v0.8.0/'+h.item.name]={chunks:[h.item.body.subarray(0,3),h.item.body.subarray(3)]};h.updater.subscribe(state=>{if(state.phase==='downloading'&&state.received>0)h.updater.cancel();});await assert.rejects(h.updater.download(),error=>error.code==='network-cancelled');assert.equal((await h.updater.info()).phase,'cancelled');assert.deepEqual(fs.readdirSync(path.join(h.directory,'0.8.0')),[]);await assert.rejects(h.updater.prepareInstall(),error=>error.code==='network-no-update');assert.equal(h.staged.length,0);}finally{h.close();}
});
test('settings persist partial changes and a verified receipt survives restart without new network requests',async()=>{
  const h=setup();try{await h.updater.setSettings({includePrerelease:true});await h.updater.setSettings({autoDownload:true});assert.equal((await h.updater.info()).settings.includePrerelease,true);await assert.rejects(h.updater.setSettings({url:'https://evil.test'}));await h.updater.check();await h.updater.download();const calls=[];const next=createNetworkUpdater({cacheDir:h.directory,currentVersion:'0.7.0',platform:'linux',arch:'x64',installKind:'managed',https:mockHTTPS({},calls)});assert.equal((await next.info()).phase,'downloaded');assert.equal(calls.length,0);assert.equal((await next.info()).settings.autoDownload,true);assert.equal((await next.info()).settings.includePrerelease,true);}finally{h.close();}
});
test('Windows, macOS and DEB return only independently reverified installer paths to privileged main process',async()=>{
  for(const [platform,arch,installKind]of [['win32','x64','nsis'],['darwin','arm64','dmg'],['darwin','x64','dmg'],['linux','x64','deb']]){const h=setup({platform,arch,installKind});try{await h.updater.check();await h.updater.download();const result=await h.updater.prepareInstall();assert.equal(result.mode,installKind);assert.equal(result.sha256,h.item.digest);assert.equal(path.dirname(result.file),path.join(h.directory,'0.8.0'));assert.equal(h.staged.length,0);}finally{h.close();}}
});
test('unsafe cache symlinks and invalid local receipts are refused without following links',async()=>{
  const h=setup();try{const other=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'writer-network-other-')));try{fs.symlinkSync(other,path.join(h.directory,'0.8.0'),process.platform==='win32'?'junction':'dir');await h.updater.check();await assert.rejects(h.updater.download(),error=>error.code==='network-unsafe-cache');assert.deepEqual(fs.readdirSync(other),[]);}finally{fs.rmSync(other,{recursive:true,force:true});}}finally{h.close();}
});

test('anonymous REST rate limits, service failures, offline errors and timeouts use only the fixed public feed',async()=>{
  for(const route of [{status:403,headers:{'x-ratelimit-remaining':'0'}},{status:403},{status:429},{status:500},{status:503},{error:Error('offline')},{timeout:true},{chunks:[Buffer.from('[')],streamError:Error('connection interrupted')}]){
    const h=setup({currentVersion:'0.8.0',version:'0.8.1'});
    try{
      h.routes[API]=route;h.routes[FEED]={body:Buffer.from(JSON.stringify([h.item.metadata]))};
      const state=await h.updater.check();assert.equal(state.phase,'available');assert.equal(state.candidate.version,'0.8.1');
      assert.deepEqual(h.calls.map(call=>call.url),[API,FEED]);assert.ok(h.calls.every(call=>!Object.keys(call.options.headers).some(key=>key.toLowerCase()==='authorization')));
      assert.equal(h.calls[1].options.headers.Accept,'application/json');assert.ok(!JSON.stringify(state).includes('https:'));
    }finally{h.close();}
  }
});

test('successful primary metadata does not make a second request and installed 0.8.0 never offers itself',async()=>{
  const h=setup({currentVersion:'0.8.0'});
  try{
    h.routes[FEED]={body:Buffer.from(JSON.stringify([release('0.8.1').metadata]))};
    const state=await h.updater.check();assert.equal(state.phase,'idle');assert.equal(state.upToDate,true);assert.equal(state.candidate,null);
    assert.deepEqual(h.calls.map(call=>call.url),[API]);
  }finally{h.close();}
});

test('fallback respects published stable versus opt-in preview releases without inventing an update',async()=>{
  const h=setup({currentVersion:'0.8.0',version:'0.8.1'});
  try{
    h.routes[API]={status:429};h.routes[FEED]={body:Buffer.from(JSON.stringify([release('0.8.0').metadata,{...h.item.metadata,prerelease:true}]))};
    let state=await h.updater.check();assert.equal(state.upToDate,true);assert.equal(state.candidate,null);
    await h.updater.setSettings({includePrerelease:true});state=await h.updater.check();assert.equal(state.phase,'available');assert.equal(state.candidate.version,'0.8.1');assert.equal(state.candidate.prerelease,true);
    h.routes[FEED]={body:Buffer.from(JSON.stringify([{...h.item.metadata,draft:true}]))};state=await h.updater.check();assert.equal(state.upToDate,true);assert.equal(state.candidate,null);
  }finally{h.close();}
});

test('public metadata redirects cannot escape the exact HTTPS Pages path or widen installer hosts',async()=>{
  checkedURL(FEED,'pages');assert.throws(()=>checkedURL(FEED));assert.throws(()=>checkedURL(FEED,true));
  for(const url of ['http://asoming.github.io/writer-desk/updates.json',FEED+'?other=1',FEED+'#data','https://asoming.github.io/updates.json','https://asoming.github.io/writer-desk/other.json','https://other.github.io/writer-desk/updates.json',API]){
    assert.throws(()=>checkedURL(url,'pages'));
    const h=setup();try{h.routes[API]={status:403};h.routes[FEED]={status:302,headers:{location:url}};await assert.rejects(h.updater.check(),error=>error.code==='network-unsafe-url');assert.deepEqual(h.calls.map(call=>call.url),[API,FEED]);}finally{h.close();}
  }
});

test('malformed, oversized or unsafe primary metadata never gets hidden by fallback',async()=>{
  for(const [route,code]of [[{body:Buffer.from('{')},'network-invalid-release'],[{body:Buffer.from('{}')},'network-invalid-release'],[{body:Buffer.alloc(2*1024**2+1)},'network-too-large'],[{status:404},'network-http'],[{status:302,headers:{location:'https://evil.test/update.json'}},'network-unsafe-url']]){
    const h=setup();try{h.routes[API]=route;h.routes[FEED]={body:Buffer.from(JSON.stringify([h.item.metadata]))};await assert.rejects(h.updater.check(),error=>error.code===code);assert.deepEqual(h.calls.map(call=>call.url),[API]);assert.equal((await h.updater.info()).candidate,null);}finally{h.close();}
  }
});

test('invalid fallback metadata is bounded and can never authorize a package',async()=>{
  for(const [route,code]of [[{body:Buffer.from('{')},'network-invalid-release'],[{body:Buffer.from('{}')},'network-invalid-release'],[{body:Buffer.from([0xff])},'network-invalid-release'],[{body:Buffer.from(JSON.stringify(Array(101).fill(null)))},'network-invalid-release'],[{body:Buffer.alloc(2*1024**2+1)},'network-too-large'],[{status:503},'network-http'],[{chunks:[Buffer.from('[')],streamError:Error('connection interrupted')},'network-connection']]){
    const h=setup();try{h.routes[API]={status:429};h.routes[FEED]=route;await assert.rejects(h.updater.check(),error=>error.code===code);assert.equal((await h.updater.info()).candidate,null);await assert.rejects(h.updater.download(),error=>error.code==='network-no-update');assert.equal(h.staged.length,0);}finally{h.close();}
  }
});

test('fallback rejects foreign packages, duplicate assets, missing checksums and invalid size or platform',async()=>{
  const good=release('0.8.1').metadata;
  for(const metadata of [{...good,assets:[good.assets[0]]},{...good,assets:[...good.assets,good.assets[0]]},{...good,assets:good.assets.map(asset=>({...asset,browser_download_url:'https://evil.test/'+asset.name}))},{...good,assets:good.assets.map(asset=>({...asset,size:0}))},release('0.8.1','darwin','arm64','dmg').metadata]){
    const h=setup({currentVersion:'0.8.0'});try{h.routes[API]={status:403};h.routes[FEED]={body:Buffer.from(JSON.stringify([metadata]))};const state=await h.updater.check();assert.equal(state.upToDate,true);assert.equal(state.candidate,null);await assert.rejects(h.updater.download(),error=>error.code==='network-no-update');assert.equal(h.staged.length,0);}finally{h.close();}
  }
});

test('cancellation during primary or fallback metadata never starts another source or installs',async()=>{
  for(const source of [API,FEED]){
    const h=setup();try{
      h.routes[API]=source===API?{stall:true}:{status:403};h.routes[FEED]={stall:true};
      const request=h.updater.check();for(let tick=0;tick<20&&!h.calls.some(call=>call.url===source);tick++)await new Promise(resolve=>setImmediate(resolve));
      assert.ok(h.calls.some(call=>call.url===source));h.updater.cancel();await assert.rejects(request,error=>error.code==='network-cancelled');
      assert.deepEqual(h.calls.map(call=>call.url),source===API?[API]:[API,FEED]);assert.equal((await h.updater.info()).phase,'cancelled');assert.equal(h.staged.length,0);
    }finally{h.close();}
  }
});

test('fallback packages retain mandatory sidecar, byte checksum, receipt and no-downgrade gates on every platform',async()=>{
  for(const [platform,arch,installKind]of [['linux','x64','managed'],['linux','x64','deb'],['win32','x64','nsis'],['darwin','arm64','dmg'],['darwin','x64','dmg']]){
    let installed='0.8.0';const h=setup({currentVersion:'0.8.0',version:'0.8.1',platform,arch,installKind,getInstalledVersion:()=>installed});
    try{
      h.routes[API]={status:429};h.routes[FEED]={body:Buffer.from(JSON.stringify([h.item.metadata]))};await h.updater.check();
      const assetURL=BASE+'v0.8.1/'+h.item.name;h.routes[assetURL]={body:Buffer.from('modified archive')};await assert.rejects(h.updater.download(),error=>error.code==='network-hash-mismatch');assert.equal(h.staged.length,0);
      h.routes[assetURL]={body:h.item.body};await h.updater.download();const result=await h.updater.prepareInstall();assert.equal(result.version,'0.8.1');assert.equal(result.mode,installKind);
      installed='0.8.2';await assert.rejects(h.updater.prepareInstall(),error=>error.code==='network-downgrade');
      assert.equal(h.calls.filter(call=>call.url===BASE+'v0.8.1/'+h.item.sum).length,2);assert.ok(h.calls.every(call=>call.url===API||call.url===FEED||call.url.startsWith(BASE+'v0.8.1/')));
    }finally{h.close();}
  }
});
