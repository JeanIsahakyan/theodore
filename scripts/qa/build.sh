#!/usr/bin/env bash
# Build Theodore with the QA driver (docs/live-qa.md) and install it for testing.
#
#   ui deps ──▶ app with --features qa-driver ──▶ CLI ──▶ $THEODORE_QA_APP
#                                                            ├─ Theodore.app
#                                                            └─ theodore
#
# Always a dev build: build.rs refuses the feature in any other. Not for real
# use (AGENTS.md, "Installing Theodore").
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
app_dir=${THEODORE_QA_APP:-/tmp/theodore-qa/app}
target=${CARGO_TARGET_DIR:-$root/target}
bundle=$target/debug/bundle/macos/Theodore.app
bin=Contents/MacOS/theodore-app

pnpm -C "$root/ui" install --frozen-lockfile
(
  cd "$root/apps/desktop"
  cargo tauri build --debug --bundles app --features qa-driver \
    --config '{"bundle":{"createUpdaterArtifacts":false}}'
)
cargo build --manifest-path "$root/Cargo.toml" -p theodore-cli

# A build without the driver would start fine and then time out on every `q`.
count=$(strings "$bundle/$bin" | grep -c THEODORE_QA_DRIVER || true)
if [ "${count:-0}" -eq 0 ]; then
  echo "✗ no QA driver in $bundle/$bin: not installing" >&2
  exit 1
fi

mkdir -p "$app_dir"
rm -rf "${app_dir:?}/Theodore.app"
cp -R "$bundle" "$app_dir/Theodore.app"
cp "$target/debug/theodore" "$app_dir/theodore"
echo "✓ installed to $app_dir"
