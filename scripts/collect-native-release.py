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

原生安装包：Linux x64 `.deb`、Windows x64 `.exe`、macOS Apple Silicon / Intel 各自的 `.dmg`。Linux 同时保留离线升级 `.tar.gz`。

支持 Ubuntu 22.04+ 或兼容桌面环境、Windows 10+、macOS 13+。每个包都在对应操作系统和 CPU 上编译本机保存服务，并通过实际安装包提取/安装、桌面启动、十万字示例、本机保存与重启检查；校验报告随包提供。

此批为未签名测试发行版。Windows 未使用发布者证书；macOS 仅作本机 ad-hoc 签名，未使用 Developer ID、未公证。Windows/macOS 可能显示系统安全提示。正式对外分发前需要发布者签名与 Apple 公证。这里不提供关闭系统安全保护的方法。

macOS 下载与处理器对应的包，将 App 拖到 Applications。作品仍保存在原有用户数据目录；卸载安装程序不会主动删除作品库。Linux 的旧用户安装快捷方式可能遮住系统 `.deb` 入口，迁移说明见仓库 `desktop/BUILD.md`。

本版新增 Word .docx / TXT / Markdown 稿件导入，先预览分卷分章、确认后建立独立作品；本地校对提供有限错词规则与每书词典，作者选择修正；段落批注与书签支持保存、跳转、重新关联和历史迁移。十万字示例三格式逐章正文核对完整。

Linux TAR 延续完整清单及包内安装脚本验收，报告绑定本次压缩包 SHA256。TAR 检查验证提取、安装和固定入口，桌面保存重开由对应原生安装包与冻结服务检查覆盖。

沿用 0.6.0 的全书查找与预览替换、版本逐段对比恢复、AI 长篇记忆、伏笔追踪、故事时间线、每日目标/日历/字数趋势、Word/EPUB/PDF 排版导出与可停止的 AI 流式回复，以及正文输入时滚动位置回顶修复。

内置 101,506 字示例《潮汐档案馆》，包含 6 卷 36 章、32 位人物、12 条伏笔与 18 个时间事件。旧示例及个人作品不会被覆盖，可从书架载入新版示例副本。

本轮验收见 [docs/acceptance-v0.7.0.md](https://github.com/asoming/writer-desk/blob/main/docs/acceptance-v0.7.0.md)，功能说明与原有边界见 docs/acceptance-v0.6.0.md。Word 已验证结构和全文完整性；本次环境中的 LibreOffice 渲染受运行库版本限制，尚未验证 Word 阅读器实际分页。PDF 已用 Electron 实际生成并检查分页。AI 使用隔离模拟服务验收，没有调用真实收费服务。

Mac 适配双指滚动与惯性、人物图双指平移和以手势位置为中心的捏合缩放。非编辑区域支持横向返回书架，`Command + [` 也可返回；返回前经过保存检查。使用原生窗口按钮及常用 Command 快捷键。实体触控板的手感仍需真人在 Mac 上验证。

下载后可用对应 `.sha256` 或 `SHA256SUMS.txt` 检查文件完整性。此 release 由原生构建工作流生成草稿，验收完成后再发布。
""", "utf-8")
    print(json.dumps({"version": version, "installers": sorted(expected), "nativeReports": len(platforms) + 1}, ensure_ascii=False))


if __name__ == "__main__":
    main()
