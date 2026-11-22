import { describe, expect, it } from 'vitest';
import {
  clearLocalCopies,
  localCopyOf,
  rememberLocalCopy,
} from '../src/fleet/local-copies';
import { SOFT_CAP_BYTES } from '../src/ui/fileViewer';
import {
  COULDNT_LOAD_TEXT,
  THUMB_CAP_BYTES,
  THUMB_LOAD_ANYWAY_BYTES,
  forgetHostsWithoutFiles,
  hostCantSendFiles,
  hostHasFiles,
  imageReadOf,
  initialThumb,
  isContextPath,
  markHostWithoutFiles,
  reduceThumb,
  type ThumbEvent,
  type ThumbState,
} from '../src/ui/stepImages';
import type { ToolStep } from '../src/ui/turnRows';

const read = (target: string | null, name = 'Read'): ToolStep => ({
  kind: 'tool',
  name,
  target,
  ok: null,
});

const run = (events: ThumbEvent[], from: ThumbState = initialThumb()) =>
  events.reduce(reduceThumb, from);

describe('which steps read an image', () => {
  it('a Read of a file with an image extension, by its path', () => {
    expect(imageReadOf(read('.context/shot.png'))).toBe('.context/shot.png');
    expect(imageReadOf(read('assets/icon.PNG'))).toBe('assets/icon.PNG');
    expect(imageReadOf(read('./sketch/home.jpg'))).toBe('sketch/home.jpg');
    for (const ext of ['jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif'])
      expect(imageReadOf(read(`a/b.${ext}`))).toBe(`a/b.${ext}`);
    expect(imageReadOf(read('shot.png', 'NotebookRead'))).toBe('shot.png');
    expect(imageReadOf(read('shot.png', 'read_file'))).toBe('shot.png');
  });

  it('not a read, not an image, not a path', () => {
    expect(imageReadOf(read('src/app.tsx'))).toBeNull();
    expect(imageReadOf(read('logo.svg'))).toBeNull();
    expect(imageReadOf(read('shot.png', 'Edit'))).toBeNull();
    expect(imageReadOf(read('shot.png', 'Bash'))).toBeNull();
    expect(imageReadOf(read('shot.png', 'read_many_files'))).toBeNull();
    expect(imageReadOf(read(null))).toBeNull();
    expect(imageReadOf(read(''))).toBeNull();
    expect(imageReadOf(read('/abs/shot.png'))).toBeNull();
    expect(imageReadOf(read('a/../shot.png'))).toBeNull();
    expect(imageReadOf(read('a//shot.png'))).toBeNull();
    expect(imageReadOf(read('shot.png/'))).toBeNull();
    expect(imageReadOf(read('-x.png'))).toBeNull();
    expect(imageReadOf(read('https://x/a.png'))).toBeNull();
    expect(imageReadOf(read('a\nb.png'))).toBeNull();
    expect(imageReadOf(read('.png'))).toBeNull();
    // The host cuts a long target with `…`: not a path any more.
    expect(imageReadOf(read(`${'a'.repeat(79)}…`))).toBeNull();
  });

  it('knows the files you sent (.context/<name>)', () => {
    expect(isContextPath('.context/shot.png')).toBe(true);
    expect(isContextPath('.context/a/b.png')).toBe(false);
    expect(isContextPath('context/shot.png')).toBe(false);
    expect(isContextPath('shot.png')).toBe(false);
  });
});

describe('the thumbnail state machine', () => {
  it('idle ─▶ loading with the small cap ─▶ ready', () => {
    expect(initialThumb()).toEqual({ phase: 'idle' });
    const loading = run([{ type: 'request' }]);
    expect(loading).toEqual({ phase: 'loading', cap: THUMB_CAP_BYTES });
    expect(THUMB_CAP_BYTES).toBe(2 * 1024 * 1024);
    expect(run([{ type: 'ready', uri: 'file:///a.png' }], loading)).toEqual({
      phase: 'ready',
      uri: 'file:///a.png',
    });
  });

  it('too large: "Tap to load" asks again with the viewer cap, then gives up quietly', () => {
    const large = run([
      { type: 'request' },
      { type: 'refused', code: 'fleet.too_large', message: '' },
    ]);
    expect(large).toEqual({ phase: 'large', cap: THUMB_CAP_BYTES });
    const again = run([{ type: 'loadAnyway' }], large);
    expect(again).toEqual({ phase: 'loading', cap: THUMB_LOAD_ANYWAY_BYTES });
    expect(THUMB_LOAD_ANYWAY_BYTES).toBe(SOFT_CAP_BYTES);
    expect(
      run([{ type: 'refused', code: 'fleet.too_large', message: '' }], again),
    ).toEqual({ phase: 'unavailable' });
    // loadAnyway means nothing elsewhere.
    expect(run([{ type: 'loadAnyway' }])).toEqual(initialThumb());
  });

  it('a failure says so with Retry; Retry asks again', () => {
    const failed = run([
      { type: 'request' },
      { type: 'refused', code: 'fleet.offline', message: 'offline' },
    ]);
    expect(failed).toEqual({ phase: 'failed', message: COULDNT_LOAD_TEXT });
    expect(
      run([{ type: 'refused', code: null, message: 'no answer' }]),
    ).toMatchObject({ phase: 'failed' });
    expect(run([{ type: 'retry' }], failed)).toEqual({
      phase: 'loading',
      cap: THUMB_CAP_BYTES,
    });
  });

  it('not found, denied or an older host: the path as today, no noise', () => {
    for (const code of [
      'fleet.not_found',
      'fleet.unknown_space',
      'fleet.denied',
      'fleet.upgrade_required',
      'fleet.invalid',
    ]) {
      expect(
        run([{ type: 'request' }, { type: 'refused', code, message: 'x' }]),
      ).toEqual({ phase: 'unavailable' });
    }
    expect(run([{ type: 'unavailable' }])).toEqual({ phase: 'unavailable' });
  });

  it('remembers a host that can’t send files for the session', () => {
    expect(hostCantSendFiles('fleet.upgrade_required')).toBe(true);
    expect(hostCantSendFiles('fleet.invalid')).toBe(true);
    expect(hostCantSendFiles('fleet.not_found')).toBe(false);
    expect(hostCantSendFiles(null)).toBe(false);
    expect(hostHasFiles('dev_old')).toBe(true);
    markHostWithoutFiles('dev_old');
    expect(hostHasFiles('dev_old')).toBe(false);
    expect(hostHasFiles('dev_new')).toBe(true);
    forgetHostsWithoutFiles();
    expect(hostHasFiles('dev_old')).toBe(true);
  });
});

describe('local copies of the files you sent', () => {
  it('a sent image is found by its .context path in that space, until sign-out', () => {
    rememberLocalCopy('rs_1', 'shot.png', 'file:///tmp/shot.png');
    expect(localCopyOf('rs_1', '.context/shot.png')).toBe(
      'file:///tmp/shot.png',
    );
    expect(localCopyOf('rs_2', '.context/shot.png')).toBeNull();
    expect(localCopyOf('rs_1', 'shot.png')).toBeNull();
    rememberLocalCopy('', 'shot.png', 'file:///x');
    rememberLocalCopy('rs_1', 'other.png', '');
    expect(localCopyOf('rs_1', '.context/other.png')).toBeNull();
    clearLocalCopies();
    expect(localCopyOf('rs_1', '.context/shot.png')).toBeNull();
  });
});
