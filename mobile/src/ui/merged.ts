/**
 * The "Merged #N" chip of a space screen (the desktop's status chip, small):
 * a space whose PR merged on its host, and what can be done with it. Pure,
 * so the tests read it; the view is `./MergedChip.tsx`.
 *
 * ```text
 * mirrored row  pr: github:owner/repo#12, done_at: 1 700 000 000 000
 *   ─▶ ● Merged #12  ─ tap ─▶ ╭ Continue on a new branch ╮   focus the composer, a note
 *                             │ Open PR #12              │   only with a web URL for the id
 *                             ╰ Archive                  ╯   destructive, only when canArchive
 * pr set, done_at null (open PR)   ─▶ no chip
 * done_at set, no pr (merged locally) ─▶ no chip (nothing to open)
 * ```
 *
 * A PR id is the host's `PrRef::id`: `<host>:<owner>/<repo>#<n>`, the slug
 * nested on GitLab (`gitlab:group/sub/proj#3`). Fleet text is untrusted: a
 * URL is built only from a slug whose every segment is `[A-Za-z0-9_.-]+`.
 */
import type { Space } from '../fleet/contract';

export interface MergedPr {
  number: number;
  /** The host's id, `github:owner/repo#12`. */
  id: string;
}

/** The merged PR of a mirrored row; `null` while it is open or there is none. */
export function mergedPr(
  row: Pick<Space, 'pr' | 'done_at' | 'shipped'> | null | undefined,
): MergedPr | null {
  if (!row?.pr || typeof row.done_at !== 'number') return null;
  const hash = row.pr.lastIndexOf('#');
  if (hash < 0) return null;
  const number = Number(row.pr.slice(hash + 1));
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, id: row.pr };
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** How each host is reached on the web; others have no obvious page. */
const HOSTS: Record<
  string,
  { depth: 'two' | 'nested'; url: (slug: string, n: number) => string }
> = {
  github: {
    depth: 'two',
    url: (slug, n) => `https://github.com/${slug}/pull/${n}`,
  },
  gitlab: {
    depth: 'nested',
    url: (slug, n) => `https://gitlab.com/${slug}/-/merge_requests/${n}`,
  },
  bitbucket: {
    depth: 'two',
    url: (slug, n) => `https://bitbucket.org/${slug}/pull-requests/${n}`,
  },
};

/**
 * The PR's page for a host id, `null` when the host has none here or the id
 * doesn't have the shape (nothing is built from a slug that isn't a slug).
 */
export function prWebUrl(pr: string): string | null {
  const colon = pr.indexOf(':');
  const hash = pr.lastIndexOf('#');
  if (colon <= 0 || hash <= colon) return null;
  const host = HOSTS[pr.slice(0, colon)];
  if (!host) return null;
  const slug = pr.slice(colon + 1, hash);
  const n = Number(pr.slice(hash + 1));
  if (
    !/^[0-9]+$/.test(pr.slice(hash + 1)) ||
    !Number.isSafeInteger(n) ||
    n <= 0
  )
    return null;
  const parts = slug.split('/');
  if (host.depth === 'two' ? parts.length !== 2 : parts.length < 2) return null;
  if (!parts.every((s) => SEGMENT.test(s))) return null;
  return host.url(slug, n);
}

export type MergedChipItemId = 'continue' | 'pr' | 'archive';

export interface MergedChipItem {
  id: MergedChipItemId;
  label: string;
  /** Drawn in the danger color. */
  destructive?: boolean;
}

/** What the chip's menu offers; Open PR needs a web page, Archive the right. */
export function mergedChipItems(opts: {
  prUrl: string | null;
  canArchive: boolean;
  number?: number;
}): MergedChipItem[] {
  const items: MergedChipItem[] = [
    { id: 'continue', label: 'Continue on a new branch' },
  ];
  if (opts.prUrl) {
    items.push({
      id: 'pr',
      label: opts.number ? `Open PR #${opts.number}` : 'Open PR',
    });
  }
  if (opts.canArchive) {
    items.push({ id: 'archive', label: 'Archive', destructive: true });
  }
  return items;
}

/** The composer's note after "Continue on a new branch". */
export function continueNote(base: string | null | undefined): string {
  return `Your next message continues on a new branch from the updated ${base || 'base'}.`;
}
