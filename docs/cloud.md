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
| `GET /v1/fleet/ws` | bearer access JWT with `org_id` | WebSocket upgrade to the org's fleet hub (below, and `docs/fleet.md`) |

Body: JSON object, 64 KiB max. Errors: `{ "error": { "code", "message" } }`.

Rate limits (Cloudflare rate-limiting bindings, separate counters per
environment; over: `429 cloud.rate_limited`):

| Bucket | Key | Limit | Routes |
| --- | --- | --- | --- |
| `RL_PUBLIC` | client IP (`cf-connecting-ip`) | 30 / min | `POST /v1/auth/select-organization`, `GET /v1/fleet/ws` |
| `RL_USER` | user (`sub`, after the token checks out) | 120 / min | `GET /v1/orgs`, `POST /v1/orgs/personal` |

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
| Deployed by | push to `staging` | push to `main` |

- The API key is set by the owner, never in git or CI:
  `wrangler secret put WORKOS_API_KEY --env staging|production`. A deploy
  keeps it.
- Client ids are public: plain vars in `cloud/wrangler.toml`.
- The key is also the client secret for the organization-selection grant.

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
  ─▶ OrgHub(idFromName(org_id)) + x-theodore-fleet-caller {userId, orgId, sessionId, expMs}
     (incoming header replaced, Authorization dropped)
  ─▶ acceptWebSocket(tag u:<user>) ─▶ challenge ─▶ hello ─▶ welcome ...
```

Protocol 3 only (`fleet.version`, close 4003, for anything else).

- **Hibernation API**: an idle socket bills nothing. Per-socket state is its
  attachment (user, org, token expiry, device, generation, presence); the
  rest is SQLite, so a woken hub rebuilds nothing.
- **One alarm** for every deadline (hello due, token expiry + 60 s, 10 s
  grace, 2 min pending, 20 s escalation), set only when it moves earlier.
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

A failed event, ask or reply check is `error{fleet.bad_signature}`, nothing
stored or forwarded (a refused reply leaves its request pending).
A gap the cloud can't fill is its own unsigned `space_gap{space, from, to}`:
informational, never content.

Same-user devices aren't trusted by each other just for being the same user
(trust is pinned per device), so the cloud keeps a space to the two devices
it belongs to:

| What | Who |
| --- | --- |
| `subscribe{space}` (history and live events) | the space's origin and host only; anyone else `fleet.not_yours` |
| a question, while you're at the host | the host only (its own card) |
| a question, otherwise | the origin if online (`active` if you're at it, else `origin`); a third device being active doesn't pull it |
| after 20 s unanswered (or nowhere to show) | escalated to the origin, if not already there, and on its reconnect; never to every device |
| moving between origin and host | follows you (`moved`); presence elsewhere changes nothing |
| `answer` request | routed like any request; the question is dismissed elsewhere (`answered_elsewhere`) only after the host's signed `reply` with `ok` for it, a refusal leaves it open |
| a request whose target is its origin | `refused{fleet.invalid}` |

`remove_device{device_id}` forgets one of the caller's other devices, only
while that device is offline:

```
same user? no ─▶ fleet.not_yours      the caller itself? ─▶ fleet.invalid
connected now? ─▶ fleet.invalid (nothing changes)
─▶ delete its row, the spaces it hosts (events, subs; their questions dismissed `resolved`)
─▶ requests waiting for it ─▶ origin: refused{fleet.offline};  replies held for it dropped
─▶ devices pushed to the rest
```

Online devices can't be removed, so one device (a compromised one, say)
can't knock the others out. Its key can connect again, as a new device
(new id, no spaces): the cloud pins keys, devices decide trust.

Storage (DO SQLite):

| Table | Holds |
| --- | --- |
| `devices` | device_id, user, pinned public key, info, generation, last seen |
| `spaces` | space, user, host, origin, parent, depth, last seq, status, last activity, its `started` envelope, stored event bytes |
| `events` | the host's signed envelope and its body's bytes, the newest 500 / 4 MiB per space (gaps are what's missing) |
| `pending` | a routed request until its reply: target, generation, claimed, envelope, `ask_id` of an answer |
| `replies` | a signed reply or a `refused` held for an origin that's offline (2 min), as the frame to send |
| `asks` | an open question (the host's envelope): where it shows, via, escalated |
| `subs` | (device, space) live subscriptions, dropped with the connection |
| `conns` | per-connection deadline (hello, token expiry) |
| `meta` | `schema` = 3; on any other value every table but `devices` and `conns` is dropped (older rows carry older signatures) |

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
| a space whose host is offline | 30 days | forgotten with its events and questions (checked on any hello and alarm) |
| device info | 8 KiB | `fleet.too_large` |
| one space event | 64 KiB | `fleet.too_large` |
| stored event bytes per space (body length) | 4 MiB, and 500 events | its oldest events go |
| stored event bytes per user (body length; a `started` body twice: ring and kept copy) | 64 MiB | the oldest events of finished (stopped/failed) spaces go, oldest space first; none left: `error{fleet.busy}`, the event not stored (the host keeps it in its journal and resumes from `last_seq`) |
| hello after connect | 10 s | `fleet.bad_message`, close 1008 |
| token | exp + 60 s without `reauth` | `fleet.unauthorized`, close 4001 |

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
| 4001 | `fleet.unauthorized`, `fleet.no_org` (incl. expired token) | fatal, no redial |
| 4003 | `fleet.key_mismatch`, `fleet.version`, `fleet.too_many_devices` | fatal, no redial |
| 4000 | a newer connection of the same device took over | — |
| 1008 / 1009 | `fleet.bad_signature`, `fleet.bad_message` before hello, `fleet.too_many_connections`, `fleet.too_large` | redial |

HTTP on the upgrade: 401/403 fatal, 5xx redial, 426 `fleet.upgrade_required`
without `Upgrade: websocket`.

Logs name the error kind only: never a token, a nonce or an envelope body.

Tests (`test/fleet-*.test.ts`) drive `Hub` with node:sqlite, fake sockets
and a fake clock; the DO shell (`org-hub.ts`) itself runs only in Workers.
