/**
 * Pure logic for the image diff block: which paths get the image treatment,
 * the compare-mode cycle, slider clamping, and byte-size formatting. No
 * React, no store — easy to unit test on its own.
 */

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
]);

/** A changed file gets the image treatment by extension — a binary flag
 *  alone isn't enough (an SVG is text, so `git` never flags it binary). */
export function isImageDiffPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export type ImageDiffMode = 'side-by-side' | 'swipe' | 'onion';

export const IMAGE_DIFF_MODES: readonly ImageDiffMode[] = [
  'side-by-side',
  'swipe',
  'onion',
];

/** Cycles through the three modes (e.g. a keyboard shortcut or a button),
 *  wrapping back to the first after the last. */
export function cycleImageDiffMode(mode: ImageDiffMode): ImageDiffMode {
  const i = IMAGE_DIFF_MODES.indexOf(mode);
  return IMAGE_DIFF_MODES[(i + 1) % IMAGE_DIFF_MODES.length]!;
}

/** Swipe/onion sliders are a 0-100 position; clamps a raw input (pointer
 *  position math, a stray keystroke) back into range. `NaN` lands at the
 *  midpoint rather than propagating. */
export function clampPercent(n: number): number {
  if (Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable byte size, e.g. `834 B`, `12.4 KB`, `3.0 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${UNITS[i]}`;
}

/** The "+3.2 KB (+12%)" / "-834 B" line under a before/after image pair.
 *  `null` on either side (added/deleted files only ever have one side)
 *  means there's nothing to compare. */
export function formatSizeDelta(
  before: number | null,
  after: number | null,
): string {
  if (before == null || after == null) return '';
  const diff = after - before;
  if (diff === 0) return 'no size change';
  const sign = diff > 0 ? '+' : '-';
  const magnitude = formatBytes(Math.abs(diff));
  if (before <= 0) return `${sign}${magnitude}`;
  const pct = Math.round((Math.abs(diff) / before) * 100);
  return `${sign}${magnitude} (${sign}${pct}%)`;
}
