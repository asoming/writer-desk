#!/usr/bin/env python3
"""Build a Linux release without putting personal data into the archive."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text("utf-8"))["version"]
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=root / "dist" / f"WriterDesk-{version}-linux-x64.tar.gz")
args = parser.parse_args()
if sys.platform != "linux" or platform.machine() not in ("x86_64", "amd64"):
    raise SystemExit("This script builds Linux x64 only; build on the matching target OS.")
subprocess.run([sys.executable, str(root / "scripts" / "build-backend.py")], cwd=root, check=True)
subprocess.run(["node", str(root / "node_modules" / "electron-builder" / "cli.js"), "--linux", "--dir", "--x64"], cwd=root, check=True)
args.output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(args.output, "w:gz", compresslevel=6) as archive:
    archive.add(root / "dist" / "linux-unpacked", arcname="WriterDesk")
print(f"Linux desktop release: {args.output.resolve()}")
