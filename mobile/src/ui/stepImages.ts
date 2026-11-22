/**
 * Images the agent reads, shown inline in a turn's step rows
 * (docs/mobile.md "Files"): which tool steps name an image, and the state
 * of one thumbnail, without React. The view is
 * `src/components/chat/step-thumbnail.tsx`.
 *
 * ```text
 * Read  .context/shot.png   ─▶ a local copy on this phone (you sent it)? ─▶ shown at once
 *                          ─▶ else read_file {max_bytes: 2 MiB} ─▶ fetched ─▶ shown (cached)
 *   fleet.too_large         ─▶ "Large image · Tap to load" ─▶ again with 8 MiB
 *                              (over that too ─▶ the viewer's own flow, on tap)
 *   not found / denied / an older host (no read_file) ─▶ the path as today, quietly
 *   offline / silent / anything else ─▶ "Couldn't load image · Retry"
 * ```
 *
 * The host's `target` is a path's last two segments at most, so a deeper
 * path can't be fetched: it comes back not found and the row stays as it
 * was. `.context/<name>` (the files you attach) always resolves.
 */
import { SOFT_CAP_BYTES } from './fileViewer';
import { extensionOf } from './filePaths';
import type { ToolStep } from './turnRows';

/** Tools that read one file by path (`turnRows.ts` labels them "Read"). */
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'read_file']);

/** What the phone draws; SVG is left out (untrusted markup, no raster). */
export const STEP_IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
  'avif',
]);

/** A thumbnail asks for this much; a larger image waits for a tap. */
export const THUMB_CAP_BYTES = 2 * 1024 * 1024;
/** "Tap to load": the viewer's first cap. */
export const THUMB_LOAD_ANYWAY_BYTES = SOFT_CAP_BYTES;

/**
 * The image path a step reads, or `null`: a read tool whose target has an
 * image extension and looks like a relative path (no cut-off `…`, no
 * absolute path, no control characters).
 */
export function imageReadOf(step: ToolStep): string | null {
  if (!READ_TOOLS.has(step.name) || !step.target) return null;
  let s = step.target.trim();
  if (s === '' || s.length > 1024 || s.endsWith('…')) return null;
  if (/[\0\n\r\t]/.test(s) || s.includes('://')) return null;
  if (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/') || s.endsWith('/') || s.startsWith('-')) return null;
  if (s.split('/').some((part) => part === '' || part === '..')) return null;
  const ext = extensionOf(s);
  return ext && STEP_IMAGE_EXT.has(ext) ? s : null;
}

/** A file you attached: the host keeps it under `.context/`. */
export const isContextPath = (path: string): boolean =>
  path.startsWith('.context/') && path.split('/').length === 2;

// ── one thumbnail's state ───────────────────────────────────────────────────

export type ThumbState =
  | { phase: 'idle' }
  | { phase: 'loading'; cap: number }
  | { phase: 'ready'; uri: string }
  /** Over the cap asked for: a tap asks with the next one. */
  | { phase: 'large'; cap: number }
  | { phase: 'failed'; message: string }
  /** Nothing to draw and nothing to say: the row shows the path. */
  | { phase: 'unavailable' };

export type ThumbEvent =
  | { type: 'request' }
  | { type: 'ready'; uri: string }
  | { type: 'refused'; code: string | null; message: string }
  | { type: 'loadAnyway' }
  | { type: 'retry' }
  /** The host can't send files (older than protocol 8), or this device
   *  can't open them: ask nothing. */
  | { type: 'unavailable' };

export const initialThumb = (): ThumbState => ({ phase: 'idle' });

/** Refusals that say the image won't come, not that it failed to. */
const QUIET_CODES = new Set([
  'fleet.not_found',
  'fleet.unknown_space',
  'fleet.denied',
  'fleet.invalid',
  'fleet.upgrade_required',
]);

export const COULDNT_LOAD_TEXT = "Couldn't load image";
export const RETRY_TEXT = 'Retry';
export const LARGE_IMAGE_TEXT = 'Large image';
export const TAP_TO_LOAD_TEXT = 'Tap to load';

export function reduceThumb(s: ThumbState, e: ThumbEvent): ThumbState {
  switch (e.type) {
    case 'request':
    case 'retry':
      return { phase: 'loading', cap: THUMB_CAP_BYTES };
    case 'loadAnyway':
      return s.phase === 'large'
        ? { phase: 'loading', cap: THUMB_LOAD_ANYWAY_BYTES }
        : s;
    case 'ready':
      return { phase: 'ready', uri: e.uri };
    case 'unavailable':
      return { phase: 'unavailable' };
    case 'refused': {
      if (e.code === 'fleet.too_large') {
        const cap = s.phase === 'loading' ? s.cap : THUMB_CAP_BYTES;
        // Over the viewer's cap too: the viewer offers the download.
        return cap >= THUMB_LOAD_ANYWAY_BYTES
          ? { phase: 'unavailable' }
          : { phase: 'large', cap };
      }
      if (e.code && QUIET_CODES.has(e.code)) return { phase: 'unavailable' };
      return { phase: 'failed', message: COULDNT_LOAD_TEXT };
    }
  }
}

/** A refusal that means the host can't send files at all. */
export const hostCantSendFiles = (code: string | null): boolean =>
  code === 'fleet.upgrade_required' || code === 'fleet.invalid';

// ── hosts that can't send files ─────────────────────────────────────────────

const noFiles = new Set<string>();

/** Remembered for the session: no more asked of that host. */
export function markHostWithoutFiles(hostDevice: string): void {
  noFiles.add(hostDevice);
}

export const hostHasFiles = (hostDevice: string): boolean =>
  !noFiles.has(hostDevice);

export function forgetHostsWithoutFiles(): void {
  noFiles.clear();
}
