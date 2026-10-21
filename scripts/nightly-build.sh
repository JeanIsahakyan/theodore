#!/bin/sh
# Local nightly build: a DMG numbered by the commit it was built from.
#
#   version = <Cargo.toml version>-nightly.<commits on HEAD>
#   file    = target/release/bundle/dmg/Theodore_<version>_<sha>_aarch64.dmg
#
# The number only grows (one per commit), so newer builds always compare as
# newer. Nothing is committed, tagged or published; the version files keep
# their release version. Ad-hoc signed, no updater artifacts (no key yet).
#
# Usage: scripts/nightly-build.sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ uncommitted changes: a nightly is built from a commit, commit first." >&2
  exit 1
fi

base=$(awk '
  /^\[workspace\.package\]/ { in_block = 1; next }
  /^\[/ { in_block = 0 }
  in_block && /^version = "/ { gsub(/version = "|"/, ""); print; exit }
' Cargo.toml)
count=$(git rev-list --count HEAD)
sha=$(git rev-parse --short HEAD)
version="$base-nightly.$count"
echo "▶ Theodore $version ($sha)"

(cd apps/desktop && cargo tauri build --bundles app \
  --config "{\"version\":\"$version\",\"bundle\":{\"createUpdaterArtifacts\":false}}")

bundle="$root/target/release/bundle"
app="$bundle/macos/Theodore.app"
dmg="$bundle/dmg/Theodore_${version}_${sha}_aarch64.dmg"
mkdir -p "$bundle/dmg"

# hdiutil directly: tauri's DMG script styles the window through Finder
# AppleScript, which needs an automation permission this machine may lack.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "Theodore $version" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
hdiutil verify "$dmg" >/dev/null

echo "✓ $dmg"
