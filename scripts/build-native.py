#!/usr/bin/env python3
"""Build installers with a service compiled on the matching native host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
ARCH = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())


def write_checksums(directory):
    artifacts = sorted(path for path in directory.iterdir() if path.is_file() and (
        path.name.endswith((".deb", ".exe", ".dmg", ".tar.gz"))))
    if not artifacts:
        raise RuntimeError("No native installer artifacts were produced")
    for artifact in artifacts:
        checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
        # Existing Linux offline updater expects this exact .sha256 naming convention.
        sidecar = artifact.with_name(artifact.name.removesuffix(".tar.gz") + ".sha256") if artifact.name.endswith(".tar.gz") else artifact.with_name(artifact.name + ".sha256")
        sidecar.write_text(f"{checksum}  {artifact.name}\n", encoding="ascii")
    return artifacts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("linux", "win32", "darwin"), default=sys.platform)
    parser.add_argument("--arch", choices=("x64", "arm64"), default=ARCH)
    parser.add_argument("--skip-backend", action="store_true", help="Use an already verified native backend")
    parser.add_argument("--dir", action="store_true", help="Build an unpacked app only (development verification)")
    args = parser.parse_args()
    if (args.platform, args.arch) != (sys.platform, ARCH):
        parser.error(f"Build on {args.platform}/{args.arch}; this host Python is {sys.platform}/{ARCH}.")
    if args.platform in ("linux", "win32") and args.arch != "x64":
        parser.error("The initial Debian and Windows releases target x64.")
    version = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
    if not args.skip_backend:
        subprocess.run([sys.executable, str(ROOT / "scripts/build-backend.py")], cwd=ROOT, check=True)
    node = os.environ.get("WRITER_DESK_BUILD_NODE", "node")
    node_arch = subprocess.check_output([node, "-p", "process.arch"], text=True).strip()
    if node_arch != args.arch:
        parser.error(f"Node architecture is {node_arch}; use native {args.arch} Node.")
    platform_option, target = {"linux": ("--linux", "deb"), "win32": ("--win", "nsis"), "darwin": ("--mac", "dmg")}[args.platform]
    command = [node, str(ROOT / "node_modules/electron-builder/cli.js"), platform_option]
    command += ["--dir"] if args.dir else [target]
    command += ["--" + args.arch, "--publish", "never"]
    subprocess.run(command, cwd=ROOT, check=True)
    if args.dir:
        return
    output = ROOT / "dist"
    if args.platform == "linux":
        # FPM adds resources/apparmor-profile after afterPack. Regenerate the
        # complete directory manifest only after every target has finished;
        # the already sealed .deb remains unchanged.
        subprocess.run([node, str(ROOT / "scripts/linux-release.cjs"), "finalize",
                        str(output / "linux-unpacked"), version, args.arch], cwd=ROOT, check=True)
        # The independent managed/offline updater remains available beside the .deb.
        with tarfile.open(output / f"WriterDesk-{version}-linux-x64.tar.gz", "w:gz", format=tarfile.USTAR_FORMAT, compresslevel=6) as archive:
            archive.add(output / "linux-unpacked", arcname="WriterDesk")
    artifacts = write_checksums(output)
    if args.platform == "linux":
        # Validate the actual compressed artifact, including its checksum, and
        # exercise the shipped installer against isolated installation paths.
        subprocess.run([node, str(ROOT / "scripts/linux-release.cjs"), "verify",
                        str(output / f"WriterDesk-{version}-linux-x64.tar.gz"), version, args.arch,
                        str(output / "linux-tar-verification.json")], cwd=ROOT, check=True)
    for artifact in artifacts:
        print(f"Native release: {artifact}")


if __name__ == "__main__":
    main()
