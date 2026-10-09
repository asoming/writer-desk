'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'linux') return;
  const source = context.packager.projectDir;
  const output = context.appOutDir;
  await fs.copyFile(path.join(source, 'desktop', 'install-linux.sh'), path.join(output, 'install-linux.sh'));
  await fs.chmod(path.join(output, 'install-linux.sh'), 0o755);
  await fs.copyFile(path.join(source, 'desktop', 'assets', 'icon.png'), path.join(output, 'writer-desk.png'));
  await fs.copyFile(path.join(source, 'desktop', 'BUILD.md'), path.join(output, 'DESKTOP-README.md'));
};
