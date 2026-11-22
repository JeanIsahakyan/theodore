/**
 * The files attached to the message being written, per composer (zustand),
 * kept out of the screens so an upload survives a sheet or a screen change.
 * Rules: `src/ui/attachments.ts`; docs/mobile.md "Files".
 *
 * ```text
 * lists[composer]   Home: "home"; a space: its id; a sub-space: its local id
 * ```
 */
import { create } from 'zustand';
import type { BlobRef } from '../gen/fleet';
import {
  attachmentDone,
  attachmentFailed,
  attachmentProgress,
  attachmentRetried,
  newAttachment,
  type Attachment,
} from '../ui/attachments';

export const HOME_COMPOSER = 'home';

export interface AttachmentsState {
  lists: Record<string, Attachment[]>;
  /** Why the last pick added nothing (a limit, a refused permission). */
  notices: Record<string, string>;
}

const initial: AttachmentsState = { lists: {}, notices: {} };

export const useAttachments = create<AttachmentsState>(() => initial);

export function resetAttachments(): void {
  useAttachments.setState(initial, true);
}

const EMPTY: Attachment[] = [];
export const selectAttachments =
  (composer: string) =>
  (s: AttachmentsState): Attachment[] =>
    s.lists[composer] ?? EMPTY;

export const selectNotice =
  (composer: string) =>
  (s: AttachmentsState): string | null =>
    s.notices[composer] ?? null;

/** A line under the previews; `null` clears it. */
export function setAttachmentNotice(
  composer: string,
  text: string | null,
): void {
  useAttachments.setState((s) => {
    if ((s.notices[composer] ?? null) === text) return {};
    const notices = { ...s.notices };
    if (text) notices[composer] = text;
    else delete notices[composer];
    return { notices };
  });
}

let counter = 0;
const nextKey = () => `att_${Date.now().toString(36)}_${(counter += 1)}`;

const update = (
  composer: string,
  key: string,
  f: (a: Attachment) => Attachment,
) =>
  useAttachments.setState((s) => {
    const list = s.lists[composer];
    if (!list?.some((a) => a.key === key)) return {};
    return {
      lists: {
        ...s.lists,
        [composer]: list.map((a) => (a.key === key ? f(a) : a)),
      },
    };
  });

/** A file picked: shown at once as uploading. Returns its key. */
export function addAttachment(
  composer: string,
  input: { name: string; mime: string; size: number; uri: string | null },
): string {
  const a = newAttachment({ ...input, key: nextKey() });
  useAttachments.setState((s) => ({
    lists: { ...s.lists, [composer]: [...(s.lists[composer] ?? []), a] },
  }));
  return a.key;
}

export function attachmentProgressed(
  composer: string,
  key: string,
  fraction: number,
): void {
  update(composer, key, (a) => attachmentProgress(a, fraction));
}

export function attachmentUploaded(
  composer: string,
  key: string,
  ref: BlobRef,
): void {
  update(composer, key, (a) => attachmentDone(a, ref));
}

export function attachmentErrored(
  composer: string,
  key: string,
  error: string,
): void {
  update(composer, key, (a) => attachmentFailed(a, error));
}

/** Retry: uploading again; the screen uploads it. Returns it, or `null`
 *  when it is gone. */
export function attachmentRetry(
  composer: string,
  key: string,
): Attachment | null {
  update(composer, key, attachmentRetried);
  return (
    useAttachments.getState().lists[composer]?.find((a) => a.key === key) ??
    null
  );
}

/** ✕, or the message was sent: gone from the list. Returns what it was. */
export function removeAttachment(
  composer: string,
  key: string,
): Attachment | null {
  const was =
    useAttachments.getState().lists[composer]?.find((a) => a.key === key) ??
    null;
  useAttachments.setState((s) => {
    const list = s.lists[composer];
    if (!list?.some((a) => a.key === key)) return {};
    const kept = list.filter((a) => a.key !== key);
    const lists = { ...s.lists };
    if (kept.length) lists[composer] = kept;
    else delete lists[composer];
    return { lists };
  });
  return was;
}

/** The message went out: its files leave the composer. */
export function clearAttachments(composer: string): void {
  useAttachments.setState((s) => {
    if (!(composer in s.lists)) return {};
    const lists = { ...s.lists };
    delete lists[composer];
    return { lists };
  });
}
