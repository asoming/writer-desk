'use strict';
// Observational Windows PowerShell startup probe. Each script only writes a
// fixed marker to its own temporary file and stdout, then exits. It never opens
// installers, waits for other processes or touches application/user data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1]) : null;
const result = { passed: true, diagnosticOnly: true, platform: process.platform, cases: [] };
const marker = 'WRITER_PROBE';
const CASE_BUDGET_MS = 5000, MATRIX_BUDGET_MS = 55000;
const configurations = [
  { variant: 'detached-baseline', detached: true },
  { variant: 'attached-control', detached: false, stdin: 'pipe' },
  { variant: 'detached-input-none', detached: true, format: ['-InputFormat', 'None'] },
  { variant: 'detached-output-text', detached: true, format: ['-OutputFormat', 'Text'] },
  { variant: 'detached-input-none-output-text', detached: true, format: ['-InputFormat', 'None', '-OutputFormat', 'Text'] },
  { variant: 'detached-input-none-output-text-pipe', detached: true, stdin: 'pipe', format: ['-InputFormat', 'None', '-OutputFormat', 'Text'] },
  { variant: 'detached-command', detached: true, commandMode: true },
  { variant: 'detached-command-input-none-output-text', detached: true, commandMode: true, format: ['-InputFormat', 'None', '-OutputFormat', 'Text'] },
  { variant: 'detached-window-style-hidden', detached: true, windowsHide: false, windowStyle: true },
  { variant: 'detached-command-window-style-hidden', detached: true, windowsHide: false, windowStyle: true, commandMode: true, format: ['-InputFormat', 'None', '-OutputFormat', 'Text'] },
];
function literal(value) { return "'" + value.replace(/'/g, "''") + "'"; }
function markerScript(file) {
  return "$ErrorActionPreference = 'Stop'\n" +
    '[IO.File]::WriteAllText(' + literal(file) + ', ' + literal(marker) + ')\n' +
    '[Console]::Out.WriteLine(' + literal(marker) + ')\n[Console]::Out.Flush()\nexit 7\n';
}
async function probe(command, configuration, markerFile, budgetMs) {
  const { variant, detached, stdin = 'ignore', windowsHide = true, commandMode = false, format = [], windowStyle = false } = configuration;
  const began = Date.now(), value = { variant, detached, stdin, windowsHide,
    mode: commandMode ? '-Command' : '-EncodedCommand', format, windowStyle: windowStyle ? 'Hidden' : null,
    exitCode: null, signal: null, stdout: '', stderr: '', timeout: false, spawnErrorCode: '' };
  const script = markerScript(markerFile);
  const args = ['-NoProfile', '-NonInteractive', ...format, ...(windowStyle ? ['-WindowStyle', 'Hidden'] : []),
    ...(commandMode ? ['-Command', script] : ['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])];
  await new Promise(resolve => {
    let child, completed = false, outputBudget = 4096, reapTimer = null;
    function finish() {
      if (completed) return; completed = true; clearTimeout(timeout); clearTimeout(reapTimer);
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); resolve();
    }
    function capture(channel, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), part = bytes.subarray(0, Math.max(0, outputBudget));
      value[channel] += part.toString('utf8'); outputBudget -= part.length;
    }
    // Leave a short close-event grace period inside the five-second case budget.
    // Even if the OS does not deliver close after kill, this observation ends.
    const timeout = setTimeout(() => {
      value.timeout = true; try { child?.kill(); } catch { }
      reapTimer = setTimeout(finish, Math.min(150, budgetMs));
    }, Math.max(1, budgetMs - 150));
    try { child = spawn(command, args, { detached, windowsHide, stdio: [stdin, 'pipe', 'pipe'] }); }
    catch (error) { value.spawnErrorCode = error.code || error.message; finish(); return; }
    // A piped stdin is intentionally kept open. All cases pass the script as
    // an argument and must not depend on closing or writing to that pipe.
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
    child.once('error', error => { value.spawnErrorCode = error.code || error.message; finish(); });
    child.once('close', (code, signal) => { value.exitCode = code; value.signal = signal; finish(); });
  });
  value.elapsedMs = Date.now() - began;
  value.markerSeen = value.stdout.split(/\r?\n/).some(line => line === marker);
  value.fileMarkerSeen = false;
  try { value.fileMarkerSeen = fs.readFileSync(markerFile, 'utf8').replace(/^\uFEFF/, '') === marker; }
  catch (error) { if (error.code !== 'ENOENT') value.markerReadErrorCode = error.code || String(error); }
  value.scriptExecuted = value.fileMarkerSeen || value.markerSeen;
  value.expectedExit = value.exitCode === 7;
  return value;
}
(async () => {
  const began = Date.now(); let temporary = null;
  try {
    if (process.platform !== 'win32') result.skipped = 'Windows-only observational startup matrix';
    else {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      result.command = command;
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-update-probe-'));
      for (let index = 0; index < configurations.length; index++) {
        const configuration = configurations[index], remaining = MATRIX_BUDGET_MS - (Date.now() - began);
        if (remaining < 200) { result.cases.push({ variant: configuration.variant, skipped: 'Overall diagnostic time budget exhausted' }); continue; }
        result.cases.push(await probe(command, configuration, path.join(temporary, 'marker-' + index + '.txt'), Math.min(CASE_BUDGET_MS, remaining)));
      }
      result.successfulConfigurations = result.cases.filter(item => item.fileMarkerSeen && item.expectedExit && !item.timeout && !item.spawnErrorCode)
        .map(({ variant, detached, stdin, windowsHide, mode, format, windowStyle, markerSeen }) => ({ variant, detached, stdin, windowsHide, mode, format, windowStyle, stdoutMarkerSeen: markerSeen }));
      result.stdoutMissingDespiteExecution = result.cases.filter(item => item.fileMarkerSeen && !item.markerSeen).map(item => item.variant);
    }
  } catch (error) { result.passed = false; result.error = error.stack || String(error); }
  finally {
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { result.cleanupErrorCode = error.code || String(error); }
    }
  }
  result.elapsedMs = Date.now() - began;
  const output = JSON.stringify(result, null, 2) + '\n';
  if (reportPath) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, output); }
  console.log(output);
  if (!result.passed) process.exitCode = 1;
})();
