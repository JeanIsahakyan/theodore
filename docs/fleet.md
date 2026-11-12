# Fleet — spaces across your devices

Theodore on one machine starts, steers and answers spaces on another, and an
agent in a space can do the same. Every machine running Theodore (the desktop
app, or `theodore daemon` on a server later) is a **device**; the Theodore
cloud relays between the devices of one organization.

```
Theodore (mac1) ──WSS──▶ cloud Worker ──▶ Durable Object "OrgHub" (one per org_id)
Theodore (mac2) ──WSS──▶      │              ├─ SQLite: devices, spaces, events, asks
agent on mac1 ─space-tools MCP─▶ core mac1 ──┘  ├─ routes requests, claims, replies
                                                └─ routes questions to where you are
```

Wire types: `crates/fleet-protocol` (Rust, the source of truth; TS for the
Worker generated into `cloud/src/gen/fleet.ts`). Core ⇄ adapter: the
`FleetPort` in `crates/ports/src/fleet.rs`. UI: `crates/contract/src/fleet.rs`.

## Trust: the cloud relays, devices decide

The cloud never makes a device run anything on its own word.

| Guard | Where | Holds even if the cloud is compromised |
| --- | --- | --- |
| Device key: ed25519, made on first use, kept in the keychain (`fleet.device_key`) | device | the cloud only ever sees the public half |
| Every request (start, send, stop, answer) is a `SignedEnvelope` by the origin device's key over the exact body bytes | origin core | yes |
| The target accepts only devices it trusts: their public key pinned locally (`fleet.trusted_devices`), trust given on that device, once | target core | yes |
| `issued_at` within 5 min, `req_id` never seen in the last 10 min | target core | yes |
| `fleet.accept_remote` off by default; `fleet.max_mode` caps the mode (default Edit; Run only if set to Run) | target core | yes |
| Claim with the connection's `generation` before running: one execution per request | cloud + target | — |
| Access JWT (WorkOS, with `org_id`) on connect and on every refresh (`reauth`); hello signs the cloud's nonce | cloud | — |

No raw shell over the fleet: a remote device runs **spaces**, in their modes,
with every local guard a space already has (worktree guard, edit guard, trust
for repo commands, secrets stripped).

## Connect

```
core ─GET wss://<cloud>/v1/fleet/ws, Authorization: Bearer <access JWT with org_id>
cloud ─▶ challenge{nonce}
core  ─▶ hello{device_id?, public_key, signature(nonce), info, spaces:[{space, seq}]}
cloud: device_id known ─▶ its pinned public key must match, same user; new ─▶ register
cloud ─▶ welcome{device_id, generation, resume:{space → last seq the cloud has}}
core  ─▶ adapter flushes its outbox (replies, ask_resolved), core replays its journal after `resume`
every access-token refresh ─▶ reauth{access_token}; none by exp + 60 s ─▶ cloud closes
```

Reconnect: backoff 0.5 s doubling to 30 s, jitter ±25 %. Heartbeat: the
device pings every 15 s (WebSocket ping frames; the cloud runtime answers
them without waking the hub); no traffic, pongs included, for 45 s ─▶ drop
and redial.

| Refusal | Cloud sends | Device |
| --- | --- | --- |
| bad or expired token, no `org_id` | `error{fleet.unauthorized \| fleet.no_org}`, close 4001, reason = the code | stops; a new link after the next sign-in |
| key mismatch, protocol version, too many devices | `error{fleet.key_mismatch \| fleet.version \| fleet.too_many_devices}`, close 4003 | stops |
| HTTP 401/403 on the upgrade | — | stops |
| no hello in 10 s, a frame before hello, bad signature | close 1008 `fleet.bad_message` / `fleet.bad_signature` | redials |
| anything else (5xx, drop) | — | redials |

## Start a space on another device

```
mac1 core ─sign─▶ request{envelope: RemoteRequest{op: StartSpace}} ─▶ cloud
cloud ─▶ mac2: request{envelope, generation}
mac2 core: verify signature, trust, freshness, accept_remote, mode ≤ max_mode, project known
         ─▶ claim{req_id, generation} ─▶ claim_result{claimed}
         ─▶ create_space(...) ─▶ reply{req_id, ok:{space, name}} ─▶ cloud ─▶ mac1
mac2: space events ─▶ space_event{space, seq, event} ─▶ cloud ─▶ subscribers (mac1 UI)
```

Refusals come back as `reply{err:{code, message}}`:

| Code | When |
| --- | --- |
| `fleet.remote_off` | `fleet.accept_remote` is off on the target |
| `fleet.untrusted_device` | origin's key isn't pinned on the target: the target shows "Trust <device>?" |
| `fleet.bad_signature` | signature or body doesn't check out |
| `fleet.stale_request` | `issued_at` out of window or `req_id` seen |
| `fleet.mode_not_allowed` | mode above `fleet.max_mode` |
| `fleet.unknown_project` / `fleet.unknown_space` | not on the target |
| `fleet.depth` | deeper than 2 or more than 5 children |
| `fleet.invalid` | the op doesn't fit what it acts on (answers that don't answer the set, an empty message) |
| `fleet.offline` | target not connected within 10 s grace |

## Events and history

The device hosting a space is the source of truth: it journals the space's
`RemoteSpaceEvent`s with `seq` (last 2000 per space). The cloud keeps the last
500 per space for late subscribers; older ones replay from the device while it
is online. `subscribe{space, since}` sends history, then live, in order.

## Questions go to where you are

```
space on mac2 calls ask_user ─▶ card on mac2 (as today) + ask{...} ─▶ cloud
cloud: your active device (focused, idle < 60 s) ─▶ else the space's origin device
       ─▶ else after 20 s everyone (+ push, later)          moved focus ─▶ follows you
answer on mac1 ─sign─▶ request{op: Answer} ─▶ mac2 verifies like any request ─▶ turn goes on
answered on mac2 itself ─▶ ask_resolved ─▶ cloud dismisses it everywhere
```

## Agents use it too

Space-tools gains `fleet_devices`, `fleet_start_space`, `fleet_send`,
`fleet_wait`, `fleet_read`, `fleet_stop`. The calling space is the parent;
depth ≤ 2, ≤ 5 children per space, checked by the origin core and the cloud.
An agent acts with its device's authority: it reaches only devices that trust
this one, within their `max_mode`.

| Tool | Does |
| --- | --- |
| `fleet_devices` | other devices online that take remote spaces: projects, `max_mode` |
| `fleet_start_space` | a space on `device` in `project` with a `goal` and `mode`; returns its `rs_` id |
| `fleet_send` / `fleet_stop` | a message as its next turn / stop its turn |
| `fleet_wait` | until each space is idle, waiting, stopped or failed (≤ 10 min) |
| `fleet_read` | status, last reply, question, history after `since` |

Listed only while the fleet is on and connected; the system prompt names
them then. A space hosted here for the fleet starts children at its own
depth + 1 with itself as parent; any other space starts them at depth 1.

## Settings (per device)

| Key | Default | |
| --- | --- | --- |
| `fleet.enabled` | `false` | connect to the cloud at all |
| `fleet.accept_remote` | `false` | let trusted devices start and steer spaces here |
| `fleet.max_mode` | `edit` | highest mode a remote request may use (`ask`, `plan`, `edit`, `run`) |
| `fleet.trusted_devices` | `[]` | `[{device_id, public_key, name}]`, changed only on this device |
| `fleet.name` | the Mac's computer name | how other devices list this one |

Kept in the local store (kv `fleet.settings`), not as synced `setting`
rows: only `fleet_set_settings` and `fleet_trust_device` change them, never
a UI transaction. Trusting pins the key the cloud lists for that device at
that moment; a later key change shows the device untrusted again.

## App side

Core: `crates/app/src/usecases/fleet*.rs`. The socket is the adapter's
(`FleetPort`); everything the messages mean is the core's.

```
enabled + signed in + cloud URL + org_id ─▶ FleetPort::start ─▶ link
  token refresh ─▶ Reauth          org switch ─▶ Close + new link
  sign-out / off ─▶ Close          Fatal ─▶ status error, no redial until
                                     sign-in, org or settings change
```

The cloud-assigned device id is kept per organization (kv
`fleet.device_id:<org>`); the key is the keychain's `fleet.device_key`.

### This device as the target

```
request ─▶ for this device ─▶ accept_remote ─▶ origin pinned (else TrustNeeded)
  ─▶ open(pinned key) ─▶ fresh + req_id unseen ─▶ op fits ─▶ claim
claim_result{claimed: true} ─▶ run ─▶ reply        not claimed ─▶ nothing runs
```

- "Op fits": start — mode ≤ `max_mode`, project here, depth ≤ 2, < 5
  children of its parent hosted here; send — space hosted, mode ≤ cap
  (the space's own when none given); answer — the question set waits and
  the answers fit it (`fleet.invalid` otherwise).
- A request re-delivered while its claim is open is claimed again; once
  run, refused or rejected it's a replay (`fleet.stale_request`).
- `start_space` runs the usual `create_space` (goal, mode, agent, model) and
  stores the mapping in `fleet_spaces` (remote id, local space, origin,
  parent, depth, bookkeeping as JSON).

### Hosted spaces: events and journal

One observer task reads the core's sync frames and run steps; it never
takes a space's lock, and a space turn never waits on it.

```
space row / agent reply / run step of a hosted space
  ─▶ diff with what was last reported ─▶ RemoteSpaceEvent, seq + 1
  ─▶ fleet_events (last 2000 per space) ─▶ space_event
welcome{resume} ─▶ journal after the cloud's seq ─▶ open questions asked again
```

| Space | Event |
| --- | --- |
| hosting starts | `started` |
| a run starts | `turn_started` (the message, ≤ 2000 chars) |
| a top-level tool call | `tool` (one line, ≤ 200) |
| the agent's reply lands | `reply` (≤ 8000), `turn_ended` (done · stopped · failed) |
| `question` set / cleared | `question` + `ask` / `question_cleared` + `ask_resolved` |
| status | `status`: running · waiting (a question) · idle · failed · stopped (archived) |

### Questions

`ask_user` in a hosted space keeps its card here and also sends
`ask{ask_id = the question set's id, from "<device> · <space>"}`. Answered
here, stopped, timed out or cleared by a restart: `ask_resolved`. A
verified `answer` request feeds the same pending set; first answer wins.
Per question, the options picked, or one text that isn't an option for
"Other". An `ask` routed here ─▶ `FleetAsk`; `dismiss` ─▶ `FleetAskDismissed`.

### This device as the origin

```
fleet_start_space ─▶ rs_<uuid> ─▶ seal(device key) ─▶ request ─▶ `starting`
  + subscribe{since 0}   reply ok ─▶ name, branch   reply err ─▶ failed + why
space_event ─▶ status, last reply, question ─▶ FleetSpace + FleetSpaceLine
reconnect ─▶ subscribe{since: last seq seen}
```

Spaces started from here and their lines (last 500) live in memory only: a
restart forgets them. `fleet_send`/`fleet_stop`/`fleet_answer` wait up to
15 s for the host's reply and return its refusal; not connected, they fail
here without sending.

## Cloud

`OrgHub` details, storage and limits: `docs/cloud.md` "Fleet". Where it
pins down what this doc leaves open:

- A fatal refusal closes the socket with 4001 (`fleet.unauthorized`,
  `fleet.no_org`) or 4003 (`fleet.key_mismatch`, `fleet.version`,
  `fleet.too_many_devices`), the code as the reason; the device doesn't
  redial.
- A `gap{from, to}` arrives as `space_event` with `seq = from`. A space's
  `started` event outlives the ring: a late subscriber gets it, then the gap.
- An unclaimed request is re-sent on the target's reconnect; a claimed one
  waits for its reply (the target's outbox) until the 2 min expiry.
- A reply to an origin that's offline is held 2 min and sent after its
  welcome.
- A question shows on the host itself and nowhere else while the host is
  your active device; it still escalates after 20 s.
- Cloud-only codes: `fleet.bad_message` (malformed or out-of-order frame),
  `fleet.too_many_devices` (20 per user), `fleet.upgrade_required` (HTTP 426).

## Not yet

`theodore daemon` (headless Linux device), phone client and push, file
transfer, cross-user sharing within an org (v1 routes only between one
user's own devices).
