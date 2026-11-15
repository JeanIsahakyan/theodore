import { describe, expect, it } from 'vitest';
import {
  deviceDetail,
  fingerprintLabel,
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
});
