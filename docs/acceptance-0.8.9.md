# 作家工作台 0.8.9 验收

## 本轮范围

长篇沉浸式码字默认显示原有卷章目录。左上角只有目录开关图标，可收起或展开；卷可折叠，章节可点击选择，保留搜索与每章字数。新建、编辑、重命名和重复统计等目录工具隐藏。右侧作品大纲、书名、本次码字与计时，以及退出图标继续保留，系统窗口按钮仍隐藏。

同书切章先保存当前正文，失败留在原章；输入法组合中或另一次切换未完成时不切章。新章载入后重置输入基线，本次统计器、记录编号与开始时间保持不变，第一下新输入正常计数，原有章节文字不算新增码字。退出仍生成一份汇总及首页记录。

左侧目录使用独立的沉浸布局状态，退出恢复普通写作时原有的目录显隐状态。窄窗口的目录和作品大纲轮流打开；选择章节后收起浮层，继续显示正文。短篇仍是一篇连续正文，不显示卷章目录或左上开关。

## 隔离检查

31 项码字模型与界面检查通过，包含跨章连续计数、切章保存失败、组合输入与切换保护、目标被删除、重复点击，以及等待保存时原生退出造成的竞争。26 项原生窗口、preload 与存储检查通过，包含 Mac 退出动画与窗口恢复尚未完成时的取消通知和状态读回。切章与退出共享临时正文锁，任何完成顺序都能恢复可编辑状态。全量 Node 检查共 541 项通过。

真实 Electron 使用生产页面、preload、原生控制器及主进程保存与 Esc 处理，运行独立书库和 101,506 字示例。跨卷切换前故意使保存失败，确认原章和所属卷保留；重试保存成功后载入新章，确认首字计入、两章合计 9 字保存为同一会话，两章正文分别正确保存。

另保持章节保存请求未完成，按原生 Esc，确认先退出系统全屏，保存完成后显示汇总，迟到切章不再执行，正文恢复可编辑。测试同时检查卷折叠、目录收起的滚动与光标、普通目录状态恢复、短篇与英文夜间窄窗口。示例原文件 SHA256 不变，未使用用户真实书库进行测试。

## 发行状态

<!-- verified-release-0.8.9:3838270c6932973bf36819bf1664cd631b341053 -->

最终发行源码为 `3838270c6932973bf36819bf1664cd631b341053`，对应[四平台原生构建](https://github.com/asoming/writer-desk/actions/runs/39103693016)；[0.8.9 测试版](https://github.com/asoming/writer-desk/releases/tag/v0.8.9)已公开。所有下列结果均来自该提交与本轮最终发行文件。


| 平台 | Node 通过 / 总数 | 平台跳过 | GUI 流程 | 新沉浸流程组 | 冻结会话测试 | 安装检查 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| [Linux x64](https://github.com/asoming/writer-desk/actions/runs/39103693016/job/117604978132) | 541 / 541 | 0 | 12 | 12 | 13 | 通过 |
| [Windows x64](https://github.com/asoming/writer-desk/actions/runs/39103693016/job/117604977907) | 537 / 541 | 4 | 12 | 12 | 13 | 通过 |
| [Mac Apple Silicon](https://github.com/asoming/writer-desk/actions/runs/39103693016/job/117604978148) | 537 / 541 | 4 | 12 | 12 | 13 | 通过 |
| [Mac Intel](https://github.com/asoming/writer-desk/actions/runs/39103693016/job/117604978094) | 537 / 541 | 4 | 12 | 12 | 13 | 通过 |

各平台 Node 均无失败或取消。Windows 与 macOS 各 4 项为平台专属跳过；Linux 全部通过。每个平台执行 12 个真实 Electron GUI 流程，新沉浸写作流程含 12 组检查，覆盖目录展开、收起、跨章累计、切章保存失败及窄窗口。原生窗口控制器另通过 Linux / Windows 7 组、Mac 8 组。

每个平台完成 42 套 Python 存储与生命周期回归，以及冻结后的稿件导入、工作区与同步、首页、沉浸会话、对照稿和 Skill 检查。会话测试为 13 项，其中 10 项源码统计模型及参数验证、3 项实际冻结服务 HTTP 流程；它是 42 套回归中的一套，冻结后另行复验。速率半值向上取整，与界面一致。测试的 SQLite 文件检查连接显式关闭，Windows 临时目录清理通过。

实际安装器检查覆盖 Linux DEB、Windows EXE 和两种架构 Mac DMG，包括桌面启动、十万字示例、保存与重启；Linux TAR 另通过托管安装与安装脚本检查。Windows Node 与 Electron 的更新助手各 4 组通过。

下载后的 18 个发行文件完成独立核对，含 6 份 SHA256 侧文件、4 份平台安装报告和 1 份 TAR 报告。Linux TAR 清单含 240 个文件，每项大小与散列一致。打包的沉浸脚本、工作区、首页、手势、主进程、preload 和原生全屏助手逐字节匹配源码；原生退出意图及时取消切章，保存后再次读取原生状态，防止动画期间迟到导航。18 份内置 Skill Markdown 一致，8 组冻结 Skill 流程和 18 次模拟请求通过，101,506 字示例保持完整，未包含私人数据库、密钥或个人规则目录。

| 文件 | SHA256 |
| --- | --- |
| [WriterDesk-0.8.9-linux-amd64.deb](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-linux-amd64.deb) | `13c1e2162b4b97217ce108fcd5a3f42f91bb71cbc656fedd552931d5137f6aa0` |
| [WriterDesk-0.8.9-linux-x64.tar.gz](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-linux-x64.tar.gz) | `b33f7cc33209cbff852d87b24d9706c0a4c3202edce4f2f8cf164d1f1eaee4a0` |
| [WriterDesk-0.8.9-mac-arm64.dmg](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-mac-arm64.dmg) | `6501375a46058c7f401dba7aa9c4ab30775257dbf0646a883fdc2f7c73f9bded` |
| [WriterDesk-0.8.9-mac-x64.dmg](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-mac-x64.dmg) | `4847375a41f1b457411a9a27ce8cc694835c34548586fe1ebad7e32ba97106ea` |
| [WriterDesk-0.8.9-source.zip](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-source.zip) | `8b5ed4d256401afcb12786d5478c9bf24da7d40f07e3e3f138b15cbad15577cc` |
| [WriterDesk-0.8.9-windows-x64.exe](https://github.com/asoming/writer-desk/releases/download/v0.8.9/WriterDesk-0.8.9-windows-x64.exe) | `fe9e0cf5a2db8ef6d96c874c3eac98cff7514dd55e34ea6e1bae8d16b164599c` |

公开联网通道实际通过 固定官网更新索引 发现 0.8.9，下载 TAR 并核对侧文件、下载收据与独立散列，再验证发行清单、暂存新版并生成重启计划。测试只读校验已安装的 0.8.8 资源，再复制到临时安装根；临时活动版本仍为 0.8.8，未执行 0.8.9 激活，未启动 App 或安装器，未访问用户书库，临时文件已清理。此项证明联网升级的检查、下载、校验、暂存与计划流程，不表示用户当前安装已切换到 0.8.9。

日常升级继续使用「设置 → 更新 → 检查更新」，本版需启用「接收预览版」。安装包更新保留为备用。Windows 未签名，macOS 使用临时签名且未公证；Mac 实体触控板手感仍需实机检查。
<!-- /verified-release-0.8.9 -->

## 界面

![目录展开](immersive-chapters-v0.8.9.png)

![目录收起](immersive-chapters-collapsed-v0.8.9.png)

![英文夜间窄窗口](immersive-chapters-English-dark-v0.8.9.png)
