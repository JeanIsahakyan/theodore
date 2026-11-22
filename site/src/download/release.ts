/**
 * The latest GitHub release: its version, date and the install assets by
 * name (docs/releasing.md "Linux builds"). Read at build time into the page
 * and again in the browser; without either, every link falls back to the
 * release page itself.
 */
import { RELEASES_API, RELEASES_LATEST } from '../content/links';

export type AssetKey =
  | 'mac-arm64-dmg'
  | 'linux-x64-appimage'
  | 'linux-x64-deb'
  | 'linux-arm64-appimage'
  | 'linux-arm64-deb';

export interface Release {
  /** `0.1.31` */
  version: string;
  /** ISO date. */
  publishedAt: string;
  /** The release page. */
  url: string;
  assets: Partial<Record<AssetKey, { url: string; size: number }>>;
}

const PATTERNS: Record<AssetKey, RegExp> = {
  'mac-arm64-dmg': /^Theodore_.+_aarch64\.dmg$/,
  'linux-x64-appimage': /^Theodore_.+_x86_64\.AppImage$/,
  'linux-x64-deb': /^Theodore_.+_amd64\.deb$/,
  'linux-arm64-appimage': /^Theodore_.+_aarch64\.AppImage$/,
  'linux-arm64-deb': /^Theodore_.+_arm64\.deb$/,
};

interface ApiRelease {
  tag_name?: string;
  published_at?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}

/** The release as the GitHub API describes it, or null when the answer
 *  isn't one. */
export function parseRelease(data: unknown): Release | null {
  const r = data as ApiRelease | null;
  if (!r || typeof r !== 'object' || typeof r.tag_name !== 'string')
    return null;
  const assets: Release['assets'] = {};
  for (const a of r.assets ?? []) {
    if (
      typeof a.name !== 'string' ||
      typeof a.browser_download_url !== 'string'
    )
      continue;
    for (const [key, re] of Object.entries(PATTERNS) as [AssetKey, RegExp][]) {
      if (re.test(a.name))
        assets[key] = { url: a.browser_download_url, size: a.size ?? 0 };
    }
  }
  return {
    version: r.tag_name.replace(/^v/, ''),
    publishedAt: r.published_at ?? '',
    url: r.html_url ?? RELEASES_LATEST,
    assets,
  };
}

export async function fetchRelease(): Promise<Release | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    return parseRelease(await res.json());
  } catch {
    return null;
  }
}

/** The download link for an asset: the file, or the release page. */
export function assetUrl(release: Release | null, key: AssetKey): string {
  return release?.assets[key]?.url ?? RELEASES_LATEST;
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
