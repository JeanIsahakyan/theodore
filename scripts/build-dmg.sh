#!/bin/sh
# The DMG, laid out as a drag-to-install window, from a built .app.
#
#   <app> ──▶ dmgbuild (scripts/dmg-settings.py, layout from tauri.conf.json)
#         ──▶ <out.dmg>: <app> + Applications link, background, 128 px icons
#         ──▶ hdiutil verify
#
# dmgbuild writes the window's .DS_Store directly, so no Finder and no
# AppleScript: the same window on CI (build.yml) as on a desk
# (nightly-build.sh). It runs from a throwaway venv, pinned below; nothing
# is installed globally. Needs python3 >= 3.10 (PYTHON overrides which).
# Signing the DMG is the caller's job (build.yml, with a Developer ID).
#
# Usage: scripts/build-dmg.sh <app-path> <out-dmg> <volume-name>
set -eu

# dmgbuild and its two dependencies, pinned.
DMGBUILD="dmgbuild==1.6.7 ds_store==1.3.3 mac_alias==2.2.3"

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <app-path> <out-dmg> <volume-name>" >&2
  exit 2
fi
app=${1%/}
out=$2
volume=$3

root=$(cd "$(dirname "$0")/.." && pwd)
python=${PYTHON:-python3}

[ -d "$app" ] || { echo "✗ no app bundle at $app" >&2; exit 1; }
command -v "$python" >/dev/null || { echo "✗ $python not found" >&2; exit 1; }
if ! "$python" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "✗ dmgbuild needs python >= 3.10, $python is $("$python" -V 2>&1)" >&2
  echo "  set PYTHON to a newer one (brew install python)." >&2
  exit 1
fi

venv=$(mktemp -d)
trap 'rm -rf "$venv"' EXIT
"$python" -m venv "$venv"
# shellcheck disable=SC2086 # word-split on purpose: one spec per word
"$venv/bin/pip" install --quiet --disable-pip-version-check $DMGBUILD

mkdir -p "$(dirname "$out")"
rm -f "$out"
"$venv/bin/dmgbuild" \
  -s "$root/scripts/dmg-settings.py" \
  -D "app=$app" \
  -D "config=$root/apps/desktop/tauri.conf.json" \
  "$volume" "$out"
hdiutil verify "$out" >/dev/null

echo "✓ $out"
