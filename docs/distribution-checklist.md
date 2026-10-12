# 0.5.0 跨平台发行

安装包由同一份源码，在对应操作系统与处理器架构上构建。每个安装包附带 SHA256 校验文件；源码和产物保存在 GitHub 仓库，不包含个人作品库、AI 密钥或本机导入的写作 Skill。

| 系统 | 安装包 | 要求 |
| --- | --- | --- |
| Linux | `WriterDesk-0.5.0-linux-amd64.deb` | Ubuntu 22.04+ / 兼容 Debian 系统，amd64 |
| Windows | `WriterDesk-0.5.0-windows-x64.exe` | Windows 10 / 11，64 位 |
| Mac，Apple 芯片 | `WriterDesk-0.5.0-mac-arm64.dmg` | macOS 13+，M 系列芯片 |
| Mac，Intel | `WriterDesk-0.5.0-mac-x64.dmg` | macOS 13+，Intel 芯片 |

Linux 仍提供 `WriterDesk-0.5.0-linux-x64.tar.gz`，供既有用户使用本机离线升级器。

Windows 安装向导可选择安装位置，安装后创建桌面与开始菜单入口；卸载保留作品数据。Mac 打开 DMG 后，将 App 拖到 Applications，再从 Applications 启动，升级时先保存退出旧版。Mac 的最低系统要求依据 [Electron 44 支持范围](https://www.electronjs.org/blog/electron-44-0)。

本轮是未配置发布者证书的测试发行。Windows 安装包未作 Authenticode 签名；Mac 使用本机临时签名，未作 Developer ID 签名和 Apple 公证。测试机能够启动，不代表下载后已通过 Gatekeeper 或 SmartScreen。公开分发前需接入相应证书，并在下载的新副本上验证系统检查。[Apple 的 App 打开与安全说明](https://support.apple.com/en-gb/102445)解释了签名与公证的作用。

## Mac 触控板

- 正文、大纲、列表、提示框与 AI 对话采用原生双指滚动，保留惯性滚动。
- 人物图内双指平移、捏合缩放；缩放以手势所在位置为中心。
- 非编辑区域的横向返回手势调用 App 的返回书架操作，先完成保存；编辑框、图谱、横向列表与弹窗保留自己的操作。
- `Command + [` 也可返回书架。系统的三指 / 四指切换桌面手势由 macOS 管理。
- 使用 Mac 原生红黄绿窗口按钮，支持系统全屏与常用 Command 快捷键。

## 验收边界

自动验收使用隔离的测试作品库，检查原生保存服务启动、认证、示例小说、保存重开、自动备份、作品文件夹、图片读写、章节恢复与彻底删除，并启动实际 Electron 窗口检查资源加载。自动构建成功不能替代实体触控板操作。

Mac 硬件验收需在 Apple 芯片与 Intel 机器各检查一次：长篇与短篇连续滚动；在图谱捏合时中心稳定；双指平移；横向返回前保存；编辑框横向手势不退出作品；中文输入法选字不被打断；窗口全屏与恢复；重新打开后作品、图片和布局保留。正式签名之后还需从下载的 DMG 安装，检查隔离属性与 Gatekeeper。

构建命令、原生 CI 和旧 Linux 图标迁移见 [Desktop build](../desktop/BUILD.md)。
