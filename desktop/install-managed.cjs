'use strict';
const path = require('node:path');
const updater = require('./updater.cjs');
const source = path.resolve(process.argv[2] || __dirname);
if (process.platform !== 'linux') { console.error(updater.errorMessage({ code: 'update-unsupported' })); process.exitCode = 1; }
else updater.installDirectory(source).then(installed => {
  console.info(`作家工作台 ${installed.version} 已安装到：${installed.versionPath}`);
  console.info('应用菜单已使用固定启动入口。正在运行的旧版不会被关闭；请保存并退出后重新打开。');
  console.info(`Writer's Desk ${installed.version} is installed at: ${installed.versionPath}`);
  console.info('The application menu now uses a stable launcher. A running older version is preserved; save and close it, then reopen the app.');
}).catch(error => { console.error(updater.errorMessage(error, process.env.LANG?.startsWith('en') ? 'en' : 'zh')); process.exitCode = 1; });
