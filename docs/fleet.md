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
| Every signature has a purpose: it signs `"theodore-fleet-<hello\|request\|event\|ask>-v2\0" ‖ bytes` (`Domain`), so one made for one purpose never verifies as another | every device | yes |
| Hello signs only a 32-byte nonce, one challenge per socket (another, or a nonce of any other length ─▶ the socket is dropped unsigned) | adapter | yes: the cloud can't get a request signed |
| Every request (start, send, stop, answer) is a `SignedEnvelope` by the origin device's key over the exact body bytes (`Domain::Request`) | origin core | yes |
| Every event of a hosted space (`SpaceEventBody`) and every question (`RemoteAsk`) is signed by its host (`Domain::Event`, `Domain::Ask`); the origin keeps only those that verify against the host's key pinned there, and the host of a space is the start's target for good | host + origin core | yes |
| A device accepts requests, events and questions only from devices it trusts: their public key pinned locally (`fleet.trusted_devices`), trust given on that device, for exactly the key whose fingerprint (128 bits, 8 groups) the user compared | every core | yes |
| Only trusted devices are targets: the start dialog, `fleet_devices` and `fleet_start_space` list and reach only devices pinned here | origin core | yes |
| `issued_at` within 5 min, `req_id` never seen in the last 10 min — kept in the store (`fleet_seen`), so a request that ran is a replay after a restart too | target core | yes |
| `fleet.accept_remote` off by default; `fleet.max_mode` caps the mode (default Edit; Run only if set to Run); both and the pin are checked again right before a claimed request runs | target core | yes |
| Agents act within their turn: start, send and stop only from a turn in Edit or Run, at most in its mode, and only on spaces that space started; never from a space hosted here for another device | origin core + MCP | yes |
| Claim with the connection's `generation` before running: one execution per request | cloud + target | — |
| Access JWT (WorkOS, with `org_id`) on connect and on every refresh (`reauth`) | cloud | — |

No raw shell over the fleet: a remote device runs **spaces**, in their modes,
with every local guard a space already has (worktree guard, edit guard, trust
for repo commands, secrets stripped).

## Connect

```
core ─GET wss://<cloud>/v1/fleet/ws, Authorization: Bearer <access JWT with org_id>
cloud ─▶ challenge{nonce}
core  ─▶ hello{protocol: 2, device_id?, public_key, sign_hello(nonce), info, spaces:[{space, seq}]}
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
| key mismatch, protocol version, too many devices, removed by another device | `error{fleet.key_mismatch \| fleet.version \| fleet.too_many_devices \| fleet.removed}`, close 4003 | stops (removed: the stored device id is dropped; turning the fleet off and on joins as a new device) |
| HTTP 401/403 on the upgrade | — | stops |
| no hello in 10 s, a frame before hello, bad signature, too many connections or spaces | close 1008 `fleet.bad_message` / `fleet.bad_signature` / `fleet.too_many_connections` / `fleet.too_many_spaces` | redials |
| a challenge that isn't 32 bytes, or a second one | — (the device drops the socket) | redials |
| anything else (5xx, drop) | — | redials |

## Start a space on another device

```
mac1 core ─sign─▶ request{envelope: RemoteRequest{op: StartSpace}} ─▶ cloud
cloud ─▶ mac2: request{envelope, generation}
mac2 core: verify signature, trust, freshness, accept_remote, mode ≤ max_mode, project known
         ─▶ claim{req_id, generation} ─▶ claim_result{claimed}
         ─▶ create_space(...) ─▶ reply{req_id, ok:{space, name}} ─▶ cloud ─▶ mac1
mac2: space events ─▶ space_event{seal_as(SpaceEventBody{space, seq, host_device, event}, Event)}
         ─▶ cloud ─▶ mac1 (origin) ─▶ verified with mac2's pinned key ─▶ UI
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
`RemoteSpaceEvent`s with `seq` (last 2000 per space) and signs each one as
it sends it. The cloud keeps the last 500 per space for late subscribers;
older ones replay from the device while it is online. `subscribe{space,
since}` (origin and host only) sends history, then live, in order. What the
cloud no longer has comes as `space_gap{space, from, to}`: unsigned, shown
as a gap line and nothing else.

## Questions go to where you are

```
space on mac2 calls ask_user ─▶ card on mac2 (as today) + ask{seal_as(RemoteAsk, Ask)} ─▶ cloud
cloud: only the space's origin and host ever get it
       you're at the host ─▶ it stays there      else ─▶ the origin
       unanswered 20 s ─▶ escalated to the origin (never to other devices)
mac1: verified with mac2's pinned key ─▶ "<pinned name> · <name from mac2's signed started>"
answer on mac1 ─sign─▶ request{op: Answer} ─▶ mac2 verifies like any request ─▶ turn goes on
  ─▶ mac2's ok reply ─▶ only then the cloud dismisses it elsewhere
answered on mac2 itself ─▶ ask_resolved ─▶ cloud dismisses it on the origin
```

## Agents use it too

Space-tools gains `fleet_devices`, `fleet_start_space`, `fleet_send`,
`fleet_wait`, `fleet_read`, `fleet_stop`. An agent acts with its device's
authority, and no more than its turn's: it reaches only devices trusted
here that trust this one, within their `max_mode` and its own turn's mode.

| Tool | Does | Who gets it |
| --- | --- | --- |
| `fleet_devices` | other devices online, trusted here, that take remote spaces: projects, `max_mode` | every space turn |
| `fleet_start_space` | a space on `device` (id, or a name only one trusted device has) in `project` with a `goal` and `mode` ≤ the turn's; returns its `rs_` id | a turn in Edit or Run, of a space not hosted for another device |
| `fleet_send` / `fleet_stop` | a message as its next turn (at most in the turn's mode, never above the space's own) / stop its turn | same as `fleet_start_space` |
| `fleet_wait` | until each space is idle, waiting, stopped or failed (≤ 10 min) | every space turn |
| `fleet_read` | status, last reply, question, history after `since` | every space turn |

Every tool that names a space works only on spaces the calling space (or
one of its children) started: not ones the user started from the UI, not
another space's. The run context carries the turn's mode and whether the
space is hosted here (`FleetTools::Read` / `Steer`); the MCP server neither
lists nor runs what it doesn't allow, and the core checks again.

```
space of this device's own, Edit/Run turn ─▶ children at depth 1 under its
  stable fleet id (kv `fleet.parent:<space>`): ≤ 5, counted by the cloud too
space hosted here for another device ─▶ read-only tools: a device trusted by
  this one but not by the origin can't reach further through it
```

Listed only while the fleet is on and connected; the system prompt names
them then.

## Settings (per device)

| Key | Default | |
| --- | --- | --- |
| `fleet.enabled` | `false` | connect to the cloud at all |
| `fleet.accept_remote` | `false` | let trusted devices start and steer spaces here |
| `fleet.max_mode` | `edit` | highest mode a remote request may use (`ask`, `plan`, `edit`, `run`) |
| `fleet.trusted_devices` | `[]` | `[{device_id, public_key, name}]`, changed only on this device |
| `fleet.name` | the Mac's computer name | how other devices list this one |

Kept in the local store (kv `fleet.settings`), not as synced `setting`
rows: only `fleet_set_settings`, `fleet_trust_device` and
`fleet_remove_device` change them, never a UI transaction.

```
Devices page / "Trust <device>?" notice ─▶ Trust ─▶ confirm: the full
  fingerprint, "make sure <device> shows the same fingerprint" ─▶ Trust
  ─▶ fleet_trust_device{device_id, trusted, public_key: the key shown}
  ─▶ refused unless the cloud still lists exactly that key ─▶ pinned
a later key change ─▶ untrusted again; trust has to be given again
Remove (another device) ─▶ confirm ─▶ fleet_remove_device ─▶ remove_device
  ─▶ the cloud drops it and signs it out; unpinned here
```

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
  ─▶ open(pinned key) ─▶ fresh + req_id unseen (store) ─▶ op fits ─▶ claim
claim_result{claimed: true} ─▶ seen done (store) ─▶ accept_remote, same pin,
  mode ≤ max_mode again ─▶ run ─▶ reply           not claimed ─▶ nothing runs
```

- "Op fits": start — mode ≤ `max_mode`, project here, depth ≤ 2, < 5
  children of its parent hosted here; send — space hosted, mode ≤ cap
  (the space's own when none given, and that mode is what runs); answer —
  the question set waits and the answers fit it (`fleet.invalid` otherwise).
- A request re-delivered while its claim is open is claimed again, after a
  restart too; once run, refused or rejected it's a replay
  (`fleet.stale_request`), after a restart too (`fleet_seen`, 10 min past
  `issued_at`).
- `start_space` runs the usual `create_space` (goal, mode, agent, model) and
  stores the mapping in `fleet_spaces` (remote id, local space, origin,
  parent, depth, bookkeeping as JSON).

### Hosted spaces: events and journal

One observer task reads the core's sync frames and run steps; it never
takes a space's lock, and a space turn never waits on it.

```
space row / agent reply / run step of a hosted space
  ─▶ diff with what was last reported ─▶ RemoteSpaceEvent, seq + 1
  ─▶ fleet_events (last 2000 per space) ─▶ space_event, signed (Event)
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

`ask_user` in a hosted space keeps its card here and also sends a signed
`ask{ask_id = the question set's id, from "<device> · <space>"}` (`from` is
for display only; the origin names it from its pin). Answered
here, stopped, timed out or cleared by a restart: `ask_resolved`. A
verified `answer` request feeds the same pending set; first answer wins.
Per question, the options picked, or one text that isn't an option for
"Other". An `ask` routed here that verifies against its host's pin ─▶
`FleetAsk`; `dismiss` ─▶ `FleetAskDismissed`.

### This device as the origin

```
fleet_start_space (target pinned here) ─▶ rs_<uuid> ─▶ seal(device key)
  ─▶ request ─▶ `starting` (host = target, name = its pin's, for good)
  + subscribe{since 0}   reply ok ─▶ name, branch   reply err ─▶ failed + why
space_event ─▶ signer is the host, open_as(host's pin, Event) ─▶ status, last
  reply, question ─▶ FleetSpace + FleetSpaceLine     else ─▶ dropped (debug log)
  (`started` names it; host, parent and depth stay what was asked)
space_gap ─▶ a gap line only
reconnect ─▶ subscribe{since: last seq seen}
```

Fleet text (replies, turns, tools, questions) comes from another device:
the UI renders it without loading images or making links.

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
  redial. The cloud doesn't send `fleet.removed`: `remove_device` takes
  only a device that's offline (an online one: `fleet.invalid`).
- The cloud's own refusals of a request arrive as `refused{req_id, code,
  message}`; a `reply` is the target's, signed, checked by the cloud and
  forwarded unchanged.
- Events the cloud lost arrive as an unsigned `space_gap{space, from, to}`,
  never as a `space_event`. A space's `started` event outlives the ring: a
  late subscriber gets it, then the gap.
- A space's events and questions reach only its origin and its host. A
  question goes to the origin (or stays on the host while you're there); it
  escalates after 20 s to the origin, not to every device, and another
  device's presence doesn't pull it. An answer dismisses it elsewhere only
  after the host's `ok`.
- An unclaimed request is re-sent on the target's reconnect; a claimed one
  waits for its reply (the target's outbox) until the 2 min expiry.
- A reply or refusal to an origin that's offline is held 2 min and sent
  after its welcome.
- Stored events are capped by bytes: 4 MB per space (oldest out), 64 MB
  per user (finished spaces' oldest out first, else `error{fleet.busy}`
  and the host keeps the event in its journal).
- Cloud-only codes: `fleet.bad_message` (malformed or out-of-order frame),
  `fleet.too_many_devices` (20 per user), `fleet.too_many_connections` (10
  sockets per user), `fleet.too_many_spaces` (200 per user),
  `fleet.upgrade_required` (HTTP 426).

## Not yet

`theodore daemon` (headless Linux device), phone client and push, file
transfer, cross-user sharing within an org (v1 routes only between one
user's own devices).
