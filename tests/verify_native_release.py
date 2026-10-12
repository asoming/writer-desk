"""Release collection fixtures exercise Debian naming and verification gates."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]


class NativeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-release-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source, self.destination = self.base / "artifacts", self.base / "collected"
        self.installers, self.reports = [], []
        targets = (
            ("linux", "x64", ("linux-amd64.deb", "linux-x64.tar.gz")),
            ("win32", "x64", ("windows-x64.exe",)),
            ("darwin", "arm64", ("mac-arm64.dmg",)),
            ("darwin", "x64", ("mac-x64.dmg",)),
        )
        for platform, arch, suffixes in targets:
            folder = self.source / f"native-{platform}-{arch}"
            folder.mkdir(parents=True)
            for suffix in suffixes:
                artifact = folder / f"WriterDesk-{VERSION}-{suffix}"
                artifact.write_bytes(("isolated installer fixture " + artifact.name).encode())
                sidecar = artifact.name.removesuffix(".tar.gz") + ".sha256" if suffix.endswith(".tar.gz") else artifact.name + ".sha256"
                digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
                (folder / sidecar).write_text(f"{digest}  {artifact.name}\n", "ascii")
                self.installers.append(artifact)
            report = folder / "installer-smoke.json"
            report.write_text(json.dumps({"passed": True, "version": VERSION, "platform": platform, "arch": arch}), "utf-8")
            self.reports.append(report)

    def collect(self):
        return subprocess.run([sys.executable, str(ROOT / "scripts/collect-native-release.py"),
                               str(self.source), str(self.destination)], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8", timeout=30)

    def assert_rejected(self, message):
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def test_collects_five_installers_four_reports_and_valid_source_archive(self):
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["nativeReports"], 4)
        self.assertEqual(len(summary["installers"]), 5)
        self.assertIn(f"WriterDesk-{VERSION}-linux-amd64.deb", summary["installers"])
        for artifact in self.installers:
            self.assertEqual((self.destination / artifact.name).read_bytes(), artifact.read_bytes())
        self.assertEqual(len(list(self.destination.glob("*-verification.json"))), 4)
        archive = self.destination / f"WriterDesk-{VERSION}-source.zip"
        with zipfile.ZipFile(archive) as source:
            self.assertIsNone(source.testzip())
            self.assertIn("package.json", source.namelist())
            self.assertEqual(json.loads(source.read("package.json"))["version"], VERSION)
        self.assertEqual(archive.with_name(archive.name + ".sha256").read_text("ascii").strip(),
                         f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}")
        checksum_lines = (self.destination / "SHA256SUMS.txt").read_text("ascii").splitlines()
        self.assertEqual(len(checksum_lines), 6)
        for line in checksum_lines:
            digest, filename = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((self.destination / filename).read_bytes()).hexdigest(), digest)

    def test_missing_installer_is_rejected(self):
        self.installers[0].unlink()
        self.assert_rejected("Missing or duplicate native installer artifacts")

    def test_duplicate_installer_is_rejected(self):
        duplicate = self.source / "unexpected-duplicate"
        duplicate.mkdir()
        (duplicate / self.installers[0].name).write_bytes(self.installers[0].read_bytes())
        self.assert_rejected("Missing or duplicate native installer artifacts")

    def test_tampered_installer_is_rejected(self):
        self.installers[0].write_bytes(b"changed after native verification")
        self.assert_rejected("Installer checksum mismatch")

    def test_missing_native_report_is_rejected(self):
        self.reports[0].unlink()
        self.assert_rejected("Missing native installer smoke reports")

    def test_duplicate_native_report_is_rejected(self):
        duplicate = self.source / "duplicate-report"
        duplicate.mkdir()
        (duplicate / "installer-smoke.json").write_bytes(self.reports[0].read_bytes())
        self.assert_rejected("Duplicate installer smoke report")

    def test_unsuccessful_native_report_is_rejected(self):
        payload = json.loads(self.reports[0].read_text("utf-8"))
        payload["passed"] = False
        self.reports[0].write_text(json.dumps(payload), "utf-8")
        self.assert_rejected("Installer smoke report failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
