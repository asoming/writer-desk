#!/usr/bin/env python3
"""Build the Python service on the same OS/architecture as the desktop target."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

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
if target.exists():
    shutil.rmtree(target)
shutil.copytree(build / "service-dist" / "writer-service", target)
print(f"Local service ready: {target}")
