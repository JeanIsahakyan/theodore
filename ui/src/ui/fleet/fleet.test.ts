import { describe, expect, it } from 'vitest';
import { confirmRequest, device, thisDevice } from '../../test/fleet';
import {
  autoOn,
  autoUntil,
  autoWarning,
  canFollow,
  capMode,
  confirmAction,
  isAnswered,
  isClient,
  kindLabel,
  lastSeenLabel,
  modesUpTo,
  pickOption,
  startableDevices,
  toWireAnswers,
  typeOther,
  untilLabel,
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
  it('keeps the trusted online ones that take remote spaces, never this one', () => {
    const list = [
      thisDevice({
        trusted: true,
        accepts_remote: true,
        projects: [{ id: 'p', name: 'x' }],
      }),
      device({ device_id: 'ok', trusted: true }),
      device({ device_id: 'untrusted', trusted: false }),
      device({ device_id: 'off', trusted: true, online: false }),
      device({ device_id: 'no', trusted: true, accepts_remote: false }),
      device({ device_id: 'empty', trusted: true, projects: [] }),
    ];
    expect(startableDevices(list).map((d) => d.device_id)).toEqual(['ok']);
  });

  it('never a phone or the web app, even one that claims projects', () => {
    const list = [
      device({ device_id: 'ok', trusted: true }),
      device({ device_id: 'phone', trusted: true, kind: 'mobile' }),
      device({ device_id: 'web', trusted: true, kind: 'web' }),
    ];
    expect(startableDevices(list).map((d) => d.device_id)).toEqual(['ok']);
  });
});

describe('kinds', () => {
  it('a phone and the web app are clients; computers are not', () => {
    expect(isClient(device({ kind: 'mobile' }))).toBe(true);
    expect(isClient(device({ kind: 'web' }))).toBe(true);
    expect(isClient(device({ kind: 'desktop' }))).toBe(false);
    expect(isClient(device({ kind: 'daemon' }))).toBe(false);
  });

  it('Claude via the cloud is a client that follows nothing', () => {
    expect(isClient(device({ kind: 'mcp' }))).toBe(true);
    expect(kindLabel(device({ kind: 'mcp' }))).toBe('Claude via cloud (MCP)');
    expect(canFollow(device({ kind: 'mcp' }))).toBe(false);
    expect(canFollow(device({ kind: 'mobile' }))).toBe(true);
    expect(canFollow(device({ kind: 'desktop' }))).toBe(true);
    expect(canFollow(device({ kind: 'daemon' }))).toBe(false);
    expect(startableDevices([device({ kind: 'mcp', trusted: true })])).toEqual(
      [],
    );
  });

  it('reads as Phone, Web app, or the OS', () => {
    expect(kindLabel(device({ kind: 'mobile' }))).toBe('Phone');
    expect(kindLabel(device({ kind: 'web' }))).toBe('Web app');
    expect(kindLabel(device({ kind: 'desktop', os: 'macos' }))).toBe('macOS');
    expect(kindLabel(device({ kind: 'daemon', os: 'linux' }))).toBe(
      'Linux server',
    );
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

describe('confirmAction', () => {
  it('says what Claude via the cloud would do', () => {
    expect(confirmAction(confirmRequest())).toBe('start an Edit space in app');
    expect(confirmAction(confirmRequest({ mode: 'run' }))).toBe(
      'start a Run space in app',
    );
    expect(
      confirmAction(
        confirmRequest({ action: 'send', space_name: 'Fix login' }),
      ),
    ).toBe('send to Fix login in Edit');
    expect(
      confirmAction(
        confirmRequest({
          action: 'approve_plan',
          space_name: 'Fix login',
          mode: 'run',
        }),
      ),
    ).toBe('approve the plan in Fix login (Run)');
  });
});

describe('auto mode', () => {
  const noon = new Date(2026, 10, 19, 12, 0, 0).getTime();

  it('lasts an hour, to the end of today, or until turned off', () => {
    expect(autoUntil('hour', noon)).toBe(noon + 3_600_000);
    expect(autoUntil('day', noon)).toBe(
      new Date(2026, 10, 19, 23, 59, 59, 999).getTime(),
    );
    expect(autoUntil('off', noon)).toBeNull();
  });

  it('reads its end today, another day, or none', () => {
    expect(untilLabel(null, noon)).toBe('until turned off');
    expect(untilLabel(noon + 3_600_000, noon)).toMatch(/^until \d/);
    expect(untilLabel(noon + 2 * 86_400_000, noon)).toMatch(/^until \D+.*, /);
  });

  it('is on until its end passes', () => {
    expect(autoOn('edit', null, noon)).toBe(true);
    expect(autoOn('full', noon + 1, noon)).toBe(true);
    expect(autoOn('full', noon, noon)).toBe(false);
    expect(autoOn('off', null, noon)).toBe(false);
    expect(autoOn(undefined, null, noon)).toBe(false);
  });

  it('warns about running commands only for full auto', () => {
    expect(autoWarning('edit')).toBe(
      'Its key is held by the Theodore cloud: with auto on, the cloud could make this computer edit without you.',
    );
    expect(autoWarning('full')).toContain('edit and run commands without you');
  });
});
