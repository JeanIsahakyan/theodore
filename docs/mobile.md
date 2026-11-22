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
| Drawer | Fleet spaces you started from here or follow, newest activity first by day (Today, Yesterday, Previous 7 days, Older), a status dot, search; Devices, Settings, the account and organization. No "New space" row: that is the header's ✎ |
| Home (new space) | The goal in the composer; under the hint a project chip and a computer chip ("theodore on mac-A", a sheet each; the computer's sheet holds the mode up to its cap), in the composer the model chip (top 4, All models, Effort); last picks remembered (below, "New space"). Before this run's first devices list: skeleton chips and "Connecting to your devices…", typing allowed, Send off; the server unreachable ─▶ "Can't reach the server", Retry (below, "First connection") |
| Devices | This device's fingerprint (large, copy) to show on the computer; a card per device, computers first (kind, online, OS · mode cap · agents, fingerprint), trust / untrust with the fingerprint confirm; on a computer, its auto mode per Claude via cloud device (Off / Auto Edit / Full auto, for 1 hour, until end of day or until turned off) |
| Settings | Account card; Organization (switch), Devices, This device (fingerprint, copy), Appearance (Light / Dark / System), Notifications, About (version, server); sign out |
| Space | Its chat (or history lines), send a message any time: your bubble shows at once, "Sending…" over it, and the field clears ("Optimistic sends" below); while a turn runs the host queues it (the bubble reads "Queued", "· 1 queued" on the strip), Stop beside Send; not sent ─▶ "Not sent · why", Retry / Edit; the composer's one chip is the model's, its sheet also holds the next message's mode (shown in the header: "on mac-A · Running · Edit"); 📎 attaches photos and files, previewed above the field, uploaded on pick ("Files" below); the running turn's steps; above the composer the activity strip ("Activity strip" below): what runs now and a timer, the turn's subagents and the space's sub-spaces, a tap opens the activity sheet; Approve / Revise a plan (Approve shows as your message at once), answer its question (the card collapses to "Answered: …" at once); a space started from Home opens here before the host answers ("Starting on mac-A…"); a file path in a reply (`src/app.tsx`) or a file on your bubble opens the file viewer |
| Sub-space | A sub-space of a followed space, read from its host by its local id every 3 s while in front: its last messages, running text, question (answered there), a composer that messages it in its own mode, with 📎 ("Sub-spaces" below) |
| File | A file of a space on a computer, pushed with Back: its name, "mac-A · theodore · 340 KB", Save or share; an image pinch-zooms, a PDF pages, text and code are monospace and highlighted ("Files" below) |

Questions and "space finished" arrive as push notifications; a question's
options are notification buttons (one tap answers it, signed on the phone,
sent over HTTPS). The web build has no push in v1: it shows them while open.
A request from Claude via cloud waiting on one of your computers (when it
sends its spaces' questions here) shows on Home as a card and arrives as a
push with Deny / Allow buttons (docs/fleet.md "Requests from Claude via the
cloud").

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
| newest 100 lines, the mirrored space row, its sub-spaces (≤ 50), newest 100 chat messages (≤ 512 KB) | older messages: not replayed, the resubscribe starts after the last seq |

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

The app speaks protocol 6. Since v4 it also reads:

| Addition | What the app does |
| --- | --- |
| `DeviceKind::Mcp` (v5) | listed as "Claude via cloud"; never a target |
| `DeviceInfo.mcp_auto` (v6) | a computer's auto mode per `mcp` device it pins, on its Devices card; changed with a signed `RemoteOp::SetMcpAuto` to that computer (trusted here) |
| `ServerMessage::Confirm{envelope}` (v6) | `RemoteConfirm`, `Domain::Confirm`, opened with the host's pin, signer = `host_device`; kept until `confirm_dismissed`, its expiry, an answer, or the next welcome (the cloud sends the waiting ones again) |
| `RemoteOp::Confirm{confirm_id, allow}` (v6) | the card's or the push's Allow / Deny, to the host; a late one (`fleet.invalid`) just drops the card |

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
                       (app)/ drawer around a stack: index (Home, new space),
                       space/[id], devices, settings pushed over it; start ─▶ /;
                       model-, computer-, project-picker, activity-sheet: the
                       composer's and the strip's sheets (iOS);
                       space/[id], sub-space/[space]/[child], file/[space] (a file
                       of a space on its computer), devices, settings
                       (+ settings/organization, device, about) pushed over it;
                       start ─▶ /
  src/components/      the shell and composer, adapted from the chat template (below)
  src/auth/            AuthKit PKCE, session + refresh, org select/switch via cloud, RS256 check
  src/shell/           wiring: AppProviders (auth + fleet clients, auth state, fleet lifecycle)
                       (not src/app: expo-router would take src/app as the routes root)
  src/fleet/           pure TS client: socket, hello, seal/verify (domain tags), pins, journal of lines,
                       spaces kept across restarts (saved.ts; data.* storage per platform),
                       files: blob.ts (seal/open), blob-store.ts (the cloud's chunks), file-cache.ts
  src/keys/            DeviceKey: secure-store (iOS/Android) | WebCrypto + IndexedDB (web)
  src/push/            expo-notifications: register, categories, background answer
  src/state/           stores (zustand) the screens read
  src/ui/native/       the native kit: SwiftUI (iOS) / Compose (Android) / RN (web) controls
  src/gen/fleet.ts     copied from cloud/src/gen (generated from Rust; never edited)
```

- Crypto: `@noble/ed25519` (pure JS, audited) with the same domain tags as
  Rust; a shared test vector (key, message, signature) produced by Rust keeps
  both sides honest. Files: `@noble/curves` (X25519 from the ed25519 keys),
  `@noble/ciphers` (XChaCha20-Poly1305), `@noble/hashes` (HKDF, SHA-256),
  checked against the Rust blob vectors ("Files" below).
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
| `Button` primary / secondary / plain / destructive, `loading`, `disabled`, `fullWidth` | `Button` `.borderedProminent` / `.bordered` / `.borderless` / role destructive | `Button` / `FilledTonalButton` / `TextButton` / `OutlinedButton` in danger | `Pressable` (destructive: outlined, red text) |
| `Button` `fullWidth` in a `Section` `plain` (Sign out) | row button, label centered | the button across the screen, no card | the button across the screen, no card |
| `Button` glassProminent / glass (floating over content) | 26+: `.glassProminent` / `.glass`; before: `.borderedProminent` / `.bordered` | `Button` / `FilledTonalButton` | as primary / secondary |
| `Segmented` (Ask/Plan/Edit, short sets) | `Picker` `.segmented` | `SingleChoiceSegmentedButtonRow` | joined segments |
| `Select` (device, project: longer lists) | `Picker` `.menu` | `ExposedDropdownMenuBox` | row that unfolds the choices |
| `Select` in a `Form` (Theme) | `Picker` `.menu`: "Theme   System ⌃⌄" | `ListItem` (value as supporting text) + `DropdownMenu` | row that unfolds the choices |
| `glass` on `Segmented`, `Select`, `TextField` (standalone) | 26+: `glassEffect` capsule / rounded behind it; before: as without | ignored | ignored |
| `Glass` (RN content on a surface: banner, panel; `shape`, `radius`, `tint`, `fallback`) | 26+: `GlassView` (`expo-glass-effect`); before: the `fallback` | `View`, `fallback` in Material You colors | `View`, `fallback` |
| `TopBar` (pushed screen: `title`, `onBack`, `action`) | before 26: "‹ Back", title, action (26+: the native glass bar instead) | Material 3 `TopAppBar` (back arrow, `titleLarge`) | "‹ Back", title, action |
| `Switch` (label, `detail`, `icon`) | `Toggle` | `ListItem` + `Switch`, row `toggleable` | row + RN `Switch` |
| `TextField` (single / `multiline`, `placeholder`, `onSubmit`, `submitLabel`) | `TextField` (vertical axis, `lineLimit`) | `OutlinedTextField` (ime action) | `TextInput` |
| `Progress` circular / linear, `value` 0…1 or none | `ProgressView` | `CircularProgressIndicator` (a value) / Expressive `LoadingIndicator` (none) / `LinearProgressIndicator` | `ActivityIndicator` / bar |
| `Form` › `Section` (`title`, `footer`, `plain`) › `Row` (`label`, `value`, `detail`, `icon`, `chevron`, `selected`, `destructive`, `loading`, `onPress`) | `Form` (inset grouped, scrolls) › `Section` › row `Button` | scrolling `Column` › titled `Card` › `ListItem` (no chevron) | `ScrollView` › card › rows |
| `icon` on `Row`, `Switch`, `Select` (`src/ui/native/icons.ts`) | SF Symbol in a `Label` (accent) | Material Symbol, the `ListItem`'s leading content (`assets/icons/*.xml`) | Lucide |
| `FormSlot` (any RN view inside a `Form`) | `RNHostView` | `RNHostView` | `View` |
| `Menu` (`label`, `groups` of choices with a check on the current one) | `Menu` with a `Picker` submenu per group, a lone group inline (glass button on iOS 26) | `AssistChip` + `DropdownMenu`, a heading per group | pill + sheet |
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
| Home's header | native glass bar, ☰ / 🔔 / ✎ bar items | opaque native header, same items | Material 3 top app bar (menu, badged bell, edit) |
| Pushed screens' header | native glass bar, "‹" back (minimal) | `TopBar` ("‹ Back") | `TopBar`: Material 3 top app bar |
| Space's header (name, "on host · status · mode") | Home's header (☰ / 🔔 / ✎), two-line title view | same, opaque native header | Home's top app bar, title + subtitle |
| Drawer | behind the content, which slides off it (rounded corners) | same | Material 3 modal navigation drawer over a scrim, pill items |
| Composer | Liquid Glass, interactive | system chrome blur | `surfaceContainerHigh`, 28 dp corners, filled send |
| Composer: model (a space: its Mode step too) | small bordered capsule (effort secondary) ─▶ formSheet route, glass sheet, grabber | same, no glass | assist chip (`labelMedium`) ─▶ Compose `ModalBottomSheet` |
| Home: project and computer chips (the computer's sheet holds Mode) | small bordered capsules with an SF Symbol ─▶ formSheet route | same | assist chips with a Material Symbol ─▶ Compose `ModalBottomSheet` |
| Space composer | `PromptInput` floating over the chat, notes on a `Glass` panel above it | same, chrome blur, notes on a card | same, `surfaceContainerHigh`, notes on a card |
| Scroll to the newest message | glass circle | blur circle | raised `card` circle, ripple |
| Plan's Approve / Revise, Send answer | capsule `.borderedProminent` / `.bordered` (kit `Button` `pill`) | same | `Button` / `FilledTonalButton` |
| Option chips | `.glassProminent` / `.glass` capsules | `.borderedProminent` / `.bordered` | `FilterChip` |
| Questions banner (on Home) | `Glass` cards tinted with the warning color | cards | cards in Material You surface |
| Connection banner | `Glass` capsule | muted pill | muted pill |

Rules:

- Glass is for what floats over content (bars, the composer, banners);
  content itself (rows, cards in a list, a form) stays plain, as in Apple's
  apps. Use `Button` `glass` / `glassProminent` and the `glass` prop, never
  `buttonStyle('glass')` or `GlassView` directly: below iOS 26 SwiftUI's
  own fallback is `.automatic` (a bare label) and `glassEffect` draws
  nothing, so the kit picks the bordered look instead.
- Never paint a background behind a glass bar: no `headerStyle`
  background on iOS 26 (expo-router then uses the system glass bar). A screen under a glass header starts at
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
  are `Segmented` (≤ 4) or `Select`; lists of settings-like rows are a `Form`,
  except Settings and Devices, which are the shell's settings rows
  ("Settings and Devices" below).
- A `Form` is the screen's scroll view (it scrolls itself): don't put it in a
  `ScrollView`. Inside it only kit controls and `FormSlot`; strings must be
  props (SwiftUI and Compose can't render a bare RN `<Text>`).
- Labels stay what tests and Maestro tap: the visible `label` is the text and
  the accessibility name; pass `accessibilityLabel` when the visible text is
  not enough ("Switch to Acme" on a row reading "Acme"), `testID` for ids.
- Colors come from `usePalette()` (accent `#2F74C8` light / `#6AA7EC` dark;
  Material You's roles on Android 12+); each `Host` follows the app's
  scheme (`useScheme()`, the Theme setting) and is tinted with the accent
  (Android 12+: the wallpaper's). Never read React Native's
  `useColorScheme()` directly: on web it ignores the setting.
- Android icons are Material Symbols (outlined, 24 dp vector drawables from
  google/material-design-icons, in `assets/icons`), drawn by Compose's
  `Icon`; a new one is a new XML there and a line in
  `src/ui/native/materialIcons.ts`.
- Every component needs its web `X.tsx`; `pnpm -C mobile build:web` and
  `npx expo export --platform ios --platform android` both must bundle.
- `app/(auth)/choose-organization.tsx` is the reference `Form` screen.
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

### Shell: drawer, header, composer

The look follows Evan Bacon's chat template (MIT,
`mobile/THIRD_PARTY_NOTICES.md` lists the files adapted from it). Theodore's
"chats" are its spaces.

```text
iOS / Android  DrawerLayout (src/components/drawer-layout.tsx) ── Stack
                 a rightward swipe anywhere on the content opens it on Home
                 and a space (src/ui/drawer.ts swipeOpensOn); not on pushed
                 screens, whose left edge is the system's back swipe. A
                 vertical or leftward move is the content's, and a horizontal
                 scroll view under the finger (chips, code block, table) wins:
                 it starts at its touch slop, under the swipe's 12 pt.
                 Open: a pan or a tap on the content closes it; Android Back too
web            sidebar beside the stack (md+), over it with a scrim (narrow)

drawer pick on Home ─▶ push [Home, pick]     elsewhere ─▶ replace [Home, pick]
new space (✎, the header) ─▶ dismissTo Home  bell ─▶ the first waiting space
```

| Piece | File |
| --- | --- |
| Drawer content (spaces by day, search, Devices, account, Settings) | `src/components/drawer-content.tsx`, groups in `src/ui/drawer.ts` |
| Home's header | `src/components/main-header{.ios,.android,}.tsx` |
| Composer: `PromptInput` (field, Send / Stop, `leading` / `trailing` chips, `above` the field: the attached files) and `ComposerDock` (rides on the keyboard) | `src/components/chat/` |
| Files: 📎, the previews strip, paths in replies, the viewer ("Files" below) | `src/components/chat/attach-*.tsx`, `use-attach.ts`, `file-link.tsx`, `src/components/file/`, `app/(app)/file/[space].tsx` |
| Chat: `Conversation` (Legend List, keyboard-aware, `ConversationScrollButton`), `Message` (your bubble / the agent's full width), `StreamingMessage` + `Shimmer` (the live turn) | `src/components/chat/` |
| Markdown: mdast (micromark, GFM tables and strikethrough) ─▶ React Native views; code blocks highlighted (highlight.js, a fixed set of languages, never guessed) | `src/components/markdown/` |
| A space's header (name, "on host · status") | `src/components/space-header.tsx` (the main header with a subtitle), `space-title.tsx` |
| A space's steps: compact grey rows that open in place (folding: `src/ui/turnRows.ts`) | `src/ui/Timeline.tsx`, `src/ui/SpaceChat.tsx` |
| What you did before the host answered: sends, Approve, answers, a start (rules: `src/ui/pending.ts`) | `src/state/pending.ts`, `PendingRow` in `src/ui/SpaceChat.tsx` |
| The activity strip above a space's composer and its sheet (rules: `src/ui/activity.ts`) | `src/ui/ActivityStrip.tsx`, `src/ui/ActivitySheet{.android,}.tsx`, route `app/(app)/activity-sheet.tsx` |
| A sub-space's screen (words: `src/ui/subSpaceScreen.ts`) | `app/(app)/sub-space/[space]/[child].tsx` |
| Composer chip, Home's where chips and picker sheets (computer + Mode, project, agent · model · effort + a space's Mode) | `src/components/pickers/` (`sheet-chip.*` a chip per platform, `sheet-host.*` opens a sheet per platform, `where-chips.tsx`), routes `app/(app)/model-picker.tsx`, `computer-picker.tsx`, `project-picker.tsx`; logic `src/ui/modelPicker.ts`, `src/ui/homeDraft.ts`, `modeRows` in `src/ui/logic.ts`; picks `src/state/compose.ts` |
| Icons: SF Symbols (iOS), Material Symbols (Android), Lucide (web) | `src/components/symbol-image.tsx` |
| Settings and Devices: rows, sections, account / fingerprint / device cards | `src/components/settings/` (below) |

- The space's last activity (`SpaceView.activeAt`): its mirrored row's
  `updated_at`, else when something of it last arrived here.
- Keyboard: `react-native-keyboard-controller` (`KeyboardProvider` at the
  root); the dock's bottom is max(safe area, keyboard), on Android edge to
  edge the IME padding. A space's list is Legend List's
  `KeyboardAwareLegendList`: its end inset is the floating dock's height +
  max(safe area, keyboard) + 8, and it lifts with the keyboard only when
  you are at the end.
- Fleet text is untrusted in the markdown too: a link is its words and its
  address in muted text (nothing opens), an image is `[image: alt]`
  (nothing loads), raw HTML is text, nesting deeper than 16 is plain text.

### Activity strip

What a running space is doing, above its composer, on the notes panel
(Glass on iOS 26+, a card elsewhere), the desktop's `SpaceProgress` and
`SpaceAgents` in two lines. Rules: `src/ui/activity.ts`; views
`src/ui/ActivityStrip.tsx`, `src/ui/ActivitySheet{.android,}.tsx`.

```text
 ... chat ...
 ⟳ 2 of 5 · Edit auth · 1 queued             1m 12s   line 1, while a turn runs
 ◌ 2 agents · 2 sub-spaces (1 waiting)            ⌃   line 2 ─▶ the activity sheet
╭──────────────────────────────────────────────╮
│ Add to the queue…                            │
│ (Opus 4.1 High ⌄)                   (■) (↑)  │
╰──────────────────────────────────────────────╯

line 1   running ─▶ the plan ("<done> of <n> · <active step>", update_progress)
                    else the newest live step ("Edit auth.ts"), else (a host
                    that doesn't mirror) the newest log line, else "Working";
                    a timer since your message; "· N queued" after it
         a question waits ─▶ "Waiting for your answer ↓": a tap scrolls to the card
         else ─▶ no line
line 2   the turn's subagents (live, or the last turn's) and the space's
         sub-spaces: "2 agents · 3 sub-spaces (1 running, 1 waiting)"; a
         spinner while any runs or waits; none of either ─▶ no line
neither ─▶ no strip (the Run warning and the chat error keep their notes)
```

Subagents are the turn's top-level `Task` / `Agent` steps with a call id
(`toolRow` kind `agent`, `src/ui/turnRows.ts`): one with no result runs
while the turn does, a `background` one until its summary lands; their
times are this app's (first seen, settled), kept per space while it lives.
The protocol has no per-subagent Stop, so the sheet offers none.

```text
Activity (the sheet: iOS formSheet route /activity-sheet?space=<id>,
          Android Compose ModalBottomSheet in place, web a modal)
  Plan · 2 of 5
    ✓ Read the flow
    ⟳ Edit auth
    ○ Tests
  This turn                         ("Last turn" once it ended)
    ◌ Explore the auth flow         running · 32s
    ✓ Review the tests              done · 1m 4s
  Sub-spaces
    ? Fix the flaky test            waiting for an answer · Edit  ›  ─▶ its screen
    ⟳ Update the docs               running · Edit                ›
    ✓ Split the crate               merged · Edit                 ›
```

### Sub-spaces

A followed space's children (docs/fleet.md "What a hosted space's agent
may do") arrive as `mirror{sub_space, <child id>}` events of that space.
The phone keeps them with its mirror and shows them as a tree.

```text
mirror{sub_space, id, MirroredSubSpace} ─▶ mirror.subSpaces[id], latest wins
  null data ─▶ removed     not its shape ─▶ dropped     ≤ 50 per space
  ─▶ saved with the space (src/fleet/saved.ts), shape-checked on load

Space screen, top of the chat           Drawer row
╭ Sub-spaces ──────────────────────╮     Fix the login redirect      ●
│ Split the crate  (Running)  Edit │     3 sub-spaces, 1 running
│   Move the types (Merged)   Edit │
╰──────────────────────────────────╯
```

| Host says | Chip |
| --- | --- |
| `done` | Merged |
| `running`, `setting_up` | Running |
| `question`, `waiting` | Waiting for you |
| `failed` | Failed |
| `idle`, `archived`, anything else | Done |

- Children are listed under their parent, siblings in the order first seen;
  one whose parent is unknown sits at the top level after the tree.
- A tap (here, or on a row of the activity sheet) opens the sub-space's
  screen; a long press copies its id. Logic: `src/ui/subSpaceTree.ts`;
  view: `src/ui/SubSpaces.tsx`.

#### The sub-space screen

A child isn't followed here (no `rs_` id, nothing mirrored), so its screen
reads it from the host through the ops on any space (docs/fleet.md "Any
space on a computer"), by its local id.

```text
[‹]      Fix the flaky test                          /sub-space/<space>/<child>
         sub-space of Retry on 429 · on mac-A · Waiting for you
 ... its last messages (read_space, up to 50) ...    yours and its parent agent's
 ⟳ Running: Edit tests/flaky.rs              32s     as bubbles, the agent's full width
 ╭ ? Which fixture should it use? ─────────╮         its question ─▶ answer_space
 │ (fixtures/a)  (fixtures/b)  [Other…]    │
 ╰─────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│ Message this sub-space…                 (↑) │     ─▶ send_to: its own mode, no chips
╰──────────────────────────────────────────────╯

in front ─▶ readSpace{space: <child>, messages: 50} now, then every 3 s
   (no subscription exists for it; one read at a time)
   ─▶ the host's signed reply, every field shape-checked (spaceReadOf)
   ─▶ refused / offline / silent ─▶ one line ("Can't reach mac-A", or the
      refusal as errorText says it); the last read stays on screen
left ─▶ the polling stops
send ─▶ your bubble at once ("Sending…"), sendTo: "Queued" while it runs; a
   read message of yours with that text replaces it ("Optimistic sends")
```

| Client (`src/fleet/client.ts`) | Op | Signed to | Answer |
| --- | --- | --- | --- |
| `readSpace(host, space, messages ≤ 50)` | `read_space` | the host's pin | `SubSpaceRead`: title, status, mode, goal, progress, messages `{from, at, text, truncated}`, live, question `{ask, questions}`, error; refused unless it names that space |
| `sendTo(host, space, text)` | `send_to` | same | `{message, queued, position}` as a send's |
| `answerSpace(host, space, ask, answers)` | `answer_space` | same | — |

- `from` is `user`, `space:<id>` (its parent's agent: "From its parent
  space" over the bubble) or the agent's name.
- The parent space gone from the fleet ─▶ "This sub-space's space isn't in
  your fleet any more".

### Optimistic sends

What you do shows before the host answers, as on the desktop
(docs/spaces.md "What you do shows before the core answers"). The pending
state lives in a small store keyed by space (`src/state/pending.ts`,
zustand), so a bubble survives leaving and reopening the space; the rules
are plain TS (`src/ui/pending.ts`), the bubble `PendingRow`
(`src/ui/SpaceChat.tsx`).

```text
send ─▶ the field cleared, your bubble at once        Sending…  ╭ and the tests ╮
  │
  ├─ host: ok {message}            ─▶ "Sent": kept until its chat_message row
  │     (space screen)                 arrives (by that id; a host that names
  │                                    none: your text within 5 min), then
  │                                    dropped in favour of the row
  │     (a host that mirrors no rows)  until a "Turn n: <text>" line past the
  │                                    send shows it was received
  │     (sub-space screen)             until a read message of yours with that
  │                                    text, close in time (read_space has no ids)
  ├─ host: ok {queued, position}   ─▶ "Queued" ("Queued · 3 in line"), counted
  │                                    on the strip; the mirrored queued row
  │                                    replaces it
  └─ refused / no answer in 15 s   ─▶ Not sent · <why>  ╭ and the tests ╮
                                                            (Retry) (Edit)
                                       Retry sends it again as new (same mode
                                       and picks); Edit puts the text back in
                                       the field; nothing is lost silently
Approve ─▶ "Plan approved, implement it." as your bubble at once, in the
           build mode: the same rules; Approve is busy meanwhile
answer  ─▶ the card collapses to "◌ Answered: SQLite" at once; the host's row
           drops the question; refused ─▶ the card is back, the error under it
start   ─▶ /space/pending_<n> at once: the goal as your bubble, "Starting on
           mac-A…", the composer off; the host's ok (or the 30 s wait's end)
           names the space ─▶ the route is replaced with /space/<rs_id>;
           refused ─▶ back on Home, the goal in the field, the error shown
```

- The send's reply carries the row's id (`{message, queued?, position?}`,
  `fleet_queue.rs`); `sendResult` keeps it (`SendResult.message`).
- A row takes at most one bubble (the oldest with its text); an agent's row
  or a failed bubble never match.
- Push notification actions answer without a card: nothing optimistic there.
- Sign-out or an org switch clears the store.

### New space: where chips, the model chip and the sheets

```text
Home            It runs on your computer; follow it from here.
                   ( 📁 theodore ⌄ )  on  ( 🖥 mac-A ⌄ )    project sheet · computer sheet (+ Mode)
                ╭──────────────────────────────────────────╮  centered; wraps as two lines,
                │ What should the agent work on?           │  "on" with the computer chip
                ╰ (Opus 4.1 High ⌄)                    (↑) ╯  the model chip, effort muted
space composer  (Opus 4.1 High ⌄)                             the space's pick, kept per space;
                                                              its sheet holds the next message's Mode
chip ─▶ iOS      router.push(/model-picker[?space=id] | /computer-picker | /project-picker)
                 formSheet, detents 0.5 / 1, grabber; iOS 26+: no background, the glass sheet
        Android  Compose ModalBottomSheet in place (drag handle, scrim, Back), Compose rows
        web      a modal card over the window
the computer's only project ─▶ the project chip has no ⌄, opens nothing
the computer chip always opens: its sheet holds the mode
```

| Sheet | Content | A tap |
| --- | --- | --- |
| Model | top 4: each agent's default model (the host's order), then their next ones round-robin, the agent named when 2+; a picked one outside them 5th with ✓; "All models  12 ›" when more are listed; "Effort  Default (High) ›" when the model takes one; in a space "Mode  Edit ›" | a model: applied (haptic), the sheet closes only when it takes no effort |
| Model ─▶ All models | a heading per agent (2+), "Default" on its default, ✓ on what runs; search from 9 models; Reset to defaults | a model: as above, back to the top |
| Model ─▶ Effort | "Default (High)", then the model's levels in full (Low … Ultracode) | applied, back to the top |
| Model ─▶ Mode (a space) | Ask / Plan / Edit / Run up to the host's cap (all when it lists none), ✓ on the next message's | `setSpaceMode`, back to the top; the header shows it ("on mac-A · Idle · Plan"), Run warns above the composer when the space isn't in Run |
| Computer | computers you trust, online dot, those that can take a space first ("2 projects · up to Edit", else "Offline" / "Doesn't take spaces…" / "No projects", dimmed); under a rule "Mode  Edit ›" | picked, closed; its project: the last started in there, else its first; another computer drops the agent pick and caps the mode |
| Computer ─▶ Mode | Ask / Plan / Edit / Run up to the computer's cap, ✓ on Home's | `setHomeMode`, back to the computers (the sheet stays) |
| Project | "Project · mac-A": Recent (started in here, newest first), All (the rest); search from 7 projects | picked, closed |

```text
picks (src/state/compose.ts, zustand: the iOS sheets are routes)
  home        {deviceId, projectId, mode, pick}  only what was picked
  spacePicks  {space id: pick}
  spaceModes  {space id: {mode, of}}  the next message's mode, picked while the
              space's own was `of`: sticky per space, a turn in another mode
              resets it; Revise sets Plan; not kept across restarts
  recent      projects spaces were started in (≤ 5): the project sheet's Recent,
              a computer's project when it is picked

kept: <data storage> theodore.fleet.picks.<user>.<org>, written 300 ms after a change
account / org ─▶ cleared ─▶ read back, shape-checked   sign-out ─▶ removed
shown: resolveHome(startable devices now): a device gone ─▶ the first, its pick
       dropped; a project gone ─▶ the first; agent / model / effort no longer
       listed ─▶ dropped; the mode capped
sent:  only what was picked (startPicks / sendPicks), the host's defaults otherwise
```

- "New space" (✎ in the header, on Home and every space; the drawer has no
  row for it): Home's goal cleared, the field focused. Not
  at a cold start: the keyboard would cover Home at launch; web focuses it
  on load.
- Run picked (the computer sheet's Mode, a space's Mode step): the warning
  shows above the composer.
- A host too old to list agents: a space's chip shows the mode instead
  ("Edit ⌄"), so its Mode step stays reachable.
- Start ─▶ the space opens with a fade, not a slide, at once under a
  pending id ("Optimistic sends" above): it is a top-level screen like
  Home, its header the main one (☰ / 🔔 / ✎, no Back, no iOS edge swipe
  back); Android Back goes to Home. Devices and Settings stay pushed with
  Back.
- Design record: `mobile/sketch/new-space/SKETCH.md`.
### Settings and Devices

The template's settings look: flat icon rows, a chevron on a row that
opens a page, thin dividers between groups, cards for what you read
(the account, a fingerprint, a device).

```text
Settings (/settings)
  (JI) name · email · ▦ org · role                      AccountCard
  ▦ Organization   Acme       › ─▶ /settings/organization   rows, a check on the current
  ▭ Devices        2 online   › ─▶ /devices                 org; tap another ─▶ switch
  ▯ This device    iPhone     › ─▶ /settings/device         FingerprintCard
  ──────
  ◐ Appearance     System ⌃⌄    native menu (iOS SwiftUI Menu, Android M3 dropdown)
  🔔 Notifications       (  ●)   haptic tick on change
  ──────
  ⓘ About          1.0.0      › ─▶ /settings/about          version, server
  ──────
  ⇥ Sign out (red)              system confirm ─▶ signed out

Devices (/devices)
  [connection banner]
  FingerprintCard   name ● Connected / fingerprint 2 × 4 groups / ( Copy ) / hint
  Computers                         2 of 3 online
    DeviceCard      [kind] name ● Online / "macOS · up to Edit · Claude, Codex"
                    fingerprint (small, monospace) / ✓ Trusted (Untrust) | [Trust]
  Phones and browsers …            none ─▶ "No other devices yet"
```

| Piece | iOS | Android | Web |
| --- | --- | --- | --- |
| `SettingsRow` | 20 pt symbol, 17 pt label, detail on the right, `›` | Material 3 list item: 24 dp icon, 16 sp label, detail as supporting text, ripple, no chevron | as iOS, Lucide |
| `SettingsToggleRow` | `UISwitch` | the kit's `Switch` (Compose list item, the whole row toggles) | RN `Switch` |
| `SettingsMenuRow` | SwiftUI `Menu`, its label drawn as a row, inline `Picker` | `ListItem` + `DropdownMenu` | the row unfolds the choices |
| Trust / Untrust | kit `Button` `.borderedProminent` / `.bordered` red | `Button` / `OutlinedButton` red | filled / outlined red |
| Copy fingerprint | `expo-clipboard`, success haptic, "Copied" for 2 s | same | same, no haptic |

- Wording is plain TS and tested: `src/ui/settingsView.ts`,
  `src/ui/deviceView.ts`.
- Accessibility names stay what tests tap: "Switch to <org>", "Trust
  <name>", "Untrust <name>", "Copy fingerprint"; the trust confirm is
  `trustPrompt()` (fingerprint in full, what trust allows).
- The pages sit under the glass header on iOS 26+ (`SettingsScroll`:
  automatic insets) and pad the bottom safe area themselves.

### Styling: Uniwind (Tailwind v4)

New shell code is styled with `className` (Uniwind, `metro.config.js`);
the kit and the older screens keep `usePalette()`.

```text
src/global.css   tokens: the template's neutrals + primary #2F74C8 / #6AA7EC,
                 success / warning / danger; light and dark variants
Android 12+      applyThemeVars() overwrites them with Material You's roles at start
                 (src/components/theme-vars.android.ts), as usePalette() does
uniwind-types.d.ts  written by Metro (uniwind); committed so typecheck needs no Metro run
```

#### Theme (Settings → Appearance)

```text
start           readTheme() (sync) ─▶ Uniwind.setTheme(t)          src/ui/themeSetting.ts
Settings pick   Uniwind.setTheme(t) ─▶ writeTheme(t)
                  kept: secure-store on iOS / Android, localStorage on web
                  (src/ui/themeStore.*); a device setting, kept across sign-out

Uniwind.setTheme(light | dark | system)
  ├─▶ className tokens: the light / dark variants of src/global.css (web: .dark on <html>)
  ├─▶ native: Appearance.setColorScheme ─▶ UIKit / AppCompat (glass bars, alerts, keyboard)
  └─▶ useScheme() = Uniwind's current theme ─▶ usePalette(), every Host's colorScheme,
                    the status bar
```

Default System. Android 12+ keeps Material You in both schemes
(`getMaterialColors` per scheme).

- Pressed states are `active:` classes, never a `style` function on
  `Pressable` (Uniwind doesn't apply those); no `var(--…)` in inline styles.
- Native modules added with the shell (dev builds must be rebuilt):
  `react-native-reanimated` + `react-native-worklets`,
  `react-native-gesture-handler`, `react-native-keyboard-controller`,
  `react-native-svg`, `expo-blur`, `expo-haptics`, `expo-image`,
  `expo-system-ui`; with Settings and Devices, `expo-clipboard`; with
  files, `expo-image-picker`, `expo-document-picker`,
  `expo-image-manipulator`, `expo-sharing`, `react-native-webview`.

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

### First connection

Until this run's first `devices` list (sent right after the welcome;
`welcomed` in the fleet store), an empty list means "not loaded yet": Home
and the drawer draw skeletons (`src/ui/Skeleton.tsx`, a slow opacity
breath, still under Reduce Motion), never the empty states
(`src/ui/load.ts`).

```text
before the first welcome of this app run, with nothing saved

[☰]        New space          [🔔][✎]
                  ⌘
              New space
        ( ▒▒▒▒▒▒▒▒ ⌄ )  on  ( ▒▒▒▒▒▒ ⌄ )      skeleton chips (the project / computer chips' size)
          Connecting to your devices…           small spinner + text
╭──────────────────────────────────────────────╮
│ What should the agent work on?               │  typing allowed, Send off until ready
│ (▒▒▒▒▒▒ ⌄)                           (↑)    │  skeleton model chip
╰──────────────────────────────────────────────╯
drawer:   5 skeleton rows instead of the empty list text
```

| State | Home | Drawer |
| --- | --- | --- |
| first connect of this run, nothing saved, no welcome yet | skeletons + "Connecting to your devices…" | skeleton rows |
| spaces saved from the last run | the saved spaces at once; Home's chips show the last picks muted (named from the saved spaces on that computer) until the devices answer | the saved list (as before) |
| connected (welcome arrived), no computer can take a space | "No computer can take a space right now…" + Devices (as before) | "Spaces you start or follow show here." (as before) |
| error, or still connecting after 10 s | skeletons, "Can't reach the server" + the reason, Retry (`fleet.start()`, the reconnect path) | saved list or "Nothing loaded yet." + Retry |

Once welcomed, a redial keeps the last list; the connection banner speaks
for the link. Sign-out and an org switch reset `welcomed`.

## Desktop changes

- Devices page: phone and web devices listed with their kind; trust works as
  for computers; "Send my spaces' questions here" toggles a delegation.
- The core signs/revokes delegations and ignores `mobile`/`web` devices as
  targets.

## Files

Photos and files go to the agent on your computer, and the computer's
files come to the phone, through the cloud's blob store as ciphertext only
(docs/fleet.md "Files (blobs)": `theodore-blob-v1`, X25519 from the
ed25519 device keys already pinned, XChaCha20-Poly1305 per chunk of ≤ 4
MiB). The TS side is `src/fleet/blob.ts`, checked byte for byte against
the Rust vectors (`src/gen/fleet-vectors.json` `blobs`); the cloud routes
are `src/fleet/blob-store.ts`.

```text
phone ─▶ computer (Home, a space, a sub-space)
  📎 ─▶ Photo library · Camera · File (expo-image-picker, expo-document-picker)
    photo ─▶ compressed (expo-image-manipulator): long side ≤ 2048 px, JPEG 0.8;
             a PNG screenshot ≤ 2 MB stays PNG                      src/ui/attachments.ts planPhoto
    ─▶ the preview above the field at once (thumbnail, or name · size)
    ─▶ fleet.uploadAttachment: sealBlob(the computer's pinned key) ─▶ PUT chunks
       (3 tries each on a network error / 5xx) ─▶ progress bar ─▶ ✓   ─▶ ↻ when it failed
    ✕ ─▶ gone; its blob DELETEd when it had one
  Send ─▶ only with words and every file ✓ ─▶ attachments: BlobRef[] on start_space / send / send_to
       ─▶ your bubble shows the files (local copies) ─▶ the host's mirrored row shows them as chips
  limits: 10 files per message, 20 MiB each after compression; another computer picked on Home
          drops the files (they were sealed for the first one) and says so

computer ─▶ phone (a path in a reply, a file chip on your bubble)
  `src/app.tsx` in a reply ─▶ a tap (src/ui/filePaths.ts filePathOf: relative, no spaces or
  shell marks, a known extension or a directory) ─▶ /file/<space>?path=…&host=…
    ─▶ fleet.readFile {space, path, max_bytes: 8 MiB} ─▶ the host seals it for this device ─▶ {blob}
    ─▶ GET chunks (progress) ─▶ openBlob with this device's key ─▶ DELETE the blob ─▶ shown,
       cached for the session (src/fleet/file-cache.ts: memory + the app's cache dir)
    fleet.too_large under 8 MiB ─▶ "Large file · Download anyway" ─▶ again with 50 MiB (the protocol's cap)
    not found / denied / offline / silent ─▶ one line (src/ui/fileViewer.ts errorLine), Retry when it may help
  a file on your bubble (`[screen.png]`) ─▶ .context/screen.png on the host
```

| Piece | File |
| --- | --- |
| Composer: 📎 (iOS action sheet, Android alert, web popover), the previews strip above the field (`PromptInput` `above`) | `src/components/chat/attach-button{.web,}.tsx`, `attachment-strip.tsx` |
| Picking and compressing | `src/components/chat/pick-files.ts` |
| One composer's files: pick ─▶ upload ─▶ ✓ / ↻, ✕, take on send | `src/components/chat/use-attach.ts`, store `src/state/attachments.ts`, rules `src/ui/attachments.ts` |
| Paths in replies, chips on your bubble ─▶ the viewer | `src/components/chat/file-link.tsx` (`FileLinkProvider` on a space's and a sub-space's screen; the markdown's `inlineCode` rule) |
| The viewer: states `src/ui/fileViewer.ts`, kinds `src/ui/filePaths.ts`, body per kind | `app/(app)/file/[space].tsx`, `src/components/file/file-body{.web,}.tsx`, `text-view.tsx`, `share{.web,}.ts` |
| Client: `uploadAttachment`, `deleteBlob`, `readFile`, `fetchBlob`, `canOpenBlobs`; `attachments` on `startSpace` / `send` / `sendTo` | `src/fleet/client.ts` |

- Opening a blob needs the X25519 secret derived from the ed25519 seed:
  `DeviceKey.blobOpener` (`src/keys/ed25519.ts`) exposes the X25519 public
  key and a shared-secret function, never the seed. A web device whose key
  is a non-extractable WebCrypto key has none: it sends files but the
  viewer says to use the phone.
- Send waits for every file: a message never names a blob that isn't in
  the cloud. Retry of a failed send sends the same references again; Edit
  takes the text back and the files go (the cloud drops a blob after a
  day anyway).
- A photo's EXIF (location) is dropped with the re-encode; a small PNG
  kept as it is has none to begin with on iOS screenshots.
- iOS usage strings for the photo library and the camera are the
  `expo-image-picker` plugin's in `app.json`; `expo-sharing` is the share
  sheet (Save Image / Save to Files); `react-native-webview` draws PDFs
  on iOS (Android: Share, its WebView can't; web: an iframe). Native
  modules: dev builds made before them must be rebuilt.
- Not run on a device yet: the pickers, compression, the share sheet and
  the PDF view are wired as their Expo modules document them; the crypto,
  the uploads, the payloads and the viewer's states are tested.

## Not in v1

Web push, hosting spaces on the phone, tablets' layouts beyond "it works".

## Build and release

Web rides the branch flow like the Worker. iOS ships with the desktop
release: a new version on `main` builds it on EAS and uploads it to
TestFlight. Android is an EAS build the owner starts by hand.

```
push staging, mobile/** ─▶ mobile-web.yml: checks ─▶ build:web ─▶ Pages theodore-web-staging
push main,    mobile/** ─▶ mobile-web.yml: checks ─▶ build:web ─▶ Pages theodore-web
every PR / push          ─▶ ci.yml `mobile`: typecheck, lint, format, test, build:web

new version on main ─▶ release.yml `ios`: eas build --profile production ─▶ eas submit ─▶ TestFlight
                                                               App Review: by hand in App Store Connect
eas build --profile preview    ─▶ internal build (staging cloud) ─▶ Play internal / ad hoc
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
| `production` | stores | store (AAB, App Store) | production, literal |
| `apk` | installing by link, no store | internal (APK Android) | production, literal |

- The EAS project is `@jean_i/theodore` (id in `app.json`). Production's
  client id and cloud URL are literal in `eas.json`: both are public (the
  client id is in every sign-in link). Same values as the `THEODORE_*` repo
  variables.
- Versioning: `appVersionSource: remote`. The user-visible version is
  `expo.version` in `app.json`; the build number (iOS) and version code
  (Android) are counted by EAS and bumped by `autoIncrement` on `production`.
  Remote, because nothing in git then has to be bumped and merged per upload
  (Apple rejects a repeated build number, and a failed upload still burns
  one). `expo.version` is the desktop's version: `scripts/bump-version.sh` sets it
  with the rest.
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

- TestFlight: every release does it (`release.yml` job `ios`, below); by
  hand, `eas build --profile production --platform ios` then
  `eas submit -p ios --id <build>`. Add internal testers in App Store Connect. No device
  registration. Prefer this to ad hoc for anyone beyond the owner's own devices.
- Play internal testing: first upload of an app must be manual in the Play
  Console (Google rejects the API for a never-uploaded app); after that
  `eas submit --platform android` lands in the internal track, set in
  `eas.json` `submit.production.android.track` if it should differ.
- Store submission: the listing, screenshots, privacy answers and review
  notes are filled in App Store Connect / Play Console by hand. Review notes
  must say how to sign in (a test WorkOS account) and that the app needs a
  computer running Theodore to do anything.

### Demo

"Try the demo" on the sign-in screen swaps both clients for the mock
services (`src/dev/demo.ts` over `src/dev/mock.ts`) under a neutral account:
every screen works on sample data, nothing talks to a server, no push.
Signing out (or "Delete account") leaves it and empties the store. It is
what App Review uses (the app shows nothing without a computer running
Theodore) and what the store screenshots are taken from.

```
sign-in ─▶ Try the demo ─▶ AppProviders: services = createDemo() ─▶ signed in (demo)
settings ─▶ Sign out ─▶ mock auth: null ─▶ services = real, fleet store reset
```

### Store listing

- App Store Connect: "Theodore Code", Developer Tools, free, all territories,
  iPhone only (`supportsTablet: false`). Text, keywords, age rating, review
  contact and notes are set through the App Store Connect API.
- Privacy policy: `https://theodore.cloud/privacy` on the website
  (`site/src/pages/Privacy.tsx`, docs/website.md), linked in Settings →
  About (`privacyPolicyUrl` in `src/config.ts`). `mobile/public/privacy.html`
  is the same text, still served by the web Worker at `/privacy` for older
  builds. Keep both true when data handling changes (cloud, push payloads,
  telemetry).
- Account deletion (App Store 5.1.1(v)): Settings → Delete account ─▶
  `DELETE /v1/account` (docs/cloud.md "Account deletion") ─▶ signed out.
- App Privacy answers (App Store Connect, by hand; the API has none): Contact
  Info (name, email), User Content (other), Identifiers (user id, device id),
  all for App Functionality, linked to the user, no tracking.

### iOS release in CI

`release.yml` job `ios` runs after the GitHub release is published (a new
version only). The signing material is not stored on EAS; the job writes
it from secrets into a gitignored `credentials.json` and points
`credentialsSource` at it, and adds the App Store Connect API key to the
submit profile (`eas submit --non-interactive` takes a local key only from
there).

| Secret | What |
| --- | --- |
| `EXPO_TOKEN` | Expo access token for `@jean_i` |
| `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD` | Apple Distribution cert + key, `.p12` base64 (expires 2027-11-21) |
| `IOS_APPSTORE_PROFILE` | App Store profile "Theodore App Store" for `app.theodore.mobile`, base64 (expires with the cert) |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | App Store Connect API key, shared with macOS notarization (docs/releasing.md) |

App Store Connect app: "Theodore code", Apple ID 6837583003 (`ascAppId` in
`eas.json`), team J33CB2C73P. Renewing: the API key (Admin) can create a
`DISTRIBUTION` certificate and an `IOS_APP_STORE` profile through the App
Store Connect API; re-encode them into the secrets.

### App Store submission (per App Store release)

CI only uploads each release's build to TestFlight. Shipping one to the App
Store is a separate step, done when the owner asks for it:

```
release vX.Y.Z on main ─▶ release.yml `ios` ─▶ build X.Y.Z in App Store Connect (VALID after ~10 min)
   ─▶ new appStoreVersion "X.Y.Z" (iOS) ─▶ "What's New" text ─▶ attach the build
   ─▶ reviewSubmissions: create (platform IOS) ─▶ add item (the version) ─▶ submitted: true
   ─▶ WAITING_FOR_REVIEW ─▶ approved ─▶ released automatically (versions are set to auto-release)
```

- All of that is App Store Connect API (`/v1/appStoreVersions`,
  `/v1/appStoreVersions/<id>/relationships/build`, `/v1/reviewSubmissions`,
  `/v1/reviewSubmissionItems`) with the Team Key; helpers and keys are in the
  owner's `~/.config/theodore/` (`bin/asc.py`, `apple/`, `README.md`).
- The version string must equal the build's (`expo.version`, which
  `scripts/bump-version.sh` sets). Only one version can be in review at a time.
- UI-only in App Store Connect (no API): App Privacy answers, the header /
  search-results art (`~/.config/theodore/store/cover.html`, 5244×2950), the
  Digital Services Act trader details, App Compliance. Drive them with a
  browser the owner signs in to.
- Not distributed in China mainland (needs an ICP filing, a security
  assessment and an AIGC declaration). EU distribution depends on the DSA
  trader verification.
- First submission: 0.1.25 (build 4), 2026-11-21.

### One-time, by the owner

| # | Step | How |
| --- | --- | --- |
| 1 | Expo account, EAS project | `npx eas-cli@latest login`, then `eas init` in `mobile/`: creates the project and writes `extra.eas.projectId` into `app.json`; commit it |
| 2 | EAS env for production | the two `eas env:create` calls above |
| 3 | Apple Developer Program, App Store Connect app | done (2026-11-20): team J33CB2C73P, app 6837583003; cert and profile made through the API, in the secrets above |
| 4 | iOS push key | done (2026-11-20): APNs key TG8NSFRC8T (Sandbox & Production) on EAS for `app.theodore.mobile`; Expo's push service uses it. Replace with `eas credentials` → iOS → Push Notifications. Never commit it |
| 5 | Google Play Console | pay, create the app `app.theodore.mobile`; make a service account key for `eas submit` (`eas credentials` → Android) |
| 6 | FCM for Android push | create a Firebase project, add the Android app, download `google-services.json`, point `expo.android.googleServicesFile` at it (upload it as an EAS file env var, not in git), then `eas credentials` → Android → FCM V1 service account key |
| 7 | WorkOS redirects | add `theodore-mobile://callback` and `https://theodore-web-staging.prd-instance.workers.dev/callback` to the staging environment, `theodore-mobile://callback` and `https://theodore-web.prd-instance.workers.dev/callback` to production (docs/releasing.md "WorkOS redirects to register") |
| 8 | Pages projects | `wrangler pages project create theodore-web-staging --production-branch staging` and `wrangler pages project create theodore-web --production-branch main` |
| 9 | Cloud CORS | the two web origins in the Worker's CORS config ("Cloud" above) |

`mobile-web.yml` reuses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`; the
token must also carry "Cloudflare Pages: Edit". No other secret is added to
GitHub: EAS holds the Apple, Google and push credentials.
