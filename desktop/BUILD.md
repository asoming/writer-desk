# Desktop build

中文名称 **作家工作台**，英文名称 **Writer's Desk**。桌面版将 Electron 与本机 Python 保存服务放在同一个发行包中，使用时不用安装 Python、Node.js 或浏览器插件。

## Run a Linux release

Linux x64 构建面向 Ubuntu 22.04+ 或兼容环境（glibc 2.35+，GTK 3，X11/Wayland 图形桌面）。系统安装使用 `sudo apt install ./WriterDesk-0.5.0-linux-amd64.deb`；`apt` 会安装依赖，在 `/opt/Writer's Desk` 放置程序、注册应用菜单，作品仍使用下文的原有数据目录。也可解压 `WriterDesk-0.5.0-linux-x64.tar.gz` 后直接运行目录里的 `writer-desk`，或执行 `bash install-linux.sh` 注册当前用户的固定安装入口。安装脚本使用包内 Electron 的 Node 运行时，不需要系统 Python 或 Node。

以前通过 `.tar.gz` 安装时，`~/.local/share/applications/writer-desk.desktop` 会优先于 `.deb` 的系统菜单入口，导致图标继续打开旧版。迁移到 `.deb` 时，先保存并退出旧版，确认直接运行 `/opt/Writer's Desk/writer-desk` 能打开新版，再将旧用户入口改名为 `writer-desk.desktop.backup`；设置了 `XDG_DATA_HOME` 时使用其 `applications/` 目录。保留旧 `versions/` 目录和作品目录。系统安装脚本不会遍历或修改用户 home；不要混用两套升级入口。后续系统版重新安装新版 `.deb`，用户安装版继续用下述离线 `.tar.gz` 升级。

默认安装目录为 `~/.local/share/writer-desk/app`，遵循 `XDG_DATA_HOME`。各版放在 `versions/<版本号>`，`current` 原子链接指向已启用版本，固定启动器为 `launch-writer-desk`。菜单入口默认显示“作家工作台”，英语环境显示“Writer's Desk”，可用中英文名称或写作关键词搜索。安装完成后可移走原解压目录；旧版安装路径与快捷方式记录在 `active.json`，旧版本目录保留。安装过程不会关闭正在运行的旧版，请保存并退出后从菜单重新打开。

## Offline installation and upgrades

在“设置 → 安装与升级 → 安装升级包”选择可信来源的 `WriterDesk-<版本号>-linux-x64.tar.gz`。同一目录必须有同名 `.sha256` 校验文件，例如 `WriterDesk-0.5.0-linux-x64.sha256`，其内容包含完整压缩包文件名与 SHA256。也支持 `.tar.gz.sha256` 后缀。安装器检查压缩包校验、发行清单、文件散列、架构和版本，拒绝路径穿越、链接、特殊文件以及未列入清单的文件。每个版本的发行目录包含自动生成的 `release-manifest.json`；清单不包含自身的散列。

准备完成只记录 `pending.json`，保持当前版本。点击“重启完成升级”后，程序先确认正文已保存、复验准备好的文件、优雅停止本机服务，再启动新版本。新版本的服务和窗口成功载入后才更新 `current` 与菜单入口；启动失败保留原入口。保存或校验失败会留在原窗口。安装器和设置入口均拒绝降级或用不同文件覆盖同一版本。

也可解压新版后运行其 `bash install-linux.sh` 完成离线升级；此操作在验证复制成功后立即启用新入口，正在运行的窗口继续使用原版，保存退出后重新打开即可。升级始终复用原用户数据目录，不搬移作品库。SHA256 与文件清单用于完整性校验，并非发布者数字签名，应从可信渠道取得升级包。升级流程仅支持 Linux，无网络下载或私有 GitHub 凭据依赖。

程序始终启用 Chromium 沙箱。有些 Linux 发行版限制非特权 user namespace，此时请管理员按本机发行版的 Electron/Chromium 沙箱策略配置系统。不要用 `--no-sandbox` 规避。

## Data and migration

- Linux: `~/.config/writer-desk/data/writer.sqlite3`，或系统配置的 XDG appData 位置。
- Windows: `%APPDATA%\writer-desk\data\writer.sqlite3`。
- macOS: `~/Library/Application Support/writer-desk/data/writer.sqlite3`。
- 左下角“设置 → 关于 → 本机数据目录 → 打开文件夹”可查到实际目录。卸载程序不应移除这个目录。完整 JSON 备份最适合跨机器迁移。
- 第一次启动开发版时，发现源代码目录 `data/` 或相邻旧 `yejian/data/` 会用 SQLite backup 安全复制数据库（包括 WAL 中的已提交内容），源文件保持原样。目标库已存在时绝不覆盖。发行包不包含你的个人作品库；用户可通过“导入备份”迁移。
- 草稿和界面偏好另存于用户目录 `client-storage.json`，不受每次启动端口变化影响。每次修改采用临时文件重命名写入；不依赖安装目录可写。

## Build from source

需要 Node.js 22.12+、Python 3.9+、当前操作系统的构建环境。固定依赖见 `package-lock.json` 和 `scripts/requirements-build.txt`。

```sh
python3 -m venv .venv-build
.venv-build/bin/pip install -r scripts/requirements-build.txt
npm ci
WRITER_DESK_BUILD_PYTHON="$PWD/.venv-build/bin/python" npm run build:linux
```

构建原生安装包时使用以下命令；`build:linux` 保留只生成旧离线包的用法，`build:deb` 同时生成 `.deb` 与离线包。

```sh
npm run build:deb
npm run build:win
npm run build:mac -- --arch arm64
npm run build:mac -- --arch x64
```

Windows 请在 Windows x64 本机用 `.venv-build\Scripts\python.exe` 设置 `WRITER_DESK_BUILD_PYTHON`。macOS 请分别在 Apple Silicon 和 Intel Mac 构建；Node、Python、Electron 和保存服务必须使用同一原生架构。`before-pack.cjs` 检查服务的版本、操作系统及 CPU，拒绝把 Linux 服务误装进 Windows/macOS 包。PyInstaller 不是跨操作系统编译器。

Windows 包支持 Windows 10+ x64，提供可选择目录的当前用户 NSIS 安装器、桌面和开始菜单入口；卸载不主动删除 AppData 作品库。macOS 包支持 macOS 13+，按 arm64 与 x64 分开发行，拖入 Applications 后启动；使用原生窗口按钮、Retina 图标，触控板行为见验收记录。当前 Windows 包无发布者证书，macOS 包仅 ad-hoc 签名，无 Developer ID 和 Apple 公证；这批是未签名测试发行版，首次运行可能遇到系统安全提示。正式公开分发需要补齐证书及公证，不要关闭系统安全保护来绕过检查。网络自动下载更新和商店发布尚未配置。

手动工作流 `.github/workflows/native-packages.yml` 使用 Ubuntu 22.04 x64、Windows Server 2022 x64、macOS 15 arm64 和 macOS 15 Intel 的原生 runner。触发输入须与 `package.json` 版本完全相同。四个任务先跑存储回归，构建后再跑冻结服务的文件夹、备份、图片、章节历史和删除流程；随后从真正的 `.deb`、`.exe`、`.dmg` 提取/安装 App，检查本机保存、重启持久化、101,506 字示例和 Electron 窗口载入。验证都使用临时作品库；Windows NSIS 验证限定在一次性的 GitHub Actions runner。真实触控板手感、Gatekeeper 下载体验和真实 Windows 桌面仍需人工验收。

只有四个原生任务全部成功才收集 SHA256、校验报告、源码 zip 和安装包到 GitHub 草稿 release；工作流不会自动公开发布。可用 `gh workflow run native-packages.yml --ref main -f version=0.5.0` 触发，验收草稿后单独发布。已公开 release 或不同源码提交的同版本草稿不会被覆盖。

Linux 的 `after-pack.cjs` 将普通文件权限统一为 `0644`、可执行文件统一为 `0755` 后生成发行清单。压缩包根目录必须是 `WriterDesk/`，只含普通文件与目录。升级读取器支持 USTAR 和常规 PAX 路径、大小、时间元数据。发行压缩包完成后生成对应 `.sha256`，不要再改包内文件。

```sh
node scripts/test-updater.cjs
npm run test:desktop
```

安装升级测试使用隔离临时目录，验证固定入口、删除原解压目录后仍可运行、PAX、散列与架构检查、错误归档拒绝、激活失败回退，以及前端桥接到主进程的保存重启契约，不修改真实安装或作品库。

开发时 `npm start` 启动独立桌面窗口，使用系统 Python 或 `WRITER_DESK_PYTHON` 指定的解释器。`start.sh` / `start.bat` 保留无 Electron 的本地浏览器启动方式。

## Runtime boundaries

渲染进程启用 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`、WebView 和拖拽导航。只有随机端口的 `127.0.0.1` 服务可以被窗口访问；主进程为该 origin 注入每次启动的随机认证 header，网页不持有秘密。网络请求、IPC sender/frame、下载来源、外部协议均有显式限制。外部 HTTP(S) 链接交给系统浏览器。

桌面窗口隐藏系统标题栏和传统菜单栏。顶部应用栏空白区域可拖动窗口，右上角提供最小化、最大化或还原、关闭按钮。语言、编辑命令、缩放、全屏、关于、数据目录和退出入口集中在左下角“设置”内；回收站与导出入口保持独立。

关闭窗口或“设置 → 退出”前由前端回调确认自动保存完成，失败时默认回到工作台，可以重试或导出备份。退出会停止子服务。服务启动超时或异常退出会给出明确提示。

官方 API 依据：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[ContextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)、[Session downloads](https://www.electronjs.org/docs/latest/api/session)、[PyInstaller](https://pyinstaller.org/en/stable/operating-mode.html)。
