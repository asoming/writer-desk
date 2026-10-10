'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createManifest } = require('./updater.cjs');
module.exports = async context => {
  if (context.electronPlatformName !== 'linux') return;
  const source = context.packager.projectDir;
  const output = context.appOutDir;
  await fs.copyFile(path.join(source, 'desktop', 'install-linux.sh'), path.join(output, 'install-linux.sh'));
  await fs.chmod(path.join(output, 'install-linux.sh'), 0o755);
  await fs.copyFile(path.join(source, 'desktop', 'assets', 'icon.png'), path.join(output, 'writer-desk.png'));
  await fs.copyFile(path.join(source, 'desktop', 'BUILD.md'), path.join(output, 'DESKTOP-README.md'));
  for (const name of ['install-managed.cjs', 'updater.cjs']) await fs.copyFile(path.join(source, 'desktop', name), path.join(output, name));
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  if (!arch) throw new Error('Linux installation currently supports x64 and arm64 only.');
  await createManifest(output, { version: context.packager.appInfo.version, arch });
};
