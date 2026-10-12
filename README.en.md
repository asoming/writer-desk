<p align="center">
  <img src="desktop/assets/icon.png" width="112" height="112" alt="Writer's Desk icon">
</p>

<h1 align="center">Writer's Desk · 作家工作台</h1>

<p align="center">A quiet, local-first studio for your books, outlines, characters and prose.</p>

<p align="center">
  <a href="README.md">中文介绍</a> ·
  <a href="README.en.md">English guide</a> ·
  <a href="https://asoming.github.io/writer-desk/?lang=en">产品官网 / Website</a> ·
  <a href="https://github.com/asoming/writer-desk/releases/tag/v0.5.0">下载 / Download</a> ·
  <a href="https://github.com/asoming/writer-desk/issues">反馈 / Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/asoming/writer-desk/releases/tag/v0.5.0"><img src="https://img.shields.io/badge/release-v0.5.0%20preview-6366f1" alt="Release v0.5.0 preview"></a>
  <a href="https://github.com/asoming/writer-desk/actions/workflows/native-packages.yml"><img src="https://img.shields.io/github/actions/workflow/status/asoming/writer-desk/native-packages.yml?branch=main&amp;label=Desktop%20builds&amp;logo=github" alt="Desktop builds"></a>
  <img src="https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS-64748b" alt="Platforms: Linux, Windows, macOS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366f1" alt="License: MIT"></a>
</p>

Writer's Desk is a desktop writing app for novels and short stories. Each book has its own cover, outline, characters, relationships and manuscript. Novels use volumes and chapters; short stories use one continuous manuscript.

Writing, saving and backups work offline. AI assistance is optional. The interface supports Chinese and English, light and dark themes, and a warm eye-comfort mode.

[Download](https://github.com/asoming/writer-desk/releases/tag/v0.5.0) · [Chinese quick start](docs/quickstart-zh.md) · [Chinese user guide](docs/user-guide-zh.md) · [Desktop build guide](desktop/BUILD.md)

> Current preview: **0.5.0**. Windows installers are unsigned. macOS apps use ad-hoc signing and have not been notarized by Apple.

## Features

| Area | What you can do |
| --- | --- |
| Bookshelf | Manage novels and short stories separately; edit titles and covers; choose from ten cover templates or upload an image; generate a random title; open each book's folder. |
| Outlines | Organize book, volume, chapter, scene and setting notes; use topic categories and search; read a continuous outline; create a volume and chapter directory from the outline. |
| Character maps | Maintain profiles, aliases, development across volumes and relationships; arrange themed maps and groups; filter relationships; jump between notes and chapters. |
| Writing | Use one writing entry with a layout suited to the book; autosave, search, rename chapters, enter focus mode and resize panels. |
| Data protection | Export individual books as TXT, Markdown or full JSON; preview and restore backups; recover recycled books and deleted chapters; permanently remove app-managed copies after confirmation. |
| Optional AI | Chat beside the outline or manuscript; edit preset prompts or write your own; discover API models; attach and display images; generate titles and covers; use local writing Skills. |
| Desktop | Linux, Windows and macOS installers; bilingual interface; light, dark and eye-comfort themes; native Mac window controls and trackpad support. |

Links between outlines, characters and prose target **chapters** and remain intact when chapters are renamed or reordered. Local name matching and same-chapter mentions are aids for review. You can write relationships manually and review AI proposals before applying them.

## Preview

![Novel writing with chapters, manuscript and AI chat](docs/writing-long-v0.4.10.png)

This screenshot records the 0.4.10 interface. Later versions added theme switching, the work-plan sidebar and chapter history. More previews: [work plan](docs/work-plan-v0.4.14.jpg), [chapter history](docs/chapter-history-v0.4.14.jpg), [image chat](docs/chat-images-v0.4.12.jpg), [dark theme](docs/appearance-night-v0.4.11.jpg), [short-story writing](docs/writing-short-v0.4.10.png), [character maps](docs/people-v0.3.1.png).

## Download and install

Download an installer from the [0.5.0 release](https://github.com/asoming/writer-desk/releases/tag/v0.5.0). Desktop packages include the runtime; end users do not need Python or Node.js.

| Platform | Requirements | Installer |
| --- | --- | --- |
| Linux x64 | Ubuntu 22.04+ or a compatible Debian desktop, glibc 2.35+ | [DEB](https://github.com/asoming/writer-desk/releases/download/v0.5.0/WriterDesk-0.5.0-linux-amd64.deb) |
| Windows x64 | Windows 10 / 11, 64-bit | [EXE](https://github.com/asoming/writer-desk/releases/download/v0.5.0/WriterDesk-0.5.0-windows-x64.exe) |
| Mac, Apple silicon | macOS 13+, M-series processor | [ARM64 DMG](https://github.com/asoming/writer-desk/releases/download/v0.5.0/WriterDesk-0.5.0-mac-arm64.dmg) |
| Mac, Intel | macOS 13+, Intel processor | [x64 DMG](https://github.com/asoming/writer-desk/releases/download/v0.5.0/WriterDesk-0.5.0-mac-x64.dmg) |

- **Linux:** run `sudo apt install ./WriterDesk-0.5.0-linux-amd64.deb` in the download directory, then open 作家工作台 from the application menu.
- **Windows:** run the EXE and follow the installer. It creates desktop and Start menu shortcuts.
- **macOS:** open the DMG, drag the app to Applications, then launch it from Applications.

Save your work and quit the older app before upgrading. Install the new package for your platform; personal books stay in a separate user data directory.

A [Linux TAR package](https://github.com/asoming/writer-desk/releases/download/v0.5.0/WriterDesk-0.5.0-linux-x64.tar.gz) remains available for the existing per-user installation and offline updater. Older user menu entries may take precedence over a new DEB installation; see [Linux installation and launcher migration](desktop/BUILD.md#run-a-linux-release) before switching installation methods.

The release includes SHA256 checksum files and native verification reports. See the [distribution checklist](docs/distribution-checklist.md) for signing and verification details. Mac supports two-finger scrolling, map panning and pinch-to-zoom, and a save-aware swipe back to the bookshelf. Physical trackpad feel still needs hands-on verification.

## Start writing

1. Create a book on the bookshelf, or open the included **潮汐档案馆 / The Tide Archive** sample.
2. Plan the outline, characters and relationships. For a novel, generate the volume and chapter directory from the outline or create it manually.
3. Click the cover, title or **Continue writing**. A novel shows its volume and chapter directory; a short story opens a single continuous manuscript.
4. Link outline notes and character records to chapters, then follow their links to the prose. Related entries in the writing view take you back to the notes.
5. Pause typing to autosave, or press `Ctrl+S` / `Command+S`. Return to the bookshelf to switch books.
6. Use the book's **Export & backup** action to save a full JSON copy. Import that copy on another device to create a separate book.

Book titles are edited through **Cover & title** on the bookshelf. Chapter names can be edited in the directory or manuscript title; both stay in sync.

### Included sample

**The Tide Archive** demonstrates the full writing workflow and is added on first launch.

| Manuscript characters | Volumes / chapters | Characters | Outline nodes | Themed maps | Manual relationships |
| --- | --- | --- | --- | --- | --- |
| 101,506 | 6 / 36 | 32 | 49 | 6 | 35 |

The manuscript is in Chinese. The count includes all non-whitespace characters, including punctuation and Latin letters; it is not an English word count. Read the [full manuscript](examples/潮汐档案馆.txt) or inspect the [complete book data](examples/tide-archive.yejian.json). Smaller novel and short-story examples are also included.

You can edit or remove the samples. Restarting does not overwrite edits or repeatedly restore a removed sample. **Load novel sample** creates a new copy of the original when needed.

## Local data and backups

The desktop app stores books in SQLite under the system user data directory, separate from installed program files. Find the actual location in **Settings → About → Local data directory**.

| Platform | Default database location |
| --- | --- |
| Linux | `~/.config/writer-desk/data/writer.sqlite3`, subject to XDG configuration |
| Windows | `%APPDATA%\writer-desk\data\writer.sqlite3` |
| macOS | `~/Library/Application Support/writer-desk/data/writer.sqlite3` |
| Browser mode from source | `data/writer.sqlite3` in the project directory |

- **Per-book exports:** TXT and Markdown contain the active manuscript. Full JSON includes the cover, volumes, chapters, outlines, characters, relationships and recycled content. Import creates a new book rather than replacing an existing one.
- **Book folders:** **Open folder** creates `正文.txt` and `作品.yejian.json` for that book and updates them after successful saves. Externally modified files are protected; their changes are not imported automatically.
- **History:** automatic snapshots are enabled by default, created after successful saves at five-minute intervals, with up to twenty per book. These settings can be changed. Preview a snapshot before restoring; the app retains the current version.
- **Deletion:** recycled books are retained for thirty days and cleaned up when due. Deleted chapter history records the deletion time and offers restore or permanent deletion. Permanent deletion clears the relevant app-managed copies; exports you made yourself and system backups remain outside its scope.

Keep important full-book JSON backups on another disk. AI conversations, chat images, API keys and local Skills are not included in book JSON exports. Personal databases and local configuration are excluded from source distributions. Detailed recovery and deletion behavior is documented in the [Chinese user guide](docs/user-guide-zh.md).

## Optional AI assistance

In **Settings → AI service**, configure a **Chat Completions-compatible** API base URL, key and model. The app can read the service's `/models` list; enter a model name manually if discovery is unavailable. HTTPS and local HTTP endpoints are supported.

The outline and writing pages have a chat sidebar with editable preset prompts and free-form prompts. Review generated outlines, prose, relationships, titles and covers before applying them. Image understanding requires a vision-capable model; cover generation requires an Images API supported by the configured service.

Book context and attached images are sent only when you submit a request. Ordinary writing, saving and local mention indexing do not need AI. Context size is validated by the model service by default; the app does not impose a fixed character cap or silently truncate your material. API keys are stored in separate local configuration.

**Settings → Writing Skills** imports locally downloaded `chinese-novelist`, `novelskill` and `human-writing` rules as optional AI context. Skill scripts are not executed, and Skill source text is not bundled with the installers. See the [AI and Skill instructions](docs/user-guide-zh.md#ai-辅助) for setup and image limits.

## Run from source

| Use | Requirements |
| --- | --- |
| Local browser mode | Python 3.9+; the saving service uses the standard library |
| Desktop development | Node.js 22.12+, npm and Python 3.9+ |
| Native installers | The above, platform build tools and `scripts/requirements-build.txt`; Python 3.12 is recommended to match native CI |

```sh
git clone https://github.com/asoming/writer-desk.git
cd writer-desk
npm ci
npm start
```

Desktop development uses system Python by default. Set `WRITER_DESK_PYTHON` to choose another interpreter. Electron and build dependencies are pinned in `package-lock.json`.

For browser mode, run `bash start.sh` on Linux / macOS or open `start.bat` on Windows. Alternatively:

```sh
python3 server.py --open
```

Windows can use `py -3 server.py --open`. The default address is `http://127.0.0.1:8765/`, listening only on the local machine. Add `--port 8766` if needed. Keep the terminal open while writing and confirm the saved status before closing it.

### Build and verify

Build on the target operating system and processor architecture. Node.js, Python and the target architecture must match. The saving service is frozen with PyInstaller; cross-operating-system compilation is not supported.

Install npm dependencies with `npm ci`, then install Python build dependencies in a virtual environment with `python -m pip install -r scripts/requirements-build.txt`. Set `WRITER_DESK_BUILD_PYTHON` to that interpreter. Full setup is in the [desktop build guide](desktop/BUILD.md#build-from-source).

| Native build host | Command | Output in `dist/` |
| --- | --- | --- |
| Linux x64 | `npm run build:deb` | DEB, legacy TAR and checksums |
| Windows x64 | `npm run build:win` | NSIS EXE and checksums |
| macOS arm64 | `npm run build:mac -- --arch arm64` | Apple silicon DMG and checksums |
| macOS x64 | `npm run build:mac -- --arch x64` | Intel DMG and checksums |

The manually dispatched [native packages workflow](.github/workflows/native-packages.yml) builds and verifies all four targets before collecting assets into a draft release. Publishing is a separate step.

Representative checks from the project root:

```sh
python3 scripts/test-native.py
python3 tests/verify_sample.py
python3 tests/verify_workflow.py
npm run test:packaging
node --test tests/desktop-mac.test.js tests/gestures.test.js
```

On Windows, replace `python3` with `py -3` or your active environment's `python`. Storage tests use isolated temporary libraries. Installer tests run in native CI; Windows install/uninstall checks are restricted to disposable runners. AI tests use a local mock service, and automated tests do not replace physical trackpad checks or signing and notarization.

The app uses Electron, a vanilla JavaScript interface and a Python saving service. Manuscripts are plain text. Accounts, cloud sync, collaborative editing and DOCX layout are not currently provided.

## Documentation and feedback

- [Chinese quick start](docs/quickstart-zh.md): first use after installation.
- [Chinese user guide](docs/user-guide-zh.md): books, outlines, characters, recovery and AI.
- [Desktop build guide](desktop/BUILD.md): development, native builds, upgrades and migration.
- [Distribution checklist](docs/distribution-checklist.md): system requirements, signing and verification scope.
- [Website maintenance](docs/website.md): static site preview, bilingual content and GitHub Pages deployment.
- [GitHub Issues](https://github.com/asoming/writer-desk/issues): report the app version, operating system, reproduction steps and expected behavior. Remove API keys and private manuscript content from logs and screenshots.

## License

The source code is licensed under the [MIT License](LICENSE). Your manuscripts remain on your computer; using the app does not automatically upload or publish them. Third-party interface dependency licenses are listed in [public/vendor](public/vendor/README.md).
