#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo '作家工作台：请先安装 Python 3.9 或更新版本。桌面发行版无需安装 Python。'
  exit 1
fi
exec python3 server.py --open "$@"
