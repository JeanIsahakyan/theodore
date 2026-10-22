#!/usr/bin/env python3
"""Metrics over saved `theodore eval --save` runs (docs/eval/local-models.md).

usage: metrics.py <runs-dir> <fixtures-root> [label ...]

<runs-dir>/<label>/<set>/<fixture>.json are the saved reports;
<fixtures-root>/<set>/<fixture>.json are the inputs they were run on.
Prints one markdown row per label for the small+real sets, and one row per
label x large fixture.
"""

import json
import os
import sys
from collections import Counter

SETS = ["small", "real", "big"]
BIG = ["migratro-77.fixture", "kdb-83.fixture", "vkclone-3.fixture"]


def load(path):
    with open(path) as f:
        return json.load(f)


def al_dispatch_hunks(fixture):
    """Root-level entry files whose changed lines call `al_dispatch` (vkclone-3)."""
    out = set()
    for f in fixture["revision"]["files"]:
        if "/" in f["path"]:
            continue
        for h in f["hunks"]:
            if any("al_dispatch" in l["text"] for l in h["lines"] if l["kind"] != "ctx"):
                out.add(h["id"])
    return out


def dedupe_ids(fixture):
    """Mirror of `interdiff::dedupe_hunk_ids`: the n-th repeat of an id gets `-n`."""
    seen = Counter()
    for f in fixture["revision"]["files"]:
        for h in f["hunks"]:
            seen[h["id"]] += 1
            if seen[h["id"]] > 1:
                h["id"] = f'{h["id"]}-{seen[h["id"]]}'


def row_metrics(report, fixture, chunks):
    groups = report["grouping"]["groups"]
    visible = [g for g in groups if g["kind"] != "hidden"]
    attempts = report["attempts"]
    if chunks is None:
        chunks = report.get("chunks")
    repairs = None
    if chunks is not None:
        repairs = max(0, attempts - chunks - (1 if chunks > 1 else 0))
    other = sum(len(g["hunks"]) for g in groups if g["id"] == "other")
    m = {
        "valid": report["valid_after_repair"],
        "first": report["valid_first_try"],
        "attempts": attempts,
        "chunks": chunks,
        "repairs": repairs,
        "other": other,
        "groups": len(groups),
        "tiny": sum(1 for g in visible if len(g["hunks"]) <= 2),
        "secs": report["duration_ms"] / 1000,
        "out_tokens": report["usage"]["output_tokens"],
        "usd": report["usage"]["usd"],
    }
    al = al_dispatch_hunks(fixture)
    if al:
        per_group = [len(al & set(g["hunks"])) for g in groups]
        top = groups[per_group.index(max(per_group))]
        where = " (in Other)" if top["id"] == "other" else ""
        m["al"] = f"{max(per_group)}/{len(al)} together{where}, spread over {sum(1 for n in per_group if n)}"
    return m


def main():
    runs, root = sys.argv[1], sys.argv[2]
    labels = sys.argv[3:] or sorted(
        d for d in os.listdir(runs) if os.path.isdir(os.path.join(runs, d))
    )
    fixtures = {}
    for s in SETS:
        for name in os.listdir(os.path.join(root, s)):
            if name.endswith(".json"):
                fx = load(os.path.join(root, s, name))
                dedupe_ids(fx)
                fixtures[(s, name[:-5])] = fx
    # Chunk counts are a pure function of fixture + budget; borrow them from
    # any run that recorded them (default budget) for runs that did not.
    # Runs whose label contains "-c" used a non-default chunk budget; hybrid
    # runs record their own single call.
    known_chunks = {}
    for label in os.listdir(runs):
        for s in SETS:
            d = os.path.join(runs, label, s)
            if not os.path.isdir(d) or "-c" in label or label.startswith("hybrid"):
                continue
            for name in os.listdir(d):
                r = load(os.path.join(d, name))
                if "chunks" in r:
                    known_chunks.setdefault((s, name[:-5]), r["chunks"])

    print("| run | valid 1st try | valid after repair | repair calls | fixtures with Other fallback | groups (sum) | groups <=2 hunks | wall (s) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    big_rows = []
    for label in labels:
        agg = Counter()
        n = 0
        for s in SETS:
            d = os.path.join(runs, label, s)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                key = (s, name[:-5])
                r = load(os.path.join(d, name))
                chunks = r.get("chunks", known_chunks.get(key))
                m = row_metrics(r, fixtures[key], chunks)
                if s == "big":
                    big_rows.append((label, key[1], m))
                    continue
                n += 1
                agg["first"] += m["first"]
                agg["valid"] += m["valid"]
                agg["repairs"] += m["repairs"] or 0
                agg["other"] += 1 if m["other"] else 0
                agg["groups"] += m["groups"]
                agg["tiny"] += m["tiny"]
                agg["secs"] += m["secs"]
        if n:
            print(
                f"| {label} | {agg['first']}/{n} | {agg['valid']}/{n} | {agg['repairs']} | "
                f"{agg['other']} | {agg['groups']} | {agg['tiny']} | {agg['secs']:.0f} |"
            )
    print()
    print("| run | fixture | valid 1st try | repair calls | Other hunks | groups | groups <=2 hunks | wall (s) | out tokens | al_dispatch |")
    print("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
    for label, name, m in sorted(big_rows, key=lambda r: (BIG.index(r[1]), r[0])):
        print(
            f"| {label} | {name.replace('.fixture', '')} | {'yes' if m['first'] else 'no'} | "
            f"{m['repairs']} | {m['other']} | {m['groups']} | {m['tiny']} | {m['secs']:.0f} | "
            f"{m['out_tokens']} | {m.get('al', '')} |"
        )


if __name__ == "__main__":
    main()
