#!/usr/bin/env python3
"""Collect only verified native artifacts from the four successful build jobs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def verified_tar_report(files, version, artifacts):
    reports = [path for path in files if path.is_file() and path.name == "linux-tar-verification.json"]
    if len(reports) != 1:
        raise RuntimeError("Missing or duplicate Linux TAR verification report")
    report = reports[0]
    try:
        payload = json.loads(report.read_text("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise RuntimeError("Invalid Linux TAR verification report") from exc
    if (not isinstance(payload, dict) or payload.get("passed") is not True
            or payload.get("version") != version or payload.get("platform") != "linux"
            or payload.get("arch") != "x64" or payload.get("managedInstallPassed") is not True
            or payload.get("installerScriptPassed") is not True):
        raise RuntimeError("Linux TAR verification report failed or mismatched")
    archive_name = f"WriterDesk-{version}-linux-x64.tar.gz"
    archive_digest = hashlib.sha256(artifacts[archive_name].read_bytes()).hexdigest()
    if payload.get("archive") != archive_name or payload.get("archiveSHA256") != archive_digest:
        raise RuntimeError("Linux TAR archive verification mismatch")
    manifest_hash, count, checks = payload.get("manifestHash"), payload.get("fileCount"), payload.get("checks")
    if (not isinstance(manifest_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", manifest_hash)
            or type(count) is not int or count < 1 or not isinstance(checks, list) or not checks
            or any(not isinstance(check, str) or not check.strip() for check in checks)):
        raise RuntimeError("Invalid Linux TAR verification evidence")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
    expected = {
        f"WriterDesk-{version}-linux-amd64.deb", f"WriterDesk-{version}-linux-x64.tar.gz",
        f"WriterDesk-{version}-windows-x64.exe", f"WriterDesk-{version}-mac-arm64.dmg",
        f"WriterDesk-{version}-mac-x64.dmg",
    }
    files = list(args.source.rglob("*"))
    artifacts = {path.name: path for path in files if path.is_file() and path.name in expected}
    if set(artifacts) != expected or sum(path.name in expected for path in files if path.is_file()) != len(expected):
        raise RuntimeError("Missing or duplicate native installer artifacts")
    # A DEB smoke report cannot stand in for running the TAR's own installer.
    # Bind this additional gate to the exact archive collected in this run.
    tar_report = verified_tar_report(files, version, artifacts)
    args.destination.mkdir(parents=True, exist_ok=True)
    checksums = []
    for name, artifact in sorted(artifacts.items()):
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        sidecar_name = name.removesuffix(".tar.gz") + ".sha256" if name.endswith(".tar.gz") else name + ".sha256"
        sidecar = artifact.with_name(sidecar_name)
        if sidecar.read_text("ascii").strip() != f"{digest}  {name}":
            raise RuntimeError(f"Installer checksum mismatch: {name}")
        shutil.copy2(artifact, args.destination / name)
        shutil.copy2(sidecar, args.destination / sidecar_name)
        checksums.append(f"{digest}  {name}")
    platforms = set()
    for report in files:
        if report.name != "installer-smoke.json":
            continue
        payload = json.loads(report.read_text("utf-8"))
        if payload.get("passed") is not True or payload.get("version") != version:
            raise RuntimeError(f"Installer smoke report failed: {report}")
        platform, arch = payload["platform"], payload["arch"]
        key = (platform, arch)
        if key in platforms:
            raise RuntimeError("Duplicate installer smoke report")
        platforms.add(key)
        shutil.copy2(report, args.destination / f"WriterDesk-{version}-{platform}-{arch}-verification.json")
    if platforms != {("linux", "x64"), ("win32", "x64"), ("darwin", "arm64"), ("darwin", "x64")}:
        raise RuntimeError("Missing native installer smoke reports")
    shutil.copy2(tar_report, args.destination / f"WriterDesk-{version}-linux-x64-tar-verification.json")
    source = args.destination / f"WriterDesk-{version}-source.zip"
    subprocess.run(["git", "archive", "--format=zip", f"--output={source.resolve()}", "HEAD"], cwd=ROOT, check=True)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    source.with_name(source.name + ".sha256").write_text(f"{digest}  {source.name}\n", "ascii")
    checksums.append(f"{digest}  {source.name}")
    (args.destination / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", "ascii")
    (args.destination / "release-notes.md").write_text(f"""作家工作台 · Writer's Desk {version}

Skill 详情采用独立弹窗，顶部显示图标、名称和简介，Markdown 按文章排版并隐藏文件头。右上角有滑动开关、更多菜单与关闭按钮，支持打开编辑、在文件管理器中显示、复制原始 Markdown、导出与参考文件切换。默认规则和任务自动保存；立即试用进入当前作品的 AI 对话，保留提示词且不自动发送。适配窄窗口、夜间、护眼与中英文，关闭后恢复原设置位置。

内置三套 App 编写的写作规则及参考资料，随安装包提供，在没有 Codex 目录的新电脑上可直接选择使用。本机已导入的个人规则优先保留；AI 服务地址、模型和密钥仍需在新电脑单独配置。

设置中的写作 Skill 支持新建、编辑、导入 Markdown 或可迁移 JSON、导出、删除个人规则和恢复内置规则。可让 AI 生成规则后预览、修改再保存，也可将 AI 对话回复存为 Skill。生成规则不发送书稿，不会自动保存或改写正文；Skill 只作为 AI 文字上下文，不执行脚本。

保留人物成长轨迹、主脉络与总脉络。主脉络可选择核心人物，总脉络保留全体关系与主题分图；成长轨迹按人物和卷排列，直接编辑档案中的成长内容并跳转到相关正文。短篇保持一份正文。

对照修改将原文与修改稿独立保存到本机。工具栏图标直接退出、不覆盖正文；右上角叉号可选择保存修改、不保存退出或取消。重启后保留两稿和标色，确认保存才更新正文、历史与统计；永久删除同步清理对照稿。

沿用默认首页、统一图标、GitHub 匿名 API 限流时的官网备用更新索引与 AI 流式回复。十万字示例、中文输入法、保存并发、重启恢复和删除后的晚到响应均列入本轮验收。

原生安装包：Linux x64 `.deb`、Windows x64 `.exe`、macOS Apple Silicon / Intel 各自的 `.dmg`。Linux 同时保留离线升级 `.tar.gz`。

支持 Ubuntu 22.04+ 或兼容桌面环境、Windows 10+、macOS 13+。每个包由对应操作系统和 CPU 的原生工作流生成。本次发行收集要求安装包提取/安装、桌面启动、十万字示例、本机保存与重启检查通过；校验报告随包提供。

此批为未签名测试发行版。Windows 未使用发布者证书；macOS 仅作本机 ad-hoc 签名，未使用 Developer ID、未公证。Windows/macOS 可能显示系统安全提示。正式对外分发前需要发布者签名与 Apple 公证。这里不提供关闭系统安全保护的方法。

macOS 下载与处理器对应的包，将 App 拖到 Applications。作品仍保存在原有用户数据目录；卸载安装程序不会主动删除作品库。Linux 的旧用户安装快捷方式可能遮住系统 `.deb` 入口，迁移说明见仓库 `desktop/BUILD.md`。

已提供外部备份位置、卷章拖动与批量整理、拆分合并、同章对照修改、跨书搜索、素材库和增强本地校对。多套 AI 服务可保存并快速切换，AI 用量按提供商实际返回 Token 与作者填写单价计算，未知用量或费用显示不可用。Word / EPUB / PDF 支持可编辑、可复用模板和自定义纸张、字体、页边距、行距及章标题样式。

保留 App 内联网更新，匹配当前平台和架构并校验 SHA256，保存后进入托管升级或原生安装器。Windows 助手等待旧进程退出后再次校验安装器；macOS 当前打开已校验的 DMG 安装引导，不自动替换 App，也不绕过系统安全检查。

保留可自建的手机写作与同步协作，支持本机 / 局域网服务、一次性邀请、权限角色、三方合并和保留原稿的冲突处理。普通局域网 HTTP 支持在线写作，手机 PWA 安装与离线启动需要可信 HTTPS。协作使用周期同步，没有逐键共同光标。

素材随 v4 完整 JSON 备份迁移，继续支持导入 v1–v3。外部盘离线时保留持久待清理记录，重连后重试；不会宣称已清除离线盘、已撤销或离线设备上的副本。保留 0.7.0 的 Word .docx / TXT / Markdown 稿件导入、离线校对、段落批注和书签。

Linux TAR 延续完整清单及包内安装脚本验收，报告绑定本次压缩包 SHA256。TAR 检查验证提取、安装和固定入口，桌面保存重开由对应原生安装包与冻结服务检查覆盖。发行清单在 AppArmor 辅助配置等后处理完成后生成，防止漏项；此前修正版说明见 [0.6.1 打包验收](https://github.com/asoming/writer-desk/blob/main/docs/acceptance-v0.6.1.md)。

沿用 0.6.0 的全书查找与预览替换、版本逐段对比恢复、AI 长篇记忆、伏笔追踪、故事时间线、每日目标/日历/字数趋势、Word/EPUB/PDF 排版导出与可停止的 AI 流式回复，以及正文输入时滚动位置回顶修复。

内置 101,506 字示例《潮汐档案馆》，包含 6 卷 36 章、32 位人物、12 条伏笔与 18 个时间事件。旧示例及个人作品不会被覆盖，可从书架载入新版示例副本。

本轮验收见 [docs/acceptance-{version}.md](https://github.com/asoming/writer-desk/blob/main/docs/acceptance-{version}.md)，功能说明与原有边界见 docs/acceptance-v0.6.0.md。Word 已验证结构和全文完整性；本次环境中的 LibreOffice 渲染受运行库版本限制，尚未验证 Word 阅读器实际分页。PDF 已用 Electron 实际生成完整示例，检查自定义纸张和 Letter 页面尺寸。AI 使用隔离模拟服务验收，没有调用真实收费服务。

Mac 适配双指滚动与惯性、人物图双指平移和以手势位置为中心的捏合缩放。非编辑区域支持横向返回书架，`Command + [` 也可返回；返回前经过保存检查。使用原生窗口按钮及常用 Command 快捷键。实体触控板的手感仍需真人在 Mac 上验证。

下载后可用对应 `.sha256` 或 `SHA256SUMS.txt` 检查文件完整性。此 release 由原生构建工作流生成草稿，验收完成后再发布。
""", "utf-8")
    print(json.dumps({"version": version, "installers": sorted(expected), "nativeReports": len(platforms) + 1}, ensure_ascii=False))


if __name__ == "__main__":
    main()
