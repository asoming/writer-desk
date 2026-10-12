#!/usr/bin/env python3
"""Test the app from its actual installer, using only disposable library data."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def only_installer(extension):
    matches = list((ROOT / "dist").glob(f"WriterDesk-*.{extension}"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one .{extension} installer, found {len(matches)}")
    installer = matches[0]
    checksum = installer.with_name(installer.name + ".sha256").read_text("ascii").strip()
    hasher = hashlib.sha256()
    with installer.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    assert checksum == f"{digest}  {installer.name}", "Installer checksum mismatch"
    return installer


def smoke(executable):
    subprocess.run([sys.executable, str(ROOT / "scripts/smoke-native.py"), "--app", str(executable),
                    "--report", str(ROOT / "dist/installer-smoke.json")], check=True)


def main():
    if sys.platform == "win32" and os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Windows installer testing is restricted to disposable GitHub Actions runners because NSIS registers shortcuts and uninstall entries.")
    with tempfile.TemporaryDirectory(prefix="writer-installer-smoke-") as directory:
        temporary = Path(directory)
        if sys.platform == "linux":
            installer = only_installer("deb")
            metadata = subprocess.check_output(["dpkg-deb", "--field", str(installer), "Package", "Version", "Architecture", "Depends"], text=True)
            assert "Package: writer-desk" in metadata and "Architecture: amd64" in metadata
            version = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
            assert f"Version: {version}" in metadata
            subprocess.run(["dpkg-deb", "--extract", str(installer), str(temporary)], check=True)
            entries = list((temporary / "usr/share/applications").glob("*.desktop"))
            assert len(entries) == 1 and "Name=作家工作台" in entries[0].read_text("utf-8")
            executables = list((temporary / "opt").glob("*/writer-desk"))
            assert len(executables) == 1
            smoke(executables[0])
        elif sys.platform == "win32":
            installer = only_installer("exe")
            destination = temporary / "app"
            user_data = Path(os.environ["APPDATA"]) / "writer-desk"
            user_data.mkdir(parents=True, exist_ok=True)
            retained = user_data / "installer-retention-fixture.txt"
            assert not retained.exists()
            retained.write_text("卸载保留作品与偏好🌙", encoding="utf-8")
            try:
                # NSIS requires /D to be the final argument. This affects only the disposable runner.
                subprocess.run([str(installer), "/S", "/D=" + str(destination)], check=True, timeout=180)
                try:
                    smoke(destination / "writer-desk.exe")
                finally:
                    uninstallers = list(destination.glob("Uninstall*.exe"))
                    if uninstallers:
                        subprocess.run([str(uninstallers[0]), "/S", "_?=" + str(destination)], check=True, timeout=120)
                assert uninstallers, "Installed app has no uninstaller"
                assert not (destination / "writer-desk.exe").exists(), "Uninstaller left the app executable"
                assert retained.read_text("utf-8") == "卸载保留作品与偏好🌙", "Uninstall removed user data"
            finally:
                retained.unlink(missing_ok=True)
        else:
            installer = only_installer("dmg")
            mountpoint = temporary / "mounted"
            mountpoint.mkdir()
            subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mountpoint), str(installer)], check=True, timeout=120)
            try:
                bundles = list(mountpoint.glob("*.app"))
                assert len(bundles) == 1
                destination = temporary / bundles[0].name
                subprocess.run(["ditto", str(bundles[0]), str(destination)], check=True)
            finally:
                subprocess.run(["hdiutil", "detach", str(mountpoint)], check=True, timeout=60)
            with (destination / "Contents/Info.plist").open("rb") as handle:
                metadata = plistlib.load(handle)
            assert metadata["CFBundleIdentifier"] == "local.writerdesk.app"
            assert metadata["LSMinimumSystemVersion"] == "13.0"
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(destination)], check=True)
            smoke(destination / "Contents/MacOS" / metadata["CFBundleExecutable"])
    report = ROOT / "dist/installer-smoke.json"
    payload = json.loads(report.read_text("utf-8"))
    payload["installer"] = installer.name
    payload["checks"].append("actual installer extraction/installation")
    payload["checks"].append("installer SHA256 verified")
    if sys.platform == "win32":
        payload["checks"].append("silent uninstall preserves user data")
    report.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")


if __name__ == "__main__":
    main()
