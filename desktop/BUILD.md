# Desktop build

中文名称 **作家工作台**，英文名称 **Writer's Desk**。桌面版将 Electron 与本机 Python 保存服务放在同一个发行包中，使用时不用安装 Python、Node.js 或浏览器插件。

## Run a Linux release

当前 Linux x64 构建面向 Ubuntu 22.04+ 或兼容环境（glibc 2.35+，GTK 3，X11/Wayland 图形桌面）。解压 `WriterDesk-0.3.3-linux-x64.tar.gz`，运行目录里的 `writer-desk`。可选运行 `install-linux.sh` 添加当前用户的应用菜单入口；注册脚本需要系统 Python 3。入口默认显示“作家工作台”，英语环境显示“Writer's Desk”，可用中英文名称或写作关键词搜索。不要移动已注册的发行目录；移动后重新运行注册脚本。

程序始终启用 Chromium 沙箱。有些 Linux 发行版限制非特权 user namespace，此时请管理员按本机发行版的 Electron/Chromium 沙箱策略配置系统。不要用 `--no-sandbox` 规避。

## Data and migration

- Linux: `~/.config/writer-desk/data/writer.sqlite3`，或系统配置的 XDG appData 位置。
- Windows: `%APPDATA%\writer-desk\data\writer.sqlite3`。
- macOS: `~/Library/Application Support/writer-desk/data/writer.sqlite3`。
- 菜单“文件 → 打开作品数据文件夹”可查到实际目录。卸载程序不应移除这个目录。完整 JSON 备份最适合跨机器迁移。
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

Windows 请在 Windows 本机用 `.venv-build\Scripts\python.exe` 设置 `WRITER_DESK_BUILD_PYTHON`，然后执行 `npm run build:win`；macOS 请在目标架构 Mac 执行 `npm run build:mac`。PyInstaller 的保存服务不能跨操作系统打包。Windows/macOS 配置已提供，当前交付只实际构建、验证 Linux x64。安装包签名、自动更新和商店发布尚未配置。

开发时 `npm start` 启动独立桌面窗口，使用系统 Python 或 `WRITER_DESK_PYTHON` 指定的解释器。`start.sh` / `start.bat` 保留无 Electron 的本地浏览器启动方式。

## Runtime boundaries

渲染进程启用 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`、WebView 和拖拽导航。只有随机端口的 `127.0.0.1` 服务可以被窗口访问；主进程为该 origin 注入每次启动的随机认证 header，网页不持有秘密。网络请求、IPC sender/frame、下载来源、外部协议均有显式限制。外部 HTTP(S) 链接交给系统浏览器。

关闭窗口前由前端回调确认自动保存完成，失败时默认回到工作台，可以重试或导出备份。退出会停止子服务。服务启动超时或异常退出会给出明确提示。

官方 API 依据：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[ContextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)、[Session downloads](https://www.electronjs.org/docs/latest/api/session)、[PyInstaller](https://pyinstaller.org/en/stable/operating-mode.html)。
