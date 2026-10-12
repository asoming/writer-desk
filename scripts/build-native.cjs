'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const python = process.env.WRITER_DESK_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, [path.join(__dirname, 'build-native.py'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
