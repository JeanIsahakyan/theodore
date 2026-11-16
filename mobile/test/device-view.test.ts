import { describe, expect, it } from 'vitest';
import { mockDevices } from '../src/dev/mock';
import {
  deviceLine,
  deviceSummary,
  fingerprintLabel,
  fingerprintLines,
  groupDevices,
  groupOnline,
  trustPrompt,
} from '../src/ui/deviceView';

const fp = '1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d';

describe('Devices wording', () => {
  it('describes a device: OS · max mode · agents', () => {
    const agents = [{ label: 'Claude' }, { label: 'Codex' }];
    expect(
      deviceLine({ os: 'macos', acceptsRemote: true, maxMode: 'edit', agents }),
    ).toBe('macOS · up to Edit · Claude, Codex');
    // Takes no spaces: no mode; an older host: no agents.
    expect(
      deviceLine({
        os: 'linux',
        acceptsRemote: false,
        maxMode: 'run',
        agents: [],
      }),
    ).toBe('Linux');
    expect(
      deviceLine({
        os: 'beos',
        acceptsRemote: true,
        maxMode: 'ask',
        agents: [],
      }),
    ).toBe('other OS · up to Ask');
  });

  it('says a card for a screen reader: name, kind, online, trust', () => {
    expect(
      deviceSummary({
        name: 'Studio',
        kind: 'desktop',
        online: true,
        trusted: false,
      }),
    ).toBe('Studio, Computer, online, not trusted');
    expect(
      deviceSummary({
        name: 'Box',
        kind: 'daemon',
        online: false,
        trusted: true,
      }),
    ).toBe('Box, Server, offline, trusted');
  });

  it('shows a fingerprint large as two lines of four groups', () => {
    expect(fingerprintLines(fp)).toEqual([
      '1a2b 3c4d 5e6f 7a8b',
      '9c0d 1e2f 3a4b 5c6d',
    ]);
    expect(fingerprintLines('1a2b 3c4d')).toEqual(['1a2b 3c4d']);
    expect(fingerprintLines('')).toEqual([]);
  });

  it('counts who is online in a group', () => {
    const on = { online: true };
    const off = { online: false };
    expect(groupOnline([on, off, on])).toBe('2 of 3 online');
    expect(groupOnline([on, on])).toBe('all online');
    expect(groupOnline([on])).toBe('online');
    expect(groupOnline([off, off])).toBe('all offline');
    expect(groupOnline([off])).toBe('offline');
    expect(groupOnline([])).toBe('');
  });

  it('reads a fingerprint group by group', () => {
    expect(fingerprintLabel('1a2b 3c4d')).toBe('Fingerprint 1a2b, 3c4d');
  });

  it('asks to compare the full fingerprint before trusting', () => {
    const prompt = trustPrompt({ name: 'Studio', fingerprint: fp });
    expect(prompt.title).toBe('Make sure Studio shows the same fingerprint:');
    expect(prompt.message).toContain(fp);
    expect(prompt.message).toContain(
      'A trusted device can start and steer spaces, within the highest mode it is allowed.',
    );
    expect(prompt.confirmLabel).toBe('Trust Studio');
    expect(prompt.destructive).toBeUndefined();
  });

  it('groups devices: computers first, online first, then by name', () => {
    const others = mockDevices.filter((d) => !d.thisDevice);
    const browser = {
      ...others[0]!,
      deviceId: 'dev-web',
      name: 'Chrome',
      kind: 'web',
    };
    const groups = groupDevices([browser, ...others]);
    expect(groups.map((g) => g.title)).toEqual([
      'Computers',
      'Phones and browsers',
    ]);
    expect(groups[0]!.devices.map((d) => d.deviceId)).toEqual([
      'dev-box',
      'dev-mac',
      'dev-new',
      'dev-work',
    ]);
    expect(groups[1]!.devices.map((d) => d.deviceId)).toEqual(['dev-web']);
    expect(groupDevices(others).map((g) => g.key)).toEqual(['computers']);
    expect(groupDevices([])).toEqual([]);
  });
});
