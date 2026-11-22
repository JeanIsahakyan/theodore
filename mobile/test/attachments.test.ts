import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAttachment,
  attachmentErrored,
  attachmentProgressed,
  attachmentRetry,
  attachmentUploaded,
  clearAttachments,
  removeAttachment,
  resetAttachments,
  selectAttachments,
  useAttachments,
} from '../src/state/attachments';
import {
  MAX_ATTACHMENTS,
  admit,
  allUploaded,
  attachmentLabel,
  canSendWith,
  formatBytes,
  isImageMime,
  mimeFromName,
  planPhoto,
  refsOf,
  sentFilesOf,
} from '../src/ui/attachments';
import type { BlobRef } from '../src/gen/fleet';

const ref = (i: number): BlobRef => ({
  blob_id: i.toString(16).padStart(32, '0'),
  name: `f${i}`,
  mime: 'text/plain',
  size: 3,
  chunks: 1,
  sha256: '0'.repeat(64),
  eph_pk: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  nonce_prefix: 'AAAAAAAAAAAAAAAAAAAAAA==',
});
const list = (c: string) => selectAttachments(c)(useAttachments.getState());
const file = {
  name: 'a.png',
  mime: 'image/png',
  size: 10,
  uri: 'file:///a.png',
};

beforeEach(() => resetAttachments());

describe('attachments store', () => {
  it('adds a file as uploading, tracks progress, settles, and leaves on send', () => {
    const k = addAttachment('home', file);
    expect(list('home')).toMatchObject([
      { key: k, name: 'a.png', image: true, state: 'uploading', progress: 0 },
    ]);
    attachmentProgressed('home', k, 0.4);
    attachmentProgressed('home', k, 0.2); // never backwards
    expect(list('home')[0]!.progress).toBe(0.4);
    attachmentUploaded('home', k, ref(1));
    expect(list('home')[0]).toMatchObject({
      state: 'done',
      progress: 1,
      ref: ref(1),
    });
    attachmentProgressed('home', k, 0.5); // done stays done
    expect(list('home')[0]!.progress).toBe(1);
    clearAttachments('home');
    expect(list('home')).toEqual([]);
    expect(useAttachments.getState().lists).toEqual({});
  });

  it('fails, retries from zero, and is removed', () => {
    const k = addAttachment('sp', file);
    attachmentErrored('sp', k, 'offline');
    expect(list('sp')[0]).toMatchObject({
      state: 'failed',
      error: 'offline',
      ref: null,
    });
    expect(attachmentLabel(list('sp')[0]!)).toBe('Not uploaded · offline');
    const again = attachmentRetry('sp', k);
    expect(again).toMatchObject({
      state: 'uploading',
      progress: 0,
      error: null,
    });
    expect(attachmentLabel(again!)).toBe('Uploading 0%');
    attachmentUploaded('sp', k, ref(2));
    const was = removeAttachment('sp', k);
    expect(was?.ref).toEqual(ref(2));
    expect(list('sp')).toEqual([]);
    expect(removeAttachment('sp', k)).toBeNull();
    expect(attachmentRetry('sp', 'nope')).toBeNull();
  });

  it('keeps composers apart', () => {
    addAttachment('home', file);
    addAttachment('sp', file);
    expect(list('home')).toHaveLength(1);
    expect(list('sp')).toHaveLength(1);
    clearAttachments('home');
    expect(list('sp')).toHaveLength(1);
  });
});

describe('send gating and the payload', () => {
  it('allows Send only with words and every file uploaded', () => {
    const k1 = addAttachment('sp', file);
    const k2 = addAttachment('sp', {
      ...file,
      name: 'b.txt',
      mime: 'text/plain',
    });
    expect(canSendWith('hi', list('sp'))).toBe(false);
    attachmentUploaded('sp', k1, ref(1));
    expect(canSendWith('hi', list('sp'))).toBe(false);
    attachmentErrored('sp', k2, 'x');
    expect(allUploaded(list('sp'))).toBe(false);
    attachmentRetry('sp', k2);
    attachmentUploaded('sp', k2, ref(2));
    expect(allUploaded(list('sp'))).toBe(true);
    expect(canSendWith('hi', list('sp'))).toBe(true);
    expect(canSendWith('   ', list('sp'))).toBe(false);
    expect(canSendWith('hi', [])).toBe(true);
    expect(refsOf(list('sp'))).toEqual([ref(1), ref(2)]);
    expect(sentFilesOf(list('sp'))).toEqual([
      {
        name: 'a.png',
        mime: 'image/png',
        size: 10,
        uri: 'file:///a.png',
        image: true,
      },
      {
        name: 'b.txt',
        mime: 'text/plain',
        size: 10,
        uri: 'file:///a.png',
        image: false,
      },
    ]);
  });

  it('admits at most 10 files of at most 20 MiB', () => {
    for (let i = 0; i < MAX_ATTACHMENTS; i++) {
      expect(admit(list('sp'), 1)).toEqual({ ok: true });
      addAttachment('sp', file);
    }
    expect(admit(list('sp'), 1)).toMatchObject({
      ok: false,
      reason: /10 files/,
    });
    expect(admit([], 20 * 1024 * 1024)).toEqual({ ok: true });
    expect(admit([], 20 * 1024 * 1024 + 1)).toMatchObject({
      ok: false,
      reason: /20 MB/,
    });
  });
});

describe('files: names, sizes, photos', () => {
  it('formats sizes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(-1)).toBe('');
  });

  it('guesses a mime type from the name when the picker gave none', () => {
    expect(mimeFromName('a.PNG', null)).toBe('image/png');
    expect(mimeFromName('a.log', '')).toBe('text/plain');
    expect(mimeFromName('a.rs', 'application/octet-stream')).toBe(
      'text/x-rust',
    );
    expect(mimeFromName('a.xyz', null)).toBe('application/octet-stream');
    expect(mimeFromName('a.xyz', 'text/weird')).toBe('text/weird');
    expect(isImageMime('image/jpeg')).toBe(true);
    expect(isImageMime('image/svg+xml')).toBe(false);
  });

  it('plans a photo: long side ≤ 2048, JPEG 0.8, a small PNG untouched', () => {
    expect(
      planPhoto({
        name: 'shot.png',
        mime: 'image/png',
        width: 1170,
        height: 2048,
        size: 500_000,
      }),
    ).toEqual({
      recode: false,
      resize: null,
      format: 'png',
      mime: 'image/png',
      name: 'shot.png',
    });
    expect(
      planPhoto({
        name: 'shot.png',
        mime: 'image/png',
        width: 1170,
        height: 2048,
        size: 3_000_000,
      }),
    ).toMatchObject({
      recode: true,
      resize: null,
      format: 'jpeg',
      mime: 'image/jpeg',
      name: 'shot.jpg',
    });
    expect(
      planPhoto({
        name: 'shot.png',
        mime: 'image/png',
        width: 1170,
        height: 2532,
        size: 500_000,
      }),
    ).toMatchObject({
      recode: true,
      resize: { width: 946, height: 2048 },
      format: 'png',
      name: 'shot.png',
    });
    expect(
      planPhoto({
        name: 'IMG_1.HEIC',
        mime: 'image/heic',
        width: 4032,
        height: 3024,
        size: 2_500_000,
      }),
    ).toEqual({
      recode: true,
      resize: { width: 2048, height: 1536 },
      format: 'jpeg',
      mime: 'image/jpeg',
      name: 'IMG_1.jpg',
    });
    expect(
      planPhoto({
        name: 'tall.png',
        mime: 'image/png',
        width: 1000,
        height: 4096,
        size: 100,
      }),
    ).toMatchObject({
      recode: true,
      resize: { width: 500, height: 2048 },
      format: 'png',
      name: 'tall.png',
    });
    expect(
      planPhoto({
        name: 'p.jpg',
        mime: 'image/jpeg',
        width: 800,
        height: 600,
        size: 100,
      }),
    ).toMatchObject({
      recode: true,
      resize: null,
      format: 'jpeg',
      name: 'p.jpg',
    });
  });
});
