# Small local models for diff grouping

**Verdict: not good enough.** No model ≤ 2 GB comes close to Claude on Theodore's
grouping, and every one breaks down on large PRs. The best local setup is a
hybrid: deterministic clustering plus Qwen3.5-2B as the namer. It is always a
valid partition and runs about 20 s on a 300-hunk PR, but it scores about 2.5/5
against Claude's 5. It could serve as an offline draft. It can't replace the
agent.

Run on an M5 Max with 36 GB, llama.cpp `b11780` (Metal), all models Q4_K_M
(the embedder is Q8_0). Dates: 2026-10-20 and 2026-10-21.

## What was run

```
plain   fixture ─▶ theodore eval --endpoint ─▶ same prompts / chunking / validate
                                               / 1 repair / Other fallback / coarsen
                   llama-server  /v1/chat/completions + JSON-schema response_format

hybrid  fixture ─▶ hidden files ─▶ union-find (same file, same edit with the
                                   file name masked, whitespace-only)
                ─▶ Qwen3-Embedding-0.6B ─▶ average-linkage merge to target count
                ─▶ small LLM: 1 call per cluster (title/why/kind/risk/check)
                              + 1 ordering call
```

- **Fixtures (16).** 3 large real PRs: migratro-77 (161 visible hunks), kdb-83
  (292), vkclone-3 (187, with 33 identical `al_dispatch` entry-file edits).
  Also 3 synthetic ones (`apps/cli/fixtures/`) and 10 real OSS PRs
  (`apps/cli/fixtures/real/`).
- **Context.** `llama-server -c 98304 -np 3` gives 32k tokens per slot,
  matching chunk concurrency 3. The default chunk budget is 48 000 chars
  (about 12–16k tokens). `max_tokens` is 8192 per call.
- **Schema.** Properties come in prompt order (`id, title, why, kind, risk,
  check, hunks, outliers`), with `maxLength` caps on strings. `--constrain-ids`
  limits `hunks`/`outliers` items to an enum of the prompt's hunk ids. The
  plain runs used it unless labelled `-free`.
- **Thinking.** Every request sends `chat_template_kwargs.enable_thinking=false`.
  No thinking loops were seen with Qwen3, Qwen3.5 or SmolLM3. Runaways did
  happen, but as JSON repetition (below).
- **Claude baseline.** Each fixture ran once with the CLI default model and
  once with `--model haiku`. Spend was $4.72 (default) and $1.93 (haiku).

## Metrics

Small and real sets, 13 fixtures. "Valid after repair" is always 13/13 because
the "Other" fallback makes any answer valid. The real signal is the first-try
column and how many fixtures needed Other.

| run | valid 1st try | Other fallback used | repair calls | groups | groups ≤2 hunks | wall (s) | quality |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude default | 13/13 | 0 | 0 | 62 | 23 | 228 | 5 |
| Claude haiku | 11/13 | 0 | 2 | 72 | 27 | 764 | 4 |
| Qwen3.5-2B | 2/13 | 9 | 11 | 52 | 27 | 490 | 2 |
| Qwen3.5-2B, no id enum | 2/13 | 10 | 11 | 60 | 33 | 343 | 2 |
| Qwen2.5-Coder-3B | 5/13 | 5 | 8 | 32 | 12 | 694 | 1.5 |
| Qwen2.5-Coder-3B, no id enum | 5/13 | 5 | 8 | 30 | 11 | 837 | 1.5 |
| Qwen2.5-Coder-1.5B | 4/13 | 7 | 9 | 26 | 7 | 484 | 1.5 |
| Qwen2.5-Coder-1.5B, no id enum | 1/13 | 9 | 12 | 20 | 1 | 347 | 1 |
| LFM2.5-1.2B | 0/13 | 12 | 13 | 47 | 30 | 70 | 1 |
| Qwen3-1.7B | 0/13 | 11 | 13 | 38 | 13 | 331 | 1.5 |
| SmolLM3-3B | 2/13 | 9 | 11 | 25 | 4 | 1178 | 1 |
| Llama-3.2-3B | 2/13 | 9 | 11 | 44 | 15 | 665 | 1.5 |
| **hybrid + Qwen3.5-2B** | 13/13 | 0 | 0 | 80 | 51 | 65 | **2.5** |
| hybrid + Qwen2.5-Coder-3B | 13/13 | 0 | 0 | 80 | 51 | 69 | 2 |
| hybrid + LFM2.5-1.2B | 13/13 | 0 | 0 | 80 | 51 | 38 | 2 |
| hybrid, no embeddings, + Qwen3.5-2B | 13/13 | 0 | 0 | 66 | 35 | 66 | 2 |
| hybrid, LLM also merges, + Qwen3.5-2B | 7/13¹ | 0 | 0 | 55 | 26 | 81 | 1.5 |

¹ For the hybrid runs, "1st try" means the LLM placed every cluster. Any
cluster it left out gets a path title ("Changes in `<dir>`").

Large PRs:

| run | fixture | 1st try | repairs | hunks in Other | groups | ≤2 hunks | wall (s) | `al_dispatch` (33) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Claude default | migratro-77 | yes | 0 | 0 | 14 | 0 | 65 | |
| Claude haiku | migratro-77 | no | 2 | 0 | 19 | 1 | 249 | |
| Qwen3.5-2B | migratro-77 | no | 4 | 125 | 8 | 5 | 215 | |
| Qwen2.5-Coder-3B | migratro-77 | no | 3 | 125 | 5 | 0 | 276 | |
| Qwen2.5-Coder-1.5B | migratro-77 | no | 3 | 125 | 5 | 1 | 221 | |
| LFM2.5-1.2B | migratro-77 | no | 4 | 3 | 10 | 7 | 10 | |
| Qwen3-1.7B | migratro-77 | no | 4 | 2 | 5 | 1 | 51 | |
| SmolLM3-3B | migratro-77 | no | 4 | 125 | 4 | 0 | 384 | |
| Llama-3.2-3B | migratro-77 | no | 4 | 98 | 21 | 5 | 169 | |
| hybrid + Qwen3.5-2B | migratro-77 | yes | 0 | 0 | 16 | 3 | 18 | |
| Claude default | kdb-83 | yes | 0 | 0 | 14 | 0 | 83 | |
| Claude haiku | kdb-83 | no | 1 | 0 | 13 | 0 | 325 | |
| Qwen3.5-2B | kdb-83 | no | 3 | 202 | 2 | 0 | 319 | |
| Qwen2.5-Coder-3B | kdb-83 | no | 3 | 202 | 3 | 0 | 432 | |
| Qwen2.5-Coder-1.5B | kdb-83 | no | 3 | 202 | 2 | 0 | 286 | |
| LFM2.5-1.2B | kdb-83 | no | 3 | 89 | 7 | 5 | 18 | |
| Qwen3-1.7B | kdb-83 | no | 3 | 200 | 3 | 1 | 255 | |
| SmolLM3-3B | kdb-83 | no | 3 | 202 | 2 | 0 | 538 | |
| Llama-3.2-3B | kdb-83 | no | 3 | 200 | 6 | 1 | 160 | |
| hybrid + Qwen3.5-2B | kdb-83 | yes | 0 | 0 | 15 | 5 | 21 | |
| Claude default | vkclone-3 | yes | 0 | 0 | 9 | 0 | 96 | 33 in 1 group |
| Claude haiku | vkclone-3 | yes | 0 | 0 | 12 | 0 | 178 | 33 in 1 |
| Qwen3.5-2B | vkclone-3 | no | 1 | 154 | 2 | 0 | 163 | 33 in 1 (rest in Other) |
| Qwen2.5-Coder-3B | vkclone-3 | no | 2 | 154 | 2 | 0 | 277 | 33 in 1 (rest in Other) |
| Qwen2.5-Coder-1.5B | vkclone-3 | no | 3 | 1 | 3 | 1 | 55 | 32 + 1 |
| LFM2.5-1.2B | vkclone-3 | no | 3 | 28 | 12 | 9 | 12 | 28 in Other + 5 |
| Qwen3-1.7B | vkclone-3 | no | 3 | 5 | 4 | 1 | 260 | 28 + 5 |
| SmolLM3-3B | vkclone-3 | no | 2 | 154 | 2 | 0 | 278 | 33 in 1 (rest in Other) |
| Llama-3.2-3B | vkclone-3 | no | 3 | 14 | 15 | 12 | 347 | spread over 14 |
| hybrid + Qwen3.5-2B | vkclone-3 | yes | 0 | 0 | 15 | 2 | 18 | 31 + 2² |

² `away.php` and `badbrowser.php` change a different code shape than the other
31 files, so the hunk-signature rule doesn't join them.

A smaller chunk budget (`--max-chars 16000`) doesn't help. The chunker splits
by top-level directory, and the biggest chunk is one directory on its own
(vkclone-3 `lib/`, 154 hunks). That chunk stays exactly as large:

| run (16k budget) | migratro-77 Other / groups | kdb-83 Other / groups | vkclone-3 Other / groups |
| --- | --- | --- | --- |
| Qwen3.5-2B | 125 / 7 | 202 / 20 | 154 / 2 |
| Qwen2.5-Coder-3B | 125 / 4 | 202 / 6 | 154 / 2 |
| Qwen2.5-Coder-1.5B | 125 / 6 | 202 / 3 | 1 / 3 |
| LFM2.5-1.2B | 3 / 6 | 200 / 5 | 28 / 12 |

## Why plain grouping fails

| failure | seen in | example |
| --- | --- | --- |
| Hunks left out | all models; the dominant validation error | Qwen3.5-2B free schema: 209 "in no group" vs 106 "unknown id" |
| JSON repetition loop until `max_tokens` | Qwen2.5-Coder-3B, -1.5B, Qwen3.5-2B, SmolLM3 on large chunks | Coder-3B wrote one hunk id 611 times in one array; kdb-83 runs hit 4 × 8192 tokens |
| Schema placeholder copied into the output | LFM2.5, Coder-1.5B | group id `"kebab-case-slug, unique"` on every group; title `"short title"` |
| One repair call rarely fixes it | everyone | only 1–3 of the 8–13 fixtures that needed a repair avoided Other; the second answer omits ids just like the first |

The id enum (`--constrain-ids`) only removes invented ids. That doesn't help
Qwen3.5-2B or Coder-3B, and gives Coder-1.5B a small lift (4/13 vs 1/13).
Omission is the real failure, and a grammar can't express "every id exactly
once".

## Per-model verdict

The quality score is 1–5, assigned by reading each grouping next to Claude's.

- **Claude default (5).** Logical steps, accurate titles and checks. Same
  quality as the M1 eval.
- **Claude haiku (4).** Valid everywhere, but 4/16 fixtures needed a repair
  call. Sensible but more
  fragmented (migratro-77 gives 19 groups vs 14, tokio gives 11 vs 7). Costs
  2.4× less but takes 3.2× longer (1517 s vs 471 s for all 16).
- **Qwen3.5-2B (2).** The best plain local model. On small PRs, titles and
  "why" are mostly on topic, but 9/13 fixtures needed Other.
  - next#88225: "why" says the fix uses "the actual source file path". It uses
    the source *index*.
  - kdb-83: 202 of 292 hunks land in Other, in 2 groups total.
- **Qwen2.5-Coder-3B (1.5).** Swings between one blob group and Other.
  - ruff#18961: everything goes in one group ("Add configurable allowlist").
  - bun#39523: one "Other" group after 229 s of a repetition loop.
- **Qwen2.5-Coder-1.5B (1.5).**
  - ruff#18961 and bun#39523: one group titled `"short title"`.
  - pr482: a reasonable split, but "Add countUsage and record usage" also
    holds `errors.ts` and the email notifier.
- **LFM2.5-1.2B (1).** Very fast (70 s for 13 fixtures), and every grouping
  needed Other.
  - Every group gets the id `"kebab-case-slug, unique"`.
  - vkclone-3: groups named "documentation" and "environment setup", one hunk
    each, all inside `AudioController.php`.
- **Qwen3-1.7B (1.5).** 0/13 first try.
  - pr482: 10 of 13 hunks in Other.
  - bun#39523: the nasm/CI group is marked `skim`.
- **SmolLM3-3B (1).** The slowest, at 1178 s for 13 fixtures (200 s for pr482
  alone). Nearly everything goes to Other (ruff#18961: 16/16).
- **Llama-3.2-3B (1.5).** Generic titles ("Foundations", "HIR", "Render") and
  wrong kinds (`limit-reached.ts` marked `hidden`). On vkclone-3 the
  `al_dispatch` edits are spread over 14 groups.
- **Hybrid + Qwen3.5-2B (2.5).** Always valid, about 20 s on kdb-83, and
  titles for coherent clusters are specific and correct ("Fix TLReader
  alignment and AesMasterKey load to use unaligned loads", "Fix BlnkBurst
  random range bounds"). The weak points:
  - Membership follows files and embeddings, not intent. On small PRs that
    means one group per file: bun#39523 splits `bootstrap.sh`, `action.yml`
    and `ci.mjs`, which Claude keeps as one CI/tooling step.
  - Large mixed clusters get the PR title as their name.
  - The "why" is sometimes invented. kdb-83 says the `std::move` change is
    "for thread safety".
  - Ordering is weak. tokio#8587 opens with `mod.rs` and calls the core
    `async_fd.rs` API change "Update documentation".
- **Hybrid + Coder-3B / LFM2.5 (2).** Same membership; titles mostly repeat
  the PR title (pr482 has the same title on 4 of 6 groups).
- **Hybrid, LLM also merges (1.5).** Small models can't bind cluster ids to
  descriptions. On kdb-83, Qwen3.5-2B's "User Preferences & Settings" group
  holds the TL-runtime `loadUnaligned` hunks; the titles are shifted by one.
  Coder-3B merges kdb-83 into 2 groups.
- **Hybrid, no embeddings (2).** Path-only clusters are coarser (8 groups on
  kdb-83) and mix unrelated directories.

## Recommendation

Keep Claude as the grouping engine. If an offline or zero-cost mode is ever
wanted, the only viable shape is the hybrid with Qwen3.5-2B (1.28 GB) and
Qwen3-Embedding-0.6B (0.64 GB):
- The hybrid decides membership deterministically.
- The LLM only writes one cluster's text per call and orders steps.
- The result should be labelled a draft.

Before it would be worth shipping, it needs:
- Clustering by intent rather than by file. The obvious levers are
  cross-file merging of related config/CI, and a lower group target for
  small PRs.
- A check that the "why" text is grounded in the hunks.

Haiku isn't a worthwhile trade either. It costs 2.4× less but is 3× slower,
more fragmented, and needed a repair on 4/16 fixtures.

## Cost

| item | disk | peak RSS during the run |
| --- | ---: | ---: |
| llama.cpp b11780 macOS arm64 | 55 MB (+17 MB tarball) | — |
| Qwen3.5-2B | 1.28 GB | 4.6 GB plain (3 × 32k ctx); 2.5–2.9 GB hybrid |
| Qwen2.5-Coder-3B | 2.10 GB | 7.3 GB |
| Qwen2.5-Coder-1.5B | 1.12 GB | 8.0 GB |
| LFM2.5-1.2B | 0.73 GB | 4.4 GB |
| Qwen3-1.7B | 1.11 GB | 15.5 GB |
| SmolLM3-3B | 1.92 GB | 12.6 GB |
| Llama-3.2-3B | 2.02 GB | 15.5 GB |
| Qwen3-Embedding-0.6B (Q8_0) | 0.64 GB | 4.3 GB (`-np 4 -ub 8192`) |

About 10 GB of models in total. RSS is unified memory (Metal), so there is no
separate VRAM figure. It is mostly the KV cache for 3 × 32k slots, and it
scales with `-c`.

Wall time for all 16 fixtures:
- Plain local runs: 2 min (LFM2.5) to 40 min (SmolLM3).
- Qwen3.5-2B: 20 min plain, 2.3 min hybrid.
- Claude: 8 min (default), 25 min (haiku).

## Not run / limits

- **Gemma 4 E2B: skipped.** Its smallest Q4_K_M GGUF is 3.1 GB, over the
  2 GB budget.
- **One run per configuration**, Claude included, so there is no variance
  estimate. Local runs used temperature 0.2 and seed 42, but runs with 3
  parallel slots aren't bit-reproducible.
- **Partial coverage for two variants.** The free schema ran on small + real
  for 3 models only. The 16k budget ran on the large PRs for 4 models only.
- **The quality score is my reading**, not a blind or multi-rater score. I
  read every large-PR grouping and about a third of the small ones per model.

## Reproduce

The harness is `theodore eval --endpoint` (`apps/cli/src/endpoint.rs`).
Metrics come from `docs/eval/scripts/metrics.py`, and the hybrid is
`docs/eval/scripts/hybrid.py`. Nothing below writes inside the repo except
the build.

```sh
E=~/.theodore-eval; mkdir -p $E/tools $E/models $E/sets/{small,real,big} $E/runs
curl -L https://github.com/ggml-org/llama.cpp/releases/download/b11780/llama-b11780-bin-macos-arm64.tar.gz | tar xz -C $E/tools
HF=https://huggingface.co
curl -L -o $E/models/Qwen3.5-2B-Q4_K_M.gguf $HF/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf
curl -L -o $E/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf $HF/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf
curl -L -o $E/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf $HF/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
curl -L -o $E/models/LFM2.5-1.2B-Instruct-Q4_K_M.gguf $HF/unsloth/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf
curl -L -o $E/models/Qwen3-1.7B-Q4_K_M.gguf $HF/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf
curl -L -o $E/models/SmolLM3-Q4_K_M.gguf $HF/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q4_K_M.gguf
curl -L -o $E/models/Llama-3.2-3B-Instruct-Q4_K_M.gguf $HF/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf
curl -L -o $E/models/Qwen3-Embedding-0.6B-Q8_0.gguf $HF/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf

cp apps/cli/fixtures/*.json $E/sets/small/; cp apps/cli/fixtures/real/*.json $E/sets/real/
cp <large-pr-fixtures>/*.fixture.json $E/sets/big/     # migratro-77, kdb-83, vkclone-3
cargo build -p theodore-cli; T=$PWD/target/debug/theodore

# Claude baseline (costs about $4.7 default + $1.9 haiku)
for s in small real big; do
  $T eval $E/sets/$s --save $E/runs/claude-default/$s
  $T eval $E/sets/$s --model haiku --save $E/runs/claude-haiku/$s
done

# one plain local run (repeat per model; drop --constrain-ids for the -free rows,
# add --max-chars 16000 for the 16k-budget table)
$E/tools/llama-b11780/llama-server -m $E/models/Qwen3.5-2B-Q4_K_M.gguf \
  -c 98304 -np 3 -ngl 99 -fa on --jinja --port 8091 &
for s in small real big; do
  $T eval $E/sets/$s --endpoint http://127.0.0.1:8091 --model q35-2 --constrain-ids \
    --save $E/runs/q35-2-enum/$s
done

# hybrid (namer + embedder)
$E/tools/llama-b11780/llama-server -m $E/models/Qwen3.5-2B-Q4_K_M.gguf \
  -c 49152 -np 3 -ngl 99 -fa on --jinja --port 8091 &
$E/tools/llama-b11780/llama-server -m $E/models/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --embeddings --pooling last -c 32768 -np 4 -b 8192 -ub 8192 -ngl 99 --port 8093 &
for s in small real big; do
  python3 docs/eval/scripts/hybrid.py $E/sets/$s $E/runs/hybrid-q35-2/$s \
    --llm http://127.0.0.1:8091 --embed http://127.0.0.1:8093     # --mode merge, or drop --embed
done

python3 docs/eval/scripts/metrics.py $E/runs $E/sets
```

`theodore eval` exits non-zero below the §5.4 targets. That's expected for
every local run; the saved JSON is what counts.
