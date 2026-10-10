#!/usr/bin/env bash
set -euo pipefail
# Copy a verified release into a stable user-managed installation.
writer_app_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
writer_app_binary="$writer_app_dir/writer-desk"
if [[ ! -x "$writer_app_binary" ]]; then
  printf '%s\n' '请在解压后的 WriterDesk 发行目录运行此脚本。 / Run this script from the extracted distribution.' >&2
  exit 1
fi
if [[ ! -f "$writer_app_dir/install-managed.cjs" || ! -f "$writer_app_dir/release-manifest.json" ]]; then
  printf '%s\n' '发行文件不完整，请重新解压完整安装包。 / Incomplete release; extract the complete package again.' >&2
  exit 1
fi
ELECTRON_RUN_AS_NODE=1 "$writer_app_binary" "$writer_app_dir/install-managed.cjs" "$writer_app_dir"
