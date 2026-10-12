#!/usr/bin/env python3
"""Build the Python service on the same OS/architecture as the desktop target."""
import os
import json
from pathlib import Path
import platform
import subprocess
import sys
from native_bundle import copy_service_bundle

root = Path(__file__).resolve().parents[1]
python = os.environ.get("WRITER_DESK_BUILD_PYTHON", sys.executable)
build = root / "build"
command = [python, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "writer-service",
           "--distpath", str(build / "service-dist"), "--workpath", str(build / "pyinstaller"),
           "--specpath", str(build), "--add-data", f"{root / 'public'}{os.pathsep}public"]
for example in ("manifest.json", "tide-archive.yejian.json"):
    if (root / "examples" / example).is_file():
        command += ["--add-data", f"{root / 'examples' / example}{os.pathsep}examples"]
for extra in ("sample-library.py", "sample_library.py"):
    if (root / extra).is_file():
        command += ["--add-data", f"{root / extra}{os.pathsep}."]
command += [str(root / "server.py")]
subprocess.run(command, cwd=root, check=True)
target = build / "backend"
copy_service_bundle(build / "service-dist" / "writer-service", target, sys.platform)
machine = platform.machine().lower()
arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
if arch is None:
    raise SystemExit(f"Unsupported native architecture: {machine}")
(target / "build-info.json").write_text(json.dumps({
    "format": "writer-desk-native-service", "platform": sys.platform, "arch": arch,
    "version": json.loads((root / "package.json").read_text("utf-8"))["version"],
    "python": platform.python_version(),
}, indent=2) + "\n", "utf-8")
print(f"Local service ready: {target}")
