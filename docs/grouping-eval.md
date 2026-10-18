# Grouping quality eval (M1 gate, plan §5.4)

10 real, merged, varied-size/language PRs run through `theodore group --agent
claude`, saved as fixtures under `apps/cli/fixtures/real/`, replayed through
`theodore eval apps/cli/fixtures/real --agent claude` for the numbers below.
`theodore eval` prints this same table and now exits non-zero if either rate
drops below the §5.4 targets (`theodore_cli::eval::EvalSummary::meets_targets`).

## Result

```
fixture                1st-try   repaired    latency     cost  groups
bun_39523                  yes        yes    18972ms  0.2592       5
django_22073               yes        yes    17800ms  0.2041       6
django_22109               yes        yes    20304ms  0.2152       5
next_88225                 yes        yes    11740ms  0.1753       3
ra_23173              ERROR: revision has 9 hunk id(s) shared by more than one physical hunk
ra_23452                   yes        yes    16794ms  0.2125       6
ruff_18961                 yes        yes    21635ms  0.2253       7
ruff_28362                 yes        yes    11163ms  0.1815       3
tokio_8587             ERROR: revision has 10 hunk id(s) shared by more than one physical hunk
ts_64846                   yes        yes    21117ms  0.2028       7

8/10 valid first try (80%), 8/10 valid after repair (80%)

BELOW §5.4 M1 TARGETS (first try >= 90%, after repair >= 100%)
```

This is the **honest** number, not a before-the-fix one: 2 of the 10 real PRs
(tokio#8587, rust-analyzer#23173) trigger a real data-integrity bug ("bug #2"
below) that `theodore eval` used to mis-report as "valid" before this pass —
fixing that *lowered* the reported pass rate from an apparent 100% to the
true 80%, below the M1 bar. `theodore eval`'s new exit code correctly
reflects that: `exit 1` on this run.

### All 10, rated

| PR | files | hunks | 1st-try | after repair | latency | cost | groups | rating | why |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |
| [ruff#18961](https://github.com/astral-sh/ruff/pull/18961) — configurable magic-value allowlist | 16 | 27 | yes | yes | 21.6s | $0.225 | 7 | 5 | Clean foundation→usage→rule-logic→tests→schema order; snapshot hunks correctly collapsed into `hidden`. |
| [ruff#28362](https://github.com/astral-sh/ruff/pull/28362) — starred TypeVar constraints | 9 | 10 | yes | yes | 11.2s | $0.182 | 3 | 5 | Tiny PR, exactly the right shape: rule-logic fix, then its fixtures/snapshots. |
| [tokio#8587](https://github.com/tokio-rs/tokio/pull/8587) — `AsyncFd::register` | 5 | 49 | **ERROR** | **ERROR** | — | — | — | 1 | Repeats one mechanical edit across many call sites in the same file → `HunkId` collisions (bug #2 below). `theodore group` now correctly refuses rather than silently dropping hunks; no grouping is produced for the reviewer at all. |
| [rust-analyzer#23173](https://github.com/rust-lang/rust-analyzer/pull/23173) — non-ambiguous monikers | 28 | 112 | **ERROR** | **ERROR** | — | — | — | 1 | Same bug, same consequence: 10 call-site edits collide to one `HunkId`; no grouping produced. |
| [rust-analyzer#23452](https://github.com/rust-lang/rust-analyzer/pull/23452) — skip arg-list for callable arg | 6 | 20 | yes | yes | 16.8s | $0.213 | 6 | 5 | Builds up in dependency order: expose accessor → new field → new struct → compute it → use it → test. |
| [django#22073](https://github.com/django/django/pull/22073) — djangodocs test cleanup | 6 | 10 | yes | yes | 17.8s | $0.204 | 6 | 5 | Dead-code removal correctly marked `skim`; version bump, API migration, test helper, test rewrite, CI step all in sensible order. |
| [django#22109](https://github.com/django/django/pull/22109) — remove ambiguous "Overview" links | 7 | 18 | yes | yes | 20.3s | $0.215 | 5 | 4 | Grouping itself is good (title renames before the links that depend on them), but non-deterministic: 1 of 3 local runs on this fixture needed a repair call — the only reliability wrinkle found outside the bug below. |
| [TypeScript#64846](https://github.com/microsoft/TypeScript/pull/64846) — timing collection via env var | 9 | 16 | yes | yes | 21.1s | $0.203 | 7 | 5 | Module → wiring in async client → wiring in sync client → the related hardening fix it needed → tests; docs hunk correctly `skim`. |
| [next.js#88225](https://github.com/vercel/next.js/pull/88225) — CSS sourcemap `source` field fix | 6 | 6 | yes | yes | 11.7s | $0.175 | 3 | 5 | Small and exactly right: core fix, new test fixture app (`skim`), the test that exercises it. |
| [bun#39523](https://github.com/oven-sh/bun/pull/39523) — libjpeg-turbo x86_64 SIMD | 11 | 19 | yes | yes | 19.0s | $0.259 | 5 | 5 | Mixed shell/C/TS/txt PR still grouped by intent, not by file type: config/docs → kernels → CI install → test → allowlist (`skim`). |

Average rating across all 10: **4.1/5** (target ≥4 — but only barely, and
only because 8/10 are excellent; the 2 that hit bug #2 score a 1, because a
reviewer gets nothing from the tool on those PRs today, which is the honest
cost of that bug). Among the 8 that complete: **4.9/5**, latency 11.2s–21.6s,
all well inside the 60s/≤50-files budget.

[tokio#8587](https://github.com/tokio-rs/tokio/pull/8587) and
[rust-analyzer#23173](https://github.com/rust-lang/rust-analyzer/pull/23173)
each repeat a mechanically-identical one-line edit at several call sites
inside the *same file* (tokio: `AsyncFd::new(x).unwrap()` →
`unsafe { AsyncFd::register(x) }.unwrap()`, repeated across many test
functions; rust-analyzer: the same `add_crate_root(..., false)` →
`add_crate_root(..., TargetKind::Lib { is_proc_macro: false })` edit at many
call sites). Before the fix in this pass, `theodore group`/`theodore eval`
reported both as "valid first try" with a normal-looking grouping — looked
great, and was wrong.

## Bugs found and fixed

### 1. Crash on a multi-byte char at the excerpt cap

`crates/grouping/src/prompt.rs::excerpt` truncated a hunk's excerpt at a
fixed byte offset with `String::truncate`, which panics if that offset isn't
on a UTF-8 char boundary — including the boundary of the "…" the function
itself inserts. This crashed `theodore group` outright
(`thread 'main' panicked ... assertion failed: self.is_char_boundary(new_len)`)
on tokio#8587 on the very first attempt to eval it — a real, mundane PR, not
a crafted edge case.

**Before:** `theodore group` on tokio#8587 → process panic, exit 101.
**After:** truncation backs off to the nearest valid char boundary
(`crates/grouping/src/prompt.rs`). Regression test:
`prompt::tests::excerpt_backs_off_to_a_char_boundary_instead_of_panicking`
(fails on the old code, passes after the fix).

### 2. Colliding `HunkId`s silently passed as "valid" (the bigger one)

`theodore_domain::interdiff::hunk_id(path, lines)` identifies a hunk by
`(path, normalized added/deleted line text)` — deliberately *not* by line
position, so the id survives context shifts across pushes (plan §4, needed
for incremental re-grouping). The side effect: if a PR makes the exact same
textual edit more than once in one file, every occurrence gets the *same*
`HunkId`. `grouping::validate`'s known-id set is a `BTreeSet<&HunkId>`, which
can't distinguish them either — so if the agent's response (reasonably)
mentions that id once, validation sees every "known" id covered and reports
success, while every occurrence past the first is silently absent from the
grouping. Confirmed on real data: ra_23173 has the id `6778343cc6ef06ab`
labeling 10 different hunks in `crates/base-db/src/input.rs` at line offsets
1054, 1068, 1082, 1116, …; tokio#8587 has similar collisions in
`tokio/src/io/async_fd.rs` and `tokio/tests/io_async_fd.rs`.

This is a design limitation in `crates/domain`/`crates/git` (not
`crates/grouping` or `apps/cli`), so it wasn't changed here. What *is* in
scope: `theodore_grouping::group_revision` now checks the input `Revision`
for duplicate hunk ids before doing anything else (prepass, prompting, agent
calls) and returns a dedicated, clearly-worded
`GroupingPipelineError::DuplicateHunkIds` instead of silently proceeding to
a misleadingly "valid" result (`crates/grouping/src/pipeline.rs`). `theodore
eval` already turns a pipeline error into an `ERROR:` row rather than a
false pass (`apps/cli/src/eval.rs`), so this surfaces immediately in the
table instead of hiding inside a "valid" count.

Tests:
- `pipeline::tests::duplicate_hunk_ids_across_files_are_rejected_before_calling_the_agent` —
  synthetic repro, asserts zero agent calls are spent on bad input.
- `pipeline::tests::duplicate_hunk_ids_is_empty_for_well_formed_input` — no
  false positives on normal revisions.
- `eval_cmd.rs::real_fixture_with_colliding_hunk_ids_is_rejected_not_silently_accepted` —
  runs the *actual* ra_23173 fixture (offline, `FakeAgentPort`, no network/cost)
  and asserts it's rejected, so this real-world case stays covered by
  `cargo test` going forward.

**Before:** `theodore eval` on these fixtures reported 10/10 valid first try
(100%) — a false "all green".
**After:** 8/10 (80%), correctly below target, `theodore eval` exits non-zero.

## Other changes made in this pass

- **`theodore group --meta <file> --save-fixture <path>`**
  (`apps/cli/src/group.rs`): lets a `--diff-file` run carry real PR
  title/body/commits and save the input as a replayable eval fixture. Added
  because `theodore group <pr-url>` currently fails for any PR with enough
  checks to need GraphQL pagination — `theodore_host_github`'s `get_pr`
  query decodes `statusCheckRollup.contexts` without a `pageInfo` field, so
  GitHub's paginated response trips `cynic`'s deserializer (`unexpected
  response: decode: missing field 'pageInfo'`). Worked around for this eval
  by fetching the diff and metadata with `gh pr diff` / `gh pr view --json`
  instead of `deps::load_pr`; see "Not fixed here" below.
- **`theodore eval` now exits non-zero on a quality regression**
  (`apps/cli/src/eval.rs::EvalSummary`, wired in `apps/cli/src/main.rs`):
  computes first-try/after-repair rates and fails the command below the
  §5.4 M1 bar (first try ≥ 90%, after repair = 100%), so CI can gate on it.
  Unit-tested at the boundary (exactly 90%, just under, and the
  after-repair-only case) — this is what actually caught bug #2 above as a
  regression rather than a quiet miscount.
- Opt-in diagnostic: `THEODORE_GROUPING_DEBUG=1` prints validation errors
  and the raw response when a first attempt fails (`crates/grouping/src/pipeline.rs`),
  used to confirm the django#22109 repair above was LLM non-determinism, not
  a parsing bug (two immediate reruns of the identical input were both valid
  first try).

## Not fixed here (belongs to another slice)

- `crates/host-github`'s `get_pr` GraphQL query breaks on any real PR with a
  long `statusCheckRollup` (pagination fields missing from the typed query).
  This blocks `theodore group <pr-url>` end-to-end for most real-world PRs
  today; it isn't a `crates/grouping` or `apps/cli` issue so it wasn't fixed
  here, but it should be flagged before `theodore group <url>` ships as the
  primary entry point.
- The `HunkId` collision in bug #2 is a `crates/domain`/`crates/git` design
  limitation (position-independent hunk identity). `crates/grouping` now
  refuses to silently mis-validate on it, but the actual fix — giving
  mechanically-identical same-file edits distinct ids — belongs to whoever
  owns `theodore_domain::interdiff::hunk_id` and `crates/git`'s diff parser.

## Fixtures

`apps/cli/fixtures/real/*.json` (git-tracked) — one file per PR above, same
`{ "pr": {...}, "revision": {...} }` shape as the original
`apps/cli/fixtures/*.json`. Kept in a subdirectory, not the top level,
because `apps/cli/fixtures/` is also scanned by the default (`cargo test`,
no network) harness tests, which assume one fixture = one agent call; the
subdirectory keeps that fast offline suite unaffected by these larger,
real-world fixtures. Run them with:

```
theodore eval apps/cli/fixtures/real --agent claude
```
