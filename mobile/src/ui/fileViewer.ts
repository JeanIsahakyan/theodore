/**
 * The file viewer's states (docs/mobile.md "Files"), without React: a
 * file of a space on a computer, asked for with `read_file`, fetched from
 * the cloud, opened with this device's key, shown.
 *
 * ```text
 * requesting ─▶ read_file {space, path, max_bytes: 8 MiB}
 *   ok {blob}             ─▶ downloading 0…1 ─▶ opening ─▶ ready (cached for the session)
 *   fleet.too_large       ─▶ large: "Large file · Download anyway" ─▶ requesting with 50 MiB
 *                            (over the protocol's cap too ─▶ error: too large)
 *   not found / denied / offline / silent ─▶ error, one line, Retry
 * Retry ─▶ requesting again (the first cap)
 * ```
 */
import { MAX_READ_FILE_BYTES } from '../fleet/blob';
import type { FileKind } from './filePaths';

/** What the viewer asks for first: enough for anything it can show. */
export const SOFT_CAP_BYTES = 8 * 1024 * 1024;
/** "Download anyway": the protocol's cap. */
export const HARD_CAP_BYTES = MAX_READ_FILE_BYTES;

export type ViewerState =
  | { phase: 'requesting'; cap: number }
  | { phase: 'downloading'; cap: number; fraction: number }
  | { phase: 'opening'; cap: number }
  | {
      phase: 'ready';
      bytes: Uint8Array;
      mime: string;
      name: string;
      uri: string | null;
    }
  | { phase: 'large'; message: string }
  | { phase: 'error'; message: string; retry: boolean };

export type ViewerEvent =
  | { type: 'request' }
  | { type: 'blob'; size: number }
  | { type: 'progress'; fraction: number }
  | { type: 'opening' }
  | {
      type: 'ready';
      bytes: Uint8Array;
      mime: string;
      name: string;
      uri: string | null;
    }
  | { type: 'refused'; code: string | null; message: string }
  | { type: 'downloadAnyway' }
  | { type: 'retry' };

export const initialViewer = (): ViewerState => ({
  phase: 'requesting',
  cap: SOFT_CAP_BYTES,
});

/** The next state. `hostName` names the computer in error lines. */
export function reduceViewer(
  s: ViewerState,
  e: ViewerEvent,
  hostName: string,
  path: string,
): ViewerState {
  switch (e.type) {
    case 'request':
    case 'retry':
      return { phase: 'requesting', cap: SOFT_CAP_BYTES };
    case 'downloadAnyway':
      return { phase: 'requesting', cap: HARD_CAP_BYTES };
    case 'blob': {
      const cap = 'cap' in s ? s.cap : SOFT_CAP_BYTES;
      return { phase: 'downloading', cap, fraction: 0 };
    }
    case 'progress':
      return s.phase === 'downloading'
        ? { ...s, fraction: Math.max(s.fraction, Math.min(1, e.fraction)) }
        : s;
    case 'opening':
      return { phase: 'opening', cap: 'cap' in s ? s.cap : HARD_CAP_BYTES };
    case 'ready':
      return {
        phase: 'ready',
        bytes: e.bytes,
        mime: e.mime,
        name: e.name,
        uri: e.uri,
      };
    case 'refused': {
      const cap = 'cap' in s ? s.cap : HARD_CAP_BYTES;
      if (e.code === 'fleet.too_large' && cap < HARD_CAP_BYTES) {
        return { phase: 'large', message: LARGE_TEXT };
      }
      return {
        phase: 'error',
        ...errorLine(e.code, e.message, hostName, path),
      };
    }
  }
}

export const LARGE_TEXT = 'Large file';
export const DOWNLOAD_ANYWAY = 'Download anyway';

/** The one line an error shows, and whether Retry makes sense. */
export function errorLine(
  code: string | null,
  message: string,
  hostName: string,
  path: string,
): { message: string; retry: boolean } {
  switch (code) {
    case 'fleet.not_found':
    case 'fleet.unknown_space':
      return { message: `Not on ${hostName}: ${path}`, retry: false };
    case 'fleet.denied':
      return {
        message: `${hostName} didn't allow reading this file.`,
        retry: false,
      };
    case 'fleet.too_large':
      return { message: `Too large to view here (over 50 MB).`, retry: false };
    case 'fleet.offline':
      return { message: `Can't reach ${hostName}: it's offline.`, retry: true };
    case 'fleet.invalid':
    case 'fleet.upgrade_required':
      return {
        message: `${hostName} runs a Theodore that can't send files yet. Update it.`,
        retry: false,
      };
    case 'fleet.blob_not_found':
      return {
        message: 'The file left the cloud before it was fetched.',
        retry: true,
      };
    default:
      return {
        message: message || `Can't reach ${hostName}.`,
        retry: true,
      };
  }
}

/** The code in a thrown fleet error, else `null`. */
export function refusalCode(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  const raw = e instanceof Error ? e.message : '';
  return /\bfleet\.[a-z_]+/.exec(raw)?.[0] ?? null;
}

/** "mac-A · theodore · 340 KB" */
export function viewerSubtitle(parts: {
  hostName: string;
  spaceName: string;
  size: string | null;
}): string {
  return [parts.hostName, parts.spaceName, parts.size]
    .filter(Boolean)
    .join(' · ');
}

/** Most text drawn (more is cut with a note): the highlighter and the
 *  phone both have limits. */
export const TEXT_SHOWN_MAX = 200_000;

/** The text of a text file as shown: decoded, cut when very long. */
export function textToShow(bytes: Uint8Array): { text: string; cut: boolean } {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (decoded.length <= TEXT_SHOWN_MAX) return { text: decoded, cut: false };
  return { text: decoded.slice(0, TEXT_SHOWN_MAX), cut: true };
}

/** What the body shows for a kind that isn't drawn inline. */
export const NO_PREVIEW_TEXT = 'No preview for this file. Save or share it.';

/** The label of the save / share action per kind and platform. */
export function saveLabel(kind: FileKind, web: boolean): string {
  if (web) return 'Download';
  return kind === 'image' ? 'Save or share' : 'Share';
}
