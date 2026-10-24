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
# The Theodore account's WorkOS client id is baked into the build from
# THEODORE_WORKOS_CLIENT_ID; signing in is then required to use the app.
# --no-account builds without one (no account, no sign-in).
#
# Usage: THEODORE_WORKOS_CLIENT_ID=client_… scripts/nightly-build.sh
#        scripts/nightly-build.sh --no-account
set -eu

account=1
for arg in "$@"; do
  case "$arg" in
    --no-account) account=0 ;;
    *) echo "✗ unknown option: $arg (usage: $0 [--no-account])" >&2; exit 2 ;;
  esac
done

if [ "$account" = 1 ]; then
  if [ -z "$(printf '%s' "${THEODORE_WORKOS_CLIENT_ID:-}" | tr -d '[:space:]')" ]; then
    echo "✗ THEODORE_WORKOS_CLIENT_ID is not set: a nightly bakes in the account's" >&2
    echo "  WorkOS client id (docs/plan.md §6.12). Set it, or pass --no-account" >&2
    echo "  to build without the account." >&2
    exit 1
  fi
  export THEODORE_WORKOS_CLIENT_ID
else
  unset THEODORE_WORKOS_CLIENT_ID
fi

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
if [ "$account" = 1 ]; then
  echo "▶ Theodore $version ($sha), account sign-in required"
else
  echo "▶ Theodore $version ($sha), no account"
fi

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
