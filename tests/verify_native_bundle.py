"""Preserve PyInstaller framework links without changing Linux updater files."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from native_bundle import copy_service_bundle, verify_macos_frameworks


@unittest.skipIf(os.name == "nt", "Versioned framework copies are a POSIX packaging contract")
class NativeBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="writer-framework-copy-")
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name) / "service"
        self.destination = Path(self.temporary.name) / "copied"
        self.framework = self.source / "_internal/Python.framework"
        version = self.framework / "Versions/3.12"
        (version / "Resources").mkdir(parents=True)
        (version / "Python").write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture-native-library")
        (version / "Resources/Info.plist").write_text("<plist><dict/></plist>", "utf-8")
        (self.framework / "Versions/Current").symlink_to("3.12", target_is_directory=True)
        (self.framework / "Python").symlink_to("Versions/Current/Python")
        (self.framework / "Resources").symlink_to("Versions/Current/Resources", target_is_directory=True)

    def test_macos_copy_preserves_versioned_framework_aliases(self):
        copy_service_bundle(self.source, self.destination, "darwin")
        copied = self.destination / "_internal/Python.framework"
        for relative in ("Versions/Current", "Python", "Resources"):
            self.assertTrue((copied / relative).is_symlink())
            self.assertEqual(os.readlink(copied / relative), os.readlink(self.framework / relative))
        self.assertEqual((copied / "Python").read_bytes(), (self.framework / "Python").read_bytes())
        self.assertTrue((self.framework / "Python").is_symlink(), "Source layout must stay unchanged")

    def test_linux_copy_stays_plain_for_existing_release_manifest(self):
        copy_service_bundle(self.source, self.destination, "linux")
        self.assertFalse(any(path.is_symlink() for path in self.destination.rglob("*")))
        self.assertEqual((self.destination / "_internal/Python.framework/Python").read_bytes(), (self.framework / "Python").read_bytes())

    def test_framework_validation_rejects_dereferenced_and_escaping_aliases(self):
        copy_service_bundle(self.source, self.destination, "linux")
        with self.assertRaisesRegex(RuntimeError, "Malformed macOS framework link"):
            verify_macos_frameworks(self.destination)
        (self.framework / "Python").unlink()
        external = self.source / "external-library"
        external.write_bytes(b"fixture")
        (self.framework / "Python").symlink_to(external)
        with self.assertRaisesRegex(RuntimeError, "escapes its bundle"):
            verify_macos_frameworks(self.source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
