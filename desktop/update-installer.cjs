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
  return `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$writerInstaller = ${literal}\n$writerExpectedHash = '${sha256.toLowerCase()}'\n$writerParentPid = ${pid}\n[Console]::Out.WriteLine('${READY}')\n[Console]::Out.Flush()\n$writerParent = $null\ntry { $writerParent = [Diagnostics.Process]::GetProcessById($writerParentPid) }\ncatch [ArgumentException] { }\nif ($null -ne $writerParent) {\n  try { $writerParent.WaitForExit() } finally { $writerParent.Dispose() }\n}\n$writerAttributes = [IO.File]::GetAttributes($writerInstaller)\nif (($writerAttributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { exit 2 }\n$writerStream = [IO.File]::OpenRead($writerInstaller)\ntry {\n  $writerHasher = [Security.Cryptography.SHA256]::Create()\n  try { $writerActualHash = [BitConverter]::ToString($writerHasher.ComputeHash($writerStream)).Replace('-', '').ToLowerInvariant() }\n  finally { $writerHasher.Dispose() }\n} finally { $writerStream.Dispose() }\nif ($writerActualHash -cne $writerExpectedHash) { exit 3 }\n$writerStartInfo = [Diagnostics.ProcessStartInfo]::new()\n$writerStartInfo.FileName = $writerInstaller\n$writerStartInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($writerInstaller)\n$writerStartInfo.UseShellExecute = $true\n$null = [Diagnostics.Process]::Start($writerStartInfo)\n`;
}
function buildLauncher(script,command){
  const encoded=Buffer.from(script,'utf16le').toString('base64'),literal="'"+command.replace(/'/g,"''")+"'";
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$writerWorker = $null
try {
  $writerWorkerInfo = [Diagnostics.ProcessStartInfo]::new()
  $writerWorkerInfo.FileName = ${literal}
  $writerWorkerInfo.Arguments = '-NoProfile -NonInteractive -EncodedCommand ${encoded}'
  $writerWorkerInfo.UseShellExecute = $false
  $writerWorkerInfo.CreateNoWindow = $true
  $writerWorkerInfo.RedirectStandardOutput = $true
  $writerWorkerInfo.RedirectStandardError = $true
  $writerWorker = [Diagnostics.Process]::Start($writerWorkerInfo)
  [Console]::Out.WriteLine('WRITER_UPDATE_WORKER ' + $writerWorker.Id)
  [Console]::Out.Flush()
  $writerErrors = $writerWorker.StandardError.ReadToEndAsync()
  $writerFirstLine = $writerWorker.StandardOutput.ReadLineAsync()
  if (-not $writerFirstLine.Wait(8000)) { throw [TimeoutException]::new('Worker readiness timed out') }
  if ($writerFirstLine.Result -cne '${READY}') { throw [InvalidOperationException]::new('Worker did not acknowledge readiness') }
  [Console]::Out.WriteLine('${READY}')
  [Console]::Out.Flush()
  $writerOutput = $writerWorker.StandardOutput.ReadToEndAsync()
  $writerWorker.WaitForExit()
  $writerExitCode = $writerWorker.ExitCode
  $writerOutputText = $writerOutput.GetAwaiter().GetResult()
  $writerErrorText = $writerErrors.GetAwaiter().GetResult()
  if ($writerOutputText) { [Console]::Out.Write($writerOutputText) }
  if ($writerErrorText) { [Console]::Error.Write($writerErrorText) }
  exit $writerExitCode
} catch {
  if ($null -ne $writerWorker) {
    try { if (-not $writerWorker.HasExited) { $writerWorker.Kill(); $null = $writerWorker.WaitForExit(1000) } } catch { }
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $writerWorker) { $writerWorker.Dispose() }
}
`;
}
function prepare(options,runtime={}){
  const script=buildPowerShell(options),root=runtime.systemRoot||process.env.SystemRoot||process.env.WINDIR||'C:\\Windows';
  if(typeof root!=='string'||!/^([A-Za-z]:)[\\/]/.test(root)||/[\u0000-\u001f\u007f]/.test(root)||root.slice(2).includes(':')||root.split(/[\\/]/).some(part=>part==='.'||part==='..'))invalid();
  const command=path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
  // libuv kills its non-detached direct children when the writer exits, while
  // Windows PowerShell may not execute at all under DETACHED_PROCESS. A hidden
  // .NET-created worker silently breaks away from libuv's job, acknowledges
  // readiness through this short-lived launcher, then waits for the writer.
  const launcher=buildLauncher(script,command);
  return{command,args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(launcher,'utf16le').toString('base64')],options:{detached:false,stdio:['ignore','pipe','pipe'],windowsHide:true}};
}
async function launch(options,spawnProcess=spawn,runtime={}){
  const prepared=prepare(options,runtime);let child,workerPid=null;
  const killProcess=typeof runtime.killProcess==='function'?runtime.killProcess:pid=>process.kill(pid);
  function stopProcesses(){
    if(workerPid!==null){try{killProcess(workerPid);}catch{}}
    try{if(child?.exitCode==null)child?.kill?.();}catch{}
  }
  const spawnFailure=error=>failure(error?.code==='ENOENT'?'network-installer-missing':['EACCES','EPERM'].includes(error?.code)?'network-installer-blocked':'network-installer-start-failed');
  try{child=spawnProcess(prepared.command,prepared.args,prepared.options);}catch(error){throw spawnFailure(error);}
  child.on('error',()=>{});child.stdout?.on('error',()=>{});child.stderr?.on('error',()=>{});
  await new Promise((resolve,reject)=>{
    let done=false,output='',received=0;
    const timer=setTimeout(()=>finish(failure('network-installer-timeout')),runtime.timeoutMs||15000);
    function cleanup(){clearTimeout(timer);child.removeListener('error',onError);child.removeListener('exit',onExit);child.stdout?.removeListener('data',onData);child.stdout?.removeListener('error',onPipeError);}
    function finish(error){
      if(done)return;done=true;cleanup();
      if(error){stopProcesses();child.stdout?.destroy();child.stderr?.destroy();reject(error);}
      else{child.stdout?.resume();child.stdout?.unref?.();child.stderr?.unref?.();resolve();}
    }
    function onError(error){finish(spawnFailure(error));}
    function onExit(){finish(failure('network-installer-start-failed'));}
    function onPipeError(){finish(failure('network-installer-start-failed'));}
    function onData(chunk){
      received+=chunk.length;if(received>8192){finish(failure('network-installer-start-failed'));return;}
      output+=chunk.toString('utf8');let newline;
      while(!done&&(newline=output.indexOf('\n'))!==-1){
        const line=output.slice(0,newline).replace(/\r$/,'');output=output.slice(newline+1);
        if(line.startsWith('WRITER_UPDATE_WORKER')){
          const match=line.match(/^WRITER_UPDATE_WORKER ([1-9]\d{0,9})$/),pid=match?Number(match[1]):0;
          if(workerPid!==null||!Number.isSafeInteger(pid)||pid<=0||pid>0xffffffff||pid===process.pid||pid===child.pid||pid===options.pid){finish(failure('network-installer-start-failed'));return;}
          workerPid=pid;
        }else if(line===READY){
          if(workerPid===null){finish(failure('network-installer-start-failed'));return;}
          finish();
        }
      }
    }
    child.once('error',onError);child.once('exit',onExit);child.stdout?.on('data',onData);child.stdout?.once('error',onPipeError);child.stderr?.resume();
    if(!child.stdout)finish(failure('network-installer-start-failed'));
  });
  child.unref();let cancelled=false;
  return{helperStarted:true,helperPid:workerPid,cancel(){if(cancelled)return;cancelled=true;stopProcesses();}};
}
module.exports={buildPowerShell,buildLauncher,prepare,launch};
