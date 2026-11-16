#!/bin/sh
# The updater's latest.json from a directory of release assets
# (build.yml's `manifest` job). Each updater asset found, with its `.sig`,
# becomes the platform entries the Tauri updater looks up: first
# `<os>-<arch>-<bundle type>`, then `<os>-<arch>`.
#
#   Theodore_<v>_aarch64.app.tar.gz  ──▶ darwin-aarch64
#   Theodore_<v>_x86_64.AppImage     ──▶ linux-x86_64, linux-x86_64-appimage
#   Theodore_<v>_amd64.deb           ──▶ linux-x86_64-deb
#   Theodore_<v>_aarch64.AppImage    ──▶ linux-aarch64, linux-aarch64-appimage
#   Theodore_<v>_arm64.deb           ──▶ linux-aarch64-deb
#
# The bare `linux-<arch>` key is the AppImage: an installed .deb asks for
# `-deb` first and must never get an AppImage (dpkg refuses it). An asset
# without its `.sig` fails; a platform not built is left out.
#
# Usage: scripts/updater-manifest.sh <dist-dir> <version> <download-base-url>
#   e.g. dist 0.3.0 https://github.com/o/r/releases/download/v0.3.0
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <dist-dir> <version> <download-base-url>" >&2
  exit 2
fi
dist=$1
version=$2
base=${3%/}

entries='{}'
# add <asset file name> <platform key>...
add() {
  name=$1
  shift
  [ -f "$dist/$name" ] || return 0
  sig="$dist/$name.sig"
  if [ ! -f "$sig" ]; then
    echo "✗ $name has no $name.sig: is TAURI_SIGNING_PRIVATE_KEY set?" >&2
    exit 1
  fi
  for key in "$@"; do
    entries=$(printf '%s' "$entries" | jq -c \
      --arg key "$key" --arg url "$base/$name" --rawfile sig "$sig" \
      '. + { ($key): { signature: ($sig | rtrimstr("\n")), url: $url } }')
  done
}

add "Theodore_${version}_aarch64.app.tar.gz" darwin-aarch64
add "Theodore_${version}_x86_64.AppImage" linux-x86_64 linux-x86_64-appimage
add "Theodore_${version}_amd64.deb" linux-x86_64-deb
add "Theodore_${version}_aarch64.AppImage" linux-aarch64 linux-aarch64-appimage
add "Theodore_${version}_arm64.deb" linux-aarch64-deb

if [ "$entries" = '{}' ]; then
  echo "✗ no updater assets for $version in $dist" >&2
  exit 1
fi

jq -n \
  --arg version "$version" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$entries" \
  '{
    version: $version,
    notes: "See the GitHub release notes.",
    pub_date: $pub_date,
    platforms: $platforms
  }'
