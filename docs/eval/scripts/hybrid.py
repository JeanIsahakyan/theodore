#!/usr/bin/env python3
"""Hybrid grouping for the local-model eval (docs/eval/local-models.md).

Deterministic clustering decides membership; a small local LLM only writes
titles, "why" and the checklist, and orders the steps (`--mode name`, one
call per cluster plus one ordering call), or also merges clusters in a single
call (`--mode merge`). Output files have the same shape as `theodore eval --save`,
so docs/eval/scripts/metrics.py reads them unchanged.

usage: hybrid.py <fixtures-dir> <out-dir> --llm URL [--embed URL]

  --llm    OpenAI-compatible chat endpoint (llama-server), e.g. http://127.0.0.1:8091
  --embed  llama-server started with --embeddings --pooling last; without it,
           clustering uses paths and identical hunks only.

Clustering, in order:
  1. hidden files (lockfiles, generated, vendored, snapshots) -> one Hidden group,
     same rule as crates/grouping/src/prepass.rs
  2. union-find: hunks of one file; hunks whose changed lines are identical
     once the file's own name is masked out (one edit repeated across files);
     whitespace-only hunks form one formatting cluster
  3. agglomerative merge (average linkage over embedding cosine, small
     same-directory bonus, cluster size cap) down to the PR-size target
     (crates/grouping/src/target.rs)
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict

LOCKFILES = {
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "poetry.lock",
    "go.sum", "composer.lock", "gemfile.lock", "pipfile.lock", "pdm.lock", "bun.lockb",
    "uv.lock",
}
VENDORED = ["vendor/", "node_modules/", "third_party/", "thirdparty/", "pods/"]


def post(url, body, timeout=1800):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def hidden_reason(f):
    for flag in f["flags"]:
        if flag.get("kind") == "generated":
            return "generated"
    lower = f["path"].lower()
    base = lower.rsplit("/", 1)[-1]
    if base in LOCKFILES:
        return "lockfile"
    if any(d in lower for d in VENDORED):
        return "vendored"
    if "__snapshots__/" in lower or base.endswith(".snap") or base.endswith(".snapshot"):
        return "snapshot"
    return None


def target(hunks):
    for hi, t in [(8, (2, 4)), (20, (3, 6)), (45, (4, 8)), (90, (6, 12))]:
        if hunks <= hi:
            return t
    return (8, 15)


def dedupe_ids(files):
    seen = Counter()
    for f in files:
        for h in f["hunks"]:
            seen[h["id"]] += 1
            if seen[h["id"]] > 1:
                h["id"] = f'{h["id"]}-{seen[h["id"]]}'


def stem_tokens(path):
    stem = path.rsplit("/", 1)[-1].split(".")[0]
    parts = re.split(r"[_\-.]|(?<=[a-z])(?=[A-Z])", stem)
    return [p.lower() for p in parts if len(p) >= 3]


def signature(path, hunk):
    """Changed lines with the file's own name masked: equal across files that
    received the same mechanical edit (al_audio.php / AudioController)."""
    toks = stem_tokens(path)
    out = []
    for l in hunk["lines"]:
        if l["kind"] == "ctx" or not l["text"].strip():
            continue
        words = re.split(r"(\W+)", l["text"].strip())
        words = ["§" if any(t in w.lower() for t in toks) else w for w in words]
        out.append(l["kind"][0] + re.sub(r"\d+", "0", "".join(words)))
    text = "\n".join(out)
    return text if len(out) >= 2 and len(text) >= 30 else None


def whitespace_only(hunk):
    add = "".join(l["text"] for l in hunk["lines"] if l["kind"] == "add")
    dele = "".join(l["text"] for l in hunk["lines"] if l["kind"] == "del")
    return bool(add or dele) and re.sub(r"\s+", "", add) == re.sub(r"\s+", "", dele)


class UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def hunk_text(path, h, max_lines=30):
    lines = [
        ("+" if l["kind"] == "add" else "-") + l["text"]
        for l in h["lines"]
        if l["kind"] != "ctx"
    ]
    return f"{path}\n{h['header']}\n" + "\n".join(lines[:max_lines])


def norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def embed(url, texts):
    out = []
    for i in range(0, len(texts), 32):
        r = post(f"{url}/v1/embeddings", {"input": [t[:6000] for t in texts[i:i + 32]]})
        out.extend(norm(d["embedding"]) for d in sorted(r["data"], key=lambda d: d["index"]))
    return out


def top_dir(path):
    return path.split("/", 1)[0] if "/" in path else ""


def parent_dir(path):
    return path.rsplit("/", 1)[0] if "/" in path else ""


def cluster(visible, embeddings, goal):
    """visible: [(path, hunk)]. Returns a list of clusters (lists of indices)."""
    uf = UF(len(visible))
    by_file = {}
    by_sig = {}
    formatting = None
    for i, (path, h) in enumerate(visible):
        if whitespace_only(h):
            # Formatting hunks form their own cluster instead of joining
            # their file's real change.
            if formatting is not None:
                uf.union(i, formatting)
            formatting = i if formatting is None else formatting
            continue
        if path in by_file:
            uf.union(i, by_file[path])
        by_file.setdefault(path, i)
        sig = signature(path, h)
        if sig:
            if sig in by_sig:
                uf.union(i, by_sig[sig])
            by_sig.setdefault(sig, i)
    groups = defaultdict(list)
    for i in range(len(visible)):
        groups[uf.find(i)].append(i)
    clusters = list(groups.values())
    if embeddings is None:
        # Path-only fallback: merge by parent dir, then top-level dir.
        for key in (parent_dir, top_dir):
            if len(clusters) <= goal:
                break
            merged = defaultdict(list)
            for c in clusters:
                merged[key(visible[c[0]][0])].extend(c)
            clusters = list(merged.values())
        return clusters

    def centroid(c):
        s = [0.0] * len(embeddings[0])
        for i in c:
            for k, x in enumerate(embeddings[i]):
                s[k] += x
        return norm(s)

    # Average linkage (Lance-Williams update) over centroid cosine plus a
    # small same-directory bonus.
    cents = [centroid(c) for c in clusters]
    n = len(clusters)
    sim = [[0.0] * n for _ in range(n)]
    for a in range(n):
        for b in range(a + 1, n):
            s = sum(x * y for x, y in zip(cents[a], cents[b]))
            pa, pb = visible[clusters[a][0]][0], visible[clusters[b][0]][0]
            s += 0.05 * (top_dir(pa) == top_dir(pb)) + 0.05 * (parent_dir(pa) == parent_dir(pb))
            sim[a][b] = sim[b][a] = s
    alive = set(range(n))
    # Size cap: code embeddings of one language are all fairly similar, so
    # without it one blob absorbs most of a large PR.
    cap = max(max(map(len, clusters)), math.ceil(2.5 * len(visible) / goal))
    while len(alive) > goal:
        pairs = [
            (sim[a][b] - 0.03 * math.log2(len(clusters[a]) + len(clusters[b])), a, b)
            for a in alive
            for b in alive
            if a < b
        ]
        allowed = [p for p in pairs if len(clusters[p[1]]) + len(clusters[p[2]]) <= cap]
        _, a, b = max(allowed or pairs)
        na, nb = len(clusters[a]), len(clusters[b])
        for k in alive:
            if k not in (a, b):
                sim[a][k] = sim[k][a] = (na * sim[a][k] + nb * sim[b][k]) / (na + nb)
        clusters[a] = clusters[a] + clusters[b]
        alive.discard(b)
    return [clusters[k] for k in sorted(alive)]


SYSTEM = """You are reviewing a pull request whose changed hunks were already \
clustered by similarity. Turn the clusters into about {lo}-{hi} review groups, \
each one logical step a reviewer approves as a unit. Merge clusters only when \
they are the same logical change; never split one. Config, env, CI and docs \
edits that support one change belong with that change.

Order groups in reading order: foundations first (schema, models, types), then \
the code that uses them, then tests, then anything mechanical last.

For each group give: id (kebab-case, unique), title (short), why (1-3 sentences: \
what changed and why), kind ("normal", or "skim" for mechanical changes: pure \
renames, formatting, import-only, the same edit repeated across many files), \
risk (one sentence on what could go wrong, or empty), check (short, concrete \
things a reviewer should verify), clusters (cluster ids). Every cluster id must \
appear in exactly one group."""


def cluster_block(cid, c, visible, budget, samples=3):
    files = Counter(visible[i][0] for i in c)
    out = [f"## cluster {cid} ({len(c)} hunks)"]
    out.append("files: " + ", ".join(f"{p} ({n})" for p, n in files.most_common(12)))
    if len(files) > 12:
        out.append(f"... and {len(files) - 12} more files")
    # Samples from different files, spread across the cluster.
    picks, seen = [], set()
    for i in c:
        if visible[i][0] not in seen:
            seen.add(visible[i][0])
            picks.append(i)
    step = max(1, len(picks) // samples)
    for i in picks[::step][:samples]:
        path, h = visible[i]
        out.append(f"### {path} — {h['header']}")
        out.append(hunk_text(path, h, 6 if samples <= 3 else 12).split("\n", 2)[-1][:budget])
    return "\n".join(out)


def schema(cluster_ids, min_groups):
    """Bounded so a looping model can't run away: at least `min_groups`
    groups, at most one per cluster, and no group can swallow so many
    clusters that the minimum becomes unreachable."""
    s = lambda n: {"type": "string", "maxLength": n}
    n = len(cluster_ids)
    # Plain dicts keep insertion order: title and why come before clusters.
    return {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "minItems": min_groups,
                "maxItems": n,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": s(60),
                        "title": s(100),
                        "why": s(400),
                        "kind": {"type": "string", "enum": ["normal", "skim"]},
                        "risk": s(300),
                        "check": {"type": "array", "maxItems": 5, "items": s(200)},
                        "clusters": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": max(1, n - min_groups + 1),
                            "items": {"type": "string", "enum": cluster_ids},
                        },
                    },
                    "required": ["id", "title", "why", "kind", "risk", "check", "clusters"],
                },
            }
        },
        "required": ["groups"],
    }


def pr_meta(pr):
    out = [f"# PR\nTitle: {pr.get('title', '')}"]
    if pr.get("body"):
        out.append("Body:\n" + pr["body"][:3000])
    if pr.get("commits"):
        out.append("Commits:\n" + "\n".join(f"- {c}" for c in pr["commits"][:30]))
    return "\n".join(out)


def chat(llm, model, system, user, schema_, max_tokens):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
        "seed": 42,
        "max_tokens": max_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "answer", "strict": True, "schema": schema_},
        },
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = post(f"{llm}/v1/chat/completions", body)
    usage = (resp["usage"]["prompt_tokens"], resp["usage"]["completion_tokens"])
    return json.loads(resp["choices"][0]["message"]["content"]), usage


NAME_SYSTEM = """You are reviewing one step of a pull request. The hunks below \
were grouped together because they are similar; describe them as one review \
step. Give: title (short, specific to these hunks), why (1-3 sentences: what \
changed and why), kind ("skim" for mechanical changes: pure renames, \
formatting, import-only, one edit repeated across many files; otherwise \
"normal"), risk (one sentence on what could go wrong, or empty), check \
(short, concrete things a reviewer should verify in THESE hunks)."""

ORDER_SYSTEM = """Order these review steps of one pull request for reading: \
foundations first (schema, models, types), then the code that uses them, then \
tests, then docs, config and anything mechanical last. List every step id \
exactly once."""


def name_schema():
    s = lambda n: {"type": "string", "maxLength": n}
    return {
        "type": "object",
        "properties": {
            "title": s(100),
            "why": s(400),
            "kind": {"type": "string", "enum": ["normal", "skim"]},
            "risk": s(300),
            "check": {"type": "array", "maxItems": 4, "items": s(200)},
        },
        "required": ["title", "why", "kind", "risk", "check"],
    }


def name_clusters(llm, model, pr_block, clusters, cids, visible):
    """One naming call per cluster (the model never has to bind ids to
    content), then one ordering call over the titles."""
    from concurrent.futures import ThreadPoolExecutor

    def one(k):
        user = pr_block + "\n\n" + cluster_block(cids[k], clusters[k], visible, 1200, samples=6)
        try:
            return chat(llm, model, NAME_SYSTEM, user, name_schema(), 1200)
        except Exception as e:  # noqa: BLE001 - fall back to a path title
            print(f"  name call failed: {e}", file=sys.stderr)
            return None, (0, 0)

    with ThreadPoolExecutor(3) as pool:
        named = list(pool.map(one, range(len(clusters))))
    usage = {"input_tokens": 0, "output_tokens": 0, "usd": 0.0}
    groups = {}
    for k, (answer, (i, o)) in enumerate(named):
        usage["input_tokens"] += i
        usage["output_tokens"] += o
        members = clusters[k]
        answer = answer or {
            "title": f"Changes in {common_path([visible[j][0] for j in members])}",
            "why": "", "kind": "normal", "risk": "", "check": [],
        }
        groups[cids[k]] = {
            "id": f"{cids[k]}-{slug(answer['title'])[:40]}",
            "title": answer["title"], "why": answer["why"], "kind": answer["kind"],
            "risk": answer["risk"] or None, "check": answer["check"],
            "hunks": [visible[j][1]["id"] for j in members], "outliers": [],
        }
    order = cids
    if len(cids) > 1:
        listing = "\n".join(
            f"- {c}: {g['title']} ({len(g['hunks'])} hunks; files: "
            + ", ".join(sorted({visible[j][0].rsplit('/', 1)[-1] for j in clusters[cids.index(c)]})[:5])
            + ")"
            for c, g in groups.items()
        )
        sch = {
            "type": "object",
            "properties": {
                "order": {
                    "type": "array",
                    "minItems": len(cids),
                    "maxItems": len(cids),
                    "items": {"type": "string", "enum": cids},
                }
            },
            "required": ["order"],
        }
        try:
            answer, (i, o) = chat(llm, model, ORDER_SYSTEM, pr_block + "\n\n" + listing, sch, 600)
            usage["input_tokens"] += i
            usage["output_tokens"] += o
            seen = []
            for c in answer["order"] + cids:
                if c not in seen:
                    seen.append(c)
            order = seen
        except Exception as e:  # noqa: BLE001 - keep cluster order
            print(f"  order call failed: {e}", file=sys.stderr)
    return [groups[c] for c in order], usage


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "group"


def common_path(paths):
    parts = [p.split("/") for p in paths]
    prefix = []
    for seg in zip(*parts):
        if len(set(seg)) != 1:
            break
        prefix.append(seg[0])
    return "/".join(prefix) or "repository root"


def run(fx, llm, embed_url, model, mode):
    start = time.time()
    files = fx["revision"]["files"]
    dedupe_ids(files)
    hidden = {f["path"]: hidden_reason(f) for f in files if hidden_reason(f)}
    groups = []
    hidden_hunks = [h["id"] for f in files if f["path"] in hidden for h in f["hunks"]]
    if hidden_hunks:
        reasons = ", ".join(sorted(set(hidden.values())))
        groups.append({
            "id": "hidden", "title": "Lockfiles, generated and vendored files",
            "why": f"Not reviewed in detail: {reasons}.", "kind": "hidden", "risk": None,
            "check": [], "hunks": hidden_hunks, "outliers": [],
        })
    visible = [(f["path"], h) for f in files if f["path"] not in hidden for h in f["hunks"]]
    usage = {"input_tokens": 0, "output_tokens": 0, "usd": 0.0}
    if not visible:
        return groups, usage, 0, 0, time.time() - start
    lo, hi = target(len(visible))
    embeddings = embed(embed_url, [hunk_text(p, h) for p, h in visible]) if embed_url else None
    clusters = cluster(visible, embeddings, hi)
    clusters.sort(key=lambda c: min(c))
    cids = [f"c{k + 1}" for k in range(len(clusters))]

    pr_block = pr_meta(fx.get("pr", {}))
    if mode == "name":
        named, usage = name_clusters(llm, model, pr_block, clusters, cids, visible)
        groups.extend(named)
        return groups, usage, len(clusters), 0, time.time() - start
    user = [pr_block]
    if hidden:
        user.append("\n# Not shown (collapsed into a hidden group, already handled)")
        user.extend(f"- {p} ({r})" for p, r in hidden.items())
    user.append(f"\n# Clusters ({len(clusters)})")
    per = max(200, 30000 // max(1, len(clusters)) // 3)
    user.extend(cluster_block(cid, c, visible, per) for cid, c in zip(cids, clusters))
    lo, hi = min(lo, len(clusters)), min(hi, len(clusters))
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM.format(lo=lo, hi=hi)},
            {"role": "user", "content": "\n\n".join(user)},
        ],
        "temperature": 0.2,
        "seed": 42,
        "max_tokens": 6000,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "answer", "strict": True, "schema": schema(cids, lo)},
        },
        "chat_template_kwargs": {"enable_thinking": False},
    }
    try:
        resp = post(f"{llm}/v1/chat/completions", body)
        usage["input_tokens"] = resp["usage"]["prompt_tokens"]
        usage["output_tokens"] = resp["usage"]["completion_tokens"]
        answer = json.loads(resp["choices"][0]["message"]["content"])["groups"]
    except Exception as e:  # noqa: BLE001 - any failure falls back below
        print(f"  llm call failed: {e}", file=sys.stderr)
        answer = []

    assigned = set()
    used_ids = {"hidden"}
    for g in answer:
        mine = [c for c in g.get("clusters", []) if c in cids and c not in assigned]
        if not mine:
            continue
        assigned.update(mine)
        gid = slug(g.get("id") or g.get("title", ""))
        while gid in used_ids:
            gid += "-x"
        used_ids.add(gid)
        hunks = [visible[i][1]["id"] for c in mine for i in clusters[cids.index(c)]]
        groups.append({
            "id": gid, "title": g.get("title", ""), "why": g.get("why", ""),
            "kind": g.get("kind", "normal"), "risk": g.get("risk") or None,
            "check": g.get("check", []), "hunks": hunks, "outliers": [],
        })
    fallback = [c for c in cids if c not in assigned]
    for c in fallback:
        members = clusters[cids.index(c)]
        where = common_path([visible[i][0] for i in members])
        groups.append({
            "id": f"cluster-{c}", "title": f"Changes in {where}", "why": "",
            "kind": "normal", "risk": None, "check": [],
            "hunks": [visible[i][1]["id"] for i in members], "outliers": [],
        })
    return groups, usage, len(clusters), len(fallback), time.time() - start


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fixtures_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--llm", required=True)
    ap.add_argument("--embed")
    ap.add_argument("--model", default="local")
    ap.add_argument(
        "--mode",
        choices=["name", "merge"],
        default="name",
        help="name: one LLM call per cluster + one ordering call; "
        "merge: one call that names, merges and orders all clusters",
    )
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)
    print(f"{'fixture':<22} {'clusters':>8} {'fallback':>8} {'groups':>6} {'secs':>6}")
    for name in sorted(os.listdir(a.fixtures_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(a.fixtures_dir, name)) as f:
            fx = json.load(f)
        groups, usage, n_clusters, n_fallback, secs = run(fx, a.llm, a.embed, a.model, a.mode)
        all_ids = [h["id"] for f in fx["revision"]["files"] for h in f["hunks"]]
        got = [h for g in groups for h in g["hunks"]]
        valid = sorted(got) == sorted(all_ids) and len(set(got)) == len(got)
        report = {
            "fixture": name[:-5], "chunks": 1, "attempts": 1,
            "valid_first_try": valid and n_fallback == 0, "valid_after_repair": valid,
            "duration_ms": int(secs * 1000), "usage": usage,
            "clusters": n_clusters, "fallback_clusters": n_fallback,
            "grouping": {"rev": fx["revision"]["head"], "groups": groups},
        }
        with open(os.path.join(a.out_dir, name), "w") as f:
            json.dump(report, f, indent=2)
        print(f"{name[:-5]:<22} {n_clusters:>8} {n_fallback:>8} {len(groups):>6} {secs:>6.1f}")


if __name__ == "__main__":
    main()
