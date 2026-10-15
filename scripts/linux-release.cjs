'use strict';

// FPM targets can add files after electron-builder's afterPack hook. Finalize
// the completed directory before creating an offline TAR, then verify the TAR
// through the same strict updater and installer used on a user's computer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const updater = require('../desktop/updater.cjs');

function metadataChecked(metadata) {
  if (process.platform !== 'linux') throw new Error('Linux offline releases must be finalized and verified on Linux.');
  updater.compareVersions(metadata?.version, metadata?.version);
  if (!['x64', 'arm64'].includes(metadata?.arch)) throw new Error('Unsupported Linux release architecture.');
  return { version: metadata.version, arch: metadata.arch };
}
function profileChecked(checked) {
  if (!checked.manifest.files.some(file => file.path === 'resources/apparmor-profile')) throw new Error('The completed Debian build is missing its AppArmor profile.');
}
async function finalizeLinuxDirectory(directory, metadata) {
  metadata = metadataChecked(metadata);
  directory = path.resolve(directory);
  // Do not relabel an old directory as a newer release. afterPack must already
  // have created the correct version/architecture before the FPM target runs.
  const existing = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (existing.format !== 'writer-desk-release' || existing.platform !== 'linux' || existing.version !== metadata.version || existing.arch !== metadata.arch) throw new Error('Refusing to relabel stale or foreign Linux build output.');
  await updater.createManifest(directory, metadata);
  const checked = await updater.validateDirectory(directory, { arch: metadata.arch, currentVersion: metadata.version });
  profileChecked(checked);
  return { version: checked.manifest.version, platform: 'linux', arch: checked.manifest.arch, manifestHash: checked.manifestHash, fileCount: checked.manifest.files.length };
}
async function archiveDigest(archive) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) digest.update(chunk);
  return digest.digest('hex');
}
function cleanStaging(root) {
  return !fs.readdirSync(root).some(name => name === '.install-lock' || name.startsWith('.staging-'));
}
async function verifyLinuxArchive(archive, metadata, { installerScript = false, reportPath = null } = {}) {
  metadata = metadataChecked(metadata);
  archive = path.resolve(archive);
  if (!archive.endsWith('.tar.gz') || !fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink()) throw new Error('Choose an ordinary Linux release TAR.');
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'writer-linux-release-'));
  try {
    const stageOptions = { root: path.join(temporary, 'staged-app'), applications: path.join(temporary, 'stage-applications'), arch: metadata.arch, currentVersion: metadata.version };
    const staged = await updater.stageArchive(archive, stageOptions);
    if (staged.pendingVersion !== metadata.version || staged.checksumVerified !== true) throw new Error('The TAR contains a different release or failed checksum verification.');
    if (fs.existsSync(path.join(stageOptions.root, 'current')) || fs.existsSync(stageOptions.applications)) throw new Error('Staging unexpectedly activated the app.');
    if (!cleanStaging(stageOptions.root)) throw new Error('Staging left a temporary directory or lock behind.');
    const source = path.join(stageOptions.root, 'versions', metadata.version);
    const checked = await updater.validateDirectory(source, stageOptions);
    profileChecked(checked);

    // Every installer path and desktop entry stays below this unique temporary
    // directory. Neither the user's home nor the user's library is involved.
    const installOptions = { root: path.join(temporary, "managed app '$%"), applications: path.join(temporary, 'applications'), arch: metadata.arch, currentVersion: metadata.version };
    fs.mkdirSync(installOptions.applications, { recursive: true });
    const desktopPath = path.join(installOptions.applications, 'writer-desk.desktop');
    const legacyEntry = '[Desktop Entry]\nExec=/old/disposable/WriterDesk/writer-desk\n';
    fs.writeFileSync(desktopPath, legacyEntry);
    const privateData = path.join(temporary, 'private-user-data', 'writer.sqlite3');
    fs.mkdirSync(path.dirname(privateData));
    fs.writeFileSync(privateData, 'Unchanged disposable authored library');
    if (installerScript) {
      const result = spawnSync('bash', [path.join(source, 'install-linux.sh')], {
        encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024,
        env: { ...process.env, WRITER_DESK_INSTALL_ROOT: installOptions.root, WRITER_DESK_APPLICATIONS_DIR: installOptions.applications,
          WRITER_DESK_USER_DATA: path.dirname(privateData), XDG_DATA_HOME: path.join(temporary, 'xdg-data') }
      });
      if (result.error || result.status !== 0) throw new Error('The packaged install-linux.sh failed: ' + (result.error?.message || result.stderr || result.stdout || result.status));
    } else {
      await updater.installDirectory(source, installOptions);
    }
    const destination = path.join(installOptions.root, 'versions', metadata.version);
    const installed = await updater.validateDirectory(destination, installOptions);
    const active = JSON.parse(fs.readFileSync(path.join(installOptions.root, 'active.json'), 'utf8'));
    if (installed.manifestHash !== checked.manifestHash || active.version !== metadata.version || active.manifestHash !== checked.manifestHash) throw new Error('The installed release differs from the verified TAR.');
    if (fs.readlinkSync(path.join(installOptions.root, 'current')) !== 'versions/' + metadata.version) throw new Error('The managed installation has an incorrect current link.');
    if (active.previousLauncher?.content !== legacyEntry) throw new Error('The previous desktop entry was not retained for recovery.');
    const desktop = fs.readFileSync(desktopPath, 'utf8');
    const quotedLauncher = path.join(installOptions.root, 'launch-writer-desk').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/%/g, '%%');
    if (!desktop.includes('Name=作家工作台\n') || !desktop.includes("Name[en]=Writer's Desk\n") || !desktop.includes('Exec="' + quotedLauncher + '"\n')) throw new Error('The stable bilingual desktop entry is invalid.');
    const launcher = path.join(installOptions.root, 'launch-writer-desk');
    if (!(fs.statSync(launcher).mode & 0o111) || !fs.readFileSync(launcher, 'utf8').includes('current')) throw new Error('The stable launcher is unavailable.');
    if (fs.readFileSync(privateData, 'utf8') !== 'Unchanged disposable authored library' || !cleanStaging(installOptions.root)) throw new Error('Installation touched library data or left staging/lock files.');

    const report = { passed: true, version: metadata.version, platform: 'linux', arch: metadata.arch, archive: path.basename(archive),
      archiveSHA256: await archiveDigest(archive), manifestHash: checked.manifestHash, fileCount: checked.manifest.files.length,
      managedInstallPassed: true, installerScriptPassed: installerScript, checks: ['archive SHA256 verified by updater', 'strict archive extraction and complete final manifest',
        'post-target AppArmor profile included', 'managed installation and stable launcher', 'bilingual desktop entry and previous entry recovery',
        'authored library remains unchanged', 'no staging directories or locks remain'] };
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { finalizeLinuxDirectory, verifyLinuxArchive };
if (require.main === module) {
  const [operation, target, version, arch, report] = process.argv.slice(2);
  const run = operation === 'finalize' && target && version && arch && !report
    ? finalizeLinuxDirectory(target, { version, arch })
    : operation === 'verify' && target && version && arch && report
      ? verifyLinuxArchive(target, { version, arch }, { reportPath: report, installerScript: true })
      : Promise.reject(new Error('Usage: linux-release.cjs finalize DIRECTORY VERSION ARCH | verify ARCHIVE VERSION ARCH REPORT'));
  run.then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
