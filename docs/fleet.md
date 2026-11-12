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
core  ─▶ replays its journal after `resume`, then its outbox
every access-token refresh ─▶ reauth{access_token}; none by exp + 60 s ─▶ cloud closes
```

Reconnect: backoff 0.5 s doubling to 30 s, jitter ±25 %. Heartbeat: cloud
pings every 15 s; no traffic for 45 s on either side ─▶ drop and redial.

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

## Settings (per device)

| Key | Default | |
| --- | --- | --- |
| `fleet.enabled` | `false` | connect to the cloud at all |
| `fleet.accept_remote` | `false` | let trusted devices start and steer spaces here |
| `fleet.max_mode` | `edit` | highest mode a remote request may use (`ask`, `plan`, `edit`, `run`) |
| `fleet.trusted_devices` | `[]` | `[{device_id, public_key, name}]`, changed only on this device |

## Not yet

`theodore daemon` (headless Linux device), phone client and push, file
transfer, cross-user sharing within an org (v1 routes only between one
user's own devices).
