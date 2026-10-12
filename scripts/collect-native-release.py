#!/usr/bin/env python3
"""Collect only verified native artifacts from the four successful build jobs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


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

设置布局、作品大纲、章节历史及原有写作功能保留；macOS 触控板操作改动以本次源码和验收说明为准。实体触控板的手感仍需真人在 Mac 上验证。

下载后可用对应 `.sha256` 或 `SHA256SUMS.txt` 检查文件完整性。此 release 由原生构建工作流生成草稿，验收完成后再发布。
""", "utf-8")
    print(json.dumps({"version": version, "installers": sorted(expected), "nativeReports": len(platforms)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
