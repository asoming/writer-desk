#!/usr/bin/env bash
set -euo pipefail
# Register this extracted distribution in the current user's application menu.
writer_app_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
writer_app_binary="$writer_app_dir/writer-desk"
if [[ ! -x "$writer_app_binary" ]]; then
  printf '%s\n' '请在解压后的 WriterDesk 发行目录运行此脚本。 / Run this script from the extracted distribution.' >&2
  exit 1
fi
writer_desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p -- "$writer_desktop_dir"
python3 - "$writer_app_dir" "$writer_desktop_dir/writer-desk.desktop" <<'PY'
from pathlib import Path
import sys
root, output = Path(sys.argv[1]), Path(sys.argv[2])
def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
output.write_text('[Desktop Entry]\nType=Application\nName=作家工作台\nName[en]=Writer\'s Desk\nName[zh]=作家工作台\nName[zh_CN]=作家工作台\nComment=本地小说写作与策划工作台\nComment[en]=Local writing studio\nKeywords=作家工作台;作家;写作;小说;Writer\'s Desk;writer;desk;writing;novel;\nExec=' + quote(root / 'writer-desk') + '\nIcon=' + str(root / 'writer-desk.png') + '\nTerminal=false\nCategories=Office;\nStartupWMClass=writer-desk\n', encoding='utf-8')
PY
chmod 644 -- "$writer_desktop_dir/writer-desk.desktop"
printf '%s\n' '已添加应用菜单入口。 / Added to the application menu.'
