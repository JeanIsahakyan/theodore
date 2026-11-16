#!/usr/bin/env bash
# Builds language servers that have no binary upstream and so are built by
# us (docs/code-intel.md §4.2 "No upstream binary"). Today that's one
# server: gopls (Go, cross-compiles, BSD-licensed), for every platform the
# manifest keys: darwin-arm64, linux-x64, linux-arm64.
#
#   go install -trimpath golang.org/x/tools/gopls@<pinned version>
#     (per platform: GOOS/GOARCH, CGO_ENABLED=0, into a throwaway GOPATH)
#   ─▶ tar.gz ─▶ sha256
#   ─▶ release "servers-<content hash of this script>" (prerelease)
#
# No codesign step here, unlike build-grammars.sh: a dylib is dlopen'd
# in-process and the OS checks its signature before loading it, but a
# server runs as a child process, and `code-intel-toolchain` ad-hoc signs
# any Mach-O binary itself right after unpacking it, on macOS only
# (crates/code-intel-toolchain/src/lib.rs `sign_adhoc`, docs/code-intel.md
# §4.2 "Signing"). Pre-signing the archive here would just be redone. A
# Linux binary needs no signature; the unpacker sets its executable bit.
#
# `-trimpath` drops build-machine paths from the binary so CI's build and a
# local one are close to reproducible; they are not guaranteed byte-for-byte
# identical (toolchain version, embedded build id), so the manifest's
# sha256 always comes from whichever build actually gets published — a
# local run here is for checking the pin builds, not for the final hash.
#
# Everything lands in a gitignored output dir (default target/servers/);
# nothing here is committed by this script. .github/workflows/servers.yml
# runs this in CI and publishes the archive as a release asset; a human
# then pastes its sha256 into
# crates/code-intel-toolchain/manifest/languages.yaml's gopls entry.
#
# Bash 3.2 compatible (macOS's shipped /bin/bash), matching build-grammars.sh.
# Go cross-compiles, so one runner builds every platform; the output is
# the same on whichever host runs it, up to the caveat above.
#
# Env overrides (all optional):
#   SERVERS_OUT_DIR        output dir                 (default: target/servers)
#   SERVERS_GOPLS_VERSION  gopls version to build      (default: v0.24.0 —
#                                                        keep in sync with
#                                                        manifest/languages.yaml's
#                                                        gopls `version`, without
#                                                        the leading "v")
#   SERVERS_PLATFORMS      space-separated platform keys to build
#                                                      (default: darwin-arm64
#                                                       linux-x64 linux-arm64)
#   SERVERS_RELEASE_BASE   release assets base URL    (default:
#                                                       https://github.com/<repo>/releases/download)
#   SERVERS_RELEASE_TAG    the release tag assets are published under
#                                                      (default: servers-<12 hex chars
#                                                       of sha256(this script)> —
#                                                       content-addressed, so a
#                                                       re-run with the same pin
#                                                       reuses the same tag)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
self="$root/scripts/build-servers.sh"

out_dir="${SERVERS_OUT_DIR:-$root/target/servers}"
work_dir="$out_dir/_work"
gopls_version="${SERVERS_GOPLS_VERSION:-v0.24.0}"
platforms="${SERVERS_PLATFORMS:-darwin-arm64 linux-x64 linux-arm64}"

gh_repo="${GITHUB_REPOSITORY:-JeanIsahakyan/theodore}"
release_base="${SERVERS_RELEASE_BASE:-https://github.com/$gh_repo/releases/download}"

if [ -z "${SERVERS_RELEASE_TAG:-}" ]; then
  self_hash=$(shasum -a 256 "$self" | awk '{print substr($1, 1, 12)}')
  release_tag="servers-$self_hash"
else
  release_tag="$SERVERS_RELEASE_TAG"
fi

echo "output dir:    $out_dir"
echo "gopls version: $gopls_version"
echo "platforms:     $platforms"
echo "release:       $release_base/$release_tag"
echo

mkdir -p "$out_dir" "$work_dir"

if ! command -v go >/dev/null 2>&1; then
  echo "✗ go is not installed; nothing to build" >&2
  exit 1
fi

# --- gopls -----------------------------------------------------------------
# The manifest's platform key -> Go's GOOS GOARCH.
go_target() {
  case "$1" in
    darwin-arm64) echo "darwin arm64" ;;
    darwin-x64) echo "darwin amd64" ;;
    linux-x64) echo "linux amd64" ;;
    linux-arm64) echo "linux arm64" ;;
    *) return 1 ;;
  esac
}

modcache=$(go env GOMODCACHE)

snippet="$out_dir/gopls-manifest-snippet.yaml"
cat > "$snippet" <<EOF
# Paste into crates/code-intel-toolchain/manifest/languages.yaml's gopls
# server entry (docs/code-intel.md §4.2 "No upstream binary").
  - name: gopls
    version: "${gopls_version#v}"
    detect: [["gopls", "version"]]
    download:
EOF

# shellcheck disable=SC2086 # $platforms is intentionally word-split
for platform in $platforms; do
  if ! target=$(go_target "$platform"); then
    echo "✗ gopls: no Go target for platform $platform" >&2
    exit 1
  fi
  set -- $target
  goos="$1"
  goarch="$2"

  echo "=== gopls $gopls_version ($platform: $goos/$goarch) ==="
  # `go install` refuses GOBIN together with a foreign GOOS/GOARCH ("cannot
  # install cross-compiled binaries when GOBIN is set"), so GOBIN stays
  # unset and a throwaway GOPATH collects the result: $GOPATH/bin/gopls
  # natively, $GOPATH/bin/<os>_<arch>/gopls cross-compiled. The module
  # cache is shared so each platform does not download everything again.
  gopath="$work_dir/gopls-gopath-$platform"
  chmod -R u+w "$gopath" 2>/dev/null || true
  rm -rf "$gopath"
  mkdir -p "$gopath"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 GOPATH="$gopath" GOMODCACHE="$modcache" \
    go install -trimpath "golang.org/x/tools/gopls@$gopls_version"

  gopls_bin=""
  for candidate in "$gopath/bin/gopls" "$gopath/bin/${goos}_${goarch}/gopls"; do
    if [ -f "$candidate" ]; then
      gopls_bin="$candidate"
    fi
  done
  if [ -z "$gopls_bin" ]; then
    echo "✗ gopls: build for $platform did not produce a binary under $gopath/bin" >&2
    exit 1
  fi

  archive_name="gopls-${gopls_version#v}-$platform.tar.gz"
  archive_path="$out_dir/$archive_name"
  # `gopls` only, flat inside the archive: the manifest's `bin` is just
  # "gopls" (matches ty / rust-analyzer's single-binary archives).
  tar -czf "$archive_path" -C "$(dirname "$gopls_bin")" gopls

  archive_sha=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  archive_size=$(python3 -c "import os,sys; print(os.path.getsize(sys.argv[1]))" "$archive_path")
  archive_url="$release_base/$release_tag/$archive_name"

  echo "  -> $archive_name ($archive_size bytes, sha256 ${archive_sha:0:12}…)"
  echo

  cat >> "$snippet" <<EOF
      $platform:
        url: $archive_url
        sha256: $archive_sha
        size: $archive_size
        format: tar.gz
        bin: gopls
        redirect_hosts: [release-assets.githubusercontent.com, objects.githubusercontent.com]
EOF
  echo "wrote $archive_path"
done

cat >> "$snippet" <<EOF
    launch: ["{bin}"]
    workspace_folders: true
EOF

echo "$release_tag" > "$out_dir/RELEASE_TAG"

echo "wrote $snippet"
echo "wrote $out_dir/RELEASE_TAG ($release_tag)"
