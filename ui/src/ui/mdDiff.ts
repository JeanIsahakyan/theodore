/**
 * Block-level diff of two markdown documents for the rendered ("rich") view:
 * top-level blocks (paragraphs, headings, lists, tables, fenced code) are
 * compared as units, like GitHub's rich diff.
 */
export type MdBlock = { kind: 'same' | 'add' | 'del'; text: string };

/** Split markdown into top-level blocks; fenced code stays one block. */
export function mdBlocks(src: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const t = cur.join('\n').trim();
    if (t) out.push(t);
    cur = [];
  };
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const f = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      cur.push(line);
      if (f === fence) {
        fence = null;
        flush();
      }
      continue;
    }
    if (f) {
      flush();
      fence = f;
      cur.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else cur.push(line);
  }
  flush();
  return out;
}

/** LCS over blocks; deletions come before additions at each change. */
export function mdDiff(oldSrc: string, newSrc: string): MdBlock[] {
  const a = mdBlocks(oldSrc);
  const b = mdBlocks(newSrc);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: MdBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: 'same', text: b[j]! });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      // Prefer emitting the deletion first when both moves tie.
      if (i < n && lcs[i + 1]![j]! === lcs[i]![j + 1]!) {
        out.push({ kind: 'del', text: a[i]! });
        i++;
      } else {
        out.push({ kind: 'add', text: b[j]! });
        j++;
      }
    } else {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    }
  }
  return out;
}

export const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
