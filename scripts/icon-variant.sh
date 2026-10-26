#!/bin/sh
# The app icon in a build's colours, so builds are told apart on the Dock.
#
#   production  blue   (the committed apps/desktop/icons, unchanged)
#   staging     orange
#   nightly     purple
#   dev         grey-green
#
# Recolours apps/desktop/icons/src/icon.svg (its three production colours:
# tile, blobs, lens shadow) and runs `cargo tauri icon` on it into <out-dir>,
# which then holds 32x32.png, 128x128.png, icon.icns and the rest. A build
# points `bundle.icon` at them with --config (build.yml, nightly-build.sh).
# The colours are the UI's too: ui/src/ui/logoColors.ts; keep them in step.
#
# Usage: scripts/icon-variant.sh <production|staging|nightly|dev> <out-dir>
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <production|staging|nightly|dev> <out-dir>" >&2
  exit 2
fi
env=$1
out=$2

# tile, blobs, shadow
case "$env" in
  production) colors="#3F86D6 #0C5BC0 #03306B" ;;
  staging) colors="#DE8435 #C05A0C #6D2D03" ;;
  nightly) colors="#8C56D2 #6120B6 #320868" ;;
  dev) colors="#669980 #406D57 #183929" ;;
  *)
    echo "✗ unknown build env: $env (production | staging | nightly | dev)" >&2
    exit 2
    ;;
esac
# Word-split on purpose: three colours into $1 $2 $3.
# shellcheck disable=SC2086
set -- $colors

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/apps/desktop/icons/src/icon.svg"
for c in "#3F86D6" "#0C5BC0" "#03306B"; do
  grep -q "$c" "$src" || {
    echo "✗ $src no longer has $c: update the colours here and in logoColors.ts" >&2
    exit 1
  }
done

mkdir -p "$out"
svg="$out/icon.svg"
sed -e "s/#3F86D6/$1/g" -e "s/#0C5BC0/$2/g" -e "s/#03306B/$3/g" "$src" > "$svg"
cargo tauri icon "$svg" --output "$out"
test -f "$out/icon.icns"
echo "✓ $env icon: $out"
