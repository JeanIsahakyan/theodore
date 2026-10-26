# Releasing

Plan §11.1 (updates) and §11.2 (signing without an Apple Developer ID). The
one-time setup the owner does before the first release, then the branch flow
that makes every build: a push to `staging` publishes a staging build, a
version bump merged to `main` publishes a production release.

## Branch flow: two builds

```
author/feature ──PR──▶ staging ──PR──▶ main
                          │              │
                    staging.yml     release.yml
                          │              │
              <ver>-staging.<run>   <ver>, only if v<ver> is new
                          ▼              ▼
          pre-release channel-staging   release v<ver> (+ tag)
          (assets replaced each run)    else: workflow artifact only
                          ▲              ▲
                staging builds poll   production builds poll
                channel-staging/      releases/latest/
                latest.json           latest.json
```

| Build | Workflow, trigger | `THEODORE_BUILD_ENV` | WorkOS client id (variable) | Updates from |
| --- | --- | --- | --- | --- |
| Staging | `staging.yml`, push to `staging` | `staging` | `THEODORE_WORKOS_CLIENT_ID_STAGING` | `channel-staging` only |
| Production | `release.yml`, push to `main` | `production` | `THEODORE_WORKOS_CLIENT_ID` | `stable` (or `beta`), never `channel-staging` |

Both call `.github/workflows/build.yml` (`workflow_call`), the one build
definition: same toolchain, signing, telemetry variables and assets, so the
two can't drift. `ci.yml` runs on every PR (into `staging`, into `main`, or
stacked) and on pushes to both branches. Both also have a manual **Run
workflow** (`workflow_dispatch`); from any other branch it builds and
publishes nothing.

## One-time: updater signing key (required before any release works)

Done on 2026-10-25: the public key is in `tauri.conf.json`, both secrets are
set, and the private key with its password lives in `~/.tauri/` on the
owner's Mac (`theodore.key`, `theodore.key.password`). Keep a copy of both
in a password manager; losing either means no installed build can update
again. The steps below are how it was done.

Every build, from v0.0.1 onward, carries the updater's public key baked into
`apps/desktop/tauri.conf.json` (`plugins.updater.pubkey`). **This key is
never rotated** — rotating it orphans every installed build, since they can
only verify updates signed by the key they shipped with.

1. Generate the keypair locally (needs `cargo install tauri-cli --version "^2" --locked`):

   ```sh
   cargo tauri signer generate -w ~/.tauri/theodore.key
   ```

   This prints a public key and writes the private key to
   `~/.tauri/theodore.key` (keep it out of git).

2. Paste the **public** key into `apps/desktop/tauri.conf.json`, replacing
   `REPLACE_WITH_UPDATER_PUBLIC_KEY`:

   ```json
   "plugins": { "updater": { "pubkey": "<paste public key here>" } }
   ```

   Commit that change.

3. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/theodore.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set in step 1
     (or an empty secret if you generated without one).

Without these two secrets, `.github/workflows/build.yml` fails at the
"build app, dmg and updater artifacts" step — the updater's pubkey is already
configured, so the bundler insists on a matching private key to sign against.

## Theodore account: the client id

Signing in to a Theodore account is required wherever the account is
configured (plan §6.12). A release build carries the WorkOS client id
compiled in, from `THEODORE_WORKOS_CLIENT_ID` in the build's environment:

- In the GitHub repo → Settings → Secrets and variables → Actions →
  **Variables**, add `THEODORE_WORKOS_CLIENT_ID` = `client_…` (the
  production environment's client id). It's a public value, so a variable,
  not a secret; it is never committed. `release.yml` passes it to the build;
  `staging.yml` passes `THEODORE_WORKOS_CLIENT_ID_STAGING` instead.
- Without it the release builds and runs with no account at all: no
  sign-in screen, no account card.
- At run time the same env var or the `account.workos.client_id` setting
  still wins over the compiled-in id (staging, a test environment).

## Error reports: New Relic

Error reports go over OTLP/HTTP to New Relic, set at build time and sent
only when the user opts in (`docs/telemetry.md`):

| Where | Name | Value |
| --- | --- | --- |
| Variables | `THEODORE_OTLP_ENDPOINT` | `https://otlp.nr-data.net` (EU account: `https://otlp.eu01.nr-data.net`) |
| Secrets | `THEODORE_OTLP_HEADERS` | `api-key=<New Relic ingest license key>` |

Both are set in the repo. The key ships inside the app, so anyone can pull
it out and send data to the account: it can only ingest, never read. Rotate
it in New Relic if it is abused. A local nightly bakes them in only when
they are exported in the shell that runs `scripts/nightly-build.sh`.

## Optional: Developer ID signing + notarization

Without this, every release is **ad-hoc signed** (`tauri.conf.json`'s
`bundle.macOS.signingIdentity: "-"`, equivalent to `codesign --force --deep -s -`).
That's enough to run on Apple Silicon, but Gatekeeper still blocks the first
launch (see below) and updates install into an unnotarized app.

To turn on real signing, add these secrets — `build.yml` picks them up
automatically (`tauri-bundler` reads them directly) and the ad-hoc path is
skipped:

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application cert, exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID used for `notarytool` |
| `APPLE_PASSWORD` | an [app-specific password](https://support.apple.com/en-us/102654) for that Apple ID (not the account password) |
| `APPLE_TEAM_ID` | your Apple Developer team id |

No other change: the workflow and `tauri.conf.json` are unchanged whether or
not these are set.

## Cutting a production release

Bump the version and let it travel the branch flow; `main` makes the tag:

```sh
git switch -c author/release-0.3.0 staging
scripts/bump-version.sh 0.3.0   # Cargo.toml + tauri.conf.json
git commit -am "chore: bump version to 0.3.0"
git push -u origin HEAD          # PR into staging, merge
                                 # then PR staging → main, merge
```

Every push to `main` runs `.github/workflows/release.yml`: `build.yml`
checks both version files agree, builds `aarch64-apple-darwin`, signs,
packages the DMG and the updater artifacts and writes `latest.json`. Then:

- **No `v0.3.0` tag yet** → it creates the tag at that commit and a GitHub
  release with the DMG, the `.app.tar.gz` + `.sig`, and `latest.json`.
  Installed production builds pick it up from `releases/latest`.
- **`v0.3.0` already exists** (a merge without a bump) → build only: the
  assets stay as a workflow artifact on the run, nothing is published.

There is no tag-push release any more: don't push `v*` tags by hand (a
hand-pushed tag only makes the next merge skip that version).

- **Never re-tag a published release.** Ship a new patch instead.

## Staging channel

Every push to `staging` runs `.github/workflows/staging.yml`, which builds
with `THEODORE_BUILD_ENV=staging` and the staging client id, as version
`<version files>-staging.<run number>` (e.g. `0.3.0-staging.57`; the run
number only grows, so each build is newer to the updater). It publishes to
one rolling **pre-release tagged `channel-staging`**, made on the first run:

1. uploads the versioned DMG, `.app.tar.gz` and `.sig`,
2. then `latest.json`, pointing at that tarball,
3. then deletes the previous build's assets and names this build's commit
   in the release notes.

An updater polling mid-run sees either the old manifest with its tarball or
the new one with its. A re-run of an older run publishes nothing. Being a pre-release, `channel-staging` is never
`releases/latest`, and no `v*` tag or release is touched.

A staging build polls only
`.../releases/download/channel-staging/latest.json`, whatever
`updates.channel` says, and Settings → Updates shows **Staging** instead of
the channel picker. Any other build resolves `updates.channel` to `stable`
or `beta` and never to staging (`effective_channel` in
`apps/desktop/src/updater.rs`).

- **Beta channel**: `updates.channel` = `"beta"` resolves to
  `.../releases/download/channel-beta/latest.json` instead of
  `.../releases/latest/download/latest.json` — publish a pre-release tagged
  exactly `channel-beta` and overwrite its `latest.json` on each beta build.
- **Never re-tag a published release.** Ship a new patch instead.

## Local nightly builds

`scripts/nightly-build.sh` builds a DMG from the current commit, numbered by
it: `<version>-nightly.<commits on HEAD>` (e.g. `0.0.1-nightly.340`), file
`target/release/bundle/dmg/Theodore_<version>_<sha>_aarch64.dmg`. The number
only grows, one per commit. Nothing is tagged or published, and the version
files keep the release version; a dirty tree is refused, so every nightly
maps to exactly one commit.

It bakes in the account's client id like a release, so it needs
`THEODORE_WORKOS_CLIENT_ID` set and stops with a message when it isn't:

```sh
THEODORE_WORKOS_CLIENT_ID=client_… scripts/nightly-build.sh
scripts/nightly-build.sh --no-account   # no account, no sign-in
```

## Build stamp: version, commit, environment

Every build bakes in its version, commit and build environment
(`apps/desktop/build.rs`); Settings → About shows them as
`0.0.1 · a1b2c3d · staging` (full sha and build date on hover, **Copy**
for bug reports), and the problem report and telemetry carry them too.

| Build | `THEODORE_BUILD_ENV` | Set by |
| --- | --- | --- |
| Production (`main`) | `production` | `release.yml` → `build.yml`, with `THEODORE_GIT_SHA=${{ github.sha }}` |
| Staging (`staging`) | `staging` | `staging.yml` → `build.yml`; or by hand, below |
| Nightly | `nightly` | `scripts/nightly-build.sh` (default) |
| Local `cargo` / `cargo tauri dev` | `dev` | nothing set |

The commit is `THEODORE_GIT_SHA` when set, else `git rev-parse HEAD`, else
`unknown`; a `dev` build from uncommitted changes says `-dirty`. Any other
`THEODORE_BUILD_ENV` value fails the build. `THEODORE_VERSION` overrides
the version (the nightly script sets `-nightly.N`, `build.yml` the version
with its suffix).

### A local staging build

The CI staging build is the usual one (above). For a local one: the
nightly script with the staging environment and the staging WorkOS
client id (the repository variable `THEODORE_WORKOS_CLIENT_ID_STAGING`):

```sh
THEODORE_BUILD_ENV=staging \
THEODORE_WORKOS_CLIENT_ID=$(gh variable get THEODORE_WORKOS_CLIENT_ID_STAGING) \
scripts/nightly-build.sh
```

Same DMG as a nightly (`<version>-nightly.<n>`), labelled `staging` in
About and in telemetry (`deployment.environment.name`). Like any staging
build it updates from `channel-staging` only, so the next CI staging build
of the same version (`-staging.N` sorts after `-nightly.N`) replaces it.

## First launch on a clean Mac (ad-hoc signed builds)

Without a Developer ID, Gatekeeper blocks the first launch of a downloaded
`.app` (it does not block the updater's own installs — see plan §11.2). Either:

- System Settings → Privacy & Security → scroll down → "Open Anyway" next to
  the blocked-app notice, then open Theodore.app again and confirm, **or**
- `xattr -dr com.apple.quarantine /Applications/Theodore.app`

After that first launch, the app updates itself normally — downloads happen
outside the browser, so no quarantine flag is ever attached, and the updater
verifies its own signature rather than relying on Gatekeeper.
