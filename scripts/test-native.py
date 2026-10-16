#!/usr/bin/env python3
"""Data portability regressions. Each suite uses only its own temporary library."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SUITES = (
    "verify_native_bundle.py", "verify_native_smoke.py", "verify_safe_fs.py", "verify_loopback_startup.py", "verify_portable_library.py", "verify_api.py", "verify_protection.py",
    "verify_book_folders.py", "verify_chat_images.py", "verify_chapter_history.py", "verify_comparison_drafts.py",
    "verify_ai.py", "verify_ai_chat.py", "verify_ai_chat_images.py", "verify_ai_cover.py", "verify_ai_models.py", "verify_ai_profiles_usage.py", "verify_ai_stream.py", "verify_skills.py", "verify_skills_frozen.py", "verify_manuscript_import.py", "verify_review_tools.py", "verify_review_workflow.py", "verify_planning.py", "verify_planning_api.py", "verify_home_dashboard.py", "verify_formatted_export.py", "verify_formatted_export_http.py",
    "verify_export_templates.py", "verify_library_search.py", "verify_assets_external.py", "verify_collaboration.py", "verify_extensions_api.py", "verify_sync_shutdown.py",
    "verify_book_purge.py", "verify_book_trash.py", "verify_categories.py", "verify_workflow.py", "verify_short_manuscript.py", "verify_default_demo.py", "verify_sample.py",
)

if __name__ == "__main__":
    # macOS /var points to /private/var. Strict owned storage rejects links,
    # so native fixtures must use the canonical temporary directory.
    environment = {**os.environ, "TMPDIR": str(Path(tempfile.gettempdir()).resolve()),
                   "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    if sys.argv[1:] == ["--frozen"]:
        service = ROOT / "build/backend" / ("writer-service.exe" if sys.platform == "win32" else "writer-service")
        for suite in ("verify_portable_library.py", "verify_comparison_frozen.py", "verify_skills_frozen.py"):
            subprocess.run([sys.executable, str(ROOT / "tests" / suite), "--service", str(service)],
                           cwd=ROOT, check=True, env=environment, timeout=180)
        raise SystemExit(0)
    for suite in SUITES:
        print(f"\nNative regression: {suite}", flush=True)
        subprocess.run([sys.executable, str(ROOT / "tests" / suite)], cwd=ROOT, check=True,
                       env=environment, timeout=180)
