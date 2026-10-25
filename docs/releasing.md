# Releasing

Plan §11.1 (updates) and §11.2 (signing without an Apple Developer ID). This
is the one-time setup the owner does before the first tag; after that,
`git tag vX.Y.Z && git push --tags` is the whole release.

## One-time: updater signing key (required before any release works)

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

Without these two secrets, `.github/workflows/release.yml` fails at the
"build app, dmg and updater artifacts" step — the updater's pubkey is already
configured, so the bundler insists on a matching private key to sign against.

## Theodore account: the client id

Signing in to a Theodore account is required wherever the account is
configured (plan §6.12). A release build carries the WorkOS client id
compiled in, from `THEODORE_WORKOS_CLIENT_ID` in the build's environment:

- In the GitHub repo → Settings → Secrets and variables → Actions →
  **Variables**, add `THEODORE_WORKOS_CLIENT_ID` = `client_…` (the
  production environment's client id). It's a public value, so a variable,
  not a secret; it is never committed. `release.yml` passes it to the build.
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

To turn on real signing, add these secrets — `release.yml` picks them up
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

## Cutting a release

```sh
scripts/bump-version.sh 0.3.0   # Cargo.toml + tauri.conf.json
git commit -am "chore: bump version to 0.3.0"
git push
git tag v0.3.0
git push --tags
```

The tag push triggers `.github/workflows/release.yml`, which verifies the tag
matches both version files, builds `aarch64-apple-darwin`, signs, packages
the DMG and the updater artifacts, and publishes a GitHub release with the
DMG, the `.app.tar.gz` + `.sig`, and `latest.json`.

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

## First launch on a clean Mac (ad-hoc signed builds)

Without a Developer ID, Gatekeeper blocks the first launch of a downloaded
`.app` (it does not block the updater's own installs — see plan §11.2). Either:

- System Settings → Privacy & Security → scroll down → "Open Anyway" next to
  the blocked-app notice, then open Theodore.app again and confirm, **or**
- `xattr -dr com.apple.quarantine /Applications/Theodore.app`

After that first launch, the app updates itself normally — downloads happen
outside the browser, so no quarantine flag is ever attached, and the updater
verifies its own signature rather than relying on Gatekeeper.
