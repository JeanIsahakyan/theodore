import { describe, expect, it } from 'vitest';
import { mockDevices } from '../src/dev/mock';
import {
  agentsLine,
  deviceDetail,
  fingerprintLabel,
  groupDevices,
  trustPrompt,
} from '../src/ui/deviceView';

const fp = '1a2b 3c4d 5e6f 7a8b 9c0d 1e2f 3a4b 5c6d';

describe('Devices wording', () => {
  it('describes a device: kind · OS · online · max mode', () => {
    expect(
      deviceDetail({
        kind: 'desktop',
        os: 'macos',
        online: true,
        acceptsRemote: true,
        maxMode: 'edit',
      }),
    ).toBe('Computer · macOS · online · runs spaces up to Edit');
    expect(
      deviceDetail({
        kind: 'desktop',
        os: 'linux',
        online: false,
        acceptsRemote: false,
        maxMode: 'run',
      }),
    ).toBe('Computer · Linux · offline');
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

  it('lists the agents a computer offers', () => {
    expect(agentsLine([{ label: 'Claude' }, { label: 'Codex' }])).toBe(
      'Claude · Codex',
    );
    expect(agentsLine([])).toBe('');
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
