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

- Push registry per device; push sent by the hub through the Expo Push API
  (`https://exp.host/--/api/v2/push/send`, no APNs/FCM keys in the Worker)
  for: a question routed to a device that isn't connected, a space it follows
  turning idle/failed. Body: "<host> · <space>: <question>", ≤ 180 chars;
  options as category actions (≤ 4).
- `POST /v1/fleet/request` routes like a socket `request`; rate-limited per user.
- Delegations stored per origin; subscribe/ask routing = origin, host, and the
  origin's live delegates.
- CORS for the web app's origin only (`https://<web>.pages.dev` per env).
- Requests targeting a `mobile` / `web` device: `refused{fleet.invalid}`.

## App (mobile/)

```
mobile/
  app/                 expo-router screens: (auth)/sign-in, (app)/spaces, space/[id], start, devices, settings
  src/auth/            AuthKit PKCE (expo-auth-session), session + refresh, org select/switch via cloud
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
- Redirect URIs to register in WorkOS: `theodore://callback` (native, per
  channel scheme) and the web origin's `/callback`.

## Desktop changes

- Devices page: phone and web devices listed with their kind; trust works as
  for computers; "Send my spaces' questions here" toggles a delegation.
- The core signs/revokes delegations and ignores `mobile`/`web` devices as
  targets.

## Not in v1

Web push, hosting spaces on the phone, file transfer, tablets' layouts beyond
"it works".
