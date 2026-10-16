'use strict';
// The Windows helper acknowledges startup, waits for the writer to exit, then
// independently verifies the downloaded installer before opening it.
const path=require('node:path');
const {spawn}=require('node:child_process');
const READY='WRITER_UPDATE_READY';
function failure(code){return Object.assign(new Error(code),{code});}
function invalid(){throw failure('network-invalid-installer');}
function buildPowerShell({file,sha256,pid}={}){
  if(typeof file!=='string'||file.length>2048||/[\u0000-\u001f\u007f]/.test(file)||!path.win32.isAbsolute(file)||!(/^[A-Za-z]:[\\/]/.test(file))||file.slice(2).includes(':')||file.split(/[\\/]/).some(part=>part==='.'||part==='..')||!/^WriterDesk-\d{1,6}\.\d{1,6}\.\d{1,6}-windows-x64\.exe$/.test(path.win32.basename(file))||typeof sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(sha256)||!Number.isSafeInteger(pid)||pid<=0||pid>0xffffffff)invalid();
  const literal="'"+file.replace(/'/g,"''")+"'";
  return `$ErrorActionPreference = 'Stop'\n$writerInstaller = ${literal}\n$writerExpectedHash = '${sha256.toLowerCase()}'\n$writerParentPid = ${pid}\n[Console]::Out.WriteLine('${READY}')\n[Console]::Out.Flush()\ntry {\n  Wait-Process -Id $writerParentPid -ErrorAction Stop\n} catch {\n  if ($null -ne (Get-Process -Id $writerParentPid -ErrorAction SilentlyContinue)) { throw }\n}\n$writerItem = Get-Item -LiteralPath $writerInstaller -Force\nif ($writerItem.PSIsContainer -or (($writerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 2 }\n$writerActualHash = (Get-FileHash -LiteralPath $writerInstaller -Algorithm SHA256).Hash\nif ($writerActualHash.ToLowerInvariant() -cne $writerExpectedHash) { exit 3 }\nStart-Process -FilePath $writerInstaller -ErrorAction Stop\n`;
}
function prepare(options,runtime={}){
  const script=buildPowerShell(options),root=runtime.systemRoot||process.env.SystemRoot||process.env.WINDIR||'C:\\Windows';
  if(typeof root!=='string'||!/^([A-Za-z]:)[\\/]/.test(root)||/[\u0000-\u001f\u007f]/.test(root)||root.slice(2).includes(':')||root.split(/[\\/]/).some(part=>part==='.'||part==='..'))invalid();
  // Windows PowerShell can exit without executing when detached; unref after
  // readiness lets this hidden child outlive the writer without that flag.
  return{command:path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options:{detached:false,stdio:['ignore','pipe','pipe'],windowsHide:true}};
}
async function launch(options,spawnProcess=spawn,runtime={}){
  const prepared=prepare(options,runtime);let child;
  const spawnFailure=error=>failure(error?.code==='ENOENT'?'network-installer-missing':['EACCES','EPERM'].includes(error?.code)?'network-installer-blocked':'network-installer-start-failed');
  try{child=spawnProcess(prepared.command,prepared.args,prepared.options);}catch(error){throw spawnFailure(error);}
  child.on('error',()=>{});
  await new Promise((resolve,reject)=>{
    let done=false,output='';
    const timer=setTimeout(()=>finish(failure('network-installer-timeout')),runtime.timeoutMs||10000);
    function cleanup(){clearTimeout(timer);child.removeListener('error',onError);child.removeListener('exit',onExit);child.stdout?.removeListener('data',onData);child.stdout?.removeListener('error',onPipeError);}
    function finish(error){
      if(done)return;done=true;cleanup();
      if(error){try{child.kill?.();}catch{}reject(error);}else resolve();
      child.stdout?.destroy();child.stderr?.destroy();
    }
    function onError(error){finish(spawnFailure(error));}
    function onExit(){finish(failure('network-installer-start-failed'));}
    function onPipeError(){finish(failure('network-installer-start-failed'));}
    function onData(chunk){output+=chunk.toString('utf8');if(output.split(/\r?\n/).some(line=>line===READY))finish();else if(output.length>8192)finish(failure('network-installer-start-failed'));}
    child.once('error',onError);child.once('exit',onExit);child.stdout?.on('data',onData);child.stdout?.once('error',onPipeError);child.stderr?.resume();
    if(!child.stdout)finish(failure('network-installer-start-failed'));
  });child.unref();let cancelled=false;return{helperStarted:true,cancel(){if(cancelled)return;cancelled=true;try{if(child.exitCode==null)child.kill?.();}catch{}}};
}
module.exports={buildPowerShell,prepare,launch};
