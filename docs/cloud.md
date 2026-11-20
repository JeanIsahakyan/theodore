# Cloud

The server side of the Theodore account: a Cloudflare Worker in `cloud/`
(TypeScript, pnpm). One Worker per channel, each in front of its own WorkOS
environment.

Why it exists:

- The app is a **public client**: it can't hold the WorkOS API key or client
  secret. Anything that needs them runs here.
- The fleet keys its state by `org_id`. Every user gets an organization
  (alone, a personal one), so solo and team use run the same path.

## Routes

| Route | Auth | Does |
| --- | --- | --- |
| `GET /v1/health` | none | `{ "ok": true }` |
| `GET /v1/orgs` | bearer access JWT | the caller's active organizations, personal first: `{ organizations: [{ id, name, role, personal }] }` |
| `POST /v1/orgs/personal` | bearer access JWT | the caller's personal org, created once: `{ organization_id, created }` |
| `POST /v1/auth/select-organization` | none (the pending token is the credential) | finishes a sign-in that needs an org picked: `{ user, organization_id, access_token, refresh_token }` |
| `POST /mcp` | MCP OAuth access token (scope `fleet`) | MCP over Streamable HTTP for Claude ("MCP" below) |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/callback`, `/oauth/org`, `/oauth/token` | none (OAuth itself) | the authorization server for `/mcp` ("MCP" below) |
| `GET /v1/fleet/ws` | bearer access JWT with `org_id`; from a browser, the subprotocol `bearer.<JWT>` (below) | WebSocket upgrade to the org's fleet hub (below, and `docs/fleet.md`) |
| `POST /v1/fleet/request` | bearer access JWT with `org_id` | a one-shot signed fleet request, no socket (a phone's notification action): `{ device_id, envelope }` ─▶ `202 { accepted: true, req_id }` or `409 { accepted: false, req_id, refused: { code, message } }` (`400` for `fleet.bad_message`) |

Body: JSON object, 64 KiB max. Errors: `{ "error": { "code", "message" } }`.

### The web app (CORS, browser sockets)

The web build of the phone app (`docs/mobile.md`) calls the cloud from a
browser. Its origins are the Worker var `WEB_ORIGINS` (comma-separated, per
environment in `wrangler.toml`):

| | `WEB_ORIGINS` |
| --- | --- |
| staging | `https://theodore-web-staging.prd-instance.workers.dev` |
| production | `https://theodore-web.prd-instance.workers.dev` |

```
OPTIONS /v1/orgs*, /v1/auth/select-organization, /v1/fleet/request
  Origin in WEB_ORIGINS ─▶ 204 + Allow-Origin <origin>, Allow-Methods GET, POST, OPTIONS,
                               Allow-Headers Authorization, Content-Type, Max-Age 600
  any other Origin      ─▶ 204, no CORS headers (the browser stops)
answers (and errors) on those routes ─▶ Allow-Origin <origin>, Vary: Origin
```

No credentials (no cookies): the bearer token is the credential. Other
routes never carry CORS headers.

A browser can't put `Authorization` on a WebSocket, so `GET /v1/fleet/ws`
also takes the token as a subprotocol, only from an origin in
`WEB_ORIGINS`:

```
new WebSocket(url, ['bearer', 'bearer.<access JWT>'])
  ─▶ Origin in WEB_ORIGINS and a `bearer.<token>` offered? no ─▶ 401 fleet.unauthorized
  ─▶ verify the token as for a header ─▶ hub; the 101 picks `bearer`
     (offered only `bearer.<token>`: the 101 picks that entry, since a
      browser drops a socket whose 101 names a protocol it didn't offer)
```

Offer both: then the token never comes back in the response.

Rate limits (Cloudflare rate-limiting bindings, separate counters per
environment; over: `429 cloud.rate_limited`):

| Bucket | Key | Limit | Routes |
| --- | --- | --- | --- |
| `RL_PUBLIC` | client IP (`cf-connecting-ip`) | 30 / min | `POST /v1/auth/select-organization`, `GET /v1/fleet/ws` |
| `RL_USER` | user (`sub`, after the token checks out) | 120 / min | `GET /v1/orgs`, `POST /v1/orgs/personal`, `POST /v1/fleet/request` |

## Auth

```
Authorization: Bearer <access JWT>
  ─▶ JWKS  <api>/sso/jwks/<client_id>  ─▶ RS256 signature
  ─▶ iss = <api> or <api>/user_management/client_…
  ─▶ exp (60 s leeway) ─▶ client_id, if present, is ours or the issuer's
  ─▶ sub = caller   (org_id, role, permissions read when present)
```

Same checks as the app (`crates/account-workos/src/jwt.rs`), but strict: an
unreachable JWKS fails the request (`503`) instead of being skipped.

## Org flows

```
first sign-in
  app ─▶ session (no org) ─▶ POST /v1/orgs/personal
      ─▶ org external_id personal:<user_id>, membership role admin
      ─▶ app: refresh_token grant + organization_id ─▶ token with org_id, role

user in 2+ orgs (second sign-in)
  app ─▶ WorkOS 403 organization_selection_required
         { pending_authentication_token, organizations }
      ─▶ user picks ─▶ POST /v1/auth/select-organization
      ─▶ cloud: organization-selection grant + client secret ─▶ session ─▶ app

switch org
  app ─▶ refresh_token grant + organization_id (public client, no cloud)
```

`/v1/orgs/personal` is idempotent and race-safe: two concurrent calls end
with one org and one membership. A deactivated membership is not undone
(`409 cloud.membership_inactive`).

## App side

The app (`crates/account-workos`, `usecases/account.rs`) calls the cloud
only with a cloud URL configured (plan §6.12 "Organizations"):
`THEODORE_CLOUD_URL` env, the `account.cloud_url` setting, or the one
compiled in per channel (`build.yml` input `cloud-url`). No URL: sign-in
works as before, no organizations.

| App call | Goes to |
| --- | --- |
| sign-in (code, device), refresh, switch org (`refresh` + `organization_id`) | WorkOS directly |
| ensure the personal org (after sign-in, at start, while the session has no org) | cloud `POST /v1/orgs/personal` |
| list orgs (`account_organizations`) | cloud `GET /v1/orgs` |
| finish a sign-in that needs an org picked | cloud `POST /v1/auth/select-organization`, then the app validates the session itself: signature always checked (JWKS unreachable ─▶ `account.network`, never skipped), and the session's `organization_id` and the token's `org_id` must both be the org picked (else `account.invalid_token`, nothing stored) |

| Cloud answer | App error |
| --- | --- |
| no connection, 5xx, 429, a 4xx without `{ error: { code } }` | `account.network` |
| `400 cloud.rejected` | `account.rejected` |
| any other 4xx | `account.protocol` (`code: message`) |

**The never-sign-out rule.** No cloud error and no org-scoped refresh ever
signs the user out or clears the session: the org step warns and retries at
the next start; a failed switch returns its error with the session
untouched. Only the background refresher, which never asks for an org,
ends a session. The access token and the pending token never land in an
error or a log.

## Verified against staging WorkOS

| Fact | Result |
| --- | --- |
| `refresh_token` grant with `organization_id`, public client, no secret | works: the app switches org itself |
| organization-selection grant without `client_secret` | `400 invalid_client "Invalid client secret."`: goes through the cloud |
| second sign-in of a user in 2+ orgs | `403 organization_selection_required` with `pending_authentication_token` and `organizations` |
| the pending token | single use |
| org-scoped access token | carries `org_id`, `role`, `permissions` |
| refresh into an org the user isn't in | `400 organization_membership_not_found`; the same refresh token still works afterwards (not burned), so a failed switch keeps the session |
| a plain refresh after an org-scoped one | keeps the org |
| membership objects | carry `organization_name` (the list needs no extra call per org) |

## Error codes

Stable `area.kind` codes, same form as the app's `error.code`
(`docs/telemetry.md`).

| Code | HTTP | When |
| --- | --- | --- |
| `cloud.unauthorized` | 401 | no or malformed bearer, bad signature, expired, wrong issuer or client, no subject |
| `cloud.jwks_unavailable` | 503 | the WorkOS signing keys couldn't be fetched |
| `cloud.rejected` | 400 | WorkOS refused with its own 4xx code (used pending token, org the user isn't in); the message carries it |
| `cloud.workos` | 502 | WorkOS failed otherwise (5xx, no code) |
| `cloud.bad_request` | 400 | body isn't a JSON object, or a required field is missing or too long |
| `cloud.too_large` | 413 | body over 64 KiB |
| `cloud.not_found` | 404 | no such route |
| `cloud.method` | 405 | method not allowed on that route |
| `cloud.membership_inactive` | 409 | the caller's personal-org membership is inactive or pending |
| `cloud.config` | 500 | `WORKOS_API_KEY` or `WORKOS_CLIENT_ID` missing |
| `cloud.rate_limited` | 429 | over a rate limit (above) |
| `cloud.internal` | 500 | anything unexpected; the log names the error kind, never the request |

## Environments and secrets

| | Staging | Production |
| --- | --- | --- |
| Worker | `theodore-cloud-staging` | `theodore-cloud` |
| WorkOS client id (`wrangler.toml` var) | `client_01M5RM1W36AHHEGBE37QD3PS6K` | `client_01M5RMBK860S2JJZNWJDDSH0BM` |
| WorkOS API key | Worker secret `WORKOS_API_KEY` | Worker secret `WORKOS_API_KEY` |
| Web app origins (`WEB_ORIGINS` var) | `https://theodore-web-staging.prd-instance.workers.dev` | `https://theodore-web.prd-instance.workers.dev` |
| Expo access token (optional) | Worker secret `EXPO_ACCESS_TOKEN` | Worker secret `EXPO_ACCESS_TOKEN` |
| Deployed by | push to `staging` | push to `main` |

- The API key is set by the owner, never in git or CI:
  `wrangler secret put WORKOS_API_KEY --env staging|production`. A deploy
  keeps it.
- Client ids are public: plain vars in `cloud/wrangler.toml`.
- The key is also the client secret for the organization-selection grant.
- `EXPO_ACCESS_TOKEN` is needed only if the Expo project turns on
  "enhanced push security"; without it pushes go out unauthenticated, as
  Expo allows by default.

## Local dev

```
cd cloud
pnpm install
echo 'WORKOS_API_KEY=sk_test_…' > .dev.vars    # gitignored; staging key
pnpm dev                                        # wrangler dev --env staging
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Tests run against a fake WorkOS: no network, no secrets. `ci.yml` (`cloud`
job) and the `lefthook` pre-push run the same checks.

## Deploy

```
push staging ─ cloud/** ─▶ cloud.yml: checks ─▶ deploy:staging    ─▶ theodore-cloud-staging
push main    ─ cloud/** ─▶ cloud.yml: checks ─▶ deploy:production ─▶ theodore-cloud
```

`workflow_dispatch` deploys a chosen environment by hand; production only
from `main`. Deploys per environment queue, never cancel. A push that
doesn't touch `cloud/` deploys nothing. No version bump or release is
involved (`docs/releasing.md`).

## One-time setup (owner)

Needed before the first deploy works; none of it is done yet.

1. `pnpm -C cloud exec wrangler login`
2. `wrangler secret put WORKOS_API_KEY --env staging`, then `--env production`
   (run in `cloud/`).
3. GitHub → Settings → Secrets and variables → Actions → **Secrets**:
   `CLOUDFLARE_API_TOKEN` (Workers edit permission) and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Later: a custom domain per Worker (`routes` in `wrangler.toml`). Until
   then the Workers answer on `workers.dev`.

## Fleet

The relay between one org's devices (`docs/fleet.md`): the Durable Object
`OrgHub`, one per `org_id`, in this Worker. Code: `cloud/src/fleet/`
(`hub.ts` the logic, `org-hub.ts` the DO shell, `wire.ts` frame checks,
`store.ts` the tables). Wire types come from `src/gen/fleet.ts`, generated
from `crates/fleet-protocol`.

```
device ─GET /v1/fleet/ws, Upgrade: websocket, Bearer JWT─▶ Worker
  ─▶ verify JWT ─▶ no org_id: 403 fleet.no_org   bad token: 401 fleet.unauthorized
                  JWKS unreachable: 503 cloud.jwks_unavailable (the device redials)
  ─▶ OrgHub(idFromName(org_id)) + x-theodore-fleet-caller {userId, orgId, sessionId, expMs}
     (incoming header replaced, Authorization dropped)
  ─▶ acceptWebSocket(tag u:<user>) ─▶ challenge ─▶ hello ─▶ welcome ...
```

Protocols 3 to 7 (`fleet.version`, close 4003, for anything else). The
hello's protocol is kept per connection:

| | Protocol 3 | Protocol 4 | Protocol 5 | Protocol 6 | Protocol 7 |
| --- | --- | --- | --- | --- | --- |
| `devices` list | computers only (`desktop`, `daemon`): it can't read `mobile` / `web` | no `mcp` device | every device | same as 5 | same as 5 |
| its own kind | `desktop` / `daemon` (else `fleet.bad_message`) | also `mobile`, `web` | same as 4 | same as 4 | same as 4 |
| `register_push`, `delegate` | unknown (`fleet.bad_message`) | accepted | accepted | accepted | accepted |
| `delegations` | never sent | after welcome and on change | same | same | same |
| `mirror` space events | never sent, live or history | sent | sent | sent | sent (`sub_space` too) |
| `confirm`, `confirm_resolved` (from a host) | unknown (`fleet.bad_message`) | same | same | accepted | accepted (`merge` too) |
| `confirm`, `confirm_dismissed` (to a delegate) | never sent | never sent | never sent | sent | sent |
| `DeviceInfo.mcp_auto` | dropped | dropped | dropped | kept and listed | kept and listed |
| ops on any space (`list_spaces` … `merge_child`), as a target | refused | refused | refused | refused | routed |

Kind `mcp` is the cloud's own device ("MCP" below): only its in-process
connection says it, and says nothing else; a socket's hello or `announce`
with `mcp` is `fleet.bad_message`. Refused with
`refused{fleet.upgrade_required}` (static words):

| Request | Target |
| --- | --- |
| from a device whose kind the target can't list | a phone's or the web's to 3, the MCP device's to 3 or 4 |
| `confirm` / `set_mcp_auto` | below 6 |
| an op on any space (`protocolFor`) | below 7 |

The op checks run when the request comes in (target online) and again
when an offline target comes back: its unclaimed requests it can't take
are refused then, the rest delivered.

`DeviceInfo.os` is `macos`, `linux`, `windows`, `ios` or `android` (a
browser: the OS it runs on). A protocol-3 device gets `linux` for any but
`macos` / `linux`; a device reads an OS it doesn't know as `other`.

- **Hibernation API**: an idle socket bills nothing. Per-socket state is its
  attachment (user, org, token expiry, device, generation, presence); the
  rest is SQLite, so a woken hub rebuilds nothing.
- **One alarm** for every deadline (hello due, token expiry + 60 s, 10 s
  grace, 2 min pending, 20 s escalation, a delegation's or a confirm's
  expiry), set only when it moves earlier.
- **Heartbeat**: the device pings (WebSocket ping frames); the runtime
  answers without waking the hub. The hub doesn't ping.
- Messages run one at a time, in arrival order. Everything is scoped to the
  sender's user: another user's devices, spaces and requests read as
  `fleet.not_yours` / `not_pending`, never as "exists".

Signatures (each over `"theodore-fleet-<kind>-v3\0" ‖ bytes`, so one kind
never verifies as another):

| Signed | By | The cloud |
| --- | --- | --- |
| hello: `hello` tag ‖ the 32 nonce bytes | the connecting device | verifies; one challenge per socket, its nonce spent on the first hello |
| request: `request` tag ‖ body | origin | doesn't verify (the target does); checks `device_id` = body origin = sender, and `target_key` = the target's pinned key (else `refused{fleet.not_yours}`); forwards unchanged |
| reply: `reply` tag ‖ `ReplyBody` | target | verifies against the sender's pinned key; `device_id` = `target_device` = sender = the pending request's target, `origin_device` = its origin; forwards unchanged |
| space event: `event` tag ‖ `SpaceEventBody` | host | verifies against the sender's pinned key; `device_id` = `host_device` = sender = the space's host; stores and forwards unchanged |
| ask: `ask` tag ‖ `RemoteAsk` | host | same as an event |
| delegation: `delegate` tag ‖ `Delegation` | origin | verifies against the sender's pinned key; `device_id` = `origin_device` = sender (below) |
| confirm: `confirm` tag ‖ `RemoteConfirm` | host | verifies against the sender's pinned key; `device_id` = `host_device` = sender, a computer (below) |

A failed event, ask or reply check is `error{fleet.bad_signature}`, nothing
stored or forwarded (a refused reply leaves its request pending).
A gap the cloud can't fill is its own unsigned `space_gap{space, from, to}`:
informational, never content.

Mirrored rows (`docs/fleet.md` "One space UI: mirrored rows"): a space
event whose `event.kind` is `mirror`, `{model, id, data}`.

```
mirror ─▶ model space | chat_message | sub_space | turn_step, id 1–256 chars?
          no ─▶ error fleet.invalid
  space, chat_message, sub_space ─▶ mirrors (space, model, id): the newer seq
                         replaces the older; data = null (a tombstone) is kept too
  turn_step           ─▶ relayed live only, never stored (last_seq moves)
  ─▶ subscribers on protocol 4; protocol 3 gets neither live nor history
subscribe{since} ─▶ ring events + kept mirrors with seq > since, in seq order
```

- Mirrors live apart from the ring: they never push an event out of the
  500, but count toward the byte budgets (below).
- **Gaps are real loss only.** A space keeps `lost_to`: the ring's oldest
  dropped (by count, bytes or a finished space's budget) and a protocol-3
  host's seq jump raise it. A hole in history at or below it is a
  `space_gap`; above it (a replaced mirror, a relayed `turn_step`, a
  protocol-4 host's compacted journal) it isn't. A protocol-4 host's seq
  jump is never a live gap.

Same-user devices aren't trusted by each other just for being the same user
(trust is pinned per device), so the cloud keeps a space to its host and
its **followers**: the origin, and the devices the origin delegated to
(below; with no delegation, just the origin):

| What | Who |
| --- | --- |
| `subscribe{space}` (history and live events) | the space's host and followers only; anyone else `fleet.not_yours` |
| a question, while you're at the host | the host only (its own card) |
| a question, otherwise | the follower you're at (`active`), else every follower online (`origin`); a device that isn't one doesn't pull it |
| after 20 s unanswered (or nowhere to show) | escalated to every follower not already showing it, and on their reconnect; never to every device |
| moving between host and followers | follows you (`moved`); presence elsewhere changes nothing |
| a request whose target is a `mobile` / `web` device | `refused{fleet.invalid}`: phones and browsers run no spaces |
| `answer` request | routed like any request; the question is dismissed elsewhere (`answered_elsewhere`) only after the host's signed `reply` with `ok` for it, a refusal leaves it open |
| a request whose target is its origin | `refused{fleet.invalid}` |
| a `start_space` whose space id is known, or has a start pending | `refused{fleet.invalid}`; the space that exists is untouched |
| a start the host refused | forgets the space only if this request made its row (at its claim): same host, origin and `req_id` |
| an op on any space of the target (protocol 7), from any origin, the MCP device too | routed on no cloud space (`pending.space` ''), never a `spaces` row: the target resolves its own id (or an `rs_` one it hosts for that origin) and decides; fields bounded only (ids ≤ 64, question / message ≤ 20 000 characters, `messages` ≤ 50, answers ≤ 20 × 50 × 4 000) |

`remove_device{device_id}` forgets one of the caller's other devices, only
while that device is offline:

```
same user? no ─▶ fleet.not_yours      the caller itself? ─▶ fleet.invalid
connected now? ─▶ fleet.invalid (nothing changes)
─▶ delete its row, the spaces it hosts (events, subs; their questions dismissed `resolved`)
─▶ requests waiting for it ─▶ origin: refused{fleet.offline};  replies held for it dropped
─▶ its push token and every delegation naming it dropped (the other side told)
─▶ its confirms dismissed where they showed, dropped
─▶ devices pushed to the rest
```

### Delegations

An origin lets another of its user's devices (a phone) follow the spaces it
started (`docs/mobile.md` "Following a computer's spaces"):

```
origin ─ delegate{envelope: Delegation{origin_device, delegate_device, issued_at_ms, expires_at_ms, revoke}}
  device_id = origin_device = sender?          no ─▶ error fleet.not_yours
  delegate is the sender itself?                   ─▶ error fleet.invalid
  delegate a device of the same user?          no ─▶ error fleet.not_yours
  issued_at_ms within 5 min of now?            no ─▶ error fleet.stale_request
  a grant whose expires_at_ms ≠ 0 is past?         ─▶ error fleet.invalid
  older than the one kept for this pair?           ─▶ error fleet.stale_request
  signed (`delegate` tag) by the sender's pinned key? no ─▶ error fleet.bad_signature
─▶ stored as signed, per (origin, delegate): the latest replaces the earlier
─▶ delegations{list} ─▶ origin and delegate (protocol 4, online)
revoke ─▶ kept as a tombstone 5 min (an older grant can't come back),
          the delegate's subscriptions to the origin's spaces end,
          its open question cards are dismissed (`resolved`)
```

- `delegations{list}`: the live delegations naming the device (origin or
  delegate), each as the origin signed it. After every welcome (protocol
  4) and on any change: grant, revoke, expiry, a removed device.
- Live: not revoked, `expires_at_ms` 0 or in the future. The alarm drops
  expired ones (both devices told) and tombstones past the 5 min window.
- A delegate gains nothing on hosts: its requests (answers, too) still
  need the host's own trust in its key.

### Confirms

An Edit or Run from Claude via the cloud (the MCP device) waits on its host
for a person's yes (`docs/fleet.md` "Requests from Claude via the cloud"),
unless the user turned on auto mode there. The host shows it on its own
screen and, through the cloud, on the devices it delegates to (a phone, the
web app, another computer):

```
host ─ confirm{envelope: RemoteConfirm{confirm_id, host_device, mcp_device,
                 action, mode, project_name, space_name, text, expires_at_ms}}
  every field bounded (text ≤ 500 chars, names ≤ 200)?  no ─▶ error fleet.bad_message
  device_id = host_device = sender?                 no ─▶ error fleet.not_yours
  the sender a computer?                            no ─▶ error fleet.invalid
  confirm_id open: the same host's ─▶ ignored;  another's ─▶ error fleet.not_yours
  expires_at_ms past?                                  ─▶ error fleet.invalid
  20 open for the user?                                ─▶ error fleet.busy
  signed (`confirm` tag) by the sender's pinned key? no ─▶ error fleet.bad_signature
─▶ kept until expires_at_ms (at most 5 min)
─▶ confirm{envelope} ─▶ the host's live delegates online on protocol 6
   (never an `mcp` one); again after their welcome, and to a new delegate
─▶ push to those away from a screen, once each
delegate ─ request{op: confirm{confirm_id, allow}} ─▶ host (any request route)
host ─ confirm_resolved{confirm_id}  (answered anywhere, or timed out)
  not its host? ─▶ error fleet.not_yours      unknown id ─▶ nothing
─▶ confirm_dismissed{confirm_id} ─▶ where it showed and the host's delegates;
   dropped
expiry │ delegation revoked or expired (that delegate) │ host removed
─▶ confirm_dismissed the same way
```

- A protocol-5 connection never gets `confirm` / `confirm_dismissed`: it
  can't read them.
- `confirm` and `set_mcp_auto{mcp_device, auto, until_ms}` (a host's auto
  mode for an `mcp` device it pins) are requests on no space (`space` ''):
  routed and claimed like any other, pending 2 min, nothing about spaces
  checked. From the MCP device itself: `refused{fleet.not_yours}` (the host
  refuses it too). To a target online below 6:
  `refused{fleet.upgrade_required}`.
- A host lists its auto modes in `DeviceInfo.mcp_auto` (≤ 8,
  `{device_id, auto: off | edit | full, until_ms}`), relayed in `devices`
  so another device can show and change them.

### Push notifications

The phone registers its Expo token over the socket; the hub sends through
the Expo Push API (`POST https://exp.host/--/api/v2/push/send`), never
APNs or FCM directly.

```
register_push{provider: expo, token}   (a `mobile` device only, else error fleet.invalid)
  token "" ─▶ removed     ExponentPushToken[…] / ExpoPushToken[…], ≤ 200 chars ─▶ stored
  (the same token on another device row is dropped: one phone, one row)

question from a host ─▶ followers ─▶ each with a token and not looking at it
  (offline, or connected but not focused / locked) ─▶ one push per question
  while you're at the host: none now; at the 20 s escalation, then
confirm from a host ─▶ its delegates the same way (not one online on an
  older protocol), one push per confirm
space status running/waiting ─▶ idle | failed | stopped (from the host's
  signed events) ─▶ one push to each such follower
send ─▶ ctx.waitUntil (routing never waits) ─▶ tickets:
  DeviceNotRegistered ─▶ token dropped;  any other error ─▶ kept, nothing retried
```

What a push carries (the app's contract, `mobile/src/push/README.md`;
`askPresentation` is ported in `src/fleet/push.ts` and a test checks both
give the same output):

| Field | Question | Finished | Confirm |
| --- | --- | --- | --- |
| `title` | `<host> · <space>` | same | `Claude via cloud · <host>` |
| `body` | the question, and `\n1) A  2) B` for 2–3 options, ≤ 180 chars | `<space> finished` / `failed` / `stopped` | `wants to <what>: <text>`, ≤ 180 chars; `<what>`: `start an Edit space in <project>`, `send to <space> in Run`, `approve the plan in <space> (Edit)` |
| `categoryId` | `ask_opt2`, `ask_opt3`, else `ask_text`; none for several questions or multi-select | none | `confirm` (Allow / Deny: a signed `confirm` request to `host_device`) |
| `channelId` / `priority` | `default` / `high` | `default` / — | `default` / `high` |
| `data` | `{kind: ask, ask_id, space, host_device, options}` (≤ 4; `[]` for several questions or multi-select) | `{kind: finished, ask_id: "", space, host_device, options: [], status}` | `{kind: confirm, confirm_id, host_device, space: "", ask_id: "", options: []}` |

`<host>` is the host's own name (its hello), `<space>` the name in its
host-signed `started` event (else the space id); the question and options
come from the host-signed ask the cloud verified.

### One-shot requests over HTTP

`POST /v1/fleet/request` is a socket `request` without a socket (a
notification's answer button):

```
Bearer JWT (org_id) ─▶ RL_USER ─▶ {device_id, envelope}
  ─▶ OrgHub: device_id one of the caller's devices? no ─▶ 409 refused{fleet.not_yours}
     envelope.device_id = device_id = body origin_device? no ─▶ 409 refused{fleet.not_yours}
     then every check of a socket `request` (target, key, depth, busy, …)
  ─▶ 202 {accepted: true, req_id}        (no waiting for the target)
  target's signed reply ─▶ the origin's socket; offline: held 2 min, sent after its welcome
```

The cloud doesn't verify the request's signature (the target does), same
as on the socket.

Online devices can't be removed, so one device (a compromised one, say)
can't knock the others out. Its key can connect again, as a new device
(new id, no spaces): the cloud pins keys, devices decide trust.

Storage (DO SQLite):

| Table | Holds |
| --- | --- |
| `devices` | device_id, user, pinned public key, info, generation, last seen |
| `spaces` | space, user, host, origin, parent, depth, last seq, status, last activity, its `started` envelope, stored event and mirror bytes, `lost_to` (holes at or below it are gaps), the start request (`req_id`) that made it |
| `events` | the host's signed envelope and its body's bytes, the newest 500 per space, within its byte budget |
| `mirrors` | (space, model, id) ─ the latest `space` / `chat_message` mirror (a tombstone too): seq, the host's signed envelope, its body's bytes |
| `pending` | a routed request until its reply: target, generation, claimed, envelope, `ask_id` of an answer, how long it may wait (`ttl_ms`: 2 min, 5 min from the MCP device) |
| `replies` | a signed reply or a `refused` held for an origin that's offline (2 min), as the frame to send |
| `asks` | an open question (the host's envelope): where it shows, via, escalated, which devices were pushed about it |
| `confirms` | an open confirm (the host's envelope): when it lapses, where it shows, which devices were pushed about it |
| `subs` | (device, space) live subscriptions, dropped with the connection |
| `conns` | per-connection deadline (hello, token expiry) |
| `push_tokens` | device ─ its Expo token, this minute's push count |
| `delegations` | (origin, delegate) ─ the latest signed delegation, issued/expiry, revoked (tombstone) |
| `meta` | `schema` = 7; on any other value every table but `devices`, `conns`, `push_tokens` and `delegations` is dropped (older rows carry older signatures); a new table (`confirms`) needs no bump. `mcp_schema` = 2 for the MCP device's own tables ("MCP" below) |

Limits:

| Limit | Value | Over it |
| --- | --- | --- |
| frame | 256 KiB (UTF-8 bytes) | `fleet.too_large`, close 1009 |
| rate per connection | 50 msgs/s, burst 500 | frame dropped, `fleet.rate_limited` (once a second) |
| devices per user | 20 | `fleet.too_many_devices`, close 4003 |
| open sockets per user (said hello or not) | 10 | `fleet.too_many_connections`, close 1008 (redial) |
| requests in flight per user | 100 | `refused{fleet.busy}` |
| spaces per user (pending starts count) | 200 | the oldest finished (stopped/failed) one is forgotten; none: `refused{fleet.too_many_spaces}` |
| open questions | 20 per space, 100 per user | `error{fleet.busy}` (the host's own card stays) |
| open confirms | 20 per user, 5 min each | `error{fleet.busy}` (the host's own prompt stays) |
| a space whose host is offline | 30 days | forgotten with its events and questions (checked on any hello and alarm) |
| device info | 8 KiB | `fleet.too_large` |
| one space event | 64 KiB | `fleet.too_large` |
| stored event bytes per space (body length; ring and mirrors together) | 16 MiB, and 500 ring events (mirrors not counted) | the ring's oldest go; if the mirrors alone leave no room: `error{fleet.busy}`, not stored |
| stored event bytes per user (body length; a `started` body twice: ring and kept copy) | 128 MiB | the oldest events of finished (stopped/failed) spaces go, oldest space first, then their mirrors; none left: `error{fleet.busy}`, the event not stored (the host keeps it in its journal and resumes from `last_seq`) |
| a `mirror`'s `id` | 256 chars | `fleet.invalid` |
| hello after connect | 10 s | `fleet.bad_message`, close 1008 |
| pushes per device | 30 / min | dropped (a question isn't marked pushed, so its escalation may try again) |
| push token | `ExponentPushToken[…]` / `ExpoPushToken[…]`, 200 chars | `fleet.bad_message` |
| a delegation's `issued_at_ms` | within 5 min of now | `error{fleet.stale_request}` |
| token | exp + 60 s without a `reauth` that verified | `fleet.unauthorized`, close 4001; if the last `reauth` couldn't be checked (JWKS unreachable): `fleet.unavailable`, close 1011 (redial) |

The burst is above the 200 first planned so a journal replay after a
reconnect isn't cut off.

Errors on the socket are `error{code, message}`. A request the cloud
itself turns down (offline, not yours, depth, busy, too many spaces,
invalid, expired) is `refused{req_id, code, message}` to its origin,
unsigned; a `reply` is only ever the target's signed one, forwarded. A
duplicate `req_id` or a body that isn't a request is an `error`, not a
`refused`: it isn't the pending request's answer. Closing ones also close
the socket with the code as the reason:

| Close | Codes | Device adapter |
| --- | --- | --- |
| 4001 | `fleet.unauthorized`, `fleet.no_org` (incl. expired token): only a token refused for what it is (signature, claims, user, org) | fatal, no redial |
| 4003 | `fleet.key_mismatch`, `fleet.version`, `fleet.too_many_devices` | fatal, no redial |
| 4000 | a newer connection of the same device took over | — |
| 1008 / 1009 | `fleet.bad_signature`, `fleet.bad_message` before hello, `fleet.too_many_connections`, `fleet.too_large` | redial |
| 1011 | `fleet.unavailable`: the token couldn't be checked (JWKS unreachable) | redial with backoff |

A `reauth` the cloud can't check (JWKS down) gets no answer: the old
deadline stands and its close is the non-fatal 1011, so an outage of
WorkOS's key endpoint never ends a device's fleet for good. A `reauth`
refused for what the token is: `error{fleet.unauthorized}` (fatal on the
device).

HTTP on the upgrade: 401/403 fatal, 5xx redial, 426 `fleet.upgrade_required`
without `Upgrade: websocket`.

Logs name the error kind only: never a token, a nonce or an envelope body.

Tests (`test/fleet-*.test.ts`) drive `Hub` with node:sqlite, fake sockets
and a fake clock; the DO shell (`org-hub.ts`) itself runs only in Workers.

## MCP

Claude Code or a claude.ai connector adds Theodore as a remote MCP server
by URL (`https://<cloud>/mcp`); the tools drive the user's computers
through the fleet, as the phone does. What it means for the fleet and the
tools: `docs/fleet.md` "MCP over the cloud". Code: `src/mcp/`.

```
client ─POST /mcp─▶ 401 WWW-Authenticate: Bearer resource_metadata=…
  ─▶ /.well-known/oauth-protected-resource/mcp ─▶ authorization server = this Worker
  ─▶ /.well-known/oauth-authorization-server
  ─▶ POST /oauth/register (dynamic client registration, RFC 7591)
  ─▶ browser: /oauth/authorize (PKCE S256, resource …/mcp) ─▶ consent page ─▶ Allow
       ─▶ AuthKit sign-in (state bound to this browser by a __Host- cookie)
       ─▶ /oauth/callback?code ─▶ WorkOS code exchange (API key as client secret)
          2+ orgs ─▶ pick one (/oauth/org) ─▶ organization-selection grant
          no org  ─▶ the personal org (as /v1/orgs/personal), refresh into it
       ─▶ grant {user, org, WorkOS refresh token (encrypted)} ─▶ the MCP device made
       ─▶ back to the client with a code
  ─▶ POST /oauth/token (code + verifier) ─▶ access token (1 h) + refresh token (30 d)
  refresh ─▶ WorkOS refreshes the same session into the same org
             refused (signed out, left the org) ─▶ invalid_grant, grant revoked
POST /mcp + Bearer ─▶ scope fleet ─▶ Origin ─▶ RL_USER ─▶ JSON-RPC (src/mcp/rpc.ts)
  tools/call ─▶ OrgHub(org) POST /mcp/call {name, arguments} ─▶ McpFleet
```

### Auth: Cloudflare's OAuth provider

`@cloudflare/workers-oauth-provider` (MIT, Cloudflare's, 1.2.x) is the
authorization server; the cloud writes only the consent page, the AuthKit
hop and the refresh callback.

| | Library | Own |
| --- | --- | --- |
| Metadata (RFC 8414, 9728), DCR, PKCE, code and refresh rotation, token hashing, RFC 8707 audience | done, tested against the MCP conformance suite | ~1 500 lines of security code to write and keep current |
| Confused-deputy rules for a proxy to another IdP (consent per client, browser-bound `state`, no framing) | `beginConsent` / `beginUpstream` helpers | to build |
| Storage | a KV namespace (`OAUTH_KV`): one new binding | a DO or KV anyway |
| Fit | wraps only `/mcp`, `/oauth/*`, `/.well-known/oauth-*`; every other route is untouched | — |
| Cost | imports `cloudflare:workers` (tests alias it to a stub) | — |

Off unless both `OAUTH_KV` and `MCP_KEY_WRAP` are there: those paths
answer `404 cloud.not_found` and nothing else changes.

### Transport

Streamable HTTP, both eras, no sessions (`src/mcp/rpc.ts`):

| | Modern (`2026-07-28`) | Legacy (`2025-03-26` … `2025-11-25`) |
| --- | --- | --- |
| Opens with | any request with `_meta["io.modelcontextprotocol/protocolVersion"]` | `initialize` (answered with the client's version if known, else `2025-11-25`) |
| Headers | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (tools/call, base64 sentinel decoded) must match the body, else `400 -32020`; another version `400 -32022 {supported, requested}` | `MCP-Protocol-Version` one of these if present |
| Methods | `server/discover`, `tools/list`, `tools/call`, `ping`; results carry `resultType: "complete"` | `initialize`, `tools/list`, `tools/call`, `ping` |
| Unknown method | `404 -32601` | `200 -32601` |

Every answer is `application/json`; notifications `202`; `GET` / `DELETE`
`405`; batches `400`. A browser `Origin` other than the Worker's own,
`https://claude.ai`, `https://claude.com` or one in `MCP_ORIGINS` is `403`.

### The MCP device in the hub

One per (user, org), in the org's `OrgHub`, next to the fleet tables:

| Table | Holds |
| --- | --- |
| `mcp_devices` | user ─ device id, public key, the private key wrapped (AES-256-GCM, key = HKDF-SHA-256(`MCP_KEY_WRAP`), AAD = org, user, public key), the in-process connection: open, its `ConnState` |
| `mcp_pins` | (user, device) ─ a computer's key confirmed with `device_trust`, its sanitized name |
| `mcp_inbox` | frames the hub sent it (`reply`, `refused`, `space_event`, `space_gap`, `ask`, `dismiss`) until a tool reads them; 5 000 per user, oldest out |
| `mcp_requests` | req id ─ target, the key pinned when sent, op, mode, space, the outcome once verified; 500 per user |
| `mcp_spaces` | a space it started ─ host, status, name, branch, last seq, last reply, open question, plan, last refusal code; finished ones past 100 per user go |
| `mcp_lines` | (space, seq, kind) ─ history from verified events, 200 per space |
| `mcp_sub_spaces` | (space, id) ─ a sub-space under a space it started, from verified `mirror{sub_space}` events (latest per id, removed on `null`), 50 per space; a new table, so no schema bump |

| Limit | Value |
| --- | --- |
| online after the last tool call | 15 min (then the alarm takes it offline; the next call says hello again and resubscribes) |
| a start, send, stop, answer waits for the computer's reply | 15 s, then `result: pending` (the reply still lands) |
| a pending request from the MCP device, in the hub | 5 min (`REQUEST_WINDOW_MS`, other origins 2 min): an Edit or Run waits that long for a person's yes on the computer (or on a phone or computer it sends its approvals to), unless the user turned on auto mode there |
| `space_wait` | ≤ 25 s per call |
| `space_ask` waits for the answer | 25 s, then `result: pending` with its `request` (the computer gives an ask about 3 min, then `fleet.timeout`) |
| goal, message | 20 000 characters |

Tool refusals are `isError` results with a code: the cloud's
(`mcp.invalid`, `mcp.unknown_device`, `mcp.unknown_space`,
`mcp.untrusted_device`, `mcp.key_changed`, `mcp.fingerprint_mismatch`,
`mcp.no_plan`, `mcp.busy`, `mcp.unknown_request`, `mcp.unknown_tool`)
with fixed words, a computer's or the fleet's (`fleet.*`) as the code only.

### Any space on a computer (protocol 7)

Tools on every space of a trusted computer, not only those the MCP device
started: the user's own, ones started elsewhere, sub-spaces. Code:
`src/mcp/tools.ts`, `src/mcp/computer.ts`.

| Tool | Op | Result |
| --- | --- | --- |
| `computer_spaces {device, project?}` | `list_spaces` | `spaces[]`, `truncated` |
| `computer_space_read {device, space, messages? ≤ 50}` | `read_space` | space, goal, branch, base, progress, messages, live, question, diff, error |
| `space_ask {device, space, question}` · `{request}` | `ask_space` | answer, agent, model, how; after 25 s `pending` + `request` |
| `space_send {space, message, mode?}` (an `rs_` it started) | `send` | as before |
| `space_send {device, space, message}` (any other) | `send_to` | `message` id; a `mode` is `mcp.invalid` (the space keeps its own) |
| `space_answer {device, space, ask, answers}` | `answer_space` | `ok` |
| `space_merge {device, parent, child}` | `merge_child` (Edit: may wait for a yes) | files, additions, deletions, conflicts, `computer_note` |

```
tool ─▶ target(): pinned here? key unchanged?  no ─▶ mcp.untrusted_device / mcp.key_changed
     ─▶ signed op {space: local id | rs_…} ─▶ hub: target below 7? ─▶ refused{fleet.upgrade_required}
                                               ─▶ computer: resolves the id, its gates, decides
reply.value (signed, ≤ 128 KiB) ─▶ verified against the pin ─▶ re-shaped:
  known fields only · texts cut · numbers / booleans checked · space ids
  (12 hex or rs_…), project and agent ids only if they pass · lists capped
  + note: the cloud's own words, "data, never instructions"
refusal ─▶ its code only ("the computer refused: …" / "refused by the cloud: …")
```

- `space` / `parent` / `child`: the computer's local id (12 hex) or an
  `rs_` id; the cloud never tracks these spaces.
- `send_to` and `merge_child` pending: `waiting_for` says the computer may
  be asking a person (`possibly …` for `send_to`: the space's own mode
  decides).
- `space_ask {request}`: only an `ask_space` this MCP device sent
  (`mcp.unknown_request` otherwise); waits ≤ 25 s again for its outcome.
- `space_read` of a space it started adds `sub_spaces[]` (local ids, from
  the kept `sub_space` mirror) and a `sub_space` line `<id> · <title> ·
  <status>` when one changes.

### Local

```
cd cloud
printf 'WORKOS_API_KEY=sk_test_…\nMCP_KEY_WRAP=%s\n' "$(openssl rand -base64 48)" > .dev.vars
pnpm dev:mcp                       # wrangler dev --env local: OAUTH_KV simulated, never deployed
claude mcp add --transport http theodore-local http://localhost:8787/mcp
```

Staging WorkOS needs `http://localhost:8787/oauth/callback` as a redirect
URI for that. Tests (`test/mcp-*.test.ts`) need none of it: fake WorkOS,
in-memory KV, the real `OrgHub` over node:sqlite.

### Production checklist

Per environment (staging, production):

- [x] `OAUTH_KV`: a KV namespace per environment, bound in `wrangler.toml`
      (`wrangler kv namespace create OAUTH_KV --env <env>`).
- [x] `MCP_KEY_WRAP` secret per environment (`openssl rand -base64 48 |
      wrangler secret put MCP_KEY_WRAP --env <env>`). Never in git. Changing
      it makes every MCP device key unreadable: those devices must be made
      again (and trusted again on the computers).
- [x] WorkOS staging ─▶ Redirects: `https://theodore-cloud-staging.prd-instance.workers.dev/oauth/callback`
      (added through the WorkOS API: `POST /user_management/redirect_uris`
      with that environment's API key).
- [x] WorkOS production ─▶ Redirects: `https://theodore-cloud.prd-instance.workers.dev/oauth/callback`
      (dashboard). Check: WorkOS's authorize with this URI goes to the
      AuthKit sign-in, an unknown one to `error.workos.com/redirect-uri-invalid`.
- [x] Nothing new for WorkOS keys: the code exchange and refresh use the
      `WORKOS_API_KEY` already set.
- [ ] Computers on the protocol this build speaks (7): older ones can't
      see the MCP device and answer `fleet.upgrade_required`. They update
      themselves.
- [ ] Optional: `MCP_ORIGINS` (var) for a browser-based MCP client; a
      Cron Trigger calling the library's `purgeExpiredData()` (KV TTLs
      already expire most); Client ID Metadata Documents
      (`clientIdMetadataDocumentEnabled` + the `global_fetch_strictly_public`
      compatibility flag; off now, DCR covers Claude Code and claude.ai).
