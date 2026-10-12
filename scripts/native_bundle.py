"""Copy the frozen service without breaking macOS versioned frameworks."""
from pathlib import Path
import shutil


def verify_macos_frameworks(bundle):
    for framework in Path(bundle).rglob("*.framework"):
        binary = framework.stem
        for relative in ("Versions/Current", binary, "Resources"):
            link = framework / relative
            if not link.is_symlink() or not link.exists():
                raise RuntimeError(f"Malformed macOS framework link: {link}")
            if not link.resolve().is_relative_to(framework.resolve()):
                raise RuntimeError(f"macOS framework link escapes its bundle: {link}")
        if not (framework / "Resources/Info.plist").is_file():
            raise RuntimeError(f"Missing macOS framework Info.plist: {framework}")


def copy_service_bundle(source, destination, platform):
    destination = Path(destination)
    if destination.exists():
        shutil.rmtree(destination)
    # PyInstaller 6 reconstructs these links for codesign. Dereferencing turns
    # Python.framework into an ambiguous bundle. Linux's existing managed
    # updater intentionally accepts only ordinary files, so keep its layout.
    shutil.copytree(source, destination, symlinks=platform == "darwin")
    if platform == "darwin":
        verify_macos_frameworks(destination)
