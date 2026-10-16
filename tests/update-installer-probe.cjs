'use strict';
// Observational Windows PowerShell stdio probe. Every script only writes one
// fixed stdout marker and exits; no files, parent processes or installers open.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1]) : null;
const result = { passed: true, diagnosticOnly: true, platform: process.platform, cases: [] };
const marker = 'WRITER_PROBE';
const scripts = {
  assignedConsole: "$writerOutput=[Console]::Out; $writerOutput.WriteLine('WRITER_PROBE'); $writerOutput.Flush(); exit 7",
  productionConsole: "$ErrorActionPreference = 'Stop'\n$writerInstaller = 'fixture-not-opened'\n$writerExpectedHash = '" + 'a'.repeat(64) + "'\n$writerParentPid = 12345\n[Console]::Out.WriteLine('WRITER_PROBE')\n[Console]::Out.Flush()\nexit 7\n",
};
async function probe(command, variant, script, detached, stdin) {
  const began = Date.now(), value = { variant, detached, stdin, windowsHide: true,
    mode: '-NoProfile -NonInteractive -EncodedCommand', exitCode: null, signal: null,
    stdout: '', stderr: '', timeout: false, spawnErrorCode: '' };
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  await new Promise(resolve => {
    let child, completed = false, budget = 4096;
    function finish() { if (completed) return; completed = true; clearTimeout(timeout); resolve(); }
    function capture(channel, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), part = bytes.subarray(0, Math.max(0, budget));
      value[channel] += part.toString('utf8'); budget -= part.length;
    }
    const timeout = setTimeout(() => { value.timeout = true; try { child?.kill(); } catch { } }, 5000);
    try {
      child = spawn(command, args, { detached, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (error) { value.spawnErrorCode = error.code || error.message; finish(); return; }
    // stdin='pipe' deliberately remains open until process exit, matching the
    // renderer-parent lifetime without sending any data or closing it early.
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.once('error', error => { value.spawnErrorCode = error.code || error.message; finish(); });
    child.once('close', (code, signal) => { value.exitCode = code; value.signal = signal; child.stdin?.destroy(); finish(); });
  });
  value.elapsedMs = Date.now() - began;
  value.markerSeen = value.stdout.split(/\r?\n/).some(line => line === marker);
  value.expectedExit = value.exitCode === 7;
  return value;
}
(async () => {
  try {
    if (process.platform !== 'win32') result.skipped = 'Windows-only observational stdio matrix';
    else {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      result.command = command;
      for (const [variant, script] of Object.entries(scripts)) {
        for (const detached of [true, false]) {
          for (const stdin of ['ignore', 'pipe']) result.cases.push(await probe(command, variant, script, detached, stdin));
        }
      }
      result.successfulConfigurations = result.cases.filter(item => item.markerSeen && item.expectedExit)
        .map(({ variant, detached, stdin }) => ({ variant, detached, stdin }));
    }
  } catch (error) { result.passed = false; result.error = error.stack || String(error); }
  const output = JSON.stringify(result, null, 2) + '\n';
  if (reportPath) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, output); }
  console.log(output);
  if (!result.passed) process.exitCode = 1;
})();
