import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import type { TelemetryStatus } from '../gen/contract';
import { WhatsCollectedView } from './WhatsCollected';

const status: TelemetryStatus = {
  usage_available: true,
  errors_available: true,
  usage: true,
  errors: false,
  events: [
    { name: 'app_started', fields: ['version', 'os'] },
    { name: 'review_opened', fields: ['files', 'repo_hash'] },
  ],
  never_sent: ['Source code or diffs', 'File paths'],
};

let m: Mounted | null = null;

afterEach(() => {
  m?.unmount();
  m = null;
});

describe('WhatsCollectedView', () => {
  it('lists every event with its fields and what is never sent', async () => {
    m = await mount(<WhatsCollectedView status={status} />);
    const events = [...m.host.querySelectorAll('.telemetry-events li')].map(
      (li) => li.textContent,
    );
    expect(events).toEqual([
      'app_started version, os',
      'review_opened files, repo_hash',
    ]);
    const never = [...m.host.querySelectorAll('.telemetry-never li')].map(
      (li) => li.textContent,
    );
    expect(never).toEqual(['Source code or diffs', 'File paths']);
    expect(m.host.textContent).toContain('repository names are hashed');
  });
});
