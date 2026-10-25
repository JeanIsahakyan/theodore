# Telemetry

One structured stream in the core (`tracing`), one redaction step, several sinks.
Code: `crates/telemetry`.

```text
core tracing ────────────┐
UI errors (log_client) ──┼─▶ one record ─▶ redaction ─┬─▶ file   everything, always on, local
panics (panic hook) ─────┘    (fields,                ├─▶ stderr dev builds / THEODORE_LOG_STDERR=1
                               op_id, kind)           ├─▶ OTLP   warn + error, panics, traces
                                                      │          only with "Send error reports"
                                                      └─▶ PostHog product events only
                                                                 only with "Share anonymous usage data"
```

## What leaves the machine

| | Local file | Error reports (OTLP) | Usage data (PostHog) |
|---|---|---|---|
| Levels | info+ (or `THEODORE_LOG`) | warn, error | info (product events) |
| Kinds | all | logs, panics, UI errors, traces | `kind="product"` only |
| Repository names, paths, logins | kept | hashed | never present |
| Debug / trace | if enabled | never | never |
| Identifier | — | install id | install id |
| On by default | yes | no | no |

Remote sinks need two things: an endpoint (env, setting or compiled in) **and** the user's
recorded choice. Until onboarding (or Settings) records a choice, nothing is sent and nothing is
queued — records are dropped. Sandbox and fixture runs never have remote sinks; tests and the
CLI never start telemetry at all.

**Anonymous, precisely:** both remote sinks identify the app by a random install id (a UUID in
`<data dir>/telemetry/install_id`), never by the Theodore account. No account id, email, name or
host login goes into any property. Repository names and paths are hashed with a key unique to the
install. PostHog events set `$process_person_profile: false` and `$geoip_disable: true`; PostHog
still sees the request's IP address — turn on "Discard client IP data" in the project settings.
What the UI promises: *not linked to your account, email or code; repository names are hashed;
you can turn this off any time in Settings.*

## The choice

- **Onboarding**, right after sign-in: "Help improve Theodore" with two checkboxes, both checked —
  "Share anonymous usage data" and "Send error reports" — and a "What's collected" link (the event
  list and what's never sent, from the core's own catalog). The step only appears when the build
  has at least one remote sink; the choice is saved before Next advances.
- **Settings → About & updates → Privacy**: the same two switches, each independent.
- Stored as settings `telemetry.usage` and `telemetry.errors` (absent = no choice yet). Turning one
  off stops its sink at once and drops what it had queued.

## Product events

Typed (`ProductEvent`), fixed field names, emitted as `tracing` records on target
`theodore::product` with `kind="product"`. Fields are counts, durations, flags or values from a
fixed set — never code, paths, titles or comment text. The wire shape is pinned by
`crates/telemetry/tests/product_events.json`.

| Event | Fields |
|---|---|
| `app_started` | `version`, `channel` |
| `signed_in` | — |
| `onboarding_step` | `step` (`account`, `telemetry`, `github`, `agents`, `projects`, `done`) |
| `pr_opened` | `host` (`github`, `gitlab`, `bitbucket`, `local`) |
| `grouping_done` | `ms`, `valid_first_try`, `groups`, `hunks`, `agent`, `chunks` |
| `grouping_failed` | `code` (an error code below) |
| `skill_run` | `skill` (a built-in id, else `custom`), `agents`, `findings`, `ms` |
| `chat_asked` | `scope` (`pr`, `group`, `hunk`) |
| `task_delegated` | `agent` |
| `task_decided` | `accepted` |
| `review_submitted` | `comments`, `review_event` (`approve`, `request_changes`, `comment`) |
| `merge` | `method` |
| `space_created` | `mode` |
| `space_turn` | `ms`, `mode`, `ok` |
| `space_shipped` | `how` (`open_pr`, `open_draft_pr`, `push`, `merge_locally`, `keep_branch`) |
| `config_saved` | `where` (`global`, `repo`, `local`) |

Every PostHog event also carries `app_version`, `os`, `channel` (the update channel), `commit`
and `build_env` (`production`, `staging`, `nightly`, `dev`; docs/releasing.md "Build stamp").
The UI can report only `onboarding_step` (`track_ui`), and the core drops values it doesn't know.

## Error codes

Failures are logged with a stable dotted `error.code`, plus context: `agent` and
`agent_version`, `duration_ms`, `attempt`, the PR (hashed remotely), `exit_code`.

| Area | Codes |
|---|---|
| Grouping | `grouping.invalid_output`, `grouping.agent_failed`, `grouping.repaired` (a repair round or the Other fallback was needed) |
| Host | `host.unauthorized` (401), `host.forbidden` (403), `host.rate_limited`, `host.not_found`, `host.conflict`, `host.validation`, `host.network`, `host.server_error`, `host.protocol`, `host.auth` (as the app sees 401/403) |
| Agent | `agent.crashed` (non-zero exit / error, with `stderr_tail` ≤ 2 KB), `agent.timed_out`, `agent.stalled`, `agent.spawn_failed`, `agent.not_installed` |
| Git | `git.command_failed`, `git.auth`, `git.not_installed`, `git.refused`, `git.unsupported`, `git.parse`, `git.io` |
| Store | `store.db`, `store.serde`, `store.migration` |
| Outbox | `outbox.gave_up` |
| Spaces | `space.command_failed`, `space.command_timed_out`, `space.turn_failed` |
| Account | `account.refresh_rejected`, `account.rejected`, `account.network`, `account.invalid_token`, `account.config`, `account.protocol`, `account.required` |
| Other | `skill.failed`, `app.not_found`, `app.invalid`, `app.internal`, `app.start_failed`, `panic` |
| UI | `ui.uncaught`, `ui.unhandled_rejection`, `ui.render_crash` |

`AppError::code()` maps every app error; command failures are logged once, at the command
boundary, inside the command's span.

## Operation ids

Every IPC call carries an `op_id` (16 hex chars made in `ui/src/core/api.ts`, sent as the
`x-theodore-op` invoke header). The command runs in an `op` span with `op_id` and `cmd`; agent
runs, grouping and host requests it starts stay in that span, so one failure stitches together
from UI to core to agent to host. `CommandFailure.opId` in the UI is the same id. Outbox writes run
later, in their own `outbox_item` span.

## Redaction

Shared, unit-tested (`crates/telemetry/src/redact.rs`), applied to every record before any sink —
the file included.

- **Secrets in any text:** GitHub tokens (`gh[pousr]_…`, `github_pat_…`), GitLab (`glpat-…` and
  the other `gl…-` prefixes), Atlassian/Bitbucket (`ATBB…`, `ATATT…`), passwords in URLs
  (`https://user:pass@…`), `Bearer …`/`Basic …`, WorkOS keys (`sk_…`), JWTs, private keys,
  `Authorization`/`Cookie`/`Private-Token` headers, `code=`/`state=`/`token=`/`key=`… query
  parameters, and `token=`/`"secret": …`/`password: …` pairs.
- **Credential fields:** any field named or segmented `token`, `secret`, `password`,
  `authorization`, `cookie`, `code_verifier`, `api_key`, `credential(s)` → `[redacted]`.
- **Content fields:** `diff`, `hunk(s)`, `patch`, `body`, `comment(s)`, `content(s)`,
  `file_content(s)`, `prompt`, `markdown`, `snippet`, `blob`, `title`, `description`, `reply`,
  `suggestion`, `stdout`, `transcript`, `text` → `[omitted: N bytes]` (numbers stay: counts).
- **Emails** → `<email:hash>`; `git@host:…` remotes are kept.
- **Home directory** → `~`.
- **Length:** fields over 2 KB (stacks and backtraces: 8 KB, messages: 4 KB) are cut with
  `…[truncated N bytes]`; `*_tail` fields keep their end.
- **Remote only:** fields naming a repo, PR, branch, project, space, path, URL, login, user or
  account → `h:<hash>`; URLs keep scheme and host, their path becomes `<url:hash>`; paths become
  `<path:hash>`, except our own source in backtraces (`…/crates/…`). The local file keeps names.

## Settings and environment

| Setting | Env | Meaning |
|---|---|---|
| `telemetry.usage` | — | "Share anonymous usage data" (bool; absent = not chosen) |
| `telemetry.errors` | — | "Send error reports" (bool; absent = not chosen) |
| `telemetry.otlp.endpoint` | `THEODORE_OTLP_ENDPOINT` | OTLP/HTTP base URL; `/v1/logs` and `/v1/traces` are appended |
| `telemetry.otlp.headers` | `THEODORE_OTLP_HEADERS` | `k=v,k2=v2`, e.g. `api-key=…` |
| `telemetry.posthog.host` | `THEODORE_POSTHOG_HOST` | default `https://us.i.posthog.com` |
| `telemetry.posthog.key` | `THEODORE_POSTHOG_KEY` | the project API key |
| `log.level` | `THEODORE_LOG` | `info` by default; a level or `tracing` directives (`info,theodore_app=debug`); the env wins |
| — | `THEODORE_LOG_STDERR` | mirror the log to stderr outside debug builds |

Each sink resolves from the first source that sets it — env, then setting, then compiled in
(`option_env!` of the same `THEODORE_*` names; the release workflow passes repository variables
and the `THEODORE_OTLP_HEADERS` secret). Endpoint and credentials come from the same source. No
keys are committed. Both sinks batch through bounded queues, never block the UI, drop on overflow
or after their retries, and flush on quit.

### New Relic

```sh
THEODORE_OTLP_ENDPOINT=https://otlp.nr-data.net \
THEODORE_OTLP_HEADERS="api-key=<ingest license key>" \
cargo run -p theodore-desktop
```

EU accounts use `https://otlp.eu01.nr-data.net`. Logs arrive with `service.name=theodore`,
`service.instance.id=<install id>`, `service.version`, `vcs.ref.head.revision` (the commit),
`deployment.environment.name` (the build environment), `theodore.update_channel` and `os.type`,
and correlate with traces by trace id.

### PostHog

```sh
THEODORE_POSTHOG_HOST=https://eu.i.posthog.com THEODORE_POSTHOG_KEY=phc_… cargo run -p theodore-desktop
```

Events go to `/batch/` in batches of up to 50 (or every 30 s), retried with backoff on 5xx/429
and network errors, dropped on another 4xx or after 4 attempts.

Either way, choose "Help improve Theodore" in onboarding or flip the switches in Settings —
nothing is sent before that.

## The local log

`<data dir>/logs/theodore.jsonl` (`~/.theodore/logs/` by default, `~/.theodore-sandbox/logs/` in
sandbox mode): one JSON object per line — `ts`, `level`, `target`, `kind`, `msg`, `spans`, then
the fields (`op_id`, `cmd`, `error.code`, …). Rotated daily and at 10 MB into
`theodore-<date>-<time>.jsonl`, at most 9 old files and 50 MB in total.

```sh
cd ~/.theodore/logs
jq -c 'select(.level == "error" or .level == "warn")' theodore.jsonl     # problems
jq -c 'select(."error.code" == "agent.crashed") | {ts, agent, exit_code, stderr_tail}' theodore.jsonl
jq -c 'select(.op_id == "3f9c0a1b2c3d4e5f")' theodore*.jsonl              # one operation, end to end
jq -r 'select(.kind == "product") | .event' theodore.jsonl | sort | uniq -c
tail -f theodore.jsonl | jq -c '{ts, level, msg, "error.code"}'
```

## Report a problem

Settings → About & updates, Help → Report a Problem…, or the "Something went wrong" screen. Builds
`<tmp>/theodore-reports/theodore-report-<stamp>.zip` with `app-info.json` (version, commit, build
environment and date, OS, agent CLI versions) and the newest logs up to 20 MB, redacted again with the remote rules
(repository names and paths hashed). The dialog lists the files for review, then **Reveal in
Finder** or **Copy summary**. Nothing is uploaded.

## UI errors

`window.onerror`, `unhandledrejection` and the top-level error boundary forward to `log_client`
(deduped and rate-limited in the UI and again in the core): message, stack, React component stack,
the route name only, and the failed command's `op_id` when there is one.
