/**
 * A release as the changelog shows it: version, date, the page on GitHub,
 * and its notes as HTML (null for a maintenance release whose notes are
 * empty or only GitHub's generated "What's Changed" list). Built at build
 * time (scripts/prerender.mjs) and again in the browser for a release that
 * came out since.
 */
import { renderMarkdown } from './markdown';

export interface ReleaseNote {
  /** `0.1.32` */
  version: string;
  /** ISO date. */
  publishedAt: string;
  url: string;
  /** Rendered notes, or null: a maintenance release. */
  html: string | null;
}

/** The lines GitHub writes itself when a release has no notes of its own. */
const GENERATED = [
  /^#+\s*what'?s changed\s*$/i,
  /^#+\s*new contributors\s*$/i,
  /^\*\s.*\bby @\S+ in https?:\/\/\S+\/pull\/\d+\s*$/i,
  /^\*\s@\S+ made their first contribution\b/i,
  /^\*\*full changelog\*\*:\s*\S+\s*$/i,
];

/** The notes without the generated parts; empty when nothing else is there. */
export function ownNotes(body: string | null | undefined): string {
  if (!body) return '';
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !GENERATED.some((re) => re.test(l.trim())))
    .join('\n')
    .trim();
}

/** The tag of an app release: `v0.1.32`. Grammar and server bundles, the
 *  staging channel and anything else on the release page are not. */
export function isAppTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

interface ApiRelease {
  tag_name?: string;
  published_at?: string;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/** One release of the GitHub API as a changelog entry; null when it isn't
 *  an app release. */
export function toReleaseNote(data: unknown): ReleaseNote | null {
  const r = data as ApiRelease | null;
  if (!r || typeof r !== 'object' || typeof r.tag_name !== 'string')
    return null;
  if (r.draft || r.prerelease || !isAppTag(r.tag_name)) return null;
  const notes = ownNotes(r.body);
  return {
    version: r.tag_name.slice(1),
    publishedAt: r.published_at ?? '',
    url: r.html_url ?? '',
    html: notes ? renderMarkdown(notes) : null,
  };
}

/** Newest first, by version. */
export function sortReleases(list: ReleaseNote[]): ReleaseNote[] {
  const key = (v: string) => v.split('.').map((n) => Number(n) || 0);
  return [...list].sort((a, b) => {
    const [x, y] = [key(a.version), key(b.version)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
}
