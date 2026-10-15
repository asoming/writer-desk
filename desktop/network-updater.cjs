'use strict';
// Only fixed repository releases are eligible. Renderer input cannot name a URL,
// file, executable, version or destination. Verification never executes a file.
const nodeFS = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {createHash, randomBytes} = require('node:crypto');
const {TextDecoder} = require('node:util');
const API = 'https://api.github.com/repos/asoming/writer-desk/releases?per_page=100';
const RELEASE_ROOT = 'https://github.com/asoming/writer-desk/releases/download/';
const ASSET_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_ASSET = 512 * 1024 ** 2, MAX_METADATA = 2 * 1024 ** 2, MAX_CHECKSUM = 1024;
const DEFAULT_SETTINGS = Object.freeze({autoCheck:true, autoDownload:false, includePrerelease:false});
const clone = value => JSON.parse(JSON.stringify(value));
function fail(code){throw Object.assign(new Error(code),{code});}
function versionParts(value){if(typeof value!=='string'||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))fail('network-invalid-release');return value.split('.').map(Number);}
function compareVersions(a,b){const left=versionParts(a),right=versionParts(b);for(let i=0;i<3;i++)if(left[i]!==right[i])return Math.sign(left[i]-right[i]);return 0;}
function artifactName(version,platform,arch,kind){
  versionParts(version);
  if(platform==='linux'&&arch==='x64'&&kind==='managed')return `WriterDesk-${version}-linux-x64.tar.gz`;
  if(platform==='linux'&&arch==='x64'&&kind==='deb')return `WriterDesk-${version}-linux-amd64.deb`;
  if(platform==='win32'&&arch==='x64'&&kind==='nsis')return `WriterDesk-${version}-windows-x64.exe`;
  if(platform==='darwin'&&['x64','arm64'].includes(arch)&&kind==='dmg')return `WriterDesk-${version}-mac-${arch}.dmg`;
  fail('network-unsupported');
}
const sidecarName = name => name.endsWith('.tar.gz')?name.slice(0,-7)+'.sha256':name+'.sha256';
function checkedURL(value,metadata=false){
  let parsed;try{parsed=new URL(value);}catch{fail('network-unsafe-url');}
  if(value.length>16384||parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.port&&parsed.port!=='443'||!(metadata?parsed.hostname==='api.github.com':ASSET_HOSTS.has(parsed.hostname)))fail('network-unsafe-url');
  return parsed;
}
function selectRelease(releases,{currentVersion,platform,arch,installKind,includePrerelease=false}){
  if(!Array.isArray(releases)||releases.length>100)fail('network-invalid-release');
  const found=[];
  for(const release of releases){
    if(!release||typeof release!=='object'||typeof release.draft!=='boolean'||typeof release.prerelease!=='boolean'||release.draft===true||release.prerelease===true&&!includePrerelease||typeof release.tag_name!=='string'||!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release.tag_name))continue;
    const version=release.tag_name.slice(1);if(compareVersions(version,currentVersion)<=0)continue;
    const filename=artifactName(version,platform,arch,installKind),checksum=sidecarName(filename);
    if(!Array.isArray(release.assets)||release.assets.length>1000)continue;
    const assets=release.assets.filter(item=>item?.name===filename),checksums=release.assets.filter(item=>item?.name===checksum);
    if(assets.length!==1||checksums.length!==1)continue;
    const asset=assets[0],sum=checksums[0],base=RELEASE_ROOT+release.tag_name+'/';
    const valid=(item,name,limit)=>Number.isSafeInteger(item.size)&&item.size>0&&item.size<=limit&&item.state==='uploaded'&&item.browser_download_url===base+name;
    if(!valid(asset,filename,MAX_ASSET)||!valid(sum,checksum,MAX_CHECKSUM))continue;
    found.push({version,tag:release.tag_name,filename,checksumName:checksum,size:asset.size,checksumSize:sum.size,
      prerelease:release.prerelease===true,notes:typeof release.body==='string'?release.body.slice(0,50000):'',publishedAt:typeof release.published_at==='string'?release.published_at:''});
  }
  found.sort((a,b)=>compareVersions(b.version,a.version));return found[0]||null;
}
function checksumValue(raw,filename){
  let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(raw).trim();}catch{fail('network-invalid-checksum');}const match=value.match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/);
  if(!match||match[2]!==filename)fail('network-invalid-checksum');return match[1].toLowerCase();
}
function safeDirectory(fs,directory){
  const resolved=path.resolve(directory);let current=path.parse(resolved).root;
  for(const part of resolved.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);try{fs.mkdirSync(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('network-unsafe-cache');
  }
  return resolved;
}
function atomicJSON(fs,file,value){
  const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
}
function readJSON(fs,file){
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)fail('network-invalid-receipt');return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function safeFile(fs,file,limit){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>limit)fail('network-invalid-receipt');return stat;}
async function hashFile(fs,file){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');}
function settingsChecked(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_SETTINGS,key)||typeof value[key]!=='boolean'))fail('network-invalid-settings');return{...DEFAULT_SETTINGS,...value};}
function errorMessage(error,language='zh'){
  const errors={
    'network-unsupported':['此系统或安装方式暂不支持联网更新。','Network updates are unavailable for this platform or installation.'],
    'network-busy':['更新操作正在进行。','An update operation is already in progress.'],
    'network-cancelled':['已取消更新下载。','Update download canceled.'],
    'network-connection':['连接 GitHub 失败，请稍后重试。','Could not connect to GitHub. Try again later.'],
    'network-timeout':['更新检查或下载超时，请稍后重试。','The update request timed out. Try again later.'],
    'network-http':['GitHub 暂时无法提供更新，请稍后重试。','GitHub could not provide the update. Try again later.'],
    'network-unsafe-url':['更新地址验证失败，已停止下载。','Update URL verification failed. Download stopped.'],
    'network-invalid-release':['发行信息格式无效，已停止更新。','Invalid release metadata. Update stopped.'],
    'network-too-large':['更新文件超过大小限制，已停止下载。','The update exceeds the size limit. Download stopped.'],
    'network-invalid-checksum':['升级包校验文件不正确，未安装。','Invalid package checksum file. Nothing was installed.'],
    'network-hash-mismatch':['升级包校验失败，请重新下载。未安装此文件。','Package verification failed. Download it again. Nothing was installed.'],
    'network-invalid-receipt':['下载记录或文件已改变，请重新下载。','The download receipt or package changed. Download it again.'],
    'network-unsafe-cache':['更新缓存目录包含异常链接，已停止操作。','The update cache contains an unexpected link. Operation stopped.'],
    'network-no-update':['请先检查并下载新版本。','Check for and download an update first.'],
    'network-downgrade':['此版本不高于当前安装版本，已取消更新。','This release is not newer than the installed version. Update canceled.'],
    'network-invalid-settings':['更新设置不正确。','Invalid update settings.']
  };
  return(errors[error?.code]||['无法完成更新，请检查网络、磁盘空间和目录权限。','Could not finish the update. Check the network, disk space and folder permissions.'])[language==='en'?1:0];
}
function createNetworkUpdater(options){
  if(!options||typeof options.cacheDir!=='string'||!options.cacheDir)throw new TypeError('A private update cache is required.');
  const fs=options.fs||nodeFS,transport=options.https||https,cache=path.resolve(options.cacheDir),listeners=new Set();
  const platform=options.platform||process.platform,arch=options.arch||process.arch,installKind=options.installKind,currentVersion=options.currentVersion;
  versionParts(currentVersion);artifactName(currentVersion,platform,arch,installKind);
  let settings={...DEFAULT_SETTINGS},state={phase:'idle',currentVersion,platform,arch,installKind,settings},controller=null,busy=false,loaded=false,loadPromise=null,receipt=null,candidate=null;
  const publicState=()=>clone({...state,settings,downloadedVersion:receipt?.version||'',candidate:candidate?{version:candidate.version,prerelease:candidate.prerelease,notes:candidate.notes||'',publishedAt:candidate.publishedAt||'',size:candidate.size}:null});
  function notify(patch){state={...state,...patch};for(const callback of listeners){try{callback(publicState());}catch{}}}
  function minimumVersion(){const installed=options.getInstalledVersion?.();return typeof installed==='string'&&/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(installed)&&compareVersions(installed,currentVersion)>0?installed:currentVersion;}
  function location(value){const name=artifactName(value.version,platform,arch,installKind);if(value.filename!==name)fail('network-invalid-receipt');return path.join(cache,value.version,name);}
  async function verifyReceipt(value){
    if(!value||value.format!=='writer-desk-network-download'||value.platform!==platform||value.arch!==arch||value.installKind!==installKind||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_ASSET)fail('network-invalid-receipt');
    versionParts(value.version);if(compareVersions(value.version,minimumVersion())<=0)fail('network-downgrade');
    const file=location(value);safeDirectory(fs,path.dirname(file));const stat=safeFile(fs,file,MAX_ASSET);
    if(stat.size!==value.size||await hashFile(fs,file)!==value.sha256)fail('network-hash-mismatch');
    const sidecar=path.join(path.dirname(file),sidecarName(value.filename));safeFile(fs,sidecar,MAX_CHECKSUM);
    if(checksumValue(fs.readFileSync(sidecar),value.filename)!==value.sha256)fail('network-hash-mismatch');return file;
  }
  async function load(){
    if(loadPromise)return loadPromise;
    loadPromise=(async()=>{if(loaded)return;loaded=true;safeDirectory(fs,cache);
    const storedSettings=readJSON(fs,path.join(cache,'settings.json'));if(storedSettings)settings=settingsChecked(storedSettings);
    const stored=readJSON(fs,path.join(cache,'download.json'));if(!stored)return;
    try{await verifyReceipt(stored);receipt=stored;candidate={version:stored.version,size:stored.size,filename:stored.filename,checksumName:sidecarName(stored.filename),tag:'v'+stored.version,notes:stored.notes||'',prerelease:stored.prerelease===true,publishedAt:stored.publishedAt||''};state.phase='downloaded';}
    catch(error){if(error.code==='network-downgrade'){fs.rmSync(path.join(cache,'download.json'),{force:true});return;}notify({phase:'error',errorCode:error.code||'network-invalid-receipt'});}
    })();return loadPromise;
  }
  async function openResponse(url,signal,metadata,redirects=0){
    checkedURL(url,metadata);if(signal.aborted)fail('network-cancelled');
    const response=await new Promise((resolve,reject)=>{
      let settled=false;const request=transport.get(url,{headers:{'User-Agent':'WriterDesk-Updater/'+currentVersion,'Accept':metadata?'application/vnd.github+json':'application/octet-stream','Accept-Encoding':'identity'},agent:false},response=>{settled=true;resolve(response);});
      const abort=()=>request.destroy(Object.assign(new Error('cancelled'),{code:'network-cancelled'}));signal.addEventListener('abort',abort,{once:true});
      request.setTimeout?.(30000,()=>request.destroy(Object.assign(new Error('timeout'),{code:'network-timeout'})));
      request.on('error',error=>{signal.removeEventListener('abort',abort);if(!settled)reject(error.code?.startsWith('network-')?error:Object.assign(new Error('connection'),{code:'network-connection'}));});
      request.on('response',response=>response.once('close',()=>signal.removeEventListener('abort',abort)));
    });
    if([301,302,303,307,308].includes(response.statusCode)){
      const redirect=response.headers.location;response.resume();if(redirects>=5||typeof redirect!=='string')fail('network-unsafe-url');let next;try{next=new URL(redirect,url).href;}catch{fail('network-unsafe-url');}checkedURL(next,metadata);return openResponse(next,signal,metadata,redirects+1);
    }
    if(response.statusCode!==200){response.resume();fail('network-http');}return response;
  }
  async function bytes(url,limit,signal,metadata=false){
    const response=await openResponse(url,signal,metadata),chunks=[];let count=0;
    try{for await(const chunk of response){if(signal.aborted)fail('network-cancelled');count+=chunk.length;if(count>limit)fail('network-too-large');chunks.push(chunk);}if(signal.aborted)fail('network-cancelled');return Buffer.concat(chunks);}
    catch(error){response.destroy();if(signal.aborted)fail('network-cancelled');if(error.code?.startsWith('network-'))throw error;fail('network-connection');}
  }
  async function operation(phase,work){
    await load();if(busy)fail('network-busy');busy=true;controller=new AbortController();const active=controller,timeout=setTimeout(()=>active.abort('timeout'),10*60*1000);timeout.unref?.();notify({phase,errorCode:null,...(phase==='downloading'?{received:0,total:candidate?.size||0}:{})});
    try{return await work(active.signal);}
    catch(error){const code=active.signal.aborted?(active.signal.reason==='timeout'?'network-timeout':'network-cancelled'):error.code?.startsWith('network-')?error.code:'network-failed';notify({phase:code==='network-cancelled'?'cancelled':'error',errorCode:code,received:0});throw Object.assign(new Error(code),{code});}
    finally{clearTimeout(timeout);if(controller===active)controller=null;busy=false;}
  }
  return Object.freeze({
    async info(){await load();return publicState();},
    subscribe(callback){if(typeof callback!=='function')throw new TypeError('A callback is required.');listeners.add(callback);return()=>listeners.delete(callback);},
    async setSettings(value){await load();settingsChecked(value);settings=settingsChecked({...settings,...value});safeDirectory(fs,cache);atomicJSON(fs,path.join(cache,'settings.json'),settings);notify({});return publicState();},
    async check(){return operation('checking',async signal=>{
      let releases;try{releases=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(API,MAX_METADATA,signal,true)));}catch(error){if(error.code?.startsWith('network-'))throw error;fail('network-invalid-release');}
      const selected=selectRelease(releases,{currentVersion:minimumVersion(),platform,arch,installKind,includePrerelease:settings.includePrerelease});
      if(receipt&&(!selected||compareVersions(receipt.version,selected.version)>=0)){candidate={...candidate,version:receipt.version,filename:receipt.filename,size:receipt.size,tag:'v'+receipt.version,checksumName:sidecarName(receipt.filename)};notify({phase:'downloaded',lastCheckedAt:new Date().toISOString(),upToDate:false});}
      else{candidate=selected;notify({phase:selected?'available':'idle',lastCheckedAt:new Date().toISOString(),upToDate:!selected});}
      return publicState();
    });},
    async download(){return operation('downloading',async signal=>{
      if(!candidate)fail('network-no-update');const release=clone(candidate);if(compareVersions(release.version,minimumVersion())<=0)fail('network-downgrade');
      const filename=artifactName(release.version,platform,arch,installKind);if(release.filename!==filename||release.checksumName!==sidecarName(filename))fail('network-invalid-release');
      const base=RELEASE_ROOT+'v'+release.version+'/',raw=await bytes(base+release.checksumName,MAX_CHECKSUM,signal),expected=checksumValue(raw,filename);
      const directory=safeDirectory(fs,path.join(cache,release.version)),destination=path.join(directory,filename),temporary=path.join(directory,filename+'.'+randomBytes(8).toString('hex')+'.part'),digest=createHash('sha256');let written=0,fd;
      try{
        fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
        const response=await openResponse(base+filename,signal,false);notify({received:0,total:release.size});
        try{for await(const chunk of response){if(signal.aborted)fail('network-cancelled');written+=chunk.length;if(written>MAX_ASSET||written>release.size)fail('network-too-large');digest.update(chunk);let offset=0;while(offset<chunk.length){const count=fs.writeSync(fd,chunk,offset,chunk.length-offset);if(count<=0)fail('network-failed');offset+=count;}notify({received:written,total:release.size});}}catch(error){response.destroy();if(signal.aborted)fail('network-cancelled');throw error;}
        if(signal.aborted)fail('network-cancelled');const sha256=digest.digest('hex');if(written!==release.size||sha256!==expected)fail('network-hash-mismatch');fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
        fs.renameSync(temporary,destination);atomicJSON(fs,path.join(directory,'receipt.json'),{filename,sha256,size:written});
        const checksumFile=path.join(directory,release.checksumName),sumTemp=checksumFile+'.'+randomBytes(8).toString('hex')+'.tmp';try{fs.writeFileSync(sumTemp,expected+'  '+filename+'\n',{flag:'wx',mode:0o600});fs.renameSync(sumTemp,checksumFile);}finally{fs.rmSync(sumTemp,{force:true});}
        receipt={format:'writer-desk-network-download',version:release.version,platform,arch,installKind,filename,size:written,sha256,prerelease:release.prerelease,notes:release.notes,publishedAt:release.publishedAt,downloadedAt:new Date().toISOString()};atomicJSON(fs,path.join(cache,'download.json'),receipt);notify({phase:'downloaded',received:written,total:written,errorCode:null});return publicState();
      }finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
    });},
    cancel(){if(controller&&['checking','downloading'].includes(state.phase)){controller.abort();return{cancelled:true};}return{cancelled:false};},
    async prepareInstall(){
      await load();if(busy)fail('network-busy');if(!receipt||candidate&&candidate.version!==receipt.version)fail('network-no-update');busy=true;notify({phase:'staging',errorCode:null});
      try{const file=await verifyReceipt(receipt);if(installKind==='managed'){
        if(!options.updater?.stageArchive)fail('network-unsupported');const result=await options.updater.stageArchive(file,{...options.updateOptions?.(),currentVersion:minimumVersion(),arch});notify({phase:'staged',pendingVersion:receipt.version});return{mode:'managed',version:receipt.version,...result};
      }notify({phase:'downloaded'});return{mode:installKind,file,version:receipt.version,sha256:receipt.sha256};}
      catch(error){if(['network-hash-mismatch','network-invalid-receipt','network-downgrade'].includes(error.code))receipt=null;notify({phase:'error',errorCode:error.code||'network-failed'});throw error;}finally{busy=false;}
    }
  });
}
module.exports={createNetworkUpdater,selectRelease,artifactName,sidecarName,checksumValue,checkedURL,compareVersions,errorMessage,DEFAULT_SETTINGS};
