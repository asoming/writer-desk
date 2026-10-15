'use strict';
// All paths below are disposable; these checks never install into the real home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const updater = require('../desktop/updater.cjs');
const project = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-updater-test-'));
const options = { root: path.join(temp, "managed path '$%"), applications: path.join(temp, 'applications'), arch: 'x64', currentVersion: '0.4.0' };
let checks = 0;
function passed(name) { checks++; console.log('PASS: ' + name); }
function write(file, bytes, mode = 0o644) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); }
async function fixture(version, suffix = '') {
  const root = path.join(temp, 'release-' + version + suffix), elf = Buffer.alloc(64);
  elf.set([127, 69, 76, 70, 2, 1]); elf.writeUInt16LE(62, 18);
  write(path.join(root, 'writer-desk'), elf, 0o755);
  for (const [file, bytes, mode] of [['resources/app.asar', 'fixture app ' + version, 0o644], ['resources/backend/writer-service', 'fixture service', 0o755], ['install-linux.sh', 'fixture installer', 0o755], ['writer-desk.png', 'fixture icon', 0o644], ['resources/long/' + 'x'.repeat(140) + '.txt', 'PAX path fixture', 0o644]]) write(path.join(root, file), bytes, mode);
  fs.chmodSync(path.join(root, 'resources/app.asar'), 0o664);
  fs.chmodSync(path.join(root, 'install-linux.sh'), 0o775);
  await updater.createManifest(root, { version, arch: 'x64' });
  assert.equal(fs.statSync(path.join(root, 'resources/app.asar')).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(root, 'install-linux.sh')).mode & 0o777, 0o755);
  return root;
}
function header(name, bytes = Buffer.alloc(0), type = '0', link = '', mode = 0o644) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8'); block.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); block.write('00000000000\0', 136);
  block.fill(32, 148, 156); block.write(type, 156); block.write(link, 157, 100); block.write('ustar\0', 257); block.write('00', 263);
  const sum = [...block].reduce((a, b) => a + b, 0); block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function malicious(name, entries, sidecar = true) {
  const archive = path.join(temp, name + '.tar.gz');
  const bytes = zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])); fs.writeFileSync(archive, bytes);
  if (sidecar) fs.writeFileSync(archive.replace(/\.tar\.gz$/, '.sha256'), createHash('sha256').update(bytes).digest('hex') + '  ' + path.basename(archive) + '\n');
  return archive;
}
function pythonArchive(source, basename) {
  const archive = path.join(temp, basename + '.tar.gz');
  const result = spawnSync('python3', ['-c', "import pathlib,tarfile,sys\nwith tarfile.open(sys.argv[2], 'w:gz', format=tarfile.PAX_FORMAT) as t:t.add(sys.argv[1],arcname='WriterDesk')", source, archive], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(archive.replace(/\.tar\.gz$/, '.sha256'), createHash('sha256').update(fs.readFileSync(archive)).digest('hex') + '  ' + path.basename(archive) + '\n');
  return archive;
}
async function rejected(archive, code) {
  const before = fs.existsSync(path.join(options.root, 'current')) ? fs.readlinkSync(path.join(options.root, 'current')) : null;
  await assert.rejects(updater.stageArchive(archive, options), error => !code || error.code === code);
  const after = fs.existsSync(path.join(options.root, 'current')) ? fs.readlinkSync(path.join(options.root, 'current')) : null;
  assert.equal(after, before);
  assert.equal(fs.readdirSync(options.root).some(name => name.startsWith('.staging-') || name === '.install-lock'), false);
}
async function testInstallation() {
  const source = await fixture('0.4.0'); fs.mkdirSync(options.applications);
  const legacyEntry = '[Desktop Entry]\nExec=/old/download/WriterDesk/writer-desk\n';
  write(path.join(options.applications, 'writer-desk.desktop'), legacyEntry);
  const privateData = path.join(temp, 'private-user-data/writer.sqlite3'); write(privateData, 'unchanged authored data');
  const installed = await updater.installDirectory(source, options);
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.0');
  assert.equal(installed.previousLauncher.content, legacyEntry);
  const entry = fs.readFileSync(path.join(options.applications, 'writer-desk.desktop'), 'utf8');
  assert.match(entry, /Name=作家工作台/); assert.match(entry, /Name\[en\]=Writer's Desk/); assert.match(entry, /launch-writer-desk/);
  assert.doesNotMatch(entry, /release-0\.4\.0/);
  const validateDesktop = spawnSync('desktop-file-validate', [path.join(options.applications, 'writer-desk.desktop')], { encoding: 'utf8' });
  assert.equal(validateDesktop.status, 0, validateDesktop.stderr);
  await updater.installDirectory(source, options);
  assert.equal(fs.readdirSync(path.join(options.root, 'versions')).length, 1);
  fs.rmSync(source, { recursive: true });
  assert.equal(fs.existsSync(path.join(options.root, 'current/resources/app.asar')), true);
  assert.equal(fs.readFileSync(privateData, 'utf8'), 'unchanged authored data');
  passed('stable managed install survives deletion of extracted source, is idempotent, preserves old launcher/data and validates bilingual desktop entry');

  const nextSource = await fixture('0.4.1'), archive = pythonArchive(nextSource, 'WriterDesk-0.4.1-linux-x64');
  const staged = await updater.stageArchive(archive, options);
  assert.equal(staged.pendingVersion, '0.4.1'); assert.equal(staged.checksumVerified, true);
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.0');
  assert.equal(updater.info(options).pendingVersion, '0.4.1');
  const planned = await updater.planRestart(options);
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.0');
  await assert.rejects(updater.activatePending('f'.repeat(64), planned.executable, options), error => error.code === 'update-not-staged');
  await assert.rejects(updater.activatePending(planned.token, process.execPath, options), error => error.code === 'update-not-staged');
  await assert.rejects(updater.activatePending(planned.token, planned.executable, { ...options, expectedVersion: '0.4.2' }), error => error.code === 'update-invalid-manifest');
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.0');
  await updater.activatePending(planned.token, planned.executable, { ...options, expectedVersion: '0.4.1' });
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.1');
  assert.deepEqual(fs.readdirSync(path.join(options.root, 'versions')).sort(), ['0.4.0', '0.4.1']);
  assert.equal(updater.info(options).pendingVersion, '');
  passed('Python PAX/fractional timestamps and long paths work; staging/relaunch planning does not switch current; activation requires token, exact executable and running version');

  const third = await fixture('0.4.2'); await updater.stageArchive(pythonArchive(third, 'third'), options);
  const pending = await updater.planRestart(options), before = fs.readFileSync(path.join(options.root, 'active.json'));
  const originalRename = fs.renameSync; let injected = false;
  fs.renameSync = (from, to) => { if (!injected && to === path.join(options.root, 'current')) { injected = true; throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }); } return originalRename(from, to); };
  try { await assert.rejects(updater.activatePending(pending.token, pending.executable, options), error => error.code === 'ENOSPC'); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.1');
  assert.deepEqual(fs.readFileSync(path.join(options.root, 'active.json')), before);
  passed('activation disk failure rolls launcher/manifest back and keeps previous current link');

  write(path.join(options.root, 'versions/0.4.2/resources/app.asar'), 'tampered staged app');
  await assert.rejects(updater.planRestart(options), error => error.code === 'update-hash-mismatch');
  assert.equal(fs.readlinkSync(path.join(options.root, 'current')), 'versions/0.4.1');
  passed('prepared files are verified again before restart; altered staged binaries never activate');

  await rejected(malicious('no-checksum', [header('WriterDesk', Buffer.alloc(0), '5')], false), 'update-checksum-missing');
  const wrong = malicious('wrong-checksum', [header('WriterDesk', Buffer.alloc(0), '5')]);
  fs.writeFileSync(wrong.replace(/\.tar\.gz$/, '.sha256'), '0'.repeat(64) + '  ' + path.basename(wrong));
  await rejected(wrong, 'update-hash-mismatch');
  passed('missing or mismatched adjacent checksum fails without touching active version');

  for (const [name, entry] of [
    ['traversal', header('WriterDesk/../../escaped', Buffer.from('private'))],
    ['absolute', header('/tmp/escaped', Buffer.from('private'))],
    ['symlink', header('WriterDesk/link', Buffer.alloc(0), '2', '/tmp')],
    ['hardlink', header('WriterDesk/link', Buffer.alloc(0), '1', '/tmp')],
    ['device', header('WriterDesk/device', Buffer.alloc(0), '3')],
    ['privileged', header('WriterDesk/file', Buffer.from('x'), '0', '', 0o4755)],
    ['backslash', header('WriterDesk/..\\escaped', Buffer.from('x'))]
  ]) await rejected(malicious(name, [entry]), 'update-unsafe-archive');
  await rejected(malicious('duplicate', [header('WriterDesk/file', Buffer.from('a')), header('WriterDesk/file', Buffer.from('b'))]), 'update-unsafe-archive');
  assert.equal(fs.existsSync(path.join(temp, 'escaped')), false);
  passed('tar traversal, absolute paths, links, devices, privilege bits, backslashes and duplicate members are rejected');

  const badHeader = header('WriterDesk/file', Buffer.from('x')); badHeader[0] ^= 1;
  await rejected(malicious('header-checksum', [badHeader]), 'update-invalid-archive');
  await rejected(malicious('trailing-payload', [header('WriterDesk', Buffer.alloc(0), '5'), Buffer.alloc(1024), Buffer.from('hidden trailing data')]), 'update-invalid-archive');
  const badManifest = await fixture('0.4.3'); fs.appendFileSync(path.join(badManifest, 'resources/app.asar'), 'tampered');
  await rejected(pythonArchive(badManifest, 'manifest-hash'), 'update-hash-mismatch');
  const foreign = await fixture('0.4.4'); const metadata = JSON.parse(fs.readFileSync(path.join(foreign, 'release-manifest.json'))); metadata.arch = 'arm64'; write(path.join(foreign, 'release-manifest.json'), JSON.stringify(metadata));
  await rejected(pythonArchive(foreign, 'wrong-arch'), 'update-wrong-platform');
  const old = await fixture('0.3.9'); await rejected(pythonArchive(old, 'downgrade'), 'update-downgrade');
  const formerlyCurrent = await fixture('0.4.0'); await rejected(pythonArchive(formerlyCurrent, 'older-than-installed'), 'update-downgrade');
  await assert.rejects(updater.installDirectory(formerlyCurrent, { root: options.root, applications: options.applications }), error => error.code === 'update-downgrade');
  passed('corrupt headers/trailing payload, per-file hash changes, wrong architecture and downgrades fail closed');

  const unlisted = await fixture('0.4.5'); write(path.join(unlisted, 'unexpected-script.sh'), 'must not be adopted', 0o755);
  await rejected(pythonArchive(unlisted, 'unlisted'), 'update-invalid-manifest');
  const sameVersion = await fixture('0.4.1', '-different'); write(path.join(sameVersion, 'resources/app.asar'), 'different release'); await updater.createManifest(sameVersion, { version: '0.4.1', arch: 'x64' });
  await rejected(pythonArchive(sameVersion, 'same-version-conflict'), 'update-version-conflict');
  passed('unlisted payloads and different packages sharing a version never overwrite an installed release');

  const rawModule = { exports: {} }; let rawFSRequests = 0;
  vm.runInNewContext(fs.readFileSync(path.join(project, 'desktop/updater.cjs'), 'utf8'), { module: rawModule, exports: rawModule.exports, Buffer, process,
    require: name => { if (name === 'original-fs') { rawFSRequests++; return fs; } if (name === 'node:fs') assert.fail('Electron integrity checks must bypass ASAR virtual fs'); return require(name); } });
  const rawChecked = await rawModule.exports.validateDirectory(path.join(options.root, 'versions/0.4.1'), options);
  assert.equal(rawFSRequests, 1); assert.equal(rawChecked.manifest.version, '0.4.1');
  passed('Electron release validation uses original-fs so app.asar remains an on-disk file; plain Node falls back to standard fs');
}
async function testUpdateBridge() {
  const app = new EventEmitter(), ipcMain = new EventEmitter(); ipcMain.handle = (name, callback) => { ipcMain[name] = callback; };
  app.setPath = app.setName = () => {}; app.getPath = () => temp; app.getVersion = () => '0.4.0'; app.isPackaged = false;
  app.requestSingleInstanceLock = () => true; app.whenReady = () => Promise.resolve(); app.quit = () => {
    const event = { preventDefault() { this.prevented = true; } }; app.emit('before-quit', event);
    assert.equal(event.prevented, undefined, 'The final restart quit must not be blocked');
    assert.notEqual(child?.exitCode, null, 'Restart must wait for the service exit'); app.quitCalled = true; app.emit('quit');
  };
  let win, child, sent, finishService, pipeClosed = 0, selected = { canceled: true, filePaths: [] }, pickerCalls = 0, staged = 0, planned = 0, stageError = null, restartError = null;
  const fakeUpdater = { ...updater, paths: () => ({ root: path.join(temp, 'bridge-install'), applications: path.join(temp, 'bridge-apps') }),
    info: () => ({ updateSupported: true, installPath: '/isolated', installedVersion: '0.4.0', pendingVersion: staged ? '0.4.1' : '' }),
    stageArchive: async file => { assert.equal(file, '/native/picker/release.tar.gz'); if (stageError) throw stageError; staged++; return { pendingVersion: '0.4.1', restartRequired: true, checksumVerified: true }; },
    planRestart: async () => { planned++; if (restartError) throw restartError; return { executable: '/verified/0.4.1/writer-desk', token: 'a'.repeat(64), version: '0.4.1' }; } };
  class FakeWindow extends EventEmitter {
    constructor() { super(); win = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.send = (channel, token) => { sent = { channel, token }; }; this.webContents.setWindowOpenHandler = () => {}; this.webContents.getZoomFactor = () => 1; }
    setMenu() {} setMenuBarVisibility() {} isDestroyed() { return !!this.destroyed; } isFullScreen() { return false; } isMaximized() { return false; }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); } destroy() { this.destroyed = true; this.emit('closed'); app.emit('window-all-closed'); }
  }
  const session = new EventEmitter(); session.webRequest = { onBeforeRequest() {}, onBeforeSendHeaders() {} }; session.setPermissionRequestHandler = session.setPermissionCheckHandler = () => {};
  const electron = { app, ipcMain, BrowserWindow: FakeWindow, Menu: { setApplicationMenu() {} }, session: { fromPartition: () => session }, shell: {}, dialog: { showErrorBox: () => assert.fail('startup'), showOpenDialog: async () => { pickerCalls++; return selected; }, showMessageBox: async () => ({ response: 0 }) } };
  const fakeSpawn = () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.kill = () => assert.fail('Update restart must use the EOF shutdown'); child.stdin = { end() { pipeClosed++; finishService = () => { child.exitCode = 0; child.emit('exit', 0); }; } }; queueMicrotask(() => child.stdout.emit('data', Buffer.from('WRITER_READY {"url":"http://127.0.0.1:39887"}\n'))); return child; };
  const context = { require: name => name === 'electron' ? electron : name === './updater.cjs' ? fakeUpdater : name === 'node:child_process' ? { spawn: fakeSpawn } : name.startsWith('./') ? require(path.join(project, 'desktop', name)) : require(name), __dirname: path.join(project, 'desktop'), process: { ...process, argv: [], env: { ...process.env, WRITER_DESK_USER_DATA: path.join(temp, 'bridge-data') } }, console, setTimeout, clearTimeout, URL, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(project, 'desktop/main.cjs'), 'utf8'), context); await new Promise(resolve => setImmediate(resolve));
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  let bridge; const invokes = [], renderer = new EventEmitter();
  renderer.sendSync = channel => { assert.equal(channel, 'writer:bootstrap'); return { language: 'zh', version: '0.4.0' }; };
  renderer.invoke = (channel, ...args) => { invokes.push({ channel, args }); return ipcMain[channel](event(), ...args); };
  renderer.send = (channel, ...args) => ipcMain.emit(channel, event(), ...args);
  vm.runInNewContext(fs.readFileSync(path.join(project, 'desktop/preload.cjs'), 'utf8'), { require: name => { assert.equal(name, 'electron'); return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'WriterDesktop'); bridge = api; } } }; } });
  for (const channel of ['writer:install-update', 'writer:restart-after-update']) {
    for (const sender of [{ sender: {}, senderFrame: {} }, { sender: win.webContents, senderFrame: { url: win.webContents.mainFrame.url } }]) assert.equal((await ipcMain[channel](sender)).code, 'untrusted-sender');
    assert.equal((await ipcMain[channel](event(), '/arbitrary/renderer/path')).code, 'update-invalid-request');
  }
  assert.equal(pickerCalls, 0);
  assert.equal((await bridge.installUpdate('/renderer/path/must/be/ignored')).canceled, true); assert.equal(staged, 0);
  assert.equal(invokes.at(-1).args.length, 0);
  selected = { canceled: false, filePaths: ['/native/picker/release.tar.gz'] };
  stageError = Object.assign(new Error('private OS path must not be reflected'), { code: 'EACCES' });
  assert.doesNotMatch((await ipcMain['writer:install-update'](event())).error, /private OS/);
  stageError = null; assert.equal((await ipcMain['writer:install-update'](event())).pendingVersion, '0.4.1');
  assert.equal((await ipcMain['writer:restart-after-update'](event())).code, 'update-save-failed'); assert.equal(planned, 0); assert.equal(app.quitCalled, undefined);
  ipcMain.emit('writer:save-ready', event());
  let restart = ipcMain['writer:restart-after-update'](event()); ipcMain.emit('writer:save-result', event(), { token: sent.token, saved: false });
  assert.equal((await restart).code, 'update-save-failed'); assert.equal(child.exitCode, null);
  restartError = Object.assign(new Error('not staged'), { code: 'update-not-staged' });
  restart = ipcMain['writer:restart-after-update'](event()); ipcMain.emit('writer:save-result', event(), { token: sent.token, saved: true });
  assert.equal((await restart).code, 'update-not-staged'); assert.equal(win.destroyed, undefined); assert.equal(child.exitCode, null);
  restartError = null; app.relaunch = () => { throw new Error('relaunch failure'); };
  restart = ipcMain['writer:restart-after-update'](event()); ipcMain.emit('writer:save-result', event(), { token: sent.token, saved: true });
  assert.equal((await restart).code, 'update-failed'); assert.equal(win.destroyed, undefined); assert.equal(child.exitCode, null);
  app.relaunch = value => { app.relaunchOptions = value; };
  restart = bridge.restartAfterUpdate('/renderer/path/must/be/ignored');
  assert.equal(invokes.at(-1).args.length, 0);
  ipcMain.emit('writer:save-result', event(), { token: 'wrong', saved: true }); assert.equal(app.relaunchOptions, undefined);
  ipcMain.emit('writer:save-result', event(), { token: sent.token, saved: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.destroyed, true); assert.equal(pipeClosed, 1); assert.equal(child.exitCode, null); assert.equal(app.quitCalled, undefined);
  const pendingQuit = { preventDefault() { this.prevented = true; } }; app.emit('before-quit', pendingQuit); assert.equal(pendingQuit.prevented, true);
  finishService();
  assert.equal((await restart).restarting, true); assert.equal(app.relaunchOptions.execPath, '/verified/0.4.1/writer-desk');
  assert.equal(app.relaunchOptions.args[0], '--writer-activate-update'); assert.equal(win.destroyed, true); assert.equal(child.exitCode, 0); assert.equal(app.quitCalled, true);
  passed('native update bridge rejects arbitrary paths/frames, preserves old app on save/verification/relaunch failure, then gracefully restarts only after the saved token');
}
(async () => { try { await testInstallation(); await testUpdateBridge(); console.log(`Updater verification complete: ${checks} groups; no real installation or user database was accessed.`); } finally { fs.rmSync(temp, { recursive: true, force: true }); } })().catch(error => { console.error(error); process.exitCode = 1; });
