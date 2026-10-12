'use strict';
// PyInstaller cannot cross-compile. Fail before packaging a backend for another OS/CPU.
const fs = require('node:fs/promises');
const path = require('node:path');

async function verifyBackend(context) {
  const platform = context.electronPlatformName;
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  if (!arch) throw new Error('Writer Desk native packages support x64 and arm64 only.');
  const backend = path.join(context.packager.projectDir, 'build', 'backend');
  const metadata = JSON.parse(await fs.readFile(path.join(backend, 'build-info.json'), 'utf8'));
  const version = context.packager.appInfo.version;
  if (metadata.platform !== platform || metadata.arch !== arch || metadata.version !== version) {
    throw new Error(`Native service mismatch: ${metadata.platform}/${metadata.arch}/${metadata.version}; expected ${platform}/${arch}/${version}. Rebuild on the target OS and architecture.`);
  }
  await fs.access(path.join(backend, platform === 'win32' ? 'writer-service.exe' : 'writer-service'));
  return metadata;
}

module.exports = verifyBackend;
