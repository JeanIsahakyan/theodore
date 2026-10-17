#!/bin/sh
# Bumps the workspace version everywhere it's duplicated: Cargo.toml
# [workspace.package] and apps/desktop/tauri.conf.json. Run once per release,
# before tagging (plan §11.1: tag == Cargo.toml version == tauri.conf version).
#
# Usage: scripts/bump-version.sh 0.3.0
set -eu

ver=${1:-}
case "$ver" in
  '') echo "usage: $0 <version>" >&2; exit 1 ;;
esac
case "$ver" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "✗ '$ver' is not a plain semver (expected X.Y.Z, no leading 'v')." >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
cargo_toml="$root/Cargo.toml"
tauri_conf="$root/apps/desktop/tauri.conf.json"

for f in "$cargo_toml" "$tauri_conf"; do
  [ -f "$f" ] || { echo "✗ missing $f" >&2; exit 1; }
done

# [workspace.package] version = "x.y.z" — only the first `version = "..."`
# line, which belongs to that table.
awk -v ver="$ver" '
  /^\[workspace\.package\]/ { in_block = 1 }
  /^\[/ && !/^\[workspace\.package\]/ { in_block = 0 }
  in_block && /^version = "/ && !done {
    print "version = \"" ver "\""
    done = 1
    next
  }
  { print }
' "$cargo_toml" > "$cargo_toml.tmp"
mv "$cargo_toml.tmp" "$cargo_toml"

tmp=$(mktemp)
sed 's/"version": "[^"]*"/"version": "'"$ver"'"/' "$tauri_conf" > "$tmp"
mv "$tmp" "$tauri_conf"

echo "✓ bumped to $ver in Cargo.toml and apps/desktop/tauri.conf.json"
echo "  next: git commit, then git tag v$ver && git push --tags"
