#!/usr/bin/env python3
"""Per-set comparison of saved `theodore eval --save` runs (docs/eval/graph-grouping.md).

usage: graph_compare.py <runs-dir> <fixtures-root> <set> <label> [label ...]

Prints one markdown row per label: first-try validity, repair calls, Other
hunks, groups vs the size-scaled target, tiny groups, groups made only of
docs/config files, cost and wall time; then one row per label x fixture.
"""

import json
import os
import sys
from collections import Counter

DOC_EXT = (".md", ".mdx", ".rst", ".txt")
CONFIG_HINTS = (".env", "dockerfile", ".github/workflows/", "changelog", ".gitlab-ci.yml",
                "jenkinsfile", "scripts/", ".yml", ".yaml", ".toml", ".ini")


def target(hunks):
    """Mirror of crates/grouping/src/target.rs."""
    if hunks <= 8:
        return (2, 4)
    if hunks <= 20:
        return (3, 6)
    if hunks <= 45:
        return (4, 8)
    if hunks <= 90:
        return (6, 12)
    return (8, 15)


def load(p):
    with open(p) as f:
        return json.load(f)


def dedupe(fx):
    seen = Counter()
    for f in fx["revision"]["files"]:
        for h in f["hunks"]:
            seen[h["id"]] += 1
            if seen[h["id"]] > 1:
                h["id"] = f'{h["id"]}-{seen[h["id"]]}'


def is_doc_or_config(path):
    p = path.lower()
    return p.endswith(DOC_EXT) or any(k in p for k in CONFIG_HINTS)


def metrics(report, fx):
    path = {h["id"]: f["path"] for f in fx["revision"]["files"] for h in f["hunks"]}
    groups = report["grouping"]["groups"]
    visible = [g for g in groups if g["kind"] != "hidden"]
    hidden = len(groups) - len(visible)
    n_hunks = sum(len(g["hunks"]) for g in visible)
    lo, hi = target(n_hunks)
    files_per = Counter()
    for g in visible:
        for f in {path.get(h, "?") for h in g["hunks"]}:
            files_per[f] += 1
    return {
        "first": report["valid_first_try"],
        "attempts": report["attempts"],
        "chunks": report.get("chunks"),
        "other": sum(len(g["hunks"]) for g in groups if g["id"] == "other"),
        "groups": len(groups),
        "in_target": lo <= len(visible) <= hi,
        "target": f"{lo}-{hi}",
        "tiny": sum(1 for g in visible if len(g["hunks"]) <= 2),
        "doc_only": sum(
            1 for g in visible if all(is_doc_or_config(path.get(h, "")) for h in g["hunks"])
        ),
        "split_files": sum(1 for n in files_per.values() if n > 1),
        "usd": report["usage"]["usd"],
        "secs": report["duration_ms"] / 1000,
    }


def main():
    runs, root, s, labels = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    fixtures = {}
    for name in sorted(os.listdir(os.path.join(root, s))):
        if name.endswith(".json"):
            fx = load(os.path.join(root, s, name))
            dedupe(fx)
            fixtures[name] = fx
    rows = []
    print("| run | valid 1st try | agent calls | Other hunks | groups | in target | groups <=2 hunks | docs/config-only groups | files split over groups | cost ($) | wall (s) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for label in labels:
        agg = Counter()
        n = 0
        for name, fx in fixtures.items():
            p = os.path.join(runs, label, s, name)
            if not os.path.exists(p):
                continue
            m = metrics(load(p), fx)
            rows.append((label, name, m))
            n += 1
            for k in ("first", "attempts", "other", "groups", "in_target", "tiny", "doc_only", "split_files"):
                agg[k] += int(m[k])
            agg["usd"] += m["usd"]
            agg["secs"] += m["secs"]
        print(
            f"| {label} | {agg['first']}/{n} | {agg['attempts']} | {agg['other']} | {agg['groups']} | "
            f"{agg['in_target']}/{n} | {agg['tiny']} | {agg['doc_only']} | {agg['split_files']} | "
            f"{agg['usd']:.2f} | {agg['secs']:.0f} |"
        )
    print()
    print("| run | fixture | 1st try | calls | groups (target) | <=2 hunks | docs/config-only | files split | cost ($) | wall (s) |")
    print("| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |")
    for label, name, m in sorted(rows, key=lambda r: (r[1], labels.index(r[0]))):
        print(
            f"| {label} | {name.replace('.json', '').replace('.fixture', '')} | "
            f"{'yes' if m['first'] else 'no'} | {m['attempts']} | {m['groups']} ({m['target']}) | "
            f"{m['tiny']} | {m['doc_only']} | {m['split_files']} | {m['usd']:.2f} | {m['secs']:.0f} |"
        )


if __name__ == "__main__":
    main()
