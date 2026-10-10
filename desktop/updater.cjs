'use strict';
// Offline Linux releases only. No archive member is ever executed during staging.
// Electron's regular fs treats app.asar as a virtual directory. Release integrity
// checks and copies must inspect the archive bytes on disk instead.
let fs;
try { fs = require('original-fs'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; fs = require('node:fs'); }
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createHash, randomBytes } = require('node:crypto');
const { TextDecoder } = require('node:util');
const MANIFEST = 'release-manifest.json';
const MAX_BYTES = 2 * 1024 ** 3, MAX_FILE = 512 * 1024 ** 2, MAX_FILES = 4096;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) fail('update-invalid-manifest');
  return value.split('.').map(Number);
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function relativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) fail('update-unsafe-archive');
  return value;
}
function directory(value) {
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('update-unsafe-installation');
  }
  return resolved;
}
function paths(options = {}) {
  const share = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return { root: path.resolve(options.root || process.env.WRITER_DESK_INSTALL_ROOT || path.join(share, 'writer-desk', 'app')),
    applications: path.resolve(options.applications || process.env.WRITER_DESK_APPLICATIONS_DIR || path.join(share, 'applications')) };
}
function jsonFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 ** 2) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function atomicJSON(file, value) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
async function locked(options, work) {
  const { root } = paths(options); directory(root);
  const lock = path.join(root, '.install-lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(lock), owner = jsonFile(path.join(lock, 'owner.json'));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(owner?.pid) || owner.pid < 1) fail('update-busy');
    try { process.kill(owner.pid, 0); fail('update-busy'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock, { mode: 0o700 });
  }
  try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return await work(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function filesIn(root, prefix = '') {
  const files = [];
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + item.name : item.name; relativeName(name);
    if (item.isSymbolicLink()) fail('update-unsafe-archive');
    if (item.isDirectory()) files.push(...filesIn(root, name));
    else if (item.isFile()) files.push(name);
    else fail('update-unsafe-archive');
    if (files.length > MAX_FILES) fail('update-too-large');
  }
  return files.sort();
}
async function createManifest(root, metadata) {
  const files = [];
  for (const name of filesIn(root).filter(name => name !== MANIFEST)) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    fs.chmodSync(file, mode);
    files.push({ path: name, size: stat.size, mode, sha256: await hashFile(file) });
  }
  const manifest = { format: 'writer-desk-release', version: metadata.version, platform: 'linux', arch: metadata.arch, entryPoint: 'writer-desk', files };
  versionParts(manifest.version);
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(path.join(root, MANIFEST), 0o644);
  return manifest;
}
async function validateDirectory(root, options = {}) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('update-unsafe-installation');
  directory(root);
  const manifest = jsonFile(path.join(root, MANIFEST));
  if (!manifest || manifest.format !== 'writer-desk-release' || manifest.entryPoint !== 'writer-desk' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) fail('update-invalid-manifest');
  versionParts(manifest.version);
  if (manifest.platform !== 'linux' || manifest.arch !== (options.arch || process.arch) || !['x64', 'arm64'].includes(manifest.arch)) fail('update-wrong-platform');
  if (options.currentVersion && compareVersions(manifest.version, options.currentVersion) < 0) fail('update-downgrade');
  const actual = filesIn(root).filter(name => name !== MANIFEST), expected = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    const name = relativeName(entry?.path);
    if (name === MANIFEST || expected.has(name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || ![0o644, 0o755].includes(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('update-invalid-manifest');
    total += entry.size; if (total > MAX_BYTES) fail('update-too-large'); expected.add(name);
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o7000 || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode || await hashFile(file) !== entry.sha256) fail('update-hash-mismatch');
  }
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) fail('update-invalid-manifest');
  for (const required of ['writer-desk', 'resources/app.asar', 'resources/backend/writer-service', 'install-linux.sh', 'writer-desk.png']) if (!expected.has(required)) fail('update-invalid-manifest');
  const fd = fs.openSync(path.join(root, 'writer-desk'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const elf = Buffer.alloc(20);
  try { if (fs.readSync(fd, elf, 0, elf.length, 0) !== elf.length || !elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== (manifest.arch === 'x64' ? 62 : 183)) fail('update-wrong-platform'); }
  finally { fs.closeSync(fd); }
  if (!(fs.statSync(path.join(root, 'writer-desk')).mode & 0o111)) fail('update-invalid-manifest');
  return { manifest, manifestHash: await hashFile(path.join(root, MANIFEST)) };
}

class TarReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.total = 0; }
  async next() {
    const item = await this.iterator.next();
    if (item.done) return null;
    this.total += item.value.length; if (this.total > MAX_BYTES) fail('update-too-large');
    return item.value;
  }
  async read(size) {
    while (this.buffer.length < size) { const chunk = await this.next(); if (!chunk) fail('update-invalid-archive'); this.buffer = Buffer.concat([this.buffer, chunk]); }
    const value = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return value;
  }
  async finish() {
    if (this.buffer.some(byte => byte !== 0)) fail('update-invalid-archive');
    for (let chunk; (chunk = await this.next()) !== null;) if (chunk.some(byte => byte !== 0)) fail('update-invalid-archive');
  }
}
function tarString(bytes) { const end = bytes.indexOf(0); return decode(end < 0 ? bytes : bytes.subarray(0, end)); }
function tarNumber(bytes) {
  const value = bytes.toString('ascii').replace(/\0/g, '').trim();
  if (!/^[0-7]*$/.test(value)) fail('update-invalid-archive');
  const number = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) fail('update-invalid-archive'); return number;
}
function paxValues(bytes) {
  const result = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space < offset || space - offset > 8) fail('update-invalid-archive');
    const digits = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(digits)) fail('update-invalid-archive');
    const length = Number(digits), end = offset + length;
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) fail('update-invalid-archive');
    const record = decode(bytes.subarray(space + 1, end - 1)), equals = record.indexOf('=');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (equals < 1 || !['path', 'size', 'mtime', 'atime', 'ctime'].includes(key) || Object.hasOwn(result, key)) fail('update-invalid-archive');
    result[key] = value; offset = end;
  }
  return result;
}
async function extractArchive(archive, staging) {
  const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > MAX_FILE || stat.size < 20) { fs.closeSync(fd); fail('update-too-large'); }
  const hash = createHash('sha256'), source = fs.createReadStream(archive, { fd, autoClose: true, start: 0 });
  const gzip = zlib.createGunzip(); source.on('data', bytes => hash.update(bytes)); source.on('error', error => gzip.destroy(error)); source.pipe(gzip);
  const reader = new TarReader(gzip), seen = new Set(); let pax = null, count = 0;
  try {
    for (;;) {
      const header = await reader.read(512);
      if (header.every(byte => byte === 0)) { if (pax || !(await reader.read(512)).every(byte => byte === 0)) fail('update-invalid-archive'); await reader.finish(); break; }
      if (++count > MAX_FILES * 2) fail('update-too-large');
      const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (tarNumber(header.subarray(148, 156)) !== checksum || !['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('ascii'))) fail('update-invalid-archive');
      const type = String.fromCharCode(header[156]), size = tarNumber(header.subarray(124, 136)), mode = tarNumber(header.subarray(100, 108));
      if (size > MAX_FILE || mode & 0o7000) fail('update-unsafe-archive');
      if (type === 'x') {
        if (pax || size > 64 * 1024) fail('update-invalid-archive');
        pax = paxValues(await reader.read(size)); await reader.read((512 - size % 512) % 512); continue;
      }
      if (!['0', '\0', '5'].includes(type) || tarString(header.subarray(157, 257))) fail('update-unsafe-archive');
      const prefix = tarString(header.subarray(345, 500)), original = (prefix ? prefix + '/' : '') + tarString(header.subarray(0, 100));
      let name = pax?.path || original;
      if (pax?.size !== undefined && (!/^\d+$/.test(pax.size) || Number(pax.size) !== size)) fail('update-invalid-archive');
      pax = null;
      if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
      relativeName(name);
      if ((name !== 'WriterDesk' && !name.startsWith('WriterDesk/')) || seen.has(name)) fail('update-unsafe-archive');
      seen.add(name);
      const target = path.join(staging, ...name.split('/'));
      if (type === '5') { if (size !== 0) fail('update-invalid-archive'); directory(target); }
      else {
        if (name === 'WriterDesk') fail('update-invalid-archive');
        directory(path.dirname(target));
        const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode & 0o111 ? 0o755 : 0o644);
        try {
          for (let remaining = size; remaining > 0;) {
            const chunk = await reader.read(Math.min(64 * 1024, remaining)); let written = 0;
            while (written < chunk.length) { const count = fs.writeSync(output, chunk, written); if (!count) fail('update-write-failed'); written += count; }
            remaining -= chunk.length;
          }
          fs.fchmodSync(output, mode & 0o111 ? 0o755 : 0o644);
        }
        finally { fs.closeSync(output); }
        await reader.read((512 - size % 512) % 512);
      }
    }
    return hash.digest('hex');
  } finally {
    source.destroy(); gzip.destroy();
    if (!source.closed) await new Promise(resolve => source.once('close', resolve));
  }
}
function archiveChecksum(archive) {
  if (!/\.tar\.gz$/i.test(archive)) fail('update-invalid-archive');
  const candidates = [archive.replace(/\.tar\.gz$/i, '.sha256'), archive + '.sha256'];
  for (const file of candidates) {
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) fail('update-invalid-checksum');
    const match = fs.readFileSync(file, 'utf8').trim().match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/);
    if (!match || match[2] !== path.basename(archive)) fail('update-invalid-checksum');
    return match[1].toLowerCase();
  }
  fail('update-checksum-missing');
}
async function publish(staging, source, checked, options) {
  const { root } = paths(options), versions = directory(path.join(root, 'versions'));
  const destination = path.join(versions, checked.manifest.version);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('update-unsafe-installation');
    const existing = await validateDirectory(destination, options);
    if (existing.manifestHash !== checked.manifestHash) fail('update-version-conflict');
  } else { fs.renameSync(source, destination); fs.chmodSync(destination, 0o755); }
  const pending = { format: 'writer-desk-pending-update', version: checked.manifest.version, manifestHash: checked.manifestHash,
    source: options.source || '', fromVersion: options.currentVersion || '', createdAt: new Date().toISOString() };
  atomicJSON(path.join(root, 'pending.json'), pending);
  return { pendingVersion: pending.version, restartRequired: true, checksumVerified: true };
}
function minimumInstalledVersion(options) {
  const active = jsonFile(path.join(paths(options).root, 'active.json'));
  if (active?.format !== 'writer-desk-installation' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(active.version || '')) return options;
  if (!options.currentVersion || compareVersions(active.version, options.currentVersion) > 0) return { ...options, currentVersion: active.version };
  return options;
}
async function stageArchive(archive, options = {}) {
  return locked(options, async () => {
    options = minimumInstalledVersion(options);
    const { root } = paths(options), expected = archiveChecksum(archive), staging = fs.mkdtempSync(path.join(root, '.staging-'));
    try {
      const digest = await extractArchive(archive, staging);
      if (digest !== expected) fail('update-hash-mismatch');
      const source = path.join(staging, 'WriterDesk'), checked = await validateDirectory(source, options);
      return await publish(staging, source, checked, { ...options, source: archive });
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
function readPending(options) {
  const { root } = paths(options), pending = jsonFile(path.join(root, 'pending.json'));
  if (!pending || pending.format !== 'writer-desk-pending-update' || !/^[a-f0-9]{64}$/.test(pending.manifestHash)) fail('update-not-staged');
  versionParts(pending.version); return pending;
}
async function planRestart(options = {}) {
  return locked(options, async () => {
    options = minimumInstalledVersion(options);
    const { root } = paths(options), pending = readPending(options), destination = path.join(root, 'versions', pending.version);
    const checked = await validateDirectory(destination, options);
    if (checked.manifestHash !== pending.manifestHash) fail('update-hash-mismatch');
    pending.activationToken = randomBytes(32).toString('hex'); atomicJSON(path.join(root, 'pending.json'), pending);
    return { executable: path.join(destination, 'writer-desk'), token: pending.activationToken, version: pending.version };
  });
}
function desktopQuote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/%/g, '%%') + '"'; }
function shellQuote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function activationFiles(root) {
  const launcher = path.join(root, 'launch-writer-desk');
  return { launcher: '#!/bin/sh\nexec ' + shellQuote(path.join(root, 'current', 'writer-desk')) + ' "$@"\n',
    desktop: '[Desktop Entry]\nType=Application\nName=作家工作台\nName[en]=Writer\'s Desk\nName[zh]=作家工作台\nName[zh_CN]=作家工作台\nComment=本地小说写作与策划工作台\nComment[en]=Local writing studio\nKeywords=作家工作台;作家;写作;小说;Writer\'s Desk;writer;desk;writing;novel;\nExec=' + desktopQuote(launcher) + '\nIcon=' + path.join(root, 'current', 'writer-desk.png') + '\nTerminal=false\nCategories=Office;\nStartupWMClass=writer-desk\n' };
}
function activate(pending, options) {
  const { root, applications } = paths(options); directory(applications);
  const destination = path.join(root, 'versions', pending.version), current = path.join(root, 'current');
  const previous = jsonFile(path.join(root, 'active.json')), desktopFile = path.join(applications, 'writer-desk.desktop');
  let oldLink = null, previousDesktop = null;
  try { const stat = fs.lstatSync(current); if (!stat.isSymbolicLink()) fail('update-unsafe-installation'); oldLink = fs.readlinkSync(current); if (!/^versions\/\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(oldLink)) fail('update-unsafe-installation'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const stat = fs.lstatSync(desktopFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) fail('update-unsafe-installation'); previousDesktop = fs.readFileSync(desktopFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const content = activationFiles(root), nonce = randomBytes(8).toString('hex');
  const active = { format: 'writer-desk-installation', version: pending.version, previousVersion: previous?.version || pending.fromVersion || '',
    versionPath: destination, source: pending.source, manifestHash: pending.manifestHash, pendingCreatedAt: pending.createdAt, activatedAt: new Date().toISOString(),
    previousLauncher: previous?.previousLauncher || (previousDesktop ? { path: desktopFile, content: previousDesktop } : null),
    previousSource: previous?.versionPath || options.previousExecutable || '' };
  const operations = [
    { file: path.join(root, 'launch-writer-desk'), bytes: content.launcher, mode: 0o755 },
    { file: desktopFile, bytes: content.desktop, mode: 0o644 },
    { file: path.join(root, 'active.json'), bytes: JSON.stringify(active, null, 2) + '\n', mode: 0o600 },
    { file: current, link: 'versions/' + pending.version }
  ];
  let applied = 0;
  try {
    for (const item of operations) {
      item.temporary = item.file + '.' + nonce + '.new'; item.backup = item.file + '.' + nonce + '.old'; item.hadPrevious = false;
      try {
        const stat = fs.lstatSync(item.file); item.hadPrevious = true;
        if (item.link) fs.symlinkSync(fs.readlinkSync(item.file), item.backup, 'dir');
        else { if (!stat.isFile() || stat.isSymbolicLink()) fail('update-unsafe-installation'); fs.linkSync(item.file, item.backup); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (item.link) fs.symlinkSync(item.link, item.temporary, 'dir');
      else fs.writeFileSync(item.temporary, item.bytes, { flag: 'wx', mode: item.mode });
    }
    for (const item of operations) { fs.renameSync(item.temporary, item.file); applied++; }
  } catch (error) {
    for (const item of operations.slice(0, applied).reverse()) { if (item.hadPrevious) fs.renameSync(item.backup, item.file); else fs.rmSync(item.file, { force: true }); }
    throw error;
  } finally { for (const item of operations) { for (const file of [item.temporary, item.backup]) if (file) { try { fs.rmSync(file, { force: true }); } catch { } } } }
  try { fs.unlinkSync(path.join(root, 'pending.json')); } catch { /* Active manifest is authoritative; stale pending is hidden by info(). */ }
  return active;
}
async function activatePending(token, executable, options = {}) {
  return locked(options, async () => {
    options = minimumInstalledVersion(options);
    const { root } = paths(options), pending = readPending(options);
    if (options.expectedVersion && pending.version !== options.expectedVersion) fail('update-invalid-manifest');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || pending.activationToken !== token || fs.realpathSync(executable) !== path.join(root, 'versions', pending.version, 'writer-desk')) fail('update-not-staged');
    const checked = await validateDirectory(path.join(root, 'versions', pending.version), options);
    if (checked.manifestHash !== pending.manifestHash) fail('update-hash-mismatch');
    return activate(pending, options);
  });
}
async function installDirectory(source, options = {}) {
  return locked(options, async () => {
    options = minimumInstalledVersion(options);
    await validateDirectory(source, options);
    const { root } = paths(options), staging = fs.mkdtempSync(path.join(root, '.staging-')), copied = path.join(staging, 'WriterDesk');
    try {
      fs.cpSync(source, copied, { recursive: true, dereference: false, errorOnExist: true, force: false });
      const checked = await validateDirectory(copied, options);
      await publish(staging, copied, checked, { ...options, source });
      return activate(readPending(options), options);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
function info(options = {}) {
  const { root } = paths(options), active = jsonFile(path.join(root, 'active.json')), pending = jsonFile(path.join(root, 'pending.json'));
  return { updateSupported: process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch), installPath: root,
    installedVersion: active?.format === 'writer-desk-installation' && typeof active.version === 'string' ? active.version : '',
    pendingVersion: pending?.format === 'writer-desk-pending-update' && pending.createdAt !== active?.pendingCreatedAt && typeof pending.version === 'string' ? pending.version : '' };
}
function errorMessage(error, language = 'zh') {
  const messages = {
    'update-checksum-missing': ['找不到升级包的 SHA256 校验文件。请将同版本 .sha256 与 .tar.gz 放在同一文件夹后重试。', 'The SHA256 checksum file is missing. Place the matching .sha256 file beside the .tar.gz package and try again.'],
    'update-invalid-checksum': ['升级包校验文件不正确，请重新下载同版本文件。', 'The checksum file is invalid. Download the matching release files again.'],
    'update-hash-mismatch': ['升级包或文件校验失败，未切换当前版本。请从可信来源重新下载。', 'Package verification failed. The current version was not changed. Download the release again from a trusted source.'],
    'update-invalid-manifest': ['升级包缺少有效的发行清单，请选择作家工作台的完整 Linux 安装包。', "The release manifest is invalid or missing. Select a complete Writer's Desk Linux package."],
    'update-invalid-archive': ['升级包格式不正确或已损坏，未切换当前版本。', 'The update archive is invalid or damaged. The current version was not changed.'],
    'update-unsafe-archive': ['升级包包含不安全的路径、链接或文件类型，已拒绝安装。', 'The package contains unsafe paths, links or file types and was rejected.'],
    'update-unsafe-installation': ['安装目录或快捷方式包含异常链接，未修改当前版本。请检查安装位置。', 'The installation location or launcher contains an unexpected link. The current version was not changed. Check the installation location.'],
    'update-wrong-platform': ['升级包与当前系统或处理器架构不匹配。', 'The package does not match this operating system or processor architecture.'],
    'update-downgrade': ['请选择当前版本或更新版本的升级包，不能通过此入口降级。', 'Choose the current release or a newer version. Downgrades are not supported here.'],
    'update-version-conflict': ['该版本已安装，但文件与此升级包不同。原版本仍保留，请选择其他版本。', 'This version is already installed with different files. The existing version was preserved. Choose another release.'],
    'update-too-large': ['升级包大小或文件数量超出限制，已停止安装。', 'The package exceeds the size or file-count limit. Installation was stopped.'],
    'update-busy': ['另一个安装或升级正在进行，请稍后重试。', 'Another installation or update is in progress. Try again shortly.'],
    'update-not-staged': ['尚未准备好升级包，请先选择并安装升级包。', 'No verified update is ready. Select and prepare an update package first.'],
    'update-save-failed': ['升级前尚未确认保存完成。请先返回写作界面重试保存，再重启升级。', 'Saving has not completed. Return to your writing, retry saving, then restart to finish the update.'],
    'update-unsupported': ['此安装升级入口目前仅支持 Linux 桌面版。', 'This installation and update workflow currently supports Linux desktop releases only.']
  };
  const fallback = ['无法完成安装升级，请检查磁盘空间和目录权限。当前版本和作品库仍保留。', 'Could not complete the installation or update. Check disk space and folder permissions. The current version and your work are preserved.'];
  return (Object.hasOwn(messages, error?.code) ? messages[error.code] : fallback)[language === 'en' ? 1 : 0];
}
module.exports = { createManifest, validateDirectory, stageArchive, planRestart, activatePending, installDirectory, info, compareVersions, paths, errorMessage };
