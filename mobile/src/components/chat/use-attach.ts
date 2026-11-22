/**
 * Attaching files to one composer (docs/mobile.md "Files"): picks, uploads
 * at once for the target computer, keeps the list in the attachments
 * store, retries and removes. The strip and the 📎 button call it.
 *
 * ```text
 * pick(source) ─▶ pickFiles ─▶ for each (room left, ≤ 20 MiB):
 *   addAttachment (uploading) ─▶ fleet.uploadAttachment(host, …, progress)
 *     ─▶ attachmentUploaded (✓)      ─▶ attachmentErrored (↻)
 * retry(key) ─▶ the same upload again      remove(key) ─▶ gone, its blob deleted
 * take()     ─▶ the refs to send and the files for the bubble; the list cleared
 * ```
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlobRef } from '../../gen/fleet';
import { useServices } from '../../services';
import {
  addAttachment,
  attachmentErrored,
  attachmentProgressed,
  attachmentRetry,
  attachmentUploaded,
  clearAttachments,
  removeAttachment,
  selectAttachments,
  selectNotice,
  setAttachmentNotice,
  useAttachments,
} from '../../state/attachments';
import {
  MAX_ATTACHMENTS,
  admit,
  refsOf,
  sentFilesOf,
  type Attachment,
  type SentFile,
} from '../../ui/attachments';
import { track } from '../../telemetry/log';
import { fileKind } from '../../ui/filePaths';
import { errorText, refusalCode } from '../../ui/logic';
import { pickFiles, type PickSource, type PickedFile } from './pick-files';

export interface Attach {
  list: Attachment[];
  /** Picking or compressing (the pickers are open, or a photo is being read). */
  picking: boolean;
  /** Why the last pick added nothing (a limit, a refused permission). */
  notice: string | null;
  pick: (source: PickSource) => Promise<void>;
  retry: (key: string) => void;
  remove: (key: string) => void;
  /** The references to send and the files for the bubble; the list cleared. */
  take: () => { refs: BlobRef[]; files: SentFile[] };
}

export function useAttach(composer: string, hostDevice: string | null): Attach {
  const { fleet } = useServices();
  const list = useAttachments(selectAttachments(composer));
  const notice = useAttachments(selectNotice(composer));
  const [picking, setPicking] = useState(false);
  const setNotice = useCallback(
    (text: string | null) => setAttachmentNotice(composer, text),
    [composer],
  );
  // The bytes of each attachment while it is in the list (a retry uploads
  // them again); dropped with it.
  const bytes = useRef(new Map<string, PickedFile>());

  // Telemetry: how many times each attachment was sent again.
  const retries = useRef(new Map<string, number>());

  const upload = useCallback(
    (key: string, file: PickedFile) => {
      if (!hostDevice) {
        attachmentErrored(composer, key, 'No computer picked.');
        return;
      }
      const started = uploadStarted();
      const facts = {
        bytes: file.bytes.length,
        retries: retries.current.get(key) ?? 0,
      };
      fleet
        .uploadAttachment(
          hostDevice,
          { bytes: file.bytes, name: file.name, mime: file.mime },
          (f) => attachmentProgressed(composer, key, f),
        )
        .then((ref) => {
          track('file_uploaded', {
            ...facts,
            chunks: ref.chunks,
            ms: uploadStarted() - started,
            outcome: 'ok',
            code: null,
          });
          attachmentUploaded(composer, key, ref);
        })
        .catch((e: unknown) => {
          track('file_uploaded', {
            ...facts,
            chunks: null,
            ms: uploadStarted() - started,
            outcome: 'failed',
            code: refusalCode(e),
          });
          attachmentErrored(composer, key, errorText(e));
        });
    },
    [composer, fleet, hostDevice],
  );

  const pick = useCallback(
    async (source: PickSource) => {
      if (picking) return;
      setNotice(null);
      const room = admit(list, 0);
      if (!room.ok) {
        setNotice(room.reason);
        return;
      }
      setPicking(true);
      try {
        const picked = await pickFiles(source, MAX_ATTACHMENTS - list.length);
        track('file_attached', {
          source,
          count: picked.length,
          bytes: picked.reduce((n, f) => n + f.bytes.length, 0),
          media: picked.length === 1 ? fileKind(picked[0]!.name, picked[0]!.mime) : null,
          outcome: picked.length ? 'ok' : 'none',
          code: null,
        });
        let refused: string | null = null;
        let current = useAttachments.getState().lists[composer] ?? [];
        for (const file of picked) {
          const ok = admit(current, file.bytes.length);
          if (!ok.ok) {
            refused = ok.reason;
            track('file_attached', {
              source,
              count: 1,
              bytes: file.bytes.length,
              media: fileKind(file.name, file.mime),
              outcome: 'refused',
              code: 'attach.limit',
            });
            continue;
          }
          const key = addAttachment(composer, {
            name: file.name,
            mime: file.mime,
            size: file.bytes.length,
            uri: file.uri,
          });
          bytes.current.set(key, file);
          current = useAttachments.getState().lists[composer] ?? [];
          upload(key, file);
        }
        if (refused) setNotice(refused);
      } catch (e: unknown) {
        track('file_attached', {
          source,
          count: 0,
          bytes: 0,
          media: null,
          outcome: 'failed',
          code: refusalCode(e) ?? 'attach.pick_failed',
        });
        setNotice(errorText(e));
      } finally {
        setPicking(false);
      }
    },
    [composer, list, picking, setNotice, upload],
  );

  const retry = useCallback(
    (key: string) => {
      const file = bytes.current.get(key);
      const again = attachmentRetry(composer, key);
      if (!again) return;
      retries.current.set(key, (retries.current.get(key) ?? 0) + 1);
      if (!file) {
        attachmentErrored(composer, key, 'Pick the file again.');
        return;
      }
      upload(key, file);
    },
    [composer, upload],
  );

  const remove = useCallback(
    (key: string) => {
      const was = removeAttachment(composer, key);
      bytes.current.delete(key);
      // Uploaded already: nothing of it stays in the cloud.
      if (was?.ref) void fleet.deleteBlob(was.ref.blob_id).catch(() => {});
    },
    [composer, fleet],
  );

  const take = useCallback(() => {
    const now = useAttachments.getState().lists[composer] ?? [];
    const out = { refs: refsOf(now), files: sentFilesOf(now) };
    clearAttachments(composer);
    bytes.current.clear();
    return out;
  }, [composer]);

  // Blobs are sealed for one computer: another one picked (Home) can't
  // read them, so they go, with a word why.
  const lastHost = useRef(hostDevice);
  useEffect(() => {
    const before = lastHost.current;
    lastHost.current = hostDevice;
    if (before === hostDevice || before === null || hostDevice === null) return;
    const now = useAttachments.getState().lists[composer] ?? [];
    if (!now.length) return;
    for (const a of now) {
      if (a.ref) void fleet.deleteBlob(a.ref.blob_id).catch(() => {});
    }
    clearAttachments(composer);
    bytes.current.clear();
    setNotice(HOST_CHANGED_TEXT);
  }, [composer, fleet, hostDevice, setNotice]);

  return { list, picking, notice, pick, retry, remove, take };
}

/** The clock for upload timing (outside render: the React compiler's rule). */
const uploadStarted = (): number => Date.now();

export const HOST_CHANGED_TEXT =
  'The files were removed: they were prepared for the other computer. Attach them again.';
