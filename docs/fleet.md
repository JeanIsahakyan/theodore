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
| Every signature has a purpose: it signs `"theodore-fleet-<hello\|request\|event\|ask\|reply\|delegate>-v3\0" ‖ bytes` (`Domain`), so one made for one purpose never verifies as another | every device | yes |
| Hello signs only a 32-byte nonce, one challenge per socket (another, or a nonce of any other length ─▶ the socket is dropped unsigned) | adapter | yes: the cloud can't get a request signed |
| Every request (start, send, stop, answer) is a `SignedEnvelope` by the origin device's key over the exact body bytes (`Domain::Request`) | origin core | yes |
| Every request names its target's public key as pinned on the origin (`target_key`, under the signature); the target runs it only if that is its own key (`fleet.not_yours` otherwise): the cloud assigns device ids, so an id alone can't say which machine a request was signed for | origin + target core | yes |
| Every reply (`ReplyBody{req_id, origin_device, target_device, outcome}`) is signed by the target (`Domain::Reply`); the origin opens it against the key it pinned for the target when it sent the request, and drops one that doesn't verify (the request then times out) | target + origin core | yes |
| The cloud's own refusals (offline, not yours, depth, busy, too many spaces, expiry…) come as `refused{req_id, code, message}`, unsigned: the origin keeps only the code, and only if it looks like one (`fleet.unknown` otherwise); `message` never reaches the UI or an agent | origin core | yes |
| Every event of a hosted space (`SpaceEventBody`) and every question (`RemoteAsk`) is signed by its host (`Domain::Event`, `Domain::Ask`); the origin keeps only those that verify against the host's key pinned there, and the host of a space is the start's target for good | host + origin core | yes |
| A device accepts requests, events and questions only from devices it trusts: their public key pinned locally (`fleet.trusted_devices`), trust given on that device, for exactly the key whose fingerprint (128 bits, 8 groups) the user compared | every core | yes |
| Only trusted devices are targets: the start dialog, `fleet_devices` and `fleet_start_space` list and reach only devices pinned here, and no request (start, send, stop, answer) is signed for a device that isn't pinned | origin core | yes |
| Phones and the web app (`kind` `mobile` / `web`) are never targets: the start dialog, `fleet_devices` and `fleet_start_space` skip them whatever they list, and no request is signed for one | origin core + UI | yes |
| A delegation (this device's spaces' questions also go to a phone) is signed by this device (`Domain::Delegate`), only for a phone or web app pinned here; one the cloud lists counts only if it verifies (this device's own against its key, another's against that origin's pin) | origin core | yes |
| `issued_at` within 5 min, `req_id` never seen in the last 10 min — kept in the store (`fleet_seen`), so a request that ran is a replay after a restart too; a request the store couldn't record as done doesn't run (`fleet.internal`) | target core | yes |
| `fleet.accept_remote` off by default; `fleet.max_mode` caps the mode (default Edit; Run only if set to Run); both, the pin and `issued_at` are checked again right before a claimed request runs | target core | yes |
| A refusal made before the request verifies carries static words only: nothing the sender claimed (its device id, any field) goes into a reply this device signs | target core | yes |
| Agents act within their turn: start, send and stop only from a turn in Edit or Run, at most in its mode, and only on spaces that space started; never from a space hosted here for another device | origin core + MCP | yes |
| What reaches an agent carries no unsigned free text: device ids only as the cloud issues them (`^dev_[0-9a-f-]{36}$`, other listed devices dropped), device names are the pins' (sanitized when pinned), project ids pass a strict pattern (names never), space names, branches, replies and questions come from signed events and replies, a refusal is its code alone (even a verified target's words stay in the UI) | origin core | yes |
| A space hosted here for another device runs commands only in Run, ships only in Edit or Run, never merges into the local folder, and gets neither the user's MCP servers nor `approve_tool` | host core + MCP | yes |
| Claim with the connection's `generation` before running: one execution per request | cloud + target | — |
| Access JWT (WorkOS, with `org_id`) on connect and on every refresh (`reauth`); fatal only when the token itself is refused, never when the cloud can't fetch the signing keys | cloud | — |

No raw shell over the fleet: a remote device runs **spaces**, in their modes,
with every local guard a space already has (worktree guard, edit guard, trust
for repo commands, secrets stripped).

## Connect

```
core ─GET wss://<cloud>/v1/fleet/ws, Authorization: Bearer <access JWT with org_id>
cloud ─▶ challenge{nonce}
core  ─▶ hello{protocol: 3, device_id?, public_key, sign_hello(nonce), info, spaces:[{space, seq}]}
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
| bad or expired token, no `org_id` | `error{fleet.unauthorized \| fleet.no_org}`, close 4001, reason = the code | stops; a new link after the next sign-in, or the next refreshed access token |
| the token couldn't be checked (JWKS unreachable): a `reauth`, then its deadline | `error{fleet.unavailable}`, close 1011 | redials with backoff (the upgrade answers 503 while the keys stay unreachable) |
| key mismatch, protocol version, too many devices | `error{fleet.key_mismatch \| fleet.version \| fleet.too_many_devices}`, close 4003 | stops (a `fleet.removed` from an older cloud is still handled: the stored device id is dropped; turning the fleet off and on joins as a new device) |
| an event over the per-user byte budget | `error{fleet.busy}`, the event isn't stored | keeps its journal; the event goes out again from `welcome.resume` |
| HTTP 401/403 on the upgrade | — | stops |
| no hello in 10 s, a frame before hello, bad signature, too many connections or spaces | close 1008 `fleet.bad_message` / `fleet.bad_signature` / `fleet.too_many_connections` / `fleet.too_many_spaces` | redials |
| a challenge that isn't 32 bytes, or a second one | — (the device drops the socket) | redials |
| anything else (5xx, drop) | — | redials |

## Start a space on another device

```
mac1 core ─sign─▶ request{envelope: RemoteRequest{target_key: mac2's pin, op: StartSpace}} ─▶ cloud
cloud ─▶ mac2: request{envelope, generation}       (or ─▶ mac1: refused{req_id, code, message})
mac2 core: verify signature, trust, target_key = own key, freshness, accept_remote,
           mode ≤ max_mode, project known, agent / model / effort listed
         ─▶ claim{req_id, generation} ─▶ claim_result{claimed}
         ─▶ create_space(...) ─▶ reply{seal_as(ReplyBody{req_id, origin, target, ok:{space, name}}, Reply)}
         ─▶ cloud, unchanged ─▶ mac1: open_as(mac2's pin, Reply) ─▶ UI
mac2: space events ─▶ space_event{seal_as(SpaceEventBody{space, seq, host_device, event}, Event)}
         ─▶ cloud ─▶ mac1 (origin) ─▶ verified with mac2's pinned key ─▶ UI
```

Two kinds of refusal, told apart on the wire:

| | Comes as | Origin keeps |
| --- | --- | --- |
| the target's | `reply{envelope}`: a signed `ReplyBody` with `err:{code, message}` | the code, and the message cut to 200 characters for the UI (plain text); an agent gets the code only |
| the cloud's | `refused{req_id, code, message}`, unsigned | the code only (`fleet.unknown` if it doesn't look like one) |

| Code | From | When |
| --- | --- | --- |
| `fleet.remote_off` | target | `fleet.accept_remote` is off on the target |
| `fleet.untrusted_device` | target | origin's key isn't pinned on the target: the target shows "Trust <device>?"; the refusal's words are fixed, never the claimed sender |
| `fleet.bad_signature` | target | signature or body doesn't check out |
| `fleet.not_yours` | target, cloud | `target_key` isn't the target's own key, or the request is for another device |
| `fleet.stale_request` | target | `issued_at` out of window or `req_id` seen |
| `fleet.mode_not_allowed` | target | mode above `fleet.max_mode` |
| `fleet.unknown_project` / `fleet.unknown_space` | target | not on the target |
| `fleet.depth` | target, cloud | deeper than 2 or more than 5 children (starts in flight count) |
| `fleet.invalid` | target, cloud | the op doesn't fit what it acts on (answers that don't answer the set, an empty message, a space id started already); origin = target |
| `fleet.agent_unavailable` | target | a start or send names an agent, model or effort the target doesn't list (`DeviceInfo.agents`): not installed, turned off, not signed in ("Sign-in"), or not that model's ("Agent, model and effort") |
| `fleet.busy` | target, cloud | a send to a space whose turn is running |
| `fleet.internal` | target | the target couldn't record the request, so it didn't run it |
| `fleet.offline` | cloud | target not connected within 10 s grace |
| `fleet.too_many_spaces` | cloud | the user's 200 spaces |

### Agent, model and effort

A device that takes remote spaces lists what may run there, and a start or
send from another device picks from that list, as the desktop's own chip
does for its spaces.

```
host: detect + agent_models (cached 10 min: detecting spawns the CLIs)
  ─▶ installed ∩ agents.<id>.enabled ∩ not signed out, agents.chat first
  ─▶ DeviceInfo.agents ─▶ hello / announce (again when an agents.* setting,
     a project or a sign-in changes)
origin UI: FleetDevice.agents ─▶ the chip in New space / the space's box
  ─▶ start{agent?, model?, effort?} / send{agent?, model?, effort?}, signed
host gate: each one named must be listed ─▶ else fleet.agent_unavailable
  ─▶ start: create_space(agent, model, effort)  send: that turn on, as a
     local send with those fields
```

| Wire field | Type | Notes |
| --- | --- | --- |
| `DeviceInfo.agents` | `FleetAgentInfo[]`, default `[]` | empty unless `accepts_remote`, and from an older host: the origin then shows no chip and sends none |
| `FleetAgentInfo` | `{id, label, default_model?, default_effort?, models: FleetModelInfo[]}` | `default_*`: what runs when a request names none (`agents.<id>.model` / `.effort`, else the first current model and its own level) |
| `FleetModelInfo` | `{id, label, efforts: string[], default_effort?}` | current models first, earlier versions after |
| `RemoteOp::StartSpace.effort` | `string?` | next to `agent`, `model` |
| `RemoteOp::Send.agent` / `.model` / `.effort` | `string?` | from that turn on; `null` keeps the space's |

Caps (`DeviceInfo::fit_agents`, the cloud's wire check the same): ≤ 4
agents, ≤ 12 models each, ≤ 8 levels a model; ids ≤ 32 (agent) / 64
(model), levels ≤ 16, labels ≤ 64 characters. An overlong id or level
isn't listed (it can't be cut), a label is cut; then, while the info's JSON
is over 8 KiB, the last model of the agent listing the most goes (earlier
versions first), then the last agent.

What the host checks, before the claim:

| Named | Must be |
| --- | --- |
| `agent` | listed |
| `model` | one of that agent's listed models (by id) |
| `effort` | one of the levels of the model in effect: the one named, else the space's own while its agent stays (send), else the agent's default; any listed model's when that one isn't listed. `ultracode` for Claude wherever a model takes a level |
| a model or effort without an agent | the space's agent (send), else the host's default (start: then named explicitly) |

#### Sign-in

A device only offers the agents that can run there: one whose CLI isn't
signed in is left out of `DeviceInfo.agents`, so the phone's pickers and
its "Default (…)" never name it. A start or send naming it is refused with
`fleet.agent_unavailable`: "Codex isn't signed in on this device. Run
`codex login` in a terminal." A start naming no agent runs the first listed
one (`effective_agent` skips a signed-out `agents.chat`).

How each CLI is checked (`crates/agents/src/sign_in.rs`), with the env a
run gets, ≤ 5 s each, all three side by side:

| Agent | Signed in when | Signed out when |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` set; else `claude auth status` says `"loggedIn": true` | it says `"loggedIn": false` (or "Not logged in") |
| Codex | `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` set; else `codex login status` says "Logged in using …" | it says "Not logged in" — unless `OPENAI_API_KEY` is set: unknown (the status command doesn't read it) |
| Gemini CLI (no status command) | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA` set; `~/.gemini/oauth_creds.json`; an auth type in `~/.gemini/settings.json` (`security.auth.selectedType`, or `selectedAuthType`); a key in `~/.gemini/.env` | none of these |

A timeout, a CLI without the status command or output it can't read is
"unknown": offered, as before. `AgentStatus.signed_in` / `.sign_in_hint`
carry it to the desktop UI.

```
checked ─▶ cached 10 min (unknown: 1 min)
a run fails signed out (agent.signed_out) ─▶ known signed out at once
   ─▶ the host's list drops it ─▶ announce
detect_agents (the UI's pickers, Settings → Agents) ─▶ differs from the
   list ─▶ announce;  "Check again" (recheck) ─▶ cache cleared first
while linked, every 10 min ─▶ checked again ─▶ announce if it changed
   (`codex login` in a terminal reaches the phone without a click)
```

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
| `fleet_devices` | other computers online, trusted here, that take remote spaces (never a phone or the web app): id, the name pinned here, project ids, `max_mode` | every space turn |
| `fleet_start_space` | a space on `device` (id, or a pinned name only one trusted device has) in `project` (an id) with a `goal` and `mode` ≤ the turn's; returns its `rs_` id | a turn in Edit or Run, of a space not hosted for another device |
| `fleet_send` / `fleet_stop` | a message as its next turn, once the space settled (at most in the turn's mode, never above the space's own) / stop its turn | same as `fleet_start_space` |
| `fleet_wait` | until each space is idle, waiting, stopped or failed (≤ 10 min) | every space turn |
| `fleet_read` | status, last reply, question, history after `since` | every space turn |

Every tool that names a space works only on spaces the calling space (or
one of its children) started: not ones the user started from the UI, not
another space's. The run context carries the turn's mode and whether the
space is hosted here (`FleetTools::Hosted` / `Steer`; `Read` for runs that
aren't space turns); the MCP server neither lists nor runs what it doesn't
allow, and the core checks again.

```
space of this device's own, Edit/Run turn ─▶ children at depth 1 under its
  stable fleet id (kv `fleet.parent:<space>`): ≤ 5, counted by the cloud too
space hosted here for another device ─▶ read-only tools: a device trusted by
  this one but not by the origin can't reach further through it
```

Listed only while the fleet is on and connected; the system prompt names
them then.

Nothing an agent reads from these tools is unsigned free text:

| Field | Source |
| --- | --- |
| device id | as the cloud issues it, `^dev_[0-9a-f-]{36}$`; a listed device with any other id is dropped on receipt |
| device name | the pin here (`fleet.trusted_devices`), never the cloud's listing: kept to `[A-Za-z0-9 ._()-]`, ≤ 40 characters, `device` if nothing is left |
| project | its id, only if it matches `^[A-Za-z0-9._:/@+-]{1,100}$` with at most 4 `:`; names never |
| space name, branch, replies, questions, history | the host's signed `started` / events, or its verified reply |
| error | `the other device refused: <code>` or `refused by the cloud: <code>`; never words, not even a verified target's (those are the UI's) |

### What a hosted space's agent may do

A space hosted here for another device runs on this machine with the
origin's goal. Its own space tools are limited by the space's mode, in the
core (`Core::fleet_hosted_may`, `space_tool_check` / `space_tool_start` /
`space_tool_ship`), and by the MCP listing (`RunContext::hosted_allows`):

| Tool | Ask · Plan | Edit | Run |
| --- | --- | --- | --- |
| `run_check`, `start_app` | refused | refused | allowed |
| `ship` (open PR, push, keep branch) | refused | allowed | allowed |
| `ship` `merge_locally` | refused | refused | refused |
| user MCP servers (`agents.user_mcp`), `approve_tool` | off | off | off |

`merge_locally` writes into the user's own checkout, which is never the
origin's to change; push or a PR is. The limits are the agent's: you can
still ship a hosted space from its page here.

## Settings (per device)

| Key | Default | |
| --- | --- | --- |
| `fleet.enabled` | `false` | connect to the cloud at all |
| `fleet.accept_remote` | `false` | let trusted devices start and steer spaces here |
| `fleet.max_mode` | `edit` | highest mode a remote request may use (`ask`, `plan`, `edit`, `run`) |
| `fleet.trusted_devices` | `[]` | `[{device_id, public_key, name}]`, changed only on this device; `name` sanitized when pinned (and when read, for older pins) |
| `fleet.delegates` | `[]` | device ids of the phones / web apps this device sends its spaces' questions to ("Phones and the web app") |
| `fleet.name` | the Mac's computer name | how other devices list this one |

Kept in the local store (kv `fleet.settings`), not as synced `setting`
rows: only `fleet_set_settings`, `fleet_trust_device`,
`fleet_remove_device` and `fleet_delegate` change them, never a UI
transaction.

```
Devices page / "Trust <device>?" notice ─▶ Trust ─▶ confirm: the full
  fingerprint, "make sure <device> shows the same fingerprint" ─▶ Trust
  ─▶ fleet_trust_device{device_id, trusted, public_key: the key shown}
  ─▶ refused unless the cloud still lists exactly that key ─▶ pinned
a later key change ─▶ untrusted again; trust has to be given again
Remove (another device, offline only) ─▶ confirm ─▶ fleet_remove_device
  ─▶ remove_device ─▶ the cloud drops it; unpinned here
  online ─▶ refused here ("only an offline device can be removed"); the
  cloud's own error{fleet.invalid} ─▶ a toast saying the same
```

## App side

Core: `crates/app/src/usecases/fleet*.rs`. The socket is the adapter's
(`FleetPort`); everything the messages mean is the core's.

```
enabled + signed in + cloud URL + org_id ─▶ FleetPort::start ─▶ link
  token refresh ─▶ Reauth          org switch ─▶ Close + new link
  sign-out / off ─▶ Close          Fatal ─▶ status error, no redial until
                                     sign-in, org or settings change, or
                                     a refreshed session's new access token
```

A refreshed access token lifts a fatal refusal too (belt and braces): a
cloud that judged an outage of its own fatal gets one more try with the
next token, and a token it refuses again just ends that link again.

The cloud-assigned device id is kept per organization (kv
`fleet.device_id:<org>`); the key is the keychain's `fleet.device_key`.

### This device as the target

```
request ─▶ for this device ─▶ accept_remote ─▶ origin pinned (else TrustNeeded)
  ─▶ open(pinned key) ─▶ target_key = this device's key ─▶ fresh + req_id
  unseen (store) ─▶ op fits (a start reserves its slot) ─▶ claim
claim_result{claimed: true} ─▶ seen done kept in the store (else fleet.internal,
  nothing runs) ─▶ fresh, accept_remote, same pin, mode ≤ max_mode again ─▶ run
  ─▶ reply, signed (Reply)                        not claimed ─▶ nothing runs,
                                                  the slot is released
```

- "Op fits": start — mode ≤ `max_mode`, project here, depth ≤ 2, < 5
  children of its parent hosted or starting here, the space id not hosted or
  starting, agent / model / effort listed (`fleet.agent_unavailable`); send —
  space hosted and not running (`fleet.busy`), mode ≤ cap (the space's own
  when none given, and that mode is what runs), agent / model / effort
  listed; answer — the question set waits and the answers fit it
  (`fleet.invalid` otherwise).
- Starts in flight: a start that passes the gate reserves its slot in
  memory (children cap, space id) under the same lock as the check, so
  concurrent starts can't all pass. The slot goes when the start ends —
  hosted, failed, refused on the recheck, its claim rejected, or the
  connection lost before its claim result.
- Sends never queue: a send to a hosted space whose turn is running is
  refused (`fleet.busy`), at the gate and again under the space's queue
  lock right before it runs. A queued message would run later, past any
  change to the trust, the pin or `max_mode` made meanwhile; refusing is
  simpler than checking all of them again at dequeue. The origin waits
  (`fleet_wait`) and sends again.
- A request re-delivered while its claim is open is claimed again, after a
  restart too; once run, refused or rejected it's a replay
  (`fleet.stale_request`), after a restart too (`fleet_seen`, 10 min past
  `issued_at`).
- `start_space` runs the usual `create_space` (goal, mode, agent, model,
  effort) and stores the mapping in `fleet_spaces` (remote id, local space,
  origin, parent, depth, bookkeeping as JSON).

### Hosted spaces: events and journal

One observer task reads the core's sync frames and run steps; it never
takes a space's lock, and a space turn never waits on it.

```
space row / agent reply / run step of a hosted space
  ─▶ diff with what was last reported ─▶ RemoteSpaceEvent, seq + 1
  ─▶ fleet_events (last 2000 per space) ─▶ space_event, signed (Event)
welcome{resume} ─▶ journal after the cloud's seq ─▶ open questions asked again
  (a space not in `resume`, which the cloud forgot, isn't replayed)
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
fleet_start_space (target pinned here) ─▶ rs_<uuid>
  ─▶ seal(device key, target_key = the target's pin) ─▶ request
  ─▶ `starting` (host = target, name = its pin's, for good) + subscribe{since 0}
reply{envelope} ─▶ signer is the target, open_as(the pin sent, Reply)
  ─▶ ok ─▶ name, branch      err ─▶ failed + code (UI: + ≤ 200 chars; agent: code only)
  └▶ doesn't verify ─▶ dropped (debug log); the request times out
refused{code} (the cloud's) ─▶ failed + "refused by the cloud: <code>"
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
15 s for the host's reply and return its refusal; not connected, or the
host no longer pinned here, they fail here without sending.

### One space UI: mirrored rows

A remote space is shown exactly like a local one: same list, same page,
chat, plan, questions and composer. The host sends its own rows; every
follower (the origin, delegated phones and browsers) keeps a copy.

```
host                                   cloud                    follower
space / chat_message row changes ─▶ mirror{model,id,data} ─▶ keep latest ─▶ upsert row,
run step (live)                  ─▶ mirror{turn_step}     ─▶ relay only  ─▶ RunStep
                                     signed Event, seq + 1    per key         Space.remote set
```

| Model | `id` | `data` | Host sends | Cloud keeps |
| --- | --- | --- | --- | --- |
| `space` | `rs_…` (the fleet id) | `Space`, local-only fields blanked | on change, ≤ 1 per second | latest |
| `chat_message` | the message id | `ChatMessage`, `pr = "space:rs_…"` | on change, ≤ 1 per second per row | latest |
| `turn_step` | `<run>:<n>` | `TurnStep`, `run = "space:rs_…:<message>"` | as it happens | relayed, not kept |

- **Ids.** The host rewrites its local space id to the fleet id in every
  row (`id`, `pr`, `run`), so all followers share one id. Message ids stay.
- **Blanked on the host:** `worktree`, `ports`, `agent_session`,
  `sent_feedback`, `review_pr`, `mirror`, the process's `pgid` and `script`. `remote`
  is never sent; the follower sets it.
- **`data = null`** deletes the row. A row whose JSON is over
  `MIRROR_ROW_MAX_BYTES` (48 KiB) has its longest texts cut with a note.
- **Compaction.** Host journal and cloud keep the latest `mirror` per
  `(model, id)`; holes in `seq` this leaves are not gaps. `turn_step` is never
  journaled nor stored: a finished turn's steps are in its reply's `activity`.
- **Protocol 3** devices never get `mirror` (the cloud drops it for them).
- **Follower.** A verified `mirror` is written to the local store, so the
  UI's sync shows it; it survives a restart and resubscribes from the last
  seq. Local-only parts (diff, terminal, files, ship, undo) say "Runs on
  <host>". Send, stop, answer and approve go through `fleet_send` /
  `fleet_stop` / `fleet_answer`; archive forgets the copy (and stops a
  running turn). The space poller, recovery and git work skip mirrored
  spaces.

### Phones and the web app

The phone and web app (docs/mobile.md) join as devices of kind `mobile` /
`web`. Here they are listed (phone / globe icon, "Phone" / "Web app"),
trusted like any device, and never a target.

```
trusted phone ─signs─▶ start / send / stop / answer ─▶ this device's gate,
  exactly as a computer's (pin, target_key, fresh, accept_remote, max_mode)
start dialog, fleet_devices, fleet_start_space, any request from here
  ─▶ kind mobile / web ─▶ skipped / refused here, nothing signed
```

A space's questions reach only its origin and host. "Send my spaces'
questions here" on a trusted phone's row lets it follow the spaces this
device started:

```
switch on  ─▶ fleet_delegate(id, true): a phone / web app, pinned with its
  listed key ─▶ fleet.delegates += id
  ─▶ delegate{seal_as(Delegation{me, id, now, expires 0, revoke: false}, Delegate)}
switch off / Untrust / Remove ─▶ fleet.delegates -= id ─▶ the same, revoke: true
welcome ─▶ devices ─▶ each wanted delegate listed in this org, signed again
  (the cloud may have lost it; ids are per org, so only listed ones)
delegations{list} ─▶ origin me: open with my key; delegate me: with the
  origin's pin; else, or not verifying, expired, a revocation ─▶ dropped
  ─▶ FleetDevice.delegation_live
  ─▶ one of mine no longer wanted ─▶ revoked, once per connection
```

`FleetDevice.delegated` is the switch (asked for here, still trusted);
`delegation_live` that the cloud holds it ("Waiting for the cloud to
confirm" while on and not yet). A delegation grants nothing on hosts: the
phone's answer to a space hosted elsewhere runs there only if that host
trusts the phone.

## Cloud

`OrgHub` details, storage and limits: `docs/cloud.md` "Fleet". Where it
pins down what this doc leaves open:

- A fatal refusal closes the socket with 4001 (`fleet.unauthorized`,
  `fleet.no_org`) or 4003 (`fleet.key_mismatch`, `fleet.version`,
  `fleet.too_many_devices`), the code as the reason; the device doesn't
  redial. 4001 only for a token refused for what it is: a token the cloud
  couldn't check (JWKS unreachable) closes with 1011 `fleet.unavailable`,
  and the device redials.
- A `start_space` for a space id the cloud knows (or has a start pending
  for) is `refused{fleet.invalid}`; a start the host refuses forgets only
  the row that very request made. The cloud doesn't send `fleet.removed`: `remove_device` takes
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
- Stored events and mirrors are capped by bytes: 16 MiB per space (the
  ring's oldest out first), 128 MiB per user (finished spaces' events out
  first, then their mirrors, else `error{fleet.busy}` and the host keeps
  the event in its journal). Only ring loss is a `space_gap`; seq holes
  from compaction or relayed `turn_step`s are not.
- Protocols 3 and 4 are accepted. A protocol-3 connection never sees
  `mobile` / `web` devices in `devices` nor gets `delegations`; a request
  to a `mobile` / `web` device is `refused{fleet.invalid}`.
- A space's followers are its origin and the origin's live delegates
  (`docs/mobile.md`): they may subscribe, and its questions reach them as
  they reach the origin (escalation too). A delegation is signed by the
  origin, checked against its pinned key, and pushed to both devices as
  `delegations{list}`.
- Phones get Expo pushes for a follower's question (when not looking at
  it) and for a followed space turning idle, failed or stopped; 30 a
  minute per device. `POST /v1/fleet/request` routes a one-shot request
  like a socket `request`; the reply comes later over the socket.
- Cloud-only codes: `fleet.bad_message` (malformed or out-of-order frame),
  `fleet.too_many_devices` (20 per user), `fleet.too_many_connections` (10
  sockets per user), `fleet.too_many_spaces` (200 per user),
  `fleet.upgrade_required` (HTTP 426).

## Not yet

`theodore daemon` (headless Linux device), file transfer, cross-user
sharing within an org (v1 routes only between one user's own devices).
Phone and web: docs/mobile.md.
