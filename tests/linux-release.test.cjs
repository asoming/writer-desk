'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const updater = require('../desktop/updater.cjs');
const { finalizeLinuxDirectory, verifyLinuxArchive } = require('../scripts/linux-release.cjs');
const linux = { skip: process.platform !== 'linux' };
const metadata = { version: '0.6.1', arch: 'x64' };
function write(file, bytes, mode = 0o644) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); }
async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'writer-final-tar-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'linux-unpacked'), elf = Buffer.alloc(64); elf.set([127, 69, 76, 70, 2, 1]); elf.writeUInt16LE(62, 18);
  write(path.join(source, 'writer-desk'), elf, 0o755);
  for (const [name, bytes, mode] of [['resources/app.asar', 'immutable fixture archive', 0o644], ['resources/backend/writer-service', 'fixture service', 0o755], ['install-linux.sh', '#!/bin/sh\nexit 0\n', 0o755], ['writer-desk.png', 'fixture icon', 0o644]]) write(path.join(source, name), bytes, mode);
  await updater.createManifest(source, metadata);
  return { temporary, source };
}
function lateProfile(source) { write(path.join(source, 'resources/apparmor-profile'), '# Added by FPM after afterPack\nprofile fixture { userns, }\n', 0o664); }
function archive(source, destination) {
  const python = process.env.WRITER_DESK_BUILD_PYTHON || 'python3';
  const result = spawnSync(python, ['-c', "import tarfile,sys\nwith tarfile.open(sys.argv[2],'w:gz',format=tarfile.USTAR_FORMAT) as archive: archive.add(sys.argv[1],arcname='WriterDesk')", source, destination], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  fs.writeFileSync(destination.replace(/\.tar\.gz$/, '.sha256'), createHash('sha256').update(fs.readFileSync(destination)).digest('hex') + '  ' + path.basename(destination) + '\n');
  return destination;
}

test('finalize after target adds AppArmor fixes the exact stale-manifest failure without changing a sealed DEB', linux, async t => {
  const { temporary, source } = await fixture(t), sealed = path.join(temporary, 'already-sealed.deb');
  write(sealed, 'Do not touch the completed Debian artifact');
  const before = fs.readFileSync(sealed);
  lateProfile(source);
  await assert.rejects(updater.validateDirectory(source, metadata), error => error.code === 'update-invalid-manifest');
  const stale = archive(source, path.join(temporary, 'stale.tar.gz'));
  await assert.rejects(verifyLinuxArchive(stale, metadata), error => error.code === 'update-invalid-manifest');
  const finalized = await finalizeLinuxDirectory(source, metadata);
  const checked = await updater.validateDirectory(source, metadata), profile = checked.manifest.files.find(file => file.path === 'resources/apparmor-profile');
  assert.ok(profile); assert.equal(profile.mode, 0o644); assert.equal(profile.sha256, createHash('sha256').update(fs.readFileSync(path.join(source, profile.path))).digest('hex'));
  assert.equal(finalized.fileCount, 6); assert.deepEqual(fs.readFileSync(sealed), before);
  const again = await finalizeLinuxDirectory(source, metadata); assert.equal(again.manifestHash, finalized.manifestHash, 'Finalization must be idempotent');
});

test('actual USTAR artifact stages and installs to isolated roots with full report and checksum evidence', linux, async t => {
  const { temporary, source } = await fixture(t); lateProfile(source); await finalizeLinuxDirectory(source, metadata);
  const file = archive(source, path.join(temporary, 'WriterDesk-0.6.1-linux-x64.tar.gz')), reportPath = path.join(temporary, 'report.json');
  const report = await verifyLinuxArchive(file, metadata, { reportPath });
  assert.equal(report.passed, true); assert.equal(report.version, metadata.version); assert.equal(report.platform, 'linux'); assert.equal(report.arch, metadata.arch); assert.equal(report.managedInstallPassed, true);
  assert.equal(report.installerScriptPassed, false, 'Synthetic ELF fixtures must never execute'); assert.equal(report.archiveSHA256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report); assert.ok(report.checks.includes('post-target AppArmor profile included'));
});

test('final artifact validation still rejects changed bytes, unlisted files and missing sidecars', linux, async t => {
  const { temporary, source } = await fixture(t); lateProfile(source); await finalizeLinuxDirectory(source, metadata);
  write(path.join(source, 'resources/app.asar'), 'tampered fixture archive');
  await assert.rejects(verifyLinuxArchive(archive(source, path.join(temporary, 'changed.tar.gz')), metadata), error => error.code === 'update-hash-mismatch');
  await finalizeLinuxDirectory(source, metadata);
  write(path.join(source, 'resources/unlisted-extra'), 'not in final manifest');
  await assert.rejects(verifyLinuxArchive(archive(source, path.join(temporary, 'extra.tar.gz')), metadata), error => error.code === 'update-invalid-manifest');
  fs.unlinkSync(path.join(source, 'resources/unlisted-extra'));
  const missing = archive(source, path.join(temporary, 'missing.tar.gz')); fs.unlinkSync(missing.replace(/\.tar\.gz$/, '.sha256'));
  await assert.rejects(verifyLinuxArchive(missing, metadata), error => error.code === 'update-checksum-missing');
});

test('finalization refuses relabeling stale output or following symbolic links', linux, async t => {
  const { temporary, source } = await fixture(t); lateProfile(source);
  await assert.rejects(finalizeLinuxDirectory(source, { version: '0.6.2', arch: 'x64' }), /stale or foreign/);
  const outside = path.join(temporary, 'outside.txt'); write(outside, 'must remain unchanged'); fs.symlinkSync(outside, path.join(source, 'resources/linked-file'));
  await assert.rejects(finalizeLinuxDirectory(source, metadata), error => error.code === 'update-unsafe-archive');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must remain unchanged');
});
