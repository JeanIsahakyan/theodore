/**
 * Files attached to a message before it is sent (docs/mobile.md "Files"):
 * the rules, without React. The store is `src/state/attachments.ts`; the
 * previews above the composer are `src/components/chat/attachments.tsx`.
 *
 * ```text
 * pick ─▶ (photo: compressed) ─▶ "uploading" 0…1 ─▶ fleet.uploadAttachment ─▶ "done" (✓, its BlobRef)
 *                                       └─ failed ─▶ "failed" (↻ Retry, ✕)
 * ✕ before send ─▶ gone; its blob deleted when it had one
 * Send ─▶ only when text isn't blank and every attachment is done
 *      ─▶ attachments: BlobRef[] on the request; the bubble shows the files
 * limits: 10 per message, 20 MiB each after compression
 * ```
 */
import type { BlobRef } from '../gen/fleet';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../fleet/blob';

export { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES };

export type AttachmentState = 'uploading' | 'done' | 'failed';

/** A file picked for the message being written. */
export interface Attachment {
  /** Local, unique in this app run. */
  key: string;
  /** The file's name as sent (its last path component). */
  name: string;
  mime: string;
  /** Bytes after compression. */
  size: number;
  /** A local URI the preview is drawn from (a photo: the compressed copy). */
  uri: string | null;
  /** Drawn as a thumbnail (an image the device can show). */
  image: boolean;
  state: AttachmentState;
  /** 0…1 while uploading. */
  progress: number;
  /** The uploaded blob; set when `done`. */
  ref: BlobRef | null;
  error: string | null;
}

/** What a sent bubble keeps of its files (`PendingSend.files`). */
export interface SentFile {
  name: string;
  mime: string;
  size: number;
  uri: string | null;
  image: boolean;
}

export const newAttachment = (input: {
  key: string;
  name: string;
  mime: string;
  size: number;
  uri: string | null;
}): Attachment => ({
  ...input,
  image: isImageMime(input.mime),
  state: 'uploading',
  progress: 0,
  ref: null,
  error: null,
});

export const attachmentProgress = (
  a: Attachment,
  fraction: number,
): Attachment =>
  a.state === 'uploading'
    ? {
        ...a,
        progress: Math.max(a.progress, Math.min(1, Math.max(0, fraction))),
      }
    : a;

export const attachmentDone = (a: Attachment, ref: BlobRef): Attachment => ({
  ...a,
  state: 'done',
  progress: 1,
  ref,
  error: null,
});

export const attachmentFailed = (a: Attachment, error: string): Attachment => ({
  ...a,
  state: 'failed',
  ref: null,
  error,
});

/** Retry: uploading again from nothing. */
export const attachmentRetried = (a: Attachment): Attachment => ({
  ...a,
  state: 'uploading',
  progress: 0,
  ref: null,
  error: null,
});

/** Send waits for every file: none uploading, none failed. */
export const allUploaded = (list: readonly Attachment[]): boolean =>
  list.every((a) => a.state === 'done' && a.ref !== null);

/** Send is allowed: words, and every file in the cloud. */
export const canSendWith = (
  text: string,
  list: readonly Attachment[],
): boolean => text.trim() !== '' && allUploaded(list);

/** The references a send carries, in the order picked. */
export const refsOf = (list: readonly Attachment[]): BlobRef[] =>
  list.flatMap((a) => (a.state === 'done' && a.ref ? [a.ref] : []));

/** What the bubble shows of them once sent. */
export const sentFilesOf = (list: readonly Attachment[]): SentFile[] =>
  list.map(({ name, mime, size, uri, image }) => ({
    name,
    mime,
    size,
    uri,
    image,
  }));

/**
 * Whether `n` more files may be added: the room left under the cap, and
 * why none can when it is 0.
 */
export function roomFor(list: readonly Attachment[]): number {
  return Math.max(0, MAX_ATTACHMENTS - list.length);
}

export const TOO_MANY_TEXT = `At most ${MAX_ATTACHMENTS} files per message.`;
export const TOO_LARGE_TEXT = 'Files are limited to 20 MB each.';

/** `true` for a file the picker may add; a reason otherwise. */
export function admit(
  list: readonly Attachment[],
  size: number,
): { ok: true } | { ok: false; reason: string } {
  if (roomFor(list) === 0) return { ok: false, reason: TOO_MANY_TEXT };
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: TOO_LARGE_TEXT };
  return { ok: true };
}

export const isImageMime = (mime: string): boolean =>
  /^image\/(jpeg|png|webp|gif|heic|heif|bmp|avif)$/i.test(mime);

/** "1.2 MB", "340 KB", "12 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** The mime type of a file from its name when the picker gave none. */
export function mimeFromName(name: string, given?: string | null): string {
  if (given && given !== 'application/octet-stream' && given !== '')
    return given;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/plain',
  csv: 'text/csv',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  rs: 'text/x-rust',
  py: 'text/x-python',
  go: 'text/x-go',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  css: 'text/css',
  html: 'text/html',
  xml: 'text/xml',
  sh: 'text/x-shellscript',
  zip: 'application/zip',
};

/**
 * How a photo is compressed before upload (expo-image-manipulator): the
 * long side at most 2048 px; JPEG at 0.8, except a PNG (a screenshot) of
 * at most 2 MB, kept as it is.
 */
export const PHOTO_LONG_SIDE = 2048;
export const PHOTO_QUALITY = 0.8;
export const PNG_KEEP_BYTES = 2 * 1024 * 1024;

export interface PhotoPlan {
  /** Re-encode at all; `false`: upload the file untouched. */
  recode: boolean;
  /** The size to resize to (long side ≤ 2048), or `null` to keep it. */
  resize: { width: number; height: number } | null;
  format: 'jpeg' | 'png';
  mime: string;
  /** The name with the format's extension. */
  name: string;
}

export function planPhoto(input: {
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
}): PhotoPlan {
  const png = /png$/i.test(input.mime) || /\.png$/i.test(input.name);
  const long = Math.max(input.width, input.height);
  const scale = long > PHOTO_LONG_SIDE ? PHOTO_LONG_SIDE / long : 1;
  const resize =
    scale < 1
      ? {
          width: Math.round(input.width * scale),
          height: Math.round(input.height * scale),
        }
      : null;
  if (png && !resize && input.size <= PNG_KEEP_BYTES) {
    return {
      recode: false,
      resize: null,
      format: 'png',
      mime: 'image/png',
      name: input.name,
    };
  }
  const format = png && input.size <= PNG_KEEP_BYTES ? 'png' : 'jpeg';
  const base = input.name.replace(/\.[^.]+$/, '') || 'photo';
  return {
    recode: true,
    resize,
    format,
    mime: format === 'png' ? 'image/png' : 'image/jpeg',
    name: `${base}.${format === 'png' ? 'png' : 'jpg'}`,
  };
}

/** The word on a chip: uploading 0…1, done, failed. */
export function attachmentLabel(a: Attachment): string {
  switch (a.state) {
    case 'uploading':
      return `Uploading ${Math.round(a.progress * 100)}%`;
    case 'done':
      return 'Uploaded';
    case 'failed':
      return `Not uploaded${a.error ? ` · ${a.error}` : ''}`;
  }
}
