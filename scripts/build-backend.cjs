'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = process.env.WRITER_DESK_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(command, [path.join(__dirname, 'build-backend.py')], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
