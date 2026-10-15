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
        self.tar_archive = next(path for path in self.installers if path.name.endswith(".tar.gz"))
        self.tar_report = self.tar_archive.parent / "linux-tar-verification.json"
        self.tar_evidence = {
            "passed": True, "version": VERSION, "platform": "linux", "arch": "x64",
            "archive": self.tar_archive.name,
            "archiveSHA256": hashlib.sha256(self.tar_archive.read_bytes()).hexdigest(),
            "manifestHash": hashlib.sha256(b"isolated complete final manifest").hexdigest(),
            "fileCount": 187, "managedInstallPassed": True, "installerScriptPassed": True,
            "checks": ["strict final manifest verified", "managed install and packaged installer passed"],
        }
        self.write_tar_report()

    def write_tar_report(self, **changes):
        self.tar_report.write_text(json.dumps({**self.tar_evidence, **changes}), "utf-8")

    def collect(self):
        return subprocess.run([sys.executable, str(ROOT / "scripts/collect-native-release.py"),
                               str(self.source), str(self.destination)], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8", timeout=30)

    def assert_rejected(self, message):
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def test_collects_five_installers_five_reports_and_valid_source_archive(self):
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["nativeReports"], 5)
        self.assertEqual(len(summary["installers"]), 5)
        self.assertIn(f"WriterDesk-{VERSION}-linux-amd64.deb", summary["installers"])
        for artifact in self.installers:
            self.assertEqual((self.destination / artifact.name).read_bytes(), artifact.read_bytes())
        self.assertEqual(len(list(self.destination.glob("*-verification.json"))), 5)
        self.assertEqual(json.loads((self.destination / f"WriterDesk-{VERSION}-linux-x64-tar-verification.json").read_text("utf-8")), self.tar_evidence)
        notes = (self.destination / "release-notes.md").read_text("utf-8")
        self.assertIn("AppArmor", notes)
        self.assertIn(f"https://github.com/asoming/writer-desk/blob/main/docs/acceptance-{VERSION}.md", notes)
        self.assertIn("同章对照修改", notes)
        self.assertIn("GitHub 匿名 API 限流", notes)
        self.assertIn("可信 HTTPS", notes)
        self.assertIn("未知用量或费用显示不可用", notes)
        self.assertIn("不自动替换 App", notes)
        self.assertIn("https://github.com/asoming/writer-desk/blob/main/docs/acceptance-v0.6.1.md", notes)
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

    def test_missing_tar_report_cannot_be_replaced_by_passing_deb_smoke(self):
        self.tar_report.unlink()
        self.assert_rejected("Missing or duplicate Linux TAR verification report")
        self.assertFalse(self.destination.exists(), "No assets should be staged before the TAR gate")

    def test_duplicate_tar_reports_are_rejected_even_if_they_agree(self):
        duplicate = self.source / "duplicate-tar-report"
        duplicate.mkdir()
        (duplicate / self.tar_report.name).write_bytes(self.tar_report.read_bytes())
        self.assert_rejected("Missing or duplicate Linux TAR verification report")

    def test_tar_report_requires_success_for_both_real_install_paths(self):
        for field in ("passed", "managedInstallPassed", "installerScriptPassed"):
            for value in (False, None, 1, "true"):
                with self.subTest(field=field, value=value):
                    self.write_tar_report(**{field: value})
                    self.assert_rejected("Linux TAR verification report failed or mismatched")

    def test_tar_report_requires_current_version_platform_and_architecture(self):
        for changes in ({"version": "0.0.0"}, {"platform": "win32"}, {"arch": "arm64"}):
            with self.subTest(changes=changes):
                self.write_tar_report(**changes)
                self.assert_rejected("Linux TAR verification report failed or mismatched")

    def test_tar_report_must_name_the_collected_archive(self):
        for name in ("another.tar.gz", "../" + self.tar_archive.name, "", None):
            with self.subTest(name=name):
                self.write_tar_report(archive=name)
                self.assert_rejected("Linux TAR archive verification mismatch")

    def test_tar_report_rejects_wrong_archive_digest(self):
        self.write_tar_report(archiveSHA256="0" * 64)
        self.assert_rejected("Linux TAR archive verification mismatch")

    def test_recomputed_sidecar_does_not_make_a_changed_tar_verified(self):
        self.tar_archive.write_bytes(self.tar_archive.read_bytes() + b" changed after TAR install verification")
        digest = hashlib.sha256(self.tar_archive.read_bytes()).hexdigest()
        sidecar = self.tar_archive.with_name(self.tar_archive.name.removesuffix(".tar.gz") + ".sha256")
        sidecar.write_text(f"{digest}  {self.tar_archive.name}\n", "ascii")
        self.assert_rejected("Linux TAR archive verification mismatch")

    def test_tar_report_requires_manifest_and_check_evidence(self):
        invalid = ({"manifestHash": "bad"}, {"manifestHash": 1}, {"manifestHash": "g" * 64},
                   {"fileCount": 0}, {"fileCount": -1}, {"fileCount": True}, {"fileCount": "187"},
                   {"checks": []}, {"checks": "passed"}, {"checks": [""]}, {"checks": [" "]}, {"checks": [True]})
        for changes in invalid:
            with self.subTest(changes=changes):
                self.write_tar_report(**changes)
                self.assert_rejected("Invalid Linux TAR verification evidence")

    def test_malformed_tar_report_is_rejected(self):
        for content in (b"not-json", b"\xff", b"[]"):
            with self.subTest(content=content):
                self.tar_report.write_bytes(content)
                self.assert_rejected("Linux TAR verification report failed or mismatched" if content == b"[]" else "Invalid Linux TAR verification report")


if __name__ == "__main__":
    unittest.main(verbosity=2)
