'use strict';
// A detached, bounded Windows helper waits for the current app to exit, then
// independently hashes the fixed downloaded installer again before execution.
const path=require('node:path');
const {spawn}=require('node:child_process');
function invalid(){throw Object.assign(new Error('network-invalid-installer'),{code:'network-invalid-installer'});}
function buildPowerShell({file,sha256,pid}={}){
  if(typeof file!=='string'||file.length>2048||/[\u0000-\u001f\u007f]/.test(file)||!path.win32.isAbsolute(file)||!(/^[A-Za-z]:[\\/]/.test(file))||file.slice(2).includes(':')||file.split(/[\\/]/).some(part=>part==='.'||part==='..')||!/^WriterDesk-\d{1,6}\.\d{1,6}\.\d{1,6}-windows-x64\.exe$/.test(path.win32.basename(file))||typeof sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(sha256)||!Number.isSafeInteger(pid)||pid<=0||pid>0xffffffff)invalid();
  const literal="'"+file.replace(/'/g,"''")+"'";
  return `$ErrorActionPreference = 'Stop'\n$writerInstaller = ${literal}\n$writerExpectedHash = '${sha256.toLowerCase()}'\n$writerParentPid = ${pid}\ntry {\n  Wait-Process -Id $writerParentPid -ErrorAction Stop\n} catch {\n  if ($null -ne (Get-Process -Id $writerParentPid -ErrorAction SilentlyContinue)) { throw }\n}\n$writerItem = Get-Item -LiteralPath $writerInstaller -Force\nif ($writerItem.PSIsContainer -or (($writerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 2 }\n$writerActualHash = (Get-FileHash -LiteralPath $writerInstaller -Algorithm SHA256).Hash\nif ($writerActualHash.ToLowerInvariant() -cne $writerExpectedHash) { exit 3 }\nStart-Process -FilePath $writerInstaller -ErrorAction Stop\n`;
}
function prepare(options){const script=buildPowerShell(options);return{command:'powershell.exe',args:['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options:{detached:true,stdio:'ignore',windowsHide:true}};}
async function launch(options,spawnProcess=spawn){
  const prepared=prepare(options),child=spawnProcess(prepared.command,prepared.args,prepared.options);
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return{helperStarted:true};
}
module.exports={buildPowerShell,prepare,launch};
