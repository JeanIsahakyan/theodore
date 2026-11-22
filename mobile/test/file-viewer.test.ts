import { describe, expect, it } from 'vitest';
import {
  HARD_CAP_BYTES,
  SOFT_CAP_BYTES,
  errorLine,
  initialViewer,
  reduceViewer,
  refusalCode,
  saveLabel,
  textToShow,
  viewerSubtitle,
  type ViewerEvent,
  type ViewerState,
} from '../src/ui/fileViewer';

const run = (events: ViewerEvent[], from: ViewerState = initialViewer()) =>
  events.reduce((s, e) => reduceViewer(s, e, 'mac-A', 'a.txt'), from);

describe('the viewer state machine', () => {
  it('starts requesting with the soft cap and goes to ready', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(initialViewer()).toEqual({
      phase: 'requesting',
      cap: SOFT_CAP_BYTES,
    });
    const s1 = run([{ type: 'blob', size: 2 }]);
    expect(s1).toEqual({
      phase: 'downloading',
      cap: SOFT_CAP_BYTES,
      fraction: 0,
    });
    const s2 = run(
      [
        { type: 'progress', fraction: 0.5 },
        { type: 'progress', fraction: 0.2 },
      ],
      s1,
    );
    expect(s2).toMatchObject({ phase: 'downloading', fraction: 0.5 });
    const s3 = run([{ type: 'opening' }], s2);
    expect(s3).toEqual({ phase: 'opening', cap: SOFT_CAP_BYTES });
    const s4 = run(
      [{ type: 'ready', bytes, mime: 'text/plain', name: 'a.txt', uri: null }],
      s3,
    );
    expect(s4).toEqual({
      phase: 'ready',
      bytes,
      mime: 'text/plain',
      name: 'a.txt',
      uri: null,
    });
  });

  it('too large under the soft cap offers Download anyway, then the hard cap', () => {
    const large = run([
      { type: 'refused', code: 'fleet.too_large', message: '' },
    ]);
    expect(large).toMatchObject({ phase: 'large', message: 'Large file' });
    const again = run([{ type: 'downloadAnyway' }], large);
    expect(again).toEqual({ phase: 'requesting', cap: HARD_CAP_BYTES });
    const still = run(
      [{ type: 'refused', code: 'fleet.too_large', message: '' }],
      again,
    );
    expect(still).toMatchObject({ phase: 'error', retry: false });
    expect((still as { message: string }).message).toMatch(/over 50 MB/);
  });

  it('errors say what happened and whether Retry helps', () => {
    expect(errorLine('fleet.not_found', '', 'mac-A', 'a.txt')).toEqual({
      message: 'Not on mac-A: a.txt',
      retry: false,
    });
    expect(errorLine('fleet.denied', '', 'mac-A', 'a.txt')).toMatchObject({
      retry: false,
    });
    expect(errorLine('fleet.offline', '', 'mac-A', 'a.txt')).toEqual({
      message: "Can't reach mac-A: it's offline.",
      retry: true,
    });
    expect(errorLine('fleet.invalid', '', 'mac-A', 'a.txt')).toMatchObject({
      message: /Update it/,
      retry: false,
    });
    expect(
      errorLine(
        null,
        "the other device didn't answer in time",
        'mac-A',
        'a.txt',
      ),
    ).toEqual({
      message: "the other device didn't answer in time",
      retry: true,
    });
    expect(errorLine(null, '', 'mac-A', 'a.txt')).toEqual({
      message: "Can't reach mac-A.",
      retry: true,
    });
    const err = run([{ type: 'refused', code: 'fleet.offline', message: 'x' }]);
    expect(err).toMatchObject({ phase: 'error', retry: true });
    expect(run([{ type: 'retry' }], err)).toEqual(initialViewer());
  });

  it('progress and opening outside a download change nothing wrong', () => {
    const s = initialViewer();
    expect(run([{ type: 'progress', fraction: 0.4 }], s)).toBe(s);
    const err = run([{ type: 'refused', code: 'fleet.denied', message: '' }]);
    expect(run([{ type: 'progress', fraction: 1 }], err)).toBe(err);
  });
});

describe('viewer words', () => {
  it('reads a refusal code from an error', () => {
    expect(
      refusalCode(Object.assign(new Error('x'), { code: 'fleet.denied' })),
    ).toBe('fleet.denied');
    expect(
      refusalCode(new Error('the other device refused: fleet.not_found: gone')),
    ).toBe('fleet.not_found');
    expect(refusalCode(new Error('offline'))).toBeNull();
    expect(refusalCode(null)).toBeNull();
  });

  it('subtitle, text cut, labels', () => {
    expect(
      viewerSubtitle({
        hostName: 'mac-A',
        spaceName: 'theodore',
        size: '340 KB',
      }),
    ).toBe('mac-A · theodore · 340 KB');
    expect(
      viewerSubtitle({ hostName: 'mac-A', spaceName: '', size: null }),
    ).toBe('mac-A');
    expect(textToShow(new TextEncoder().encode('hi'))).toEqual({
      text: 'hi',
      cut: false,
    });
    const long = textToShow(new Uint8Array(300_000).fill(97));
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(200_000);
    expect(saveLabel('image', false)).toBe('Save or share');
    expect(saveLabel('text', false)).toBe('Share');
    expect(saveLabel('pdf', true)).toBe('Download');
  });
});
