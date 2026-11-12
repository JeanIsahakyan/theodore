import { describe, expect, it } from 'vitest';
import { device, thisDevice } from '../../test/fleet';
import {
  canSend,
  canStop,
  capMode,
  isAnswered,
  lastSeenLabel,
  modesUpTo,
  pickOption,
  startableDevices,
  toWireAnswers,
  typeOther,
} from './fleet';

describe('modes', () => {
  it('a device allows every mode up to its highest', () => {
    expect(modesUpTo('ask')).toEqual(['ask']);
    expect(modesUpTo('edit')).toEqual(['ask', 'plan', 'edit']);
    expect(modesUpTo('run')).toEqual(['ask', 'plan', 'edit', 'run']);
  });

  it('brings a mode down under the cap, leaves the rest', () => {
    expect(capMode('run', 'plan')).toBe('plan');
    expect(capMode('ask', 'plan')).toBe('ask');
  });
});

describe('startableDevices', () => {
  it('keeps the online ones that take remote spaces, never this one', () => {
    const list = [
      thisDevice({ accepts_remote: true, projects: [{ id: 'p', name: 'x' }] }),
      device({ device_id: 'ok' }),
      device({ device_id: 'off', online: false }),
      device({ device_id: 'no', accepts_remote: false }),
      device({ device_id: 'empty', projects: [] }),
    ];
    expect(startableDevices(list).map((d) => d.device_id)).toEqual(['ok']);
  });
});

describe('lastSeenLabel', () => {
  const now = 10_000_000_000;
  it('reads in the unit that fits', () => {
    expect(lastSeenLabel(0, true, now)).toBe('online');
    expect(lastSeenLabel(0, false, now)).toBe('never seen');
    expect(lastSeenLabel(now - 5_000, false, now)).toBe('seen just now');
    expect(lastSeenLabel(now - 180_000, false, now)).toBe('seen 3 min ago');
    expect(lastSeenLabel(now - 3 * 3_600_000, false, now)).toBe('seen 3 h ago');
    expect(lastSeenLabel(now - 72 * 3_600_000, false, now)).toBe(
      'seen 3 days ago',
    );
  });
});

describe('statuses', () => {
  it('takes a message only between turns, stops only a running one', () => {
    expect(['idle', 'waiting'].every((s) => canSend(s as never))).toBe(true);
    for (const s of ['starting', 'running', 'stopped', 'failed'] as const) {
      expect(canSend(s)).toBe(false);
    }
    expect(canStop('running')).toBe(true);
    expect(canStop('idle')).toBe(false);
  });
});

describe('answers', () => {
  const single = { question: 'q', options: ['a', 'b'], multi: false };
  const multi = { question: 'q', options: ['a', 'b'], multi: true };
  const empty = { selected: [], other: '' };

  it('a single choice replaces the last one and clears Other', () => {
    const d = pickOption(single, { selected: ['a'], other: 'x' }, 'b');
    expect(d).toEqual({ selected: ['b'], other: '' });
  });

  it('a multi choice toggles', () => {
    let d = pickOption(multi, empty, 'a');
    d = pickOption(multi, d, 'b');
    expect(d.selected).toEqual(['a', 'b']);
    expect(pickOption(multi, d, 'a').selected).toEqual(['b']);
  });

  it('typing under Other drops a single choice, keeps a multi one', () => {
    expect(typeOther(single, { selected: ['a'], other: '' }, 'hm')).toEqual({
      selected: [],
      other: 'hm',
    });
    expect(typeOther(multi, { selected: ['a'], other: '' }, 'hm')).toEqual({
      selected: ['a'],
      other: 'hm',
    });
  });

  it('needs an answer for every question', () => {
    expect(isAnswered([empty])).toBe(false);
    expect(isAnswered([{ selected: [], other: '  ' }])).toBe(false);
    expect(isAnswered([{ selected: ['a'], other: '' }, empty])).toBe(false);
    expect(isAnswered([{ selected: ['a'], other: '' }])).toBe(true);
    expect(isAnswered([{ selected: [], other: 'x' }])).toBe(true);
  });

  it('goes on the wire as options, then the free text', () => {
    expect(
      toWireAnswers([
        { selected: ['a', 'b'], other: '' },
        { selected: [], other: ' my own ' },
        { selected: ['a'], other: 'and more' },
      ]),
    ).toEqual([['a', 'b'], ['my own'], ['a', 'and more']]);
  });
});
