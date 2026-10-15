<p align="center">
  <img src="desktop/assets/icon.png" width="112" height="112" alt="作家工作台图标">
</p>

<h1 align="center">作家工作台 · Writer's Desk</h1>

<p align="center">书架、大纲、人物与正文，在一个安静的本地工作台里。</p>

<p align="center">
  <a href="README.md">中文介绍</a> ·
  <a href="README.en.md">English guide</a> ·
  <a href="https://asoming.github.io/writer-desk/">产品官网 / Website</a> ·
  <a href="https://github.com/asoming/writer-desk/releases/tag/v0.6.0">下载 / Download</a> ·
  <a href="https://github.com/asoming/writer-desk/issues">反馈 / Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/asoming/writer-desk/releases/tag/v0.6.0"><img src="https://img.shields.io/badge/release-v0.6.0%20preview-6366f1" alt="Release v0.6.0 preview"></a>
  <a href="https://github.com/asoming/writer-desk/actions/workflows/native-packages.yml"><img src="https://img.shields.io/github/actions/workflow/status/asoming/writer-desk/native-packages.yml?branch=main&amp;label=Desktop%20builds&amp;logo=github" alt="Desktop builds"></a>
  <img src="https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20macOS-64748b" alt="Platforms: Linux, Windows, macOS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366f1" alt="License: MIT"></a>
</p>

面向小说创作的本地写作 App，将书架、大纲、人物脉络和正文放在同一个工作台。支持多部作品独立管理，长篇按卷章组织，短篇使用连续正文。

写作、保存与备份可离线完成；AI 辅助按需配置。界面支持中文 / English、日夜模式和护眼模式。

*A local-first writing studio for novels and short stories, with outlines, character maps and optional AI assistance.*

[下载安装](https://github.com/asoming/writer-desk/releases/tag/v0.6.0) · [快速上手](docs/quickstart-zh.md) · [使用指南](docs/user-guide-zh.md) · [构建说明](desktop/BUILD.md) · [MIT 许可证](LICENSE)

> 当前源码：**0.6.1**，正在补强 Linux 离线包安装验收。0.6.0 的 DEB、EXE 与 DMG 已通过原生启动检查；Linux TAR 包暂勿用于升级，等待修正版。Windows 发布者签名与 Apple 公证尚未配置。

## 功能

| 模块 | 支持的操作 |
| --- | --- |
| 书架 | 长篇、短篇分别管理；封面与书名编辑；十款封面模板、图片上传、随机书名；打开每本书的独立文件夹 |
| 大纲 | 全书、分卷、章节、情节与设定分层；主题分类与搜索；连续阅读；按大纲生成卷章目录 |
| 人物脉络 | 人物档案、别名、分卷变化与关系；主题分图、阵营分组、关系筛选；与正文双向跳转 |
| 写作 | 长篇卷章、短篇连续正文；自动保存、全书查找替换、章节改名、专注模式、可调分栏 |
| 创作工具 | 伏笔状态与未回收筛选；自定义故事时间线；每日目标、写作日历与 7 / 30 天趋势 |
| 数据保护 | 每本书独立导出、自动备份与历史恢复；正文差异对比、逐段恢复；回收站与删除章节记录 |
| 排版导出 | Word / EPUB / PDF；封面、目录、卷章样式及纸张字号选择 |
| AI 辅助 | 大纲与写作对话；可编辑预设提示词和自由提示词；模型列表读取；图片输入与显示；长篇记忆、流式回复与停止生成；书名与封面生成；本机写作 Skill |
| 桌面体验 | Linux、Windows、macOS 安装包；中英文界面；日夜与护眼模式；Mac 原生窗口按钮及触控板操作 |

大纲、人物与正文的关联定位到**章节**，改名和排序后仍保留。姓名匹配与同章提及使用本地规则，供作者核对；人物关系可手动编写，AI 提取结果需确认后采用。

## 0.6.0 新功能入口

| 操作 | 入口与规则 |
| --- | --- |
| 全书查找替换 | 写作工具栏放大镜，或 `Ctrl / Command + Shift + F / H`；先看匹配预览，按章勾选后批量替换 |
| 正文差异对比 | 「历史记录 → 历史版本与差异对比」，或逐书「导出与备份 → 历史与自动备份」；预览旧版本后点「对比当前稿」，勾选段落恢复 |
| 长篇记忆 | AI 对话的「资料 → 长篇记忆」；本地自动摘录，可编辑；「整理长篇记忆」任务调用已配置 AI，确认候选后保存 |
| 伏笔、时间线与统计 | 大纲或写作工具栏「创作工具」，三个页签按当前作品独立保存 |
| Word / EPUB / PDF | 每本书「导出与备份 → 排版导出」；排版文件不代替完整 JSON 备份 |
| 流式 AI 回复 | 大纲与写作对话逐步显示回复；「停止等待」终止本轮，未完成内容不自动写入正文 |

写作统计显示近 90 天，按本机日期记录成功保存后的正文正增量；导入、整版与逐段恢复不计产量。字数均包含标点、排除空白。正文输入和自动保存保持当前滚动位置，修复了长章中打字回到顶端的问题。详见[使用指南](docs/user-guide-zh.md)和[本轮验收](docs/acceptance-v0.6.0.md)。

## 界面预览

![0.6.0 长篇写作：卷章目录、正文与创作工具](docs/writing-v0.6.0.png)

上图为 0.6.0 实际界面，使用隔离的十万字示例作品。

[伏笔追踪](docs/foreshadows-v0.6.0.png) · [故事时间线](docs/timeline-v0.6.0.png) · [版本差异](docs/versions-v0.6.0.png) · [写作统计](docs/statistics-v0.6.0.png) · [长篇记忆](docs/memory-v0.6.0.png) · [流式回复](docs/streaming-v0.6.0.png) · [作品大纲侧栏](docs/work-plan-v0.4.14.jpg) · [图片对话](docs/chat-images-v0.4.12.jpg) · [夜间模式](docs/appearance-night-v0.4.11.jpg)

## 下载与安装

从 [GitHub 发行页](https://github.com/asoming/writer-desk/releases/tag/v0.6.0) 下载对应安装包。0.6.0 已通过四平台原生构建与实际安装包验收。桌面安装包已包含运行环境，使用时无需另外安装 Python 或 Node.js。

| 平台 | 系统要求 | 0.6.0 安装包 |
| --- | --- | --- |
| Linux x64 | Ubuntu 22.04+ 或兼容 Debian 桌面环境，glibc 2.35+ | [WriterDesk-0.6.0-linux-amd64.deb](https://github.com/asoming/writer-desk/releases/download/v0.6.0/WriterDesk-0.6.0-linux-amd64.deb) |
| Windows x64 | Windows 10 / 11，64 位 | [WriterDesk-0.6.0-windows-x64.exe](https://github.com/asoming/writer-desk/releases/download/v0.6.0/WriterDesk-0.6.0-windows-x64.exe) |
| Mac · Apple 芯片 | macOS 13+，M 系列芯片 | [WriterDesk-0.6.0-mac-arm64.dmg](https://github.com/asoming/writer-desk/releases/download/v0.6.0/WriterDesk-0.6.0-mac-arm64.dmg) |
| Mac · Intel | macOS 13+，Intel 处理器 | [WriterDesk-0.6.0-mac-x64.dmg](https://github.com/asoming/writer-desk/releases/download/v0.6.0/WriterDesk-0.6.0-mac-x64.dmg) |

- **Linux：**在下载目录运行 `sudo apt install ./WriterDesk-0.6.0-linux-amd64.deb`，随后从应用菜单打开「作家工作台」。
- **Windows：**运行 EXE，按安装向导选择目录；安装后创建桌面与开始菜单入口。
- **macOS：**打开 DMG，将 App 拖入 Applications，再从 Applications 启动。

升级前先保存并退出旧版。使用系统安装包的用户，通过相应平台的新版安装包升级；作品保留在独立的用户数据目录。

Linux 离线 TAR 包正在修正文件清单，0.6.0 压缩包暂勿用于安装。修正版继续保留既有用户安装与离线升级方式。旧压缩包的用户菜单入口可能优先打开旧版；迁移到 DEB 前请阅读 [安装与旧图标迁移](desktop/BUILD.md#run-a-linux-release)，避免混用升级入口。

发行页附带各文件的 SHA256 校验文件和汇总清单。平台签名状态、原生验收范围及 Mac 实机检查项见 [跨平台发行说明](docs/distribution-checklist.md)。Mac 支持双指滚动、人物图平移与捏合缩放，以及保存后返回书架的手势；实体触控板手感仍需实机验收。

## 快速上手

1. 在书架新建作品，或打开内置示例《潮汐档案馆》。长篇和短篇在书架中分别管理。
2. 先整理大纲、人物和关系。长篇可按大纲生成卷章目录，也可手动创建卷与章节。
3. 点击封面、书名或「继续写作」进入正文。长篇显示卷章目录，短篇直接编辑一篇连续正文。
4. 在大纲、人物资料中关联章节，点击文字跳转；正文中的关联入口可以返回相应资料。
5. 停止输入后自动保存，也可按 `Ctrl+S` / `Command+S`。切换其他作品时返回书架。
6. 使用这本书右侧的「导出与备份」保存完整 JSON。跨设备迁移时，在目标设备书架导入备份。

作品名统一在书架的「封面与书名」中修改。章节名可在目录或正文标题处修改，两处同步。

### 内置示例

《潮汐档案馆》用于展示和检查完整写作流程，首次启动自动加入书架。

| 正文字符数 | 卷 / 章节 | 人物 | 大纲节点 | 主题分图 | 手动关系 | 伏笔 / 时间事件 |
| --- | --- | --- | --- | --- | --- | --- |
| 101,506 | 6 卷 / 36 章 | 32 | 49 | 6 | 35 | 12 / 18 |

字数按非空白字符统计，包含标点和英文字母。可直接阅读 [完整正文](examples/潮汐档案馆.txt)，或查看 [完整作品数据](examples/tide-archive.yejian.json)。书架还包含简短的长篇与短篇示例。

示例新增 12 条伏笔、18 个故事事件，保持原有正文与设定。可编辑、回收或删除，重启不会覆盖作者修改或反复补入；已有示例未包含新策划时，点击「载入长篇示例」建立新版独立副本。

## 数据与备份

桌面版使用 SQLite，将作品保存在系统用户数据目录；安装与升级不将个人作品写入程序目录。可在「设置 → 关于 → 本机数据目录」查看实际位置。

| 平台 | 默认数据库位置 |
| --- | --- |
| Linux | `~/.config/writer-desk/data/writer.sqlite3`，遵循系统 XDG 配置 |
| Windows | `%APPDATA%\writer-desk\data\writer.sqlite3` |
| macOS | `~/Library/Application Support/writer-desk/data/writer.sqlite3` |
| 源码网页版 | 项目目录下的 `data/writer.sqlite3` |

- **逐书备份：**TXT / Markdown 导出活动正文；完整 JSON 包含封面、卷章、大纲、人物、关系、伏笔、时间线、每日目标、已保存长篇记忆及回收内容。导入会新建作品，保留现有作品。
- **作品文件夹：**「打开文件夹」生成该书的 `正文.txt` 和 `作品.yejian.json`，以后随成功保存更新。外部修改过的文件会受保护，外部改动不会自动导入。
- **历史恢复：**自动备份默认开启，每 5 分钟在成功保存后生成快照，每本书保留最近 20 份，可在设置调整。恢复前先预览，并保留当前版本。
- **删除与回收：**整本书回收后保留 30 天，到期清理；章节历史显示删除时间，可恢复或确认彻底删除。彻底删除会清理 App 管理的相应副本，自行导出和系统备份不在清理范围内。

请将重要作品的完整 JSON 另存到其他磁盘。写作活动统计保存在本机数据库，完整 JSON 包含每日目标，未包含活动记录。AI 对话、聊天图片、密钥和本机 Skill 不包含在作品 JSON 中；个人数据库与本机配置不纳入源码发行包。详细恢复与删除规则见 [使用指南](docs/user-guide-zh.md)。

## 可选 AI 辅助

在「设置 → AI 服务」配置兼容 **Chat Completions** 的 API 基础地址、密钥和模型。支持读取服务的 `/models` 列表，不支持列表的服务可手动填写模型名称。服务地址支持 HTTPS 和本机 HTTP。

大纲与写作页提供右侧流式对话栏，可停止本轮生成，使用预设任务或自由提示词；预设提示词可以修改。生成的大纲、正文、人物关系、章节记忆、书名与封面先预览，再由作者决定采用。长篇记忆默认由本机摘录原文，按相关性选取前文；正文变化后旧摘要标记过期。已勾选的正文资料仍完整发送，不以摘要替换。图片识别和封面生成分别需要服务支持相应的视觉模型与 Images API。

作品资料和图片仅在发送请求时交给所配置的服务；正常写作、保存与本地提及索引无需 AI。上下文默认由模型服务校验，App 不设固定字符上限或自动截断资料。密钥保存在本机独立配置中。

「设置 → 写作 Skill」可导入本机下载的 `chinese-novelist`、`novelskill` 和 `human-writing`，将选定规则作为 AI 上下文。程序不执行 Skill 脚本；Skill 原文不随安装包分发。完整设置及图片限制见 [AI 与 Skill 使用说明](docs/user-guide-zh.md#ai-辅助)。

## 从源码运行

### 环境要求

| 用途 | 前置条件 |
| --- | --- |
| 本地浏览器运行 | Python 3.9+，保存服务仅使用标准库 |
| 桌面开发 | Node.js 22.12+、npm，以及 Python 3.9+ |
| 原生安装包构建 | 上述环境、目标平台的构建工具及 `scripts/requirements-build.txt`；推荐 Python 3.12，与原生 CI 一致 |

获取源码：

```sh
git clone https://github.com/asoming/writer-desk.git
cd writer-desk
```

**桌面开发：**

```sh
npm ci
npm start
```

开发版默认使用系统 Python；可通过 `WRITER_DESK_PYTHON` 指定解释器。Electron 与构建依赖由 `package-lock.json` 固定。

**本地浏览器运行：**Linux / macOS 执行 `bash start.sh`，Windows 双击 `start.bat`。也可直接运行：

```sh
python3 server.py --open
```

Windows 可使用 `py -3 server.py --open`。默认地址为 `http://127.0.0.1:8765/`，仅监听本机；端口占用时添加 `--port 8766`。运行期间保持终端开启，退出前确认「已保存」。

### 构建安装包

在目标系统和对应处理器架构上构建，Node.js、Python 与目标架构须一致。保存服务使用 PyInstaller 打包，不支持跨操作系统编译。

先运行 `npm ci` 安装桌面依赖，再在 Python 虚拟环境中运行 `python -m pip install -r scripts/requirements-build.txt` 安装构建依赖。通过 `WRITER_DESK_BUILD_PYTHON` 指定构建解释器，配置步骤见 [桌面构建说明](desktop/BUILD.md#build-from-source)。

| 原生构建环境 | 命令 | 输出 |
| --- | --- | --- |
| Linux x64 | `npm run build:deb` | DEB、兼容离线升级的 TAR 包及校验文件 |
| Windows x64 | `npm run build:win` | NSIS EXE 安装包及校验文件 |
| macOS arm64 | `npm run build:mac -- --arch arm64` | Apple 芯片 DMG 及校验文件 |
| macOS x64 | `npm run build:mac -- --arch x64` | Intel DMG 及校验文件 |

产物输出到 `dist/`。原生 CI 工作流为 [native-packages.yml](.github/workflows/native-packages.yml)，手动触发后在四种原生环境中构建和验收，全部通过才收集到 GitHub 草稿 Release；发布是单独步骤。

### 验证

在项目根目录运行以下检查。Python 命令在 Windows 可替换为 `py -3`，或使用已激活虚拟环境的 `python`。

```sh
python3 scripts/test-native.py
python3 tests/verify_sample.py
python3 tests/verify_workflow.py
npm run test:packaging
node --test tests/desktop-mac.test.js tests/gestures.test.js
```

Linux 另可运行 `npm run test:desktop` 和 `node scripts/test-updater.cjs` 检查桌面入口与离线升级；需要 `desktop-file-utils` 提供的 `desktop-file-validate`。

存储测试使用隔离的临时作品库。实际安装包检查在原生 CI 中完成，Windows 安装 / 卸载测试限定在一次性 runner。AI 验收使用本机模拟服务，未调用真实付费模型；自动测试也不替代实体触控板、系统签名与公证检查。

## 项目结构

```text
writer-desk/
├── public/             界面、编辑器与人物图
├── website/            中英文产品官网（GitHub Pages）
├── desktop/            Electron 主进程、桥接与升级器
├── server.py           本机 HTTP 服务与 SQLite 保存
├── protection.py       自动备份与历史恢复
├── chapter_history.py  删除章节记录与清理
├── planning.py         伏笔、故事时间线与写作统计
├── story_memory.py     本地长篇记忆及相关前文选择
├── formatted_export.py Word、EPUB 与打印排版
├── ai_service.py       可选 AI 服务接入
├── skills.py           本机写作 Skill 导入与上下文
├── examples/           示例小说与完整作品数据
├── tests/              存储、界面与流程检查
├── scripts/            原生构建与发行验收
└── docs/               使用说明、截图与验收记录
```

桌面版由 Electron、原生 JavaScript 界面和 Python 保存服务组成。正文采用纯文本；当前不提供账号、云端同步或多人协作。Word、EPUB、PDF 是逐书排版导出，编辑器本身保持纯文本。

## 文档与反馈

- [快速上手](docs/quickstart-zh.md)：安装后的首次使用。
- [使用指南](docs/user-guide-zh.md)：书架、大纲、人物、保存恢复和 AI 的详细行为。
- [桌面构建说明](desktop/BUILD.md)：开发环境、平台构建、升级与数据迁移。
- [跨平台发行说明](docs/distribution-checklist.md)：系统要求、签名状态和 Mac 验收边界。
- [官网维护](docs/website.md)：本地预览、中英文内容与 GitHub Pages 部署。
- [0.6.0 功能验收](docs/acceptance-v0.6.0.md)：本轮真实验证、测试入口和待完成事项。
- [更新记录](CHANGELOG.md)：版本变化与兼容规则。

可在 [Issues](https://github.com/asoming/writer-desk/issues) 反馈问题。请附 App 版本、操作系统、复现步骤和预期行为；日志与截图请先移除密钥和私人作品内容。

## 许可证

源代码采用 [MIT License](LICENSE)。作品保存在作者本机，使用本软件不会自动上传或公开正文与资料。第三方界面依赖的许可证见 [public/vendor](public/vendor/README.md)。
