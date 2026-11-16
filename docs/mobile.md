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
| Settings | Account, organization switch, this device (name, status, fingerprint), notifications on/off, sign out, about (version, server) |

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

## Kept across restarts

iOS kills a backgrounded app at will; the Spaces list must not come back
empty. Like the desktop's `fleet.follow:<rs_>` (docs/fleet.md "One space UI:
mirrored rows"), the app keeps the spaces it started or follows, per account
and organization (`src/fleet/saved.ts`).

```
a change (event, mirror row, start ok, follow) ─▶ saved within 1 s
app to the background ─▶ saved now
launch ─▶ session ─▶ saved set of <user>.<org> ─▶ listed at once, last known status
       ─▶ socket ─▶ welcome
            started here ─▶ subscribe{since: last seq}
            followed     ─▶ delegations: its origin still delegates here ─▶ subscribe{since}
                                         else ─▶ dropped
sign-out ─▶ the set is removed     org switch ─▶ kept (sets are per org)
```

| Kept per space | Not kept |
| --- | --- |
| the list's view (host, name, project, branch, mode, status, last reply, question), last seq | live turn steps |
| newest 100 lines, the mirrored space row, newest 100 chat messages (≤ 512 KB) | older messages: not replayed, the resubscribe starts after the last seq |

- At most 50 spaces, the most recently active; the others' records are removed.
- Where: files in the app's documents directory (`expo-file-system`) on
  native, IndexedDB on web, memory in tests. Not secure-store: Android caps
  a value near 2 KB.
- A set names the fleet device id it was written for; one restored from a
  backup onto another phone (no such id there) or kept by a device that
  joined again is dropped, never resubscribed.
- What is read back is shape-checked again (it is still another device's text).

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
- CORS for the web app's origin only (`https://theodore-web[-staging].<account>.workers.dev` per env).
- Requests targeting a `mobile` / `web` device: `refused{fleet.invalid}`.

## App (mobile/)

```
mobile/
  app/                 expo-router routes: (auth)/sign-in, choose-organization, callback;
                       (app)/ stack: (tabs)/ index (Spaces), devices, settings;
                       space/[id], start pushed over the tabs
  src/auth/            AuthKit PKCE, session + refresh, org select/switch via cloud, RS256 check
  src/shell/           wiring: AppProviders (auth + fleet clients, auth state, fleet lifecycle)
                       (not src/app: expo-router would take src/app as the routes root)
  src/fleet/           pure TS client: socket, hello, seal/verify (domain tags), pins, journal of lines,
                       spaces kept across restarts (saved.ts; data.* storage per platform)
  src/keys/            DeviceKey: secure-store (iOS/Android) | WebCrypto + IndexedDB (web)
  src/push/            expo-notifications: register, categories, background answer
  src/state/           stores (zustand) the screens read
  src/ui/native/       the native kit: SwiftUI (iOS) / Compose (Android) / RN (web) controls
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

### Native UI

Screens are built from `src/ui/native` (on `@expo/ui`): one import, the
same props everywhere, a real native control per platform. Metro picks
`X.ios.tsx`, `X.android.tsx` or `X.tsx` (web).

```tsx
import { Button, Form, Row, Section, Switch, confirm } from '../../src/ui/native';
```

| Kit | iOS (SwiftUI) | Android (Compose, Material 3) | Web (React Native) |
| --- | --- | --- | --- |
| `Button` primary / secondary / plain / destructive, `loading`, `disabled`, `fullWidth` | `Button` `.borderedProminent` / `.bordered` / `.borderless` / role destructive | `Button` / `FilledTonalButton` / `TextButton` / filled in danger | `Pressable` |
| `Button` glassProminent / glass (floating over content) | 26+: `.glassProminent` / `.glass`; before: `.borderedProminent` / `.bordered` | `Button` / `FilledTonalButton` | as primary / secondary |
| `Segmented` (Ask/Plan/Edit, short sets) | `Picker` `.segmented` | `SingleChoiceSegmentedButtonRow` | joined segments |
| `Select` (device, project: longer lists) | `Picker` `.menu` | `ExposedDropdownMenuBox` | row that unfolds the choices |
| `glass` on `Segmented`, `Select`, `TextField` (standalone) | 26+: `glassEffect` capsule / rounded behind it; before: as without | ignored | ignored |
| `Glass` (RN content on a surface: banner, panel; `shape`, `radius`, `tint`, `fallback`) | 26+: `GlassView` (`expo-glass-effect`); before: the `fallback` | `View`, `fallback` in Material You colors | `View`, `fallback` |
| `TopBar` (pushed screen: `title`, `onBack`, `action`) | before 26: "‹ Back", title, action (26+: the native glass bar instead) | Material 3 `TopAppBar` (back arrow, `titleLarge`) | "‹ Back", title, action |
| `Switch` (label, `detail`) | `Toggle` | `ListItem` + `Switch`, row `toggleable` | row + RN `Switch` |
| `TextField` (single / `multiline`, `placeholder`, `onSubmit`, `submitLabel`) | `TextField` (vertical axis, `lineLimit`) | `OutlinedTextField` (ime action) | `TextInput` |
| `Progress` circular / linear, `value` 0…1 or none | `ProgressView` | `CircularProgressIndicator` (a value) / Expressive `LoadingIndicator` (none) / `LinearProgressIndicator` | `ActivityIndicator` / bar |
| `Form` › `Section` (`title`, `footer`) › `Row` (`label`, `value`, `detail`, `chevron`, `selected`, `destructive`, `loading`, `onPress`) | `Form` (inset grouped, scrolls) › `Section` › row `Button` | scrolling `Column` › titled `Card` › `ListItem` (no chevron) | `ScrollView` › card › rows |
| `FormSlot` (any RN view inside a `Form`) | `RNHostView` | `RNHostView` | `View` |
| `confirm()` / `notify()` (promise) | `UIAlertController` (RN `Alert`) | `AlertDialog` (RN `Alert`) | `window.confirm` / `alert` |

```
standalone control ─▶ its own Host (sized to it, or to the given width: fields, fullWidth)
inside a Form      ─▶ the bare native element: a Settings row / list item
inside a TopBar    ─▶ the bare control (InHost: already in the bar's Compose Host)
```

#### Liquid Glass (iOS 26+) and Material 3 (Android)

```text
liquidGlass = isLiquidGlassAvailable()   (expo-glass-effect; read once)
  true   iOS 26+ built with Xcode 26, the app not opted out
  false  iOS < 26 (the iOS 17 simulator), Android, web ─▶ the pre-26 look

Android: isDynamicColorAvailable (Android 12+)
  true   Host has no seed ─▶ Material You (wallpaper); usePalette() maps to its roles
  false  Host seeded with the accent #2F74C8 (primary exact); usePalette() = the app's
```

| Where | iOS 26+ | iOS < 26 | Android |
| --- | --- | --- | --- |
| Tabs' header | native glass bar, transparent, content under it | opaque native header | native header |
| Pushed screens' header | native glass bar, "‹" back (minimal), Start = prominent glass bar item | `TopBar` ("‹ Back") | `TopBar`: Material 3 top app bar |
| Tab bar | system glass (nothing opaque behind it) | system | Material 3 navigation bar |
| Space composer | floats over the chat: notes on a `Glass` panel, glass `Segmented`, glass field, `glassProminent` Send | bar under the chat | bar under the chat, no divider |
| Option chips | `.glassProminent` / `.glass` capsules | `.borderedProminent` / `.bordered` | `FilterChip` |
| Questions banner (over the tabs) | `Glass` cards tinted with the warning color | cards | cards in Material You surface |
| Connection banner | `Glass` capsule | muted pill | muted pill |
| Start a space | "+" glass bar item | "+" bar item | extended FAB, `primaryContainer` |

Rules:

- Glass is for what floats over content (bars, the composer, banners);
  content itself (rows, cards in a list, a form) stays plain, as in Apple's
  apps. Use `Button` `glass` / `glassProminent` and the `glass` prop, never
  `buttonStyle('glass')` or `GlassView` directly: below iOS 26 SwiftUI's
  own fallback is `.automatic` (a bare label) and `glassEffect` draws
  nothing, so the kit picks the bordered look instead.
- Never paint a background behind a glass bar: no `headerStyle`
  background on iOS 26 (expo-router then uses the system glass bar), no
  opaque view under the tab bar. A screen under a glass header starts at
  the window's top: scroll views use `contentInsetAdjustmentBehavior=
  "automatic"`, a SwiftUI `Form` follows the safe area itself, any other
  view at the top takes `useGlassHeaderInset()` (`src/shell/glassHeader.ts`),
  and `KeyboardScreen` subtracts no header.
- A standalone control's `Host` ignores the container safe area (iOS):
  scrolled under a glass bar it would otherwise shift by the bar's height.
- Android colors come from `usePalette()` (Material You roles on 12+), never
  hard-coded hex, so React Native text matches the Compose controls. Let
  Material components keep their own role colors (FAB, chips) unless a
  role is wrong.
- Material 3 Expressive in `@expo/ui` 58 is limited to `LoadingIndicator`
  (used by `Progress`), `ToggleButton`, `SplitButtonLayout` and the
  floating toolbar; shapes and motion follow the Compose defaults.

Rules for screens:

- Actions use the kit: no raw `Pressable`/`TouchableOpacity` buttons, no
  `src/ui/kit` `Button`/`Chip`/`Field`/`Confirm` in converted screens. Choices
  are `Segmented` (≤ 4) or `Select`; lists of settings-like rows are a `Form`.
- A `Form` is the screen's scroll view (it scrolls itself): don't put it in a
  `ScrollView`. Inside it only kit controls and `FormSlot`; strings must be
  props (SwiftUI and Compose can't render a bare RN `<Text>`).
- Labels stay what tests and Maestro tap: the visible `label` is the text and
  the accessibility name; pass `accessibilityLabel` when the visible text is
  not enough ("Switch to Acme" on a row reading "Acme"), `testID` for ids.
- Colors come from `usePalette()` (accent `#2F74C8` light / `#6AA7EC` dark;
  Material You's roles on Android 12+); each `Host` follows the system
  scheme and is tinted with the accent (Android 12+: the wallpaper's).
- Every component needs its web `X.tsx`; `pnpm -C mobile build:web` and
  `npx expo export --platform ios --platform android` both must bundle.
- Settings (`app/(app)/(tabs)/settings.tsx`) is the reference screen.
- Found on devices, keep them:
  - **Compose keeps what it was mounted with:** a `Button` or chip that turns
    on or off is remounted (`key` on the enabled state), or an enabled "Send
    answer" stays grey and dead.
  - **No `undefined` object props to Compose** (`colors={undefined}` fails to
    read as `ButtonColors`): spread them only when set.
  - **Don't change a SwiftUI `Form`'s modifiers on keyboard show** (e.g. a
    tap-to-dismiss gesture): SwiftUI rebuilds it and the focused field loses
    focus, so nothing can be typed. Dragging dismisses the keyboard.
  - Maestro on Android taps Compose fields poorly (it hits the first
    dropdown); a real tap (`adb shell input tap`) works.
- `@expo/ui`, `expo-symbols` and `expo-glass-effect` (also a dependency of
  `expo-router`, so already in builds that have the router) are native
  modules: a dev build made before them must be rebuilt (`npx expo prebuild --clean`, then `pnpm ios` /
  `pnpm android`); Expo Go can't show the kit.

Tabs are native (`expo-router/native-tabs`: `UITabBarController` with SF
Symbols, Material 3 navigation bar with Material Symbols); they draw no
header, so the stack around them shows the focused tab's title (on iOS 26+
a glass bar the tabs' content scrolls under). The web keeps the JS tabs.

### Connection banner

```
connected ─▶ connecting ─(< 1.5 s)─▶ connected       nothing shown (foreground, network switch)
connected ─▶ connecting ─(≥ 1.5 s)─▶ "Connecting to your devices…" capsule ─▶ gone when connected
error ─▶ "Not connected: <why>" at once
close 4000 (a newer connection of this device took over):
   another client in this JS context ─▶ this one goes quiet, never redials
   another tab / window              ─▶ "connected from another tab", redials when shown again
```

The auth and fleet clients live on `globalThis`, one set per JS runtime:
Fast Refresh can't start a second fleet client on the same device key.
Editing `src/fleet` or `src/auth` in dev needs a full reload.

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
- Expo Go shows the screens, but sign-in can't come back to it (it opens
  `exp://`, not `theodore-mobile://`) and it gets no remote push. Use a
  local dev build instead, on a simulator or emulator:

  | Platform | Needs | Run |
  | --- | --- | --- |
  | iOS | Xcode, CocoaPods | `pnpm -C mobile ios` (`expo run:ios`) |
  | Android | Android SDK and an emulator, `ANDROID_HOME` set | `pnpm -C mobile android` (`expo run:android`) |

  `ios/` and `android/` are generated (`expo prebuild`) and not committed.
  After changing `app.json` (icons, splash, plugins) or adding a native
  module, regenerate them: `npx expo prebuild --clean`. Without a Mac:
  `npx eas-cli@latest build --profile development`.
- Icons are Theodore's logo, from `mobile/assets/src/*.svg` (the glasses of
  `apps/desktop/icons/src/icon.svg`). Change a source, then run
  `mobile/scripts/icons.sh` and commit the PNGs: the iOS icon, the Android
  adaptive icon (background, foreground, monochrome), the notification icon,
  the splash, the sign-in logo and the favicon.
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
| 7 | WorkOS redirects | add `theodore-mobile://callback` and `https://theodore-web-staging.prd-instance.workers.dev/callback` to the staging environment, `theodore-mobile://callback` and `https://theodore-web.prd-instance.workers.dev/callback` to production (docs/releasing.md "WorkOS redirects to register") |
| 8 | Pages projects | `wrangler pages project create theodore-web-staging --production-branch staging` and `wrangler pages project create theodore-web --production-branch main` |
| 9 | Cloud CORS | the two web origins in the Worker's CORS config ("Cloud" above) |

`mobile-web.yml` reuses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`; the
token must also carry "Cloudflare Pages: Edit". No other secret is added to
GitHub: EAS holds the Apple, Google and push credentials.
