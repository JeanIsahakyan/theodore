# Grouping by relatedness

**Verdict: keep it.** Validity is unchanged (every run valid on the first try,
no repairs, no "Other"). The gain is on large PRs: related files in different
directories now share a prompt and a group. Config, env, CI and docs edits
land inside the change they support instead of in a "config" group of their
own. Two copies of the same generated runtime are reviewed once, not twice.
On single-prompt PRs the difference is within run-to-run noise. Agent calls
are the same in total (10 on the large set): one more on kdb-83, one fewer on
migratro-77.

Dates: 2026-10-21. Agent: Claude CLI default model. Total agent spend for
this evaluation: about $14.

## What changed

```
before   too-big PR ─▶ split by first path segment ─▶ chunks ─▶ agent
         tiny group ─▶ merge into nearest group in the same top-level dir

after    diff (+ head files, + git history when a worktree exists)
           └─▶ relatedness graph over changed files
                 ├─ drop hub files ─▶ Louvain communities ─▶ hubs rejoin
                 │
         too-big PR ─▶ units = communities (2+ files)
                     │         + unconnected files by top-level dir
                     ├─ unit over budget ─▶ split it by top-level dir
                     └─ largest first, into the fitting chunk it is most
                        related to ─▶ chunks ─▶ agent
         every prompt ─▶ "# Related changes": rollouts, then strongest edges
         tiny group ─▶ merge into the most related same-kind group,
                       else nearest same-area group (as before)
```

`ALGO_VERSION` is 3, so stored groupings regroup on open.

### Signals

| Signal | From | Weight per file pair |
| --- | --- | --- |
| import / require / use / include / `mod` | hunk lines, head file when available | `1 / sqrt(in-degree of target)` |
| a changed line names another changed file | changed lines (`CMakeLists` → source, docs → code) | `0.8 / sqrt(times named)` |
| a name defined on a changed line, used on another file's changed line | changed lines | `1 / sqrt(users)`; plain words only with ≤ 3 users |
| the same new compound name adopted by 3+ files | changed lines, never on a deleted or unchanged line | `0.3` per pair, capped at 1 |
| a rare compound identifier (`granted_by_default`) in 2–6 files | changed lines | `0.5 / (files − 1)` |
| identical edit shape (names, strings, numbers masked) | non-skim hunks | `0.6` per pair, capped at 1.5; files whose whole change is that edit are kept in one community |
| name root after stripping role suffixes; folder name for index files | paths | `0.8 / (files − 1)`, groups of 2–8 |
| test ↔ source with the same root | paths | `+0.5` |
| co-change: Jaccard over the last 1000 commits before the base, ≥ 2 shared, commits touching > 12 files ignored | git (app only) | `1.5 × Jaccard` |

Hubs are files linked by import, file-name mention or shared symbol to more than
`max(10, 2·√n)` others. Examples from the fixtures: `lib/al.lib.php` defines
`al_dispatch`, which 33 entry files call. `BaseController.php` gains the
`getPdo()` that every controller now uses. A changelog names half the PR.
Hubs sit out the Louvain run, then join the community they are most connected
to. Louvain visits nodes in index order and breaks ties toward the lowest id,
so the same diff always gives the same communities.

Code embeddings were not used: they cluster by code shape, not by feature.

### Prompt hint

Each prompt lists, in at most 2 400 chars, the rollouts first and then the
strongest pairwise links among its own files. Excerpt from vkclone-3's two
chunks:

```
# Related changes
- 34 files use the new `al_dispatch`: al_audio.php, al_fans.php, al_fave.php, … (+28 more)
- 26 files use the new `getPdo`: lib/classes/Controllers/AudioController.php, … (+20 more)
- lib/classes/Controllers/LoginController.php → lib/classes/Processors/SessionProcessor.php (`SessionProcessor`, imports)
- lib/classes/Controllers/PhotosController.php → lib/classes/Processors/PhotoProcessor.php (`adjustAlbumPhotoCount`, imports)
```

It ends with "Links are between files, not hunks: a purely mechanical hunk in
a linked file can still go to its own skim group." That sentence was added
after v3 (see below).

### Repository context in the app

`Core::grouping_context` reads the head contents of changed text files from
the worktree (≤ 512 KB each, ≤ 24 MB total, no binary/generated/LFS files, no
`..` paths). It also calls `GitPort::co_change_commits(worktree, base, paths,
1000, 12)`, which runs `git log --no-merges --name-only` from the PR base.
The `Grouper` gets both as a `RepoContext`. The eval fixtures carry only
diffs, so **none of the agent runs below used head files or co-change**. Those
two signals are unit-tested only.

## Runs

| label | code |
| --- | --- |
| claude-default, claude-default-2 | before (directory chunking), two runs to show run-to-run variance |
| graph-v1 | graph, chunks packed first-fit |
| graph-v2 | + file-name mention edges, chunks packed by affinity |
| graph-v3 | + stricter "new name" rule (compound, never seen before) |
| graph-v4 | + hint sentence about mechanical hunks (final); big set only |

Cost is not comparable across runs. The CLI's prompt cache made repeated
prompts cheap (vkclone-3 cost $0.22 in v2 and v3 against $0.67 cold). Agent
calls are the honest cost measure.

### Large PRs (3: migratro-77, kdb-83, vkclone-3)

| run | valid 1st try | agent calls | Other hunks | groups | in target | groups ≤2 hunks | docs/config-only groups | files split over groups | wall (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-default | 3/3 | 10 | 0 | 37 | 3/3 | 0 | 3 | 17 | 243 |
| claude-default-2 | 3/3 | 10 | 0 | 33 | 3/3 | 0 | 2 | 17 | 270 |
| graph-v1 | 3/3 | 10 | 0 | 37 | 3/3 | 2 | 0 | 9 | 214 |
| graph-v2 | 3/3 | 10 | 0 | 38 | 2/3 | 3 | 1 | 11 | 209 |
| graph-v3 | 3/3 | 10 | 0 | 38 | 3/3 | 4 | 2 | 9 | 217 |
| **graph-v4** | 3/3 | 10 | 0 | 40 | 3/3 | 2 | 0 | 21 | 203 |

Agent calls per PR: kdb-83 3 → 4 (three chunks instead of one oversized
`Blank/` chunk plus the rest); migratro-77 4 → 3; vkclone-3 3 → 3. "in
target" counts visible groups within the size-scaled target range (8–15
here). v2 had 16 visible groups on kdb-83. "files split over groups" jumps
in v4 because vkclone-3 got its formatting skim group back (0 → 10 split
files, the same 10 as both baselines).

### Single-prompt PRs (real set, 10 OSS PRs)

No chunking happens here, so only the hint and coarsening can matter.

| run | valid 1st try | agent calls | Other hunks | groups | in target | groups ≤2 hunks | docs/config-only groups | wall (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-default | 10/10 | 10 | 0 | 48 | 10/10 | 13 | 8 | 181 |
| graph-v1 | 10/10 | 10 | 0 | 46 | 10/10 | 12 | 9 | 172 |
| graph-v2 | 10/10 | 10 | 0 | 47 | 10/10 | 11 | 10 | 166 |
| graph-v3 | 10/10 | 10 | 0 | 45 | 10/10 | 10 | 8 | 179 |

The group count differs by 0–1 per PR, which is noise. v4 was not run on this
set; its only change from v3 is one sentence in the hint.

## Offline check: graph communities against Claude's groups

`theodore eval <set> --graph-only --compare <run dir>` builds the graph and the
chunks with no agent call. It scores partitions against a saved grouping
(here `claude-default`) by pairwise "same group" precision/recall over hunks.
"x" counts only pairs in different files: a file-level partition keeps a
file's hunks together for free. "dir" is the old rule, one block per
top-level directory. Pooled over all pairs in each set:

| set | graph P / R | graph xP / xR | dir P / R | dir xP / xR |
| --- | --- | --- | --- | --- |
| big (3) | 27% / 77% | 21% / 71% | 18% / 96% | 15% / 94% |
| real (10) | 44% / 92% | 26% / 81% | 18% / 98% | 8% / 96% |
| small (3) | 21% / 64% | 22% / 64% | 18% / 82% | 19% / 82% |

When the graph says two hunks in different files belong together, Claude
agrees 1.4× (big) to 3× (real) as often as it does for "same top-level
directory". The graph's recall is lower: Claude also groups files that share
no visible signal. That gap is why communities only pick chunk boundaries and
the agent still decides the groups.

Chunk recall (Claude-default same-group pairs kept in one prompt by the new
chunking): kdb-83 73%, migratro-77 76%, vkclone-3 100%. This is biased
against the graph: those reference groups were made under directory
chunking, so they can never span directory chunks.

## What the groupings look like

**kdb-83** (Swift client + C++ engine + codegen):

- The Swift TL runtime exists twice: the codegen template
  (`tools/codegen/swift/runtime/…`) and the copy vendored into the app
  (`Blank/…/Runtime/…`), with identical edits. Both baseline runs put the
  two copies in different chunks and reviewed them twice ("Swift runtime:
  use loadUnaligned" and again "Swift RPC runtime: unaligned loads, …"). All
  four graph runs pair each file with its copy: "Swift RPC runtime: unaligned
  loads + close handler/timeout (Reader, Aes, Connection × 2)".
- The generated Swift client (`Client.swift`, `Constants.swift`,
  `Types.swift`) links to the C++ bindings through the shared protocol
  constants (`TL_API_*`); v1–v3 grouped it with the schema, v4 hid it as
  generated, as the baselines did.
- v1 and v2 had a small leftovers group ("API shard/scatter codegen target,
  api docs redirect, AES test signature update"): files with no links were
  packed into whatever chunk had room. File-name links (`tl-pipeline.cmake`
  names the sharding sources) and affinity packing pulled those files back
  next to their peers. In v4 `regen-clients.sh` and the Xcode entitlement
  still ride along with a Swift runtime group.

**migratro-77** (auth ↔ core registry sync, 77 files):

- Baseline: separate "Config, CI and Docker wiring …" and "Wire
  CORE_TO_AUTH_SYNC_SECRET … into scripts and ops docs" groups (both runs),
  plus a docs/spec/changelog group.
- graph-v4: `.env.*`, `ci.yml`, `ci-local.sh` and `dev-all.sh` sit in
  "Registry→auth client sync: app_client table, sync secret and config
  wiring". `Dockerfile.unified`, `.env.example`, `config-catalog.md` and
  `production-image.md` sit in "Shell login tagline from VITE_PRODUCT_TAGLINE".
  Specs ride with their features: `19-tenancy-and-accounts.md` with the
  canInvite gate, `04-identity-and-tokens.md` with hop narrowing. The env keys
  are the links (`CORE_TO_AUTH_SYNC_SECRET`, `VITE_PRODUCT_TAGLINE` defined in
  `.env.example`, read in `config.ts`).
- Weak spot: v1 produced one mixed group ("Org admin requires persona
  canInvite; shell tagline from env"). Later runs didn't repeat it.

**vkclone-3** (33 entry files switched to `al_dispatch()`):

- All runs, before and after, keep the 33 `al_dispatch` edits in one group.
  The graph now forces it: those files' whole change is the same edit, so
  they are one unit, together with `al.lib.php` (a hub that rejoins them).
  This holds even though each entry file also imports its own controller.
- Regression found and fixed: in v1–v3 the separate "Formatting: array() →
  [], aligned keys" skim group vanished. The old hint said "keep linked hunks
  in one group", and the formatting hunks sit in linked controller files. The
  v4 hint sentence brought it back ("Formatting: array syntax and alignment",
  26 hunks). That is one run, so treat it as likely, not proven.

## What didn't work, and limits

- **Raw symbol links glued everything on kdb-83.** The first build counted
  every defined name: `extension Color` in 15 views, `State`, `HONK` in a
  comment. That gave 2 943 edges, 63 hubs out of 114 files, and one SwiftUI
  blob. Fixed by: no definitions from comments, prose or function locals;
  `extension` doesn't define; plain names link at most 3 users; only compound
  names count as new rollouts.
- **Pure Louvain splits a rollout.** A 5-file same-edit clique lost to the
  import edges pairing each entry file with its controller (modularity really
  does prefer that). Hence the forced bundle for files whose whole change is
  one edit.
- **More chunks cost a call.** kdb-83 went from 2 chunks (one far over budget)
  to 3 within budget.
- **File-level, not hunk-level.** A file whose hunks belong to two features
  (an `.env` file with two features' keys, `main.ts` wiring several things)
  gets one community. The agent still splits it ("files split over groups"
  rose on migratro-77), but chunking can't.
- **Not measured end to end:** head-file imports and co-change history. The
  fixtures have no repository.
- **One run per variant**, and Claude varies run to run (the two baselines
  differ by 4 groups on the big set). Read the qualitative effects that repeat
  across v1–v4 (copies paired, config folded in, rollout intact) as solid. Read
  single-run effects as indicative.

## What's left

- One-line skeleton per file (exports, routes, calls) for large PRs: not built.
- Hunk-level nodes, so a file serving two features can be split before
  chunking.
- An eval set with repositories attached, to measure head-file imports and
  co-change.
- Incremental regroup (after a push) doesn't use the graph yet.

## Reproduce

```
cargo build -p theodore-cli --release
cd ~/.theodore-eval/cwd
theodore eval ~/.theodore-eval/sets/big  --save ~/.theodore-eval/runs/<label>/big
theodore eval ~/.theodore-eval/sets/real --save ~/.theodore-eval/runs/<label>/real
theodore eval ~/.theodore-eval/sets/big --graph-only --compare ~/.theodore-eval/runs/claude-default/big [--show]
python3 docs/eval/scripts/graph_compare.py ~/.theodore-eval/runs ~/.theodore-eval/sets big claude-default <label>
python3 docs/eval/scripts/metrics.py ~/.theodore-eval/runs ~/.theodore-eval/sets claude-default <label>
```
