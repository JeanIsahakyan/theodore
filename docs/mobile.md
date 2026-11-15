# Theodore on phone and web

One Expo app (`mobile/`, React Native + TypeScript) for iOS, Android and the
web. It is a fleet **client**, never a host: it starts, follows, steers and
answers spaces that run on your computers (docs/fleet.md). No repo, no agent,
no git on the phone.

```
iPhone / Android / browser                     Theodore cloud            your computers
┌──────────────────────────────┐   WSS    ┌──────────────────┐   WSS   ┌────────────┐
│ sign in: WorkOS AuthKit PKCE │─────────▶│ OrgHub (per org) │◀────────│ mac-A host │
│ device key: ed25519          │          │                  │◀────────│ linux host │
│   iOS Keychain / Android     │  HTTPS   │ push tokens      │         └────────────┘
│   Keystore / WebCrypto+IDB   │─────────▶│ POST /v1/fleet/  │
│ fleet client (TS):           │          │       request    │──push──▶ Expo Push ─▶ APNs / FCM
│   hello, seal, verify, pins  │◀──push───│                  │
└──────────────────────────────┘          └──────────────────┘
```

## What it does (v1)

| Screen | Does |
| --- | --- |
| Sign in | AuthKit hosted page (PKCE, no secret), org picker when you're in several (through the cloud, like the desktop) |
| Spaces | Fleet spaces you started from here or follow: status, last reply, waiting questions first |
| Space | Its history (lines), send a message when it's idle or waiting, Stop while it runs, answer its question |
| Start | Pick a trusted computer that accepts remote spaces, one of its projects, the goal, a mode up to its cap |
| Devices | Your devices, fingerprints, trust / untrust with the fingerprint confirm, this device's fingerprint to show on the computer |
| Settings | Account, organization switch, notifications on/off, sign out |

Questions and "space finished" arrive as push notifications; a question's
options are notification buttons (one tap answers it, signed on the phone,
sent over HTTPS). The web build has no push in v1: it shows them while open.

## Trust, the same model

The phone is one more device with its own key; nothing about the fleet's
trust changes (docs/fleet.md "Trust").

```
phone: makes its ed25519 key on first sign-in, shows its fingerprint
mac-A (Settings → Devices): sees "iPhone", compares the fingerprint, Trust
  ─▶ mac-A runs requests the phone signs (start, send, stop, answer), within max_mode
phone: trusts mac-A the same way ─▶ only then targets it and believes its signed events/replies
```

- The phone signs every request with `Domain::Request`, verifies every event,
  ask and reply against keys it pinned, exactly like the desktop core.
- Phone and web are never targets: `DeviceInfo.kind` is `mobile` or `web`,
  `accepts_remote` is always `false`, and the cloud refuses requests to them.

## Following a computer's spaces (delegation)

A space's events and questions go only to its origin and host (docs/fleet.md).
For questions from spaces you started on the Mac to reach your phone, the Mac
**delegates**:

```
mac-A (Devices → iPhone → "Send my spaces' questions here")
  ─▶ sign Delegation{origin: mac-A, delegate: iPhone, issued_at, expires_at}  (Domain::Delegate)
  ─▶ cloud stores it; iPhone now may subscribe to mac-A's spaces and gets their asks (+ push)
iPhone answers ─▶ signed by the iPhone ─▶ the host runs it only if it trusts the iPhone
revoke on mac-A ─▶ signed revocation ─▶ cloud drops it
```

The cloud can't forge a delegation (signed by the origin, checked against the
origin's registered key), and a delegate gains no power on hosts: answers and
requests still need the host's own trust in the phone's key.

## Protocol additions (crates/fleet-protocol, v4)

| Addition | Shape |
| --- | --- |
| `DeviceKind::Mobile`, `DeviceKind::Web` | in `DeviceInfo.kind`; never targets |
| `ClientMessage::RegisterPush{token, provider}` | `provider`: `expo`; replaces this device's token; empty token removes it |
| `ClientMessage::Delegate{envelope}` | body `Delegation{origin_device, delegate_device, issued_at_ms, expires_at_ms, revoke}`, `Domain::Delegate`, signed by the origin |
| `ServerMessage::Delegations{list}` | the delegations naming this device (as origin or delegate) |
| `POST /v1/fleet/request` | Bearer JWT + `{device_id, envelope}`: a one-shot signed request (a notification action, no socket). Answers `{accepted}` or `refused{code}`; the reply comes later as push or over the socket |

## Cloud (cloud/)

- Push registry per `mobile` device; the hub sends through the Expo Push API
  (no APNs/FCM keys in the Worker) to a space's followers (its origin and the
  origin's delegates): a question for a follower that's offline or not at
  the app, and a space turning idle / failed / stopped. Title
  "<host> · <space>"; body the question with its options numbered
  (≤ 180 chars); category `ask_opt2` / `ask_opt3` (numbered buttons + Reply) or
  `ask_text` (Reply, Open); multi-question asks have no buttons. Contract:
  `mobile/src/push/README.md`, mirrored in `cloud/src/fleet/push.ts`.
- `POST /v1/fleet/request` routes like a socket `request`; rate-limited per user.
- Delegations stored per origin; subscribe/ask routing = origin, host, and the
  origin's live delegates.
- CORS for the web app's origin only (`https://<web>.pages.dev` per env).
- Requests targeting a `mobile` / `web` device: `refused{fleet.invalid}`.

## App (mobile/)

```
mobile/
  app/                 expo-router routes: (auth)/sign-in, choose-organization, callback;
                       (app)/ tabs index (Spaces), devices, settings + space/[id], start
  src/auth/            AuthKit PKCE, session + refresh, org select/switch via cloud, RS256 check
  src/shell/           wiring: AppProviders (auth + fleet clients, auth state, fleet lifecycle)
                       (not src/app: expo-router would take src/app as the routes root)
  src/fleet/           pure TS client: socket, hello, seal/verify (domain tags), pins, journal of lines
  src/keys/            DeviceKey: secure-store (iOS/Android) | WebCrypto + IndexedDB (web)
  src/push/            expo-notifications: register, categories, background answer
  src/state/           stores (zustand) the screens read
  src/gen/fleet.ts     copied from cloud/src/gen (generated from Rust; never edited)
```

- Crypto: `@noble/ed25519` (pure JS, audited) with the same domain tags as
  Rust; a shared test vector (key, message, signature) produced by Rust keeps
  both sides honest.
- Keys never leave secure storage except to sign; on web the private key is a
  non-extractable WebCrypto key in IndexedDB.
- Redirect URIs to register in WorkOS: `theodore-mobile://callback` (native, per
  channel scheme) and the web origin's `/callback`.

### Sign-in

The desktop's flow (plan §6.12), in TypeScript (`src/auth`):

```
Sign in ─▶ PKCE S256 + 256-bit state ─▶ hosted AuthKit page
   native: ASWebAuthenticationSession / Custom Tab ─▶ theodore-mobile://callback
   web:    popup ─▶ <origin>/callback ─▶ root layout posts the URL to the opener
 ─▶ state matches ─▶ POST /user_management/authenticate (code + verifier, no secret)
 ─▶ RS256 vs JWKS, iss, exp (60 s), client_id, sub ─▶ secure store ─▶ (app)
     └─ organization_selection_required ─▶ choose-organization ─▶ cloud select-organization
     └─ no org ─▶ background: cloud POST /v1/orgs/personal ─▶ refresh into it
refresher: 60 s before exp; offline ─▶ retry 30 s doubling to 10 min; rejected ─▶ signed out
```

| | Native | Web |
| --- | --- | --- |
| Session | `expo-secure-store`, Keychain after first unlock (notification actions answer in the background) | `localStorage`: readable by any script on the origin (no third-party scripts ship) |
| Several instances | one | tabs share one refresh token: refresh under a Web Lock, re-read before and after, adopt another tab's rotation |
| JWKS fetch | direct | needs WorkOS CORS for the origin; unreachable: a token from WorkOS keeps its claim checks, one from the cloud fails |

- RS256 is verified in plain TS (BigInt + `@noble/hashes`): Hermes has no
  WebCrypto `subtle`, so `jose` can't run there.
- The web origin must also be an allowed web origin (CORS) in the WorkOS
  dashboard, or the browser can't read `/user_management/authenticate`.

## Desktop changes

- Devices page: phone and web devices listed with their kind; trust works as
  for computers; "Send my spaces' questions here" toggles a delegation.
- The core signs/revokes delegations and ignores `mobile`/`web` devices as
  targets.

## Not in v1

Web push, hosting spaces on the phone, file transfer, tablets' layouts beyond
"it works".

## Build and release

The app is not part of the desktop release: no version bump, no tag. Web
rides the branch flow like the Worker; iOS and Android are EAS builds the
owner starts by hand.

```
push staging, mobile/** ─▶ mobile-web.yml: checks ─▶ build:web ─▶ Pages theodore-web-staging
push main,    mobile/** ─▶ mobile-web.yml: checks ─▶ build:web ─▶ Pages theodore-web
every PR / push          ─▶ ci.yml `mobile`: typecheck, lint, format, test, build:web

eas build --profile preview    ─▶ internal build (staging cloud) ─▶ TestFlight / Play internal
eas build --profile production ─▶ store build (production cloud) ─▶ eas submit ─▶ review
```

### Local development

- `pnpm -C mobile start` (a, i, w for Android, iOS, web). Defaults point at the
  staging cloud (`src/config.ts`).
- Expo Go is enough for the screens, sign-in on web, and the fleet client. It is
  **not** enough for what needs our own native config: remote push
  (remote push isn't supported in Expo Go) and the `theodore-mobile://`
  scheme. For those, build a dev client once:
  `npx eas-cli@latest build --profile development` (iOS simulator build,
  installable by dragging it onto the simulator), then `pnpm -C mobile start`
  and open it in that client. A rebuild is needed only after adding a native
  module or changing `app.json` plugins.
- Before pushing: `pnpm -C mobile typecheck`, `lint`, `test` (lefthook runs
  them; `format:check` and `build:web` are CI's).

### Web

`mobile-web.yml` deploys `mobile/dist` with wrangler (`pages deploy`) and writes
`_redirects` (`/* /index.html 200`) so `/callback` and deep links serve the
single-page app. Same checks as CI run first. Env per channel, baked into the
bundle (`EXPO_PUBLIC_*`) from the repo variables the desktop builds already
use:

| | Pages project | `EXPO_PUBLIC_WORKOS_CLIENT_ID` | `EXPO_PUBLIC_CLOUD_URL` |
| --- | --- | --- | --- |
| staging | `theodore-web-staging` | `THEODORE_WORKOS_CLIENT_ID_STAGING` | `THEODORE_CLOUD_URL_STAGING` |
| production | `theodore-web` | `THEODORE_WORKOS_CLIENT_ID` | `THEODORE_CLOUD_URL` |

Staging falls back to the app's staging defaults when the variables are unset;
production fails the run instead of building with them. Manual run (Actions →
Mobile web → Run workflow) picks the environment; production only from `main`.
The web origin must be in the cloud's CORS list (above).

### iOS and Android builds (EAS)

`mobile/eas.json` profiles:

| Profile | For | Distribution | Env |
| --- | --- | --- | --- |
| `development` | dev client | internal (iOS simulator build) | staging, literal |
| `preview` | testers | internal (ad hoc iOS, APK Android) | staging, literal |
| `production` | stores | store (AAB, App Store) | EAS environment `production` |

- Production's client id and cloud URL are **not** in the repo: set them once as
  EAS environment variables (`eas env:create --environment production
  --name EXPO_PUBLIC_WORKOS_CLIENT_ID --visibility plaintext`, same for
  `EXPO_PUBLIC_CLOUD_URL`). Same values as the `THEODORE_*` repo variables.
  Check a production build's values with `eas env:list --environment production`.
- Versioning: `appVersionSource: remote`. The user-visible version is
  `expo.version` in `app.json`; the build number (iOS) and version code
  (Android) are counted by EAS and bumped by `autoIncrement` on `production`.
  Remote, because nothing in git then has to be bumped and merged per upload
  (Apple rejects a repeated build number, and a failed upload still burns
  one). Bump `expo.version` by hand for a store release.
- `runtimeVersion` policy `appVersion`: a build's runtime is its
  `expo.version`. Inert until `expo-updates` is added; then an OTA update only
  reaches builds with the same version, so JS that needs a new native module
  ships with a version bump.
- One identity (`app.theodore.mobile`, scheme `theodore`) for every profile: a
  preview build and the store build replace each other on a device. Split per
  channel (`app.config.ts` reading an `APP_VARIANT` env) only if testers need
  both side by side.

### Testing and store release

```
preview     ─▶ Android: APK to install; iOS: ad hoc, devices registered with `eas device:create`
production  ─▶ eas submit --platform ios     ─▶ App Store Connect ─▶ TestFlight ─▶ review
            ─▶ eas submit --platform android ─▶ Play Console, internal track ─▶ promote
```

- TestFlight: `eas build --profile production --platform ios --auto-submit`
  uploads to App Store Connect; add internal testers there. No device
  registration. Prefer this to ad hoc for anyone beyond the owner's own devices.
- Play internal testing: first upload of an app must be manual in the Play
  Console (Google rejects the API for a never-uploaded app); after that
  `eas submit --platform android` lands in the internal track, set in
  `eas.json` `submit.production.android.track` if it should differ.
- Store submission: the listing, screenshots, privacy answers and review
  notes are filled in App Store Connect / Play Console by hand. Review notes
  must say how to sign in (a test WorkOS account) and that the app needs a
  computer running Theodore to do anything.

### One-time, by the owner

| # | Step | How |
| --- | --- | --- |
| 1 | Expo account, EAS project | `npx eas-cli@latest login`, then `eas init` in `mobile/`: creates the project and writes `extra.eas.projectId` into `app.json`; commit it |
| 2 | EAS env for production | the two `eas env:create` calls above |
| 3 | Apple Developer Program, App Store Connect app | enrol; create the app with bundle id `app.theodore.mobile`; then `eas credentials` (iOS) lets EAS make the distribution cert and profile |
| 4 | iOS push key | `eas credentials` → iOS → Push Notifications: set up a new key (an APNs `.p8`); EAS hands it to Expo's push service. Never commit it |
| 5 | Google Play Console | pay, create the app `app.theodore.mobile`; make a service account key for `eas submit` (`eas credentials` → Android) |
| 6 | FCM for Android push | create a Firebase project, add the Android app, download `google-services.json`, point `expo.android.googleServicesFile` at it (upload it as an EAS file env var, not in git), then `eas credentials` → Android → FCM V1 service account key |
| 7 | WorkOS redirects | add `theodore-mobile://callback` and `https://theodore-web-staging.pages.dev/callback` to the staging environment, `theodore-mobile://callback` and `https://theodore-web.pages.dev/callback` to production (docs/releasing.md "WorkOS redirects to register") |
| 8 | Pages projects | `wrangler pages project create theodore-web-staging --production-branch staging` and `wrangler pages project create theodore-web --production-branch main` |
| 9 | Cloud CORS | the two `pages.dev` origins in the Worker's CORS config ("Cloud" above) |

`mobile-web.yml` reuses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`; the
token must also carry "Cloudflare Pages: Edit". No other secret is added to
GitHub: EAS holds the Apple, Google and push credentials.
