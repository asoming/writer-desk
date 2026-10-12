'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const verify = require('../desktop/before-pack.cjs');

test('native packaging rejects stale, wrong architecture and wrong OS services', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-native-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = path.join(root, 'build', 'backend');
  await fs.mkdir(backend, { recursive: true });
  const context = { electronPlatformName: 'darwin', arch: 3, packager: { projectDir: root, appInfo: { version: '0.5.0' } } };
  const metadata = { version: '0.5.0', arch: 'arm64', platform: 'darwin' };
  const write = value => fs.writeFile(path.join(backend, 'build-info.json'), JSON.stringify(value));
  await assert.rejects(verify(context), /ENOENT/);
  for (const change of [{ version: '0.4.14' }, { arch: 'x64' }, { platform: 'linux' }]) {
    await write({ ...metadata, ...change });
    await assert.rejects(verify(context), /Native service mismatch/);
  }
  await write(metadata);
  await assert.rejects(verify(context), /ENOENT/);
  await fs.writeFile(path.join(backend, 'writer-service'), 'fixture');
  assert.deepEqual(await verify(context), metadata);
  await assert.rejects(verify({ ...context, arch: 0 }), /x64 and arm64/);
});

test('Windows packages require the Windows executable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-windows-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = path.join(root, 'build', 'backend');
  await fs.mkdir(backend, { recursive: true });
  const context = { electronPlatformName: 'win32', arch: 1, packager: { projectDir: root, appInfo: { version: '0.5.0' } } };
  await fs.writeFile(path.join(backend, 'build-info.json'), JSON.stringify({ version: '0.5.0', arch: 'x64', platform: 'win32' }));
  await fs.writeFile(path.join(backend, 'writer-service'), 'wrong binary');
  await assert.rejects(verify(context), /ENOENT/);
  await fs.writeFile(path.join(backend, 'writer-service.exe'), 'fixture');
  assert.equal((await verify(context)).platform, 'win32');
});
