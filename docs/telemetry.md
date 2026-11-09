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
                                                                 only with "Share usage data"
```

## What leaves the machine

| | Local file | Error reports (OTLP) | Usage data (PostHog) |
|---|---|---|---|
| Levels | info+ (or `THEODORE_LOG`) | warn, error | info (product events) |
| Kinds | all | logs, panics, UI errors, traces | `kind="product"` only |
| Repository names, paths, logins | kept | hashed | never present |
| Debug / trace | if enabled | never | never |
| Identifier | — | install id, plus the account id signed in | account id signed in, else an anonymous id |
| On by default | yes | no | no |

Remote sinks need two things: an endpoint (env, setting or compiled in) **and** the user's
recorded choice. Until onboarding (or Settings) records a choice, nothing is sent and nothing is
queued — records are dropped. Sandbox and fixture runs never have remote sinks; tests and the
CLI never start telemetry at all.

### Who a record is from

So a problem can be traced to who has it and which version they run, a signed-in record carries
the Theodore account's opaque id: the account provider's user id (`user_…`), which only someone
with access to the provider's dashboard can resolve to a person. One id per person, across
installs and versions.

```text
never signed in ─▶ PostHog distinct_id = anon id (= the install id), no person profile
sign-in         ─▶ PostHog distinct_id = user_…   $identify { $anon_distinct_id, $set: version… }
                   New Relic logs and spans: enduser.id = user_…
app start, or sharing turned on, signed in ─▶ $identify again: a new version reaches the person
sign-out        ─▶ a NEW anon id: later events aren't linked to that person
                   New Relic: no enduser.id
```

| | PostHog | New Relic |
|---|---|---|
| Signed in | `distinct_id` is `user_…`, with a person profile | `enduser.id` on every log and span |
| Signed out | a random anonymous id, `$process_person_profile: false` | none; `service.instance.id` only |
| What runs | `app_version`, `channel`, `os`, `arch`, `commit`, `build_env` on every event and in `$set` | `service.version`, `theodore.update_channel`, `os.type`, `host.arch`, `vcs.ref.head.revision`, `deployment.environment.name` |

- **Never** the email, name, host login or token. `set_account` refuses anything not shaped like a
  provider id, so one passed by mistake is treated as signed out.
- **Consent**: the id is attached by the sinks, so with a sink off nothing carries it. Each choice
  covers its own sink: "Send error reports" alone never reaches PostHog.
- **Only the remote sinks** add it, after redaction. The local log doesn't have it, so a problem
  report (its logs come from there) doesn't either. Other fields naming an account or user stay
  hashed.
- **Anon id**: `<data dir>/telemetry/anon_id`, absent (so the install id) until the first sign-out.
  The install id itself (`<data dir>/telemetry/install_id`) never changes: repository names and
  paths are hashed with a key unique to it, and it stays `service.instance.id`.

PostHog events set `$geoip_disable: true`; PostHog still sees the request's IP address — turn on
"Discard client IP data" in the project settings. What the UI promises: *linked to your Theodore
account's id when you're signed in, never to your email, name or code; repository names are
hashed; you can turn this off any time in Settings.*

## The choice

- **Onboarding**, right after sign-in: "Help improve Theodore" with two checkboxes, both checked —
  "Share usage data" and "Send error reports" — and a "What's collected" link (the event
  list and what's never sent, from the core's own catalog). The step only appears when the build
  has at least one remote sink; the choice is saved before Next advances.
- **Once, after sign-in**, for an install that onboarded before its build could send anything
  (so it never saw that step): the same choice in a dialog, Save or Don't share. It shows only
  while an available sink has no recorded choice, and never in sandbox mode.
- **Settings → About & updates → Privacy**: the same two switches, each independent.
- Stored as settings `telemetry.usage` and `telemetry.errors` (absent = no choice yet). Turning one
  off stops its sink at once and drops what it had queued.

## Product events

Typed (`ProductEvent`), fixed field names, emitted as `tracing` records on target
`theodore::product` with `kind="product"`. Fields are counts, durations, flags or values from a
fixed set — never code, paths, titles or comment text. The wire shape is pinned by
`crates/telemetry/tests/product_events.json`.

| Event | Fields | Answers |
|---|---|---|
| `app_started` | `version`, `channel` | Is the product used, on what version? |
| `signed_in` | — | Do people get past sign-in? |
| `onboarding_step` | `step` (`account`, `telemetry`, `github`, `agents`, `projects`, `done`) | Where does onboarding lose people? |
| `pr_opened` | `host` (`github`, `gitlab`, `bitbucket`, `local`) | Is review used, on which hosts? |
| `grouping_done` | `ms`, `valid_first_try`, `groups`, `hunks`, `agent`, `chunks` | Is grouping good and fast? |
| `grouping_failed` | `code` (an error code below) | Why does grouping fail? |
| `skill_run` | `skill` (a built-in id, else `custom`), `agents`, `findings`, `ms`, `outcome` | Which skills run, and do they finish? |
| `chat_asked` | `scope` (`pr`, `group`, `hunk`; `hunk` is a hunk's Ask agent) | Is the AI panel used, from where? |
| `chat_answered` | turn facts (below) | Do AI panel questions get an answer? |
| `task_delegated` | `agent` | Is delegating used? |
| `task_decided` | `accepted` | Is delegated work any good? |
| `review_submitted` | `comments`, `review_event` (`approve`, `request_changes`, `comment`) | Do reviews finish here? |
| `merge` | `method` | Do merges happen here? |
| `space_created` | `mode`, `from` (`blank`, `issue`, `branch`, `pr`) | Where does work start? |
| `space_turn` | `ms`, `mode`, `ok`, turn facts | Which agents and models, how do turns end, how long, how much do they do? |
| `message_voted` | `vote` (`up`, `down`, `cleared`), `surface` (`space`, `ai_panel`), `mode` (`none` in the AI panel), turn facts | What do people think of a reply, and what made it? |
| `space_action` | `action` (`stop`, `send_now`, `plan_approved`, `plan_revised`, `undo`, `back_to_here`) | When do people step in or take work back? |
| `queue_held` | `reason` (`stopped`, `failed`, `checkpoint_skipped`, `start_failed`, `restart`), `messages` | How often does queued work stall, and why? |
| `space_shipped` | `how` (`open_pr`, `open_draft_pr`, `push`, `merge_locally`, `keep_branch`, `merge_pr`) | Does work leave the space? |
| `config_saved` | `where` (`global`, `repo`, `local`) | Is config edited, at which layer? |
| `report_opened` | `from` (`app`, `chat`, `agent`) | With `problem_reported`: who starts a report and gives up? |
| `problem_reported` | `mode` (`issue`, `issue_with_logs`, `logs_only`) | How do reports get sent? |
| `ui_counts` | `tool_rows`, `file_hovers` (uses since the last flush) | Are tool details and file previews looked at? |
| `update_installed` | `version` (the update now on disk; the running one is `app_version`) | Do updates arrive? |
| `update_failed` | `reason` (`read_only`, `network`, `signature`, `other`) | Why don't they? |
| `move_to_applications` | `choice` (`moved`, `declined`, `failed`), `from` (`volume`, `translocated`, `folder`) | Does the first-launch move work? |

**Turn facts**, the same fields wherever a run is described (`TurnFacts`):

| Field | Values |
|---|---|
| `agent` | the agent's id |
| `model` | the name, if in a known family (`claude…`, `gpt…`, `gemini…`, …); `custom` otherwise, so a private deployment's name stays home; `default` when the CLI picked; `unknown` on a reply from before the model was recorded |
| `effort` | `minimal` … `max`, `default`, `custom` |
| `outcome` | `ok`, `failed`, `stopped` |
| `duration` | `under_10s`, `10s_1m`, `1m_5m`, `5m_15m`, `over_15m`, `unknown` |
| `tools`, `files` | tool calls and changed files; a vote in the AI panel has neither stored, so 0 |

Votes live on the reply (`ChatMessage.vote`) and sync like the rest of it; setting the vote it
already has sends nothing. `merge_pr` in `space_shipped` comes with the `merge` event of the same
merge. `ui_counts` is sent 5 minutes after the first use, or when the window hides, never per use.

Every PostHog event also carries `app_version`, `os`, `arch`, `channel` (the update channel),
`commit` and `build_env` (`production`, `staging`, `nightly`, `dev`; docs/releasing.md "Build
stamp"). The UI can report only `onboarding_step`, `plan_revised` (as `space_action`),
`report_opened` and `ui_counts` (`track_ui`, `api.trackUi`, `core/useCounts.ts`), and the core
drops values it doesn't know.

## Error codes

Failures are logged with a stable dotted `error.code`, plus context: `agent` and
`agent_version`, `duration_ms`, `attempt`, the PR (hashed remotely), `exit_code`.

| Area | Codes |
|---|---|
| Grouping | `grouping.invalid_output`, `grouping.agent_failed`, `grouping.repaired` (a repair round or the Other fallback was needed) |
| Host | `host.unauthorized` (401), `host.forbidden` (403), `host.rate_limited`, `host.not_found`, `host.conflict`, `host.validation`, `host.network`, `host.server_error`, `host.protocol`, `host.auth` (as the app sees 401/403), `host.forbidden` also for a GraphQL mutation refused as `FORBIDDEN` |
| Agent | `agent.crashed` (non-zero exit / error, with `stderr_tail` ≤ 2 KB), `agent.timed_out`, `agent.stalled`, `agent.spawn_failed`, `agent.not_installed`, `agent.offline` (info: the CLI couldn't reach its servers — a run, a grouping, a space turn), `agent.signed_out` (info: the CLI has no valid credentials; the user sees "Codex isn't signed in. Run `codex login` in a terminal.", the raw error stays in `stderr_tail`) |
| Git | `git.command_failed`, `git.auth`, `git.network` (the remote can't be reached; expected, logged at info), `git.not_installed`, `git.refused`, `git.not_a_worktree` (a space dir git wouldn't resolve as its worktree), `git.busy` (a rebase or conflict unfinished in a space; expected, logged at info), `git.unsupported`, `git.commit_not_found` (a stale sha, force-pushed away; expected, logged at info), `git.parse`, `git.io` |
| Store | `store.db`, `store.serde`, `store.migration` |
| Outbox | `outbox.gave_up` |
| Spaces | `space.command_failed`, `space.command_timed_out`, `space.turn_failed`, `space.worktree_moved_aside` (a space dir that wasn't its worktree, moved to `spaces/.moved-aside/`) |
| Account | `account.refresh_rejected`, `account.rejected`, `account.network`, `account.invalid_token`, `account.config`, `account.protocol`, `account.required` |
| Chat | `chat.failed` (an AI panel question whose run failed) |
| Other | `skill.failed`, `app.not_found`, `app.invalid`, `app.internal`, `app.start_failed`, `app.offline_not_cached`, `app.offline` (offline and the project was never cloned), `panic` |
| UI | `ui.uncaught`, `ui.unhandled_rejection`, `ui.render_crash` |

A grouping run also logs `grouping done` (local file) with `duration_ms` and `first_group_ms`,
when its first group was shown; the same `first_group_ms` is recorded on the run's `grouping`
span. Without streaming (Codex, Gemini) it equals `duration_ms`.

`AppError::code()` maps every app error; command failures are logged once, at the command
boundary, inside the command's span.

## What a flow logs

Info for each state change (the local file), warn with `error.code` for each failure (also remote).
Nothing per streamed chunk.

| Flow | Lines |
|---|---|
| Space turn | `space turn started` (`agent`, `model`, `effort`, `mode`, `resumed`), `space turn finished` (`outcome`, `duration_ms`, `tools`, `files`), `space turn failed` |
| AI panel | `chat question started`, `chat question finished` (`outcome`, `duration_ms`, `tools`), `chat question failed` |
| Agent CLI | `agent run failed` (`agent.crashed`, `exit_code`, `stderr_tail`), and the timeout and spawn codes above |
| Queue | `queue held` (`reason`, `messages`), `the queued message didn't start` |
| Tool payloads | `couldn't store a tool payload` (once per run), `couldn't prune tool payloads` |
| File preview | the command's `command failed` line (`cmd=file_preview`, `error.code`), like any command |
| Reconcile | `PR row removed` (`why`: `host_not_found`, `project_removed`) |
| Votes, account | `reply voted`, `signed in to…`, `signed out of the Theodore account` |

## Operation ids

Every IPC call carries an `op_id` (16 hex chars made in `ui/src/core/api.ts`, sent as the
`x-theodore-op` invoke header). The command runs in an `op` span with `op_id` and `cmd`; agent
runs, grouping and host requests it starts stay in that span, so one failure stitches together
from UI to core to agent to host. `CommandFailure.opId` in the UI is the same id. Outbox writes run
later, in their own `outbox_item` span.

Every command ends with one `command done` line carrying `ok` and `ms` (and `error_code` when it
failed); the same fields land on the exported trace, so New Relic shows each command's duration
and outcome. Info level, debug for the chatty ones (sync, polls, passive reads); a chatty command
isn't exported as a trace either. Why a command failed is logged once, where its error is mapped.

## Redaction

Shared, unit-tested (`crates/telemetry/src/redact.rs`), applied to every record before any sink —
the file included.

- **Secrets in any text:** GitHub tokens (`gh[pousr]_…`, `github_pat_…`), GitLab (`glpat-…` and
  the other `gl…-` prefixes), Atlassian/Bitbucket (`ATBB…`, `ATATT…`), passwords in URLs
  (`https://user:pass@…`), `Bearer …`/`Basic …`, WorkOS keys (`sk_…`), model-provider keys
  (`sk-…`), AWS key ids (`AKIA…`), Slack (`xox…-`), Google (`AIza…`) and npm (`npm_…`) tokens,
  JWTs, private keys, `Authorization`/`Cookie`/`Private-Token` headers,
  `code=`/`state=`/`token=`/`key=`… query parameters, `token=`/`"secret": …`/`password: …`
  pairs, and env-style `*_KEY=`/`*_PAT=`/`*_PASS=`/`*_AUTH=`/`*_DSN=` assignments.
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
| `telemetry.usage` | — | "Share usage data" (bool; absent = not chosen) |
| `telemetry.errors` | — | "Send error reports" (bool; absent = not chosen) |
| `telemetry.otlp.endpoint` | `THEODORE_OTLP_ENDPOINT` | OTLP/HTTP base URL; `/v1/logs` and `/v1/traces` are appended |
| `telemetry.otlp.headers` | `THEODORE_OTLP_HEADERS` | `k=v,k2=v2`, e.g. `api-key=…` |
| `telemetry.posthog.host` | `THEODORE_POSTHOG_HOST` | default `https://us.i.posthog.com` |
| `telemetry.posthog.key` | `THEODORE_POSTHOG_KEY` | the project API key |
| `log.level` | `THEODORE_LOG` | `info` by default; a level or `tracing` directives (`info,theodore_app=debug`); the env wins |
| — | `THEODORE_LOG_STDERR` | mirror the log to stderr outside debug builds |
| `report.github_repo` | `THEODORE_FEEDBACK_REPO` (build time only) | where "Report a problem" opens issues, `owner/name`; default `JeanIsahakyan/theodore`; the setting wins |

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
`deployment.environment.name` (the build environment), `theodore.update_channel`, `os.type` and
`host.arch`, signed in also `enduser.id` ("Who a record is from"), and correlate with traces by
trace id.

### PostHog

```sh
THEODORE_POSTHOG_HOST=https://eu.i.posthog.com THEODORE_POSTHOG_KEY=phc_… cargo run -p theodore-desktop
```

Events go to `/batch/` in batches of up to 50 (or every 30 s), retried with backoff on 5xx/429
and network errors, dropped on another 4xx or after 4 attempts.

Either way, choose "Help improve Theodore" in onboarding or flip the switches in Settings —
nothing is sent before that.

## The local log

`<data dir>/logs/theodore.jsonl` (`~/.theodore/logs/` in production, `~/.theodore-<env>/logs/` in
other builds, `~/.theodore-sandbox/logs/` in sandbox mode): one JSON object per line — `ts`, `level`, `target`, `kind`, `msg`, `spans`, then
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

Settings → About & updates, Help → Report a Problem…, the account menu, the "Something went
wrong" screen, or a chat ("Report from a chat" below). One dialog, three modes:

| Mode | Sends | Where |
|---|---|---|
| **Open an issue** | title, comment, app-info table | a **public** issue on GitHub, as you |
| **Open an issue with logs** | the same + the newest redacted log lines, folded in `<details>` | the same |
| **Save logs only** | nothing | a zip on disk for you to attach yourself |

```text
issue_target ─▶ repo + @login, or why not ─▶ modes 1–2 enabled / disabled with that reason
preview_issue(title, comment, with_logs) ─▶ draft id + the exact body  (app info, log lines kept)
submit_issue(…, draft) ─▶ POST /repos/{owner}/{repo}/issues, label from-app ─▶ #N + link
                          └─ label refused (422/403) ─▶ once more without it
```

- **Issues** go to `JeanIsahakyan/theodore` — or `THEODORE_FEEDBACK_REPO` (`owner/name`) at build
  time, or the `report.github_repo` setting (for a scratch repo). They are posted with your own
  GitHub token (keychain → `gh` → `GITHUB_TOKEN`, as everywhere); the dialog says "Posted publicly
  as @login on github.com/…" and requires a title and a comment.
- **App info** in an issue: version, update channel, commit, build environment and date, macOS
  version, architecture. No install id, no account, no agent CLIs, no paths.
- **Logs** in an issue are the zip's lines — the same files, the same remote-rule redaction
  (`report::log_tail`) — but only the newest ones: GitHub caps a body at 65,536 characters, so
  the logs get what the comment and table leave, and the summary says how many older lines were
  cut. A fence longer than any backtick run in them keeps a log line from closing it.
- **Preview** shows the body exactly as posted (logs folded). The post reuses the preview's draft,
  so it sends the app info and log lines the preview showed; the draft is dropped after posting.
- **No GitHub sign-in, sandbox or fixture runs**: modes 1–2 are disabled with a one-line reason;
  sandbox and fixture runs have no issue tracker at all, so they can't reach GitHub even if asked.
  Errors show inline: an expired token reads "GitHub sign-in expired …".
- **GitHub can't be checked** (rate limit, network, a 5xx, signed out): modes 1–2 wait with the
  reason — a rate limit says how long, from GitHub's reset time ("… Try again in 12 minutes.") —
  and **Retry**, which asks again and keeps the title, comment, files and a chat's draft. The
  cause is logged as a warning (`error.code`, e.g. `host.rate_limited`).
- **The zip** (`Save logs only`): `<tmp>/theodore-reports/theodore-report-<stamp>.zip` with
  `app-info.json` (version, commit, build environment and date, OS, agent CLI versions) and the
  newest logs up to 20 MB, redacted again with the remote rules (repository names and paths
  hashed). The dialog lists the files for review, then **Reveal in Finder** or **Copy summary**.
- Either way, `problem_reported` records only the mode, never the text or the issue.

### My reports

An issue the dialog opened is remembered, then followed with the same GitHub token: Settings →
About & updates lists it under **My reports** (status, comments, last activity; a click opens
the issue), and a change says so.

```text
submit_issue ─▶ #N ─▶ `report` row (synced, keyed owner/name#N), status open
poller: 20 s after start, then every 30 min (online, signed in)
  issue_status (GraphQL): state, close reason, comments, last commenter, ClosedEvent.closer
    closer = merged PR (its merge commit) or a commit ─▶ fix commit
  fixed + fix commit ─▶ first_release_with: v* releases oldest first (REST),
                        compare <sha>...<tag> = ahead|identical ─▶ released in <tag>
                        (the newest one first: one compare while none has it)
  changed ─▶ row written ─▶ ReportUpdate ─▶ toast "Open"; window in the background:
                                            a notification, a click opens the issue
```

| Change | Says |
|---|---|
| A comment by anyone but the reporter | New reply on your report #N |
| Closed as completed | Your report #N is fixed in #57 (or "was closed as fixed") |
| Its fix in a release newer than this build | Your report #N is fixed in 0.1.7: update to get it |
| Its fix in this build | Your report #N is fixed in this version — said once per version, also after an update, offline too |
| Its fix in an older build | Your report #N was fixed in 0.1.7: you have it |
| Closed as not planned / duplicate | Your report #N was closed as not planned / as a duplicate |
| Reopened | Your report #N was reopened |

- Followed: open reports; closed ones for 30 days after closing; a fix with a commit but no
  release yet for 180 days.
- Only reports filed from this install, from the version that added this on: older issues aren't
  matched. Sandbox and fixture runs post none, so they follow none.
- Nothing about it is a product event; the log has `report changed` with the number and status.

### Report from a chat

The same dialog, opened on one conversation — a space's chat or a PR's AI panel — instead of the
whole app. Three ways in, one path:

```text
"Report this" under a reply ─┐
/report <what went wrong>  ──┼─▶ draft_report ─▶ ReportDraft (memory) ─▶ report_draft event
agent ─▶ report_problem (MCP)┘        nothing sent                      └─▶ the dialog, prefilled
dialog ─▶ preview_issue / submit_issue { context: <draft id> } ─▶ the conversation, read now
```

- **"Report this"** sits under every stored agent reply (next to Retry on a failed one; not on
  one you stopped); `/report …` in either composer drafts about the chat's latest reply with
  the rest of the line as the comment — it never reaches the agent (a skill of yours named
  `report` still does).
- **`report_problem { title, description, scope, include_logs }`** is a tool on Theodore's MCP
  server for chats only: a space turn (`space-tools`) or an AI panel question (`review-tools`
  with an `ask:` run); skill and fix runs never see it. The agent drafts — the dialog opens with
  its title and comment and says "drafted by the agent" — and is told it cannot send. Only the
  dialog's **Open issue** posts. Against a prompt injection that tells the agent to report:

  | Guard | How |
  |---|---|
  | One window per turn | a run drafts once; a second call is refused (the last 256 runs remembered) |
  | Never over your window | with any dialog open, the agent's draft waits: a toast offers it now (**Review**), and it opens by itself when that dialog closes, however it closes — never lost with the toast. Several wait in turn |
  | No secrets in its text | title and comment redacted (`Redactor::text`) before the form shows them |
  | No pings | its comment's `@login`, `#12`, `owner/repo#12`, `GH-12` and issue links become inline code |
  | Bounded | title 256 chars, comment 20,000 |
- **Scope**: `turn` (default) — your message as the agent got it (a `/skill` expanded, attached
  files listed by path), the reply, its tool calls one line each (folded), the error; `message`
  — that message alone; `space` / `review` — the conversation's header only, no message text.
- **The context table**: where (`Space turn 3 of 5`, `AI panel reply 2 of 4`), scope, who
  drafted it, agent CLI and version, model, effort, mode, status, when sent, how long it took,
  files changed and tool calls (counts), the run id. No space, project, repo or branch names.
  The model is the one the run was sent — the space's, else the `agents.<id>.model` setting at
  the time, else the CLI's default — recorded on its reply when the run starts, so a later
  settings change doesn't rewrite it; a reply from before that was recorded says `unknown`.
  Each value is inline code, so nothing in one (a model name, a space's error) mentions, links
  or cross-references.
- **Logs** in a chat report are that run's only: every record of a space turn or an AI panel
  question carries `run_id` from its span (`space_turn`, `chat_run`), and `report::run_logs`
  keeps just those, redacted like the other issue logs. A reply from before runs were recorded
  has none, and no app logs stand in for them.
- **Redaction and caps**: the conversation keeps paths and names readable, as in the chat, but
  secrets, emails and the home directory are redacted (`Redactor::text`); every text is fenced
  (nothing in it renders or @mentions anyone; backticks or tildes, whichever the text can't
  close with less) and capped (prompt 4 KB, reply 8 KB, error 2 KB, 40 tool calls of 200 bytes,
  24 table rows). The whole block stays under 40 KB whatever is in it (`issue::MAX_CONTEXT`),
  so the comment and logs keep room under GitHub's 65,536; a comment that doesn't fit next to
  it is refused with "shorten the comment or leave the conversation out", never cut or sent
  over the cap.
- **What you see is what goes**: the preview opens at once with the conversation unfolded;
  **Include the conversation** unticked makes it the plain report. The draft is read when the
  dialog first previews it — a turn still running when the agent drafted shows how far it got —
  and the post sends exactly that preview: while the preview is open, **Open issue** waits
  until it shows the current mode. Drafts live in memory (the last 16) and expire.

### Attachments

Screenshots and files go with a report the way they go with a chat message — 📎, paste (⌘V)
or drop on the comment, saved by `save_attachment`, shown as tiles (images as previews) — but
Theodore never uploads them. GitHub has no API for issue attachments, and the other ways cost
the reporter more than they give:

| Option | Why not |
|---|---|
| GitHub's own upload (`user-attachments`) | web only: needs a browser session, not a token |
| A gist under the reporter's account | the gist API takes text only; binary needs a git push and the `gist` scope, which Theodore's sign-in (`repo`, `read:org`) doesn't ask for; and secret gists are public by URL |
| A branch or repo | no write access to Theodore's repo; a public fork or repo in the reporter's account just for screenshots is a lasting public side effect |
| **The browser, after the issue opens** | chosen: works for every reporter, no new scope, and the user sees each file in GitHub's own editor before it goes |

```text
📎 / ⌘V / drop ─▶ save_attachment ─▶ tiles in the dialog ("Theodore doesn't upload these")
preview ─▶ "Not in the issue: N files (…)"
Open issue ─▶ the text, as today ─▶ "Add your N files" ─▶ Show files and open the issue
   └─▶ stage_report_files(ids) ─▶ <tmp>/theodore-reports/theodore-files-<id>/ ─▶ Finder
   └─▶ the issue in the browser ─▶ the user drops them into a comment ─▶ GitHub renders them
```

- Nothing is copied or opened before **Show files and open the issue**; `stage_report_files`
  copies only saved attachments by id, into the reports folder (`reveal_report` shows nothing
  else).
- Not in **Save logs only**'s zip, and not available signed out (`save_attachment` waits for
  sign-in like every local write).

## UI errors

`window.onerror`, `unhandledrejection` and the top-level error boundary forward to `log_client`
(deduped and rate-limited in the UI and again in the core): message, stack, React component stack,
the route name only, and the failed command's `op_id` when there is one.
