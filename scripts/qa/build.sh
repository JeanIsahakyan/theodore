#!/usr/bin/env bash
# Build Theodore with the QA driver (docs/live-qa.md) and install it for testing.
#
#   ui deps ──▶ app with --features qa-driver ──▶ CLI ──▶ $THEODORE_QA_APP
#                                                            ├─ Theodore QA.app
#                                                            └─ theodore
#
# Always a dev build: build.rs refuses the feature in any other. Not for real
# use (AGENTS.md, "Installing Theodore").
#
# Its own bundle identifier, so its webview storage (tabs, theme, UI state, kept
# by identifier in ~/Library/WebKit) isn't an installed Theodore's. No URL
# scheme: theodore:// stays the installed app's.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
app_dir=${THEODORE_QA_APP:-/tmp/theodore-qa/app}
target=${CARGO_TARGET_DIR:-$root/target}
name="Theodore QA"
identifier=app.theodore.desktop.qa
bundle="$target/debug/bundle/macos/$name.app"
bin=Contents/MacOS/theodore-app

pnpm -C "$root/ui" install --frozen-lockfile
(
  cd "$root/apps/desktop"
  cargo tauri build --debug --bundles app --features qa-driver \
    --config '{"productName":"'"$name"'","identifier":"'"$identifier"'","bundle":{"createUpdaterArtifacts":false},"plugins":{"deep-link":{"desktop":{"schemes":[]}}}}'
)
cargo build --manifest-path "$root/Cargo.toml" -p theodore-cli

# A build with a shipped identifier would share an installed Theodore's storage.
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist")
if [ "$got" != "$identifier" ]; then
  echo "✗ $bundle is $got, not $identifier: not installing" >&2
  exit 1
fi

# A build without the driver would start fine and then time out on every `q`.
count=$(strings "$bundle/$bin" | grep -c THEODORE_QA_DRIVER || true)
if [ "${count:-0}" -eq 0 ]; then
  echo "✗ no QA driver in $bundle/$bin: not installing" >&2
  exit 1
fi

mkdir -p "$app_dir"
# Theodore.app: what an earlier build.sh installed, under the shipped identifier.
rm -rf "${app_dir:?}/Theodore.app" "${app_dir:?}/$name.app"
cp -R "$bundle" "$app_dir/$name.app"
cp "$target/debug/theodore" "$app_dir/theodore"
echo "✓ installed to $app_dir ($identifier)"
