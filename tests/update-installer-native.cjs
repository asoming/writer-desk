'use strict';
// Headless Windows helper acceptance. The only executable started by the
// helper is a C# fixture compiled below; it writes one marker beside itself.
// No release installer, application installation or personal data is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { launch } = require('../desktop/update-installer.cjs');
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1]) : null;
const results = { passed: false, platform: process.platform, headless: true,
  fixtureOnly: true, actualReleaseInstaller: false, cases: {} };
const children = new Set();
const ownedHelperPids = new Set();
let temporary;
function report() {
  const output = JSON.stringify(results, null, 2) + '\n';
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, output);
  }
  (results.passed ? console.log : console.error)(output);
}
function quote(value) { return "'" + value.replace(/'/g, "''") + "'"; }
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function bounded(promise, milliseconds, message) {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timeout));
}
function tracked(command, args, options) {
  const child = spawn(command, args, options);
  children.add(child);
  child.finished = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await bounded(child.finished, 5000, 'Fixture child did not stop');
}
async function parent() {
  const child = tracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { windowsHide: true, stdio: 'ignore' });
  await bounded(new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', reject);
  }), 5000, 'Fixture parent did not start');
  return child;
}
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function fixtureExecutable(powershell, directory) {
  const executable = path.join(directory, 'WriterDesk-0.8.6-windows-x64.exe');
  // No arguments or caller-selected destination enter this program. It can
  // write only the fixed marker in its own disposable executable directory.
  const csharp = `using System.IO;
using System.Reflection;
public static class WriterUpdateFixture {
  public static void Main() {
    string folder = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    File.WriteAllText(Path.Combine(folder, "fixture-ran.txt"), "fixture-only");
  }
}`;
  const script = "$ErrorActionPreference = 'Stop'\n$source = @'\n" + csharp + "\n'@\n" +
    'Add-Type -TypeDefinition $source -OutputAssembly ' + quote(executable) + ' -OutputType ConsoleApplication\n';
  const compiled = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  if (compiled.error) throw compiled.error;
  assert.equal(compiled.status, 0, 'Could not compile the disposable C# fixture: ' + compiled.stderr);
  assert.equal(fs.readFileSync(executable).subarray(0, 2).toString(), 'MZ');
  return executable;
}
async function exercise(assembly, folderName, systemRoot, powershell, mutate) {
  const directory = path.join(temporary, folderName);
  fs.mkdirSync(directory);
  const file = path.join(directory, path.basename(assembly)), marker = path.join(directory, 'fixture-ran.txt');
  fs.copyFileSync(assembly, file);
  const expected = digest(file), fakeParent = await parent();
  let helper, launchedCommand;
  const diagnostics = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), bytes: 0, truncated: false };
  function capture(channel, chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, 4096 - diagnostics.bytes);
    if (bytes.length > remaining) diagnostics.truncated = true;
    if (!remaining) return;
    const selected = bytes.subarray(0, remaining);
    diagnostics[channel] = Buffer.concat([diagnostics[channel], selected]);
    diagnostics.bytes += selected.length;
  }
  try {
    const ready = await launch({ file, sha256: expected, pid: fakeParent.pid }, (command, args, options) => {
      launchedCommand = command;
      // System32 excludes the WindowsPowerShell subdirectory. The absolute
      // helper command must still start when PowerShell cannot be found in PATH.
      helper = tracked(command, args, { ...options, env: { ...process.env, PATH: path.join(systemRoot, 'System32') } });
      diagnostics.stdio = options.stdio;
      diagnostics.detached = options.detached;
      helper.stdout?.on('data', chunk => capture('stdout', chunk));
      helper.stderr?.on('data', chunk => capture('stderr', chunk));
      helper.once('exit', (code, signal) => { diagnostics.exitCode = code; diagnostics.signal = signal; });
      helper.once('error', error => { diagnostics.spawnErrorCode = error.code || ''; });
      return helper;
    }, { systemRoot, timeoutMs: 15000 });
    assert.equal(ready.helperStarted, true);
    assert.equal(path.win32.normalize(launchedCommand).toLowerCase(), path.win32.normalize(powershell).toLowerCase());
    assert.equal(path.win32.isAbsolute(launchedCommand), true);
    assert.equal(fakeParent.exitCode, null, 'Readiness must precede parent exit');
    assert.equal(helper.exitCode, null, 'The helper must still be waiting for its parent');
    assert.equal(fs.existsSync(marker), false, 'The fixture must not run before parent exit');
    // Leave a measurable interval after readiness so an early start is caught.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker), false, 'The helper did not wait for the parent');
    if (mutate) fs.appendFileSync(file, Buffer.from([0]));
    await stop(fakeParent);
    const closed = await bounded(helper.finished, 15000, 'Helper did not finish after its parent exited');
    assert.equal(closed.error, undefined);
    if (mutate) {
      assert.equal(closed.code, 3, 'A changed installer must fail its second SHA-256 check');
      assert.equal(fs.existsSync(marker), false, 'A changed fixture must never execute');
    } else {
      assert.equal(closed.code, 0, 'Verified fixture helper did not complete');
      await until(() => fs.existsSync(marker), 'Verified fixture did not write its marker');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'fixture-only');
    }
    return { readyBeforeParentExit: true, parentExitRequired: true, absoluteSystemPowerShell: true,
      pathWithoutPowerShell: true, unicodeSpaceAndApostrophePath: true,
      ...(mutate ? { secondHashRejectsMutation: true, changedFixtureNeverExecuted: true } : { verifiedFixtureOnlyExecutedAfterExit: true }) };
  } catch (error) {
    // The production helper deliberately closes its streams after startup.
    // Capture diagnostics in this isolated fixture before that can happen.
    if (helper) {
      try { await bounded(helper.finished, 2000, 'Helper failure diagnostics timed out'); } catch { }
    }
    results.helperFailure = {
      scenario: mutate ? 'reverification' : 'readyAndWait', command: launchedCommand || '',
      stdout: diagnostics.stdout.toString('utf8'), stderr: diagnostics.stderr.toString('utf8'),
      capturedBytes: diagnostics.bytes, truncated: diagnostics.truncated,
      exitCode: diagnostics.exitCode ?? helper?.exitCode ?? null, signal: diagnostics.signal ?? helper?.signalCode ?? null,
      spawnErrorCode: diagnostics.spawnErrorCode || '', stdio: diagnostics.stdio, detached: diagnostics.detached,
    };
    throw error;
  } finally {
    await stop(fakeParent);
    await stop(helper);
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function stopOwnedHelper(pid) {
  if (!ownedHelperPids.has(pid)) return;
  if (processExists(pid)) {
    process.kill(pid);
    await until(() => !processExists(pid), 'Owned helper did not stop', 5000);
  }
  ownedHelperPids.delete(pid);
}
async function actualOwnerExit(assembly, systemRoot, powershell) {
  const directory = path.join(temporary, "真实父进程退出 Author's Draft");
  fs.mkdirSync(directory);
  const file = path.join(directory, path.basename(assembly)), marker = path.join(directory, 'fixture-ran.txt');
  fs.copyFileSync(assembly, file);
  const options = { file, sha256: digest(file) };
  const helperModule = path.resolve(__dirname, '../desktop/update-installer.cjs');
  // This child owns PowerShell in the same way the desktop main process does.
  // Its normal process.exit(0), rather than killing an unrelated wait PID,
  // proves the acknowledged helper survives the process that created it.
  const code = `const {spawn}=require('node:child_process');
const {launch}=require(${JSON.stringify(helperModule)});
let ready=false;
process.on('message',message=>{if(ready&&message?.command==='exit')process.exit(0);});
launch({...${JSON.stringify(options)},pid:process.pid},(command,args,options)=>{
  const helper=spawn(command,args,options);
  process.send({type:'helper',ownerPid:process.pid,helperPid:helper.pid,command,detached:options.detached});
  return helper;
},{systemRoot:${JSON.stringify(systemRoot)},timeoutMs:15000}).then(()=>{
  ready=true;process.send({type:'ready',ownerPid:process.pid});
}).catch(error=>{process.send({type:'failed',code:error.code||'',message:error.message});process.exit(1);});`;
  let owner, helperPid, helperInfo, diagnostics = '';
  try {
    owner = tracked(process.execPath, ['-e', code], { windowsHide: true,
      env: { ...process.env, PATH: path.join(systemRoot, 'System32') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const record = chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4096); };
    owner.stdout.on('data', record); owner.stderr.on('data', record);
    await bounded(new Promise((resolve, reject) => {
      owner.on('message', message => {
        try {
          if (message?.type === 'helper') {
            assert.equal(message.ownerPid, owner.pid);
            assert.ok(Number.isSafeInteger(message.helperPid) && message.helperPid > 0);
            helperPid = message.helperPid; ownedHelperPids.add(helperPid); helperInfo = message;
          } else if (message?.type === 'ready') {
            assert.equal(message.ownerPid, owner.pid); assert.ok(helperPid); resolve();
          } else if (message?.type === 'failed') reject(new Error('Owner helper failed: ' + message.code + ' ' + message.message));
        } catch (error) { reject(error); }
      });
      owner.once('error', reject);
      owner.once('exit', code => reject(new Error('Owner exited before helper readiness: ' + code)));
    }), 20000, 'Real owner did not acknowledge helper readiness');
    assert.equal(helperInfo.detached, false, 'This acceptance must exercise the production non-detached helper');
    assert.equal(path.win32.normalize(helperInfo.command).toLowerCase(), path.win32.normalize(powershell).toLowerCase());
    assert.equal(owner.exitCode, null);
    assert.equal(processExists(helperPid), true);
    assert.equal(fs.existsSync(marker), false);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(marker), false, 'The owned helper ran before its owner exited');
    await new Promise((resolve, reject) => owner.send({ command: 'exit' }, error => error ? reject(error) : resolve()));
    const closed = await bounded(owner.finished, 10000, 'Owner did not exit normally');
    assert.equal(closed.code, 0); assert.equal(closed.signal, null);
    await until(() => fs.existsSync(marker), 'Helper did not run the fixture after its actual owner exited', 15000);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'fixture-only');
    await until(() => !processExists(helperPid), 'Helper remained after completing the owned fixture', 10000);
    ownedHelperPids.delete(helperPid);
    return { nonDetachedProductionHelper: true, pathWithoutPowerShell: true,
      unicodeSpaceAndApostrophePath: true, acknowledgedWhileOwnerAlive: true,
      ownerExitedNormallyWithCodeZero: true, fixtureExecutedOnlyAfterActualOwnerExit: true,
      helperExitedAfterFixture: true };
  } catch (error) {
    results.ownerFailure = { helperPid: helperPid || null, ownerExitCode: owner?.exitCode ?? null,
      ownerSignal: owner?.signalCode ?? null, diagnostics };
    throw error;
  } finally {
    if (owner?.exitCode === null && owner.signalCode === null && owner.connected) {
      try {
        owner.send({ command: 'exit' });
        await bounded(owner.finished, 2000, 'Owner cleanup required termination');
      } catch { }
    }
    await stop(owner);
    if (helperPid) await stopOwnedHelper(helperPid);
  }
}

(async () => {
  if (process.platform !== 'win32') {
    results.passed = true; results.skipped = 'Native Windows helper acceptance runs only on Windows';
    report(); return;
  }
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.equal(path.win32.isAbsolute(powershell), true);
    assert.equal(fs.statSync(powershell).isFile(), true);
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-update-helper-native-')));
    const compiledDirectory = path.join(temporary, "编译样本 Author's Draft");
    fs.mkdirSync(compiledDirectory);
    const assembly = fixtureExecutable(powershell, compiledDirectory);
    results.cases.readyAndWait = await exercise(assembly, "有效样本 Author's Draft", systemRoot, powershell, false);
    results.cases.reverification = await exercise(assembly, "改动样本 Author's Draft", systemRoot, powershell, true);
    results.cases.actualOwnerExit = await actualOwnerExit(assembly, systemRoot, powershell);
    results.passed = true;
  } catch (error) {
    results.error = error.stack || String(error);
  } finally {
    for (const child of children) {
      try { await stop(child); } catch (error) { results.passed = false; results.cleanupError = error.message; }
    }
    for (const pid of ownedHelperPids) {
      try { await stopOwnedHelper(pid); } catch (error) { results.passed = false; results.cleanupError = error.message; }
    }
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { results.passed = false; results.cleanupError = error.message; }
    }
    report();
    if (!results.passed) process.exitCode = 1;
  }
})();
