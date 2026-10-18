/**
 * Pure diff helpers for the review pane: word-level marks within a changed
 * line, side-by-side row pairing, gaps between shown hunks (for context
 * expansion), and a hunk-level "what changed since an earlier revision"
 * comparison. No React, no store — easy to unit test on its own.
 */
import type { DiffLine, FileDiff, Hunk, HunkId } from '../gen/contract';

export type Mark = [number, number];

const WORD = /\w+|\s+|[^\w\s]/g;

/** Character ranges that differ between two lines, by word; `null` when the
 *  lines are too different to usefully pair (then no marks are shown). */
function pairMarks(a: string, b: string): [Mark[], Mark[]] | null {
  const ta = a.match(WORD) ?? [];
  const tb = b.match(WORD) ?? [];
  const n = ta.length;
  const m = tb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] =
        ta[i] === tb[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  if ((2 * dp[0]![0]!) / Math.max(1, n + m) < 0.5) return null;
  const ma: Mark[] = [];
  const mb: Mark[] = [];
  const push = (out: Mark[], at: number, tok: string) => {
    if (!tok.trim()) return;
    const last = out[out.length - 1];
    if (last && last[1] >= at - 1) last[1] = at + tok.length;
    else out.push([at, at + tok.length]);
  };
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ta[i] === tb[j]) {
      pa += ta[i++]!.length;
      pb += tb[j++]!.length;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      push(ma, pa, ta[i]!);
      pa += ta[i++]!.length;
    } else {
      push(mb, pb, tb[j]!);
      pb += tb[j++]!.length;
    }
  }
  return [ma, mb];
}

/** Word-level changes within a hunk's lines: a run of deletions followed by
 *  additions is paired line by line (del[k] with add[k]). Keyed by index into
 *  `lines`. */
export function wordMarks(lines: DiffLine[]): Map<number, Mark[]> {
  const out = new Map<number, Mark[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const d0 = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const a0 = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    for (let k = 0; k < Math.min(a0 - d0, i - a0); k++) {
      const r = pairMarks(lines[d0 + k]!.text, lines[a0 + k]!.text);
      if (!r) continue;
      if (r[0].length) out.set(d0 + k, r[0]);
      if (r[1].length) out.set(a0 + k, r[1]);
    }
  }
  return out;
}

export interface SplitRow {
  l?: number;
  r?: number;
}

/** Side-by-side rows: context on both sides, deletions zipped with the
 *  additions that follow them (git's usual "old | new" pairing). */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind === 'ctx') {
      rows.push({ l: i, r: i });
      i++;
      continue;
    }
    const d0 = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const a0 = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    for (let k = 0; k < Math.max(a0 - d0, i - a0); k++)
      rows.push({
        l: d0 + k < a0 ? d0 + k : undefined,
        r: a0 + k < i ? a0 + k : undefined,
      });
  }
  return rows;
}

/** A gap of unchanged lines directly above a hunk, in new-file line numbers. */
export interface Gap {
  from: number;
  to: number;
}

/** Gaps above each shown hunk of one file (sorted by position), from either
 *  the top of the file or the end of the previous hunk. Used to offer
 *  "load N lines of context" above a hunk. */
export function gapsAbove(hunks: Hunk[]): Map<HunkId, Gap> {
  const out = new Map<HunkId, Gap>();
  let end = 0;
  for (const h of hunks) {
    if (h.new_start - 1 > end)
      out.set(h.id, { from: end + 1, to: h.new_start - 1 });
    end = Math.max(end, h.new_start + h.new_lines - 1);
  }
  return out;
}

/** The gap after the last hunk of a file, given the file's total line count
 *  (known once its full content has been fetched via `get_file`). */
export function gapTail(hunks: Hunk[], totalLines: number): Gap | null {
  if (!hunks.length) return null;
  const end = Math.max(...hunks.map((h) => h.new_start + h.new_lines - 1));
  return totalLines > end ? { from: end + 1, to: totalLines } : null;
}

export type SinceKind = 'new' | 'changed';

const rangesOverlap = (a: Hunk, b: Hunk): boolean => {
  const aEnd = a.new_start + a.new_lines;
  const bEnd = b.new_start + b.new_lines;
  return a.new_start < bEnd && b.new_start < aEnd;
};

const sameLines = (a: Hunk, b: Hunk): boolean =>
  a.lines.length === b.lines.length &&
  a.lines.every(
    (l, i) => l.kind === b.lines[i]!.kind && l.text === b.lines[i]!.text,
  );

/**
 * What changed in `newFiles` relative to `oldFiles` — both diffs against the
 * same base, taken at two different heads (e.g. the head at your last visit
 * and the current head). A hunk with no entry is unchanged since `oldFiles`.
 */
export function sinceHunks(
  oldFiles: FileDiff[],
  newFiles: FileDiff[],
): Map<HunkId, SinceKind> {
  const out = new Map<HunkId, SinceKind>();
  const oldByPath = new Map(oldFiles.map((f) => [f.path, f]));
  for (const nf of newFiles) {
    const of_ = oldByPath.get(nf.path);
    for (const h of nf.hunks) {
      if (!of_) {
        out.set(h.id, 'new');
        continue;
      }
      const match = of_.hunks.find((oh) => rangesOverlap(oh, h));
      if (!match) out.set(h.id, 'new');
      else if (!sameLines(match, h)) out.set(h.id, 'changed');
    }
  }
  return out;
}
