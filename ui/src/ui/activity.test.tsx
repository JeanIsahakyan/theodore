/** The product events the UI itself reports (docs/telemetry.md), and what
 *  the sharing copy tells people about the account id. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import type { ReportDraft, Space } from '../gen/contract';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { SHARE_ROWS } from './Privacy';
import { ReportProblemView } from './ReportProblem';
import { PlanActions } from './space/SpacePlan';
import { TELEMETRY_CLAIM } from './WhatsCollected';

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('track_ui', () => null);
  transport.onCall('issue_target', () => ({
    repo: 'acme/theodore',
    url: 'https://github.com/acme/theodore',
    login: 'octocat',
    unavailable: null,
  }));
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const tracked = () =>
  transport.calls.filter((c) => c.cmd === 'track_ui').map((c) => c.args);

const draft = (by_agent: boolean): ReportDraft => ({
  id: 'c1',
  chat: 'space:s1',
  scope: 'turn',
  title: 'secret title',
  description: 'secret comment',
  include_logs: true,
  about: 'Space turn 2 of 2',
  by_agent,
});

describe('report_opened', () => {
  it.each([
    ['app', null],
    ['chat', draft(false)],
    ['agent', draft(true)],
  ])('fires once, from %s, without the draft', async (from, d) => {
    transport.onCall('preview_issue', () => ({
      draft: 'd1',
      title: '',
      body: '',
      logs: '',
      log_lines: 0,
      cut_lines: 0,
    }));
    m = await mount(<ReportProblemView draft={d} />);
    await settle();
    expect(tracked()).toEqual([{ event: { event: 'report_opened', from } }]);
  });
});

describe('plan_revised', () => {
  it('fires once per Revise and still opens the composer', async () => {
    let revised = 0;
    m = await mount(
      <PlanActions
        space={{ id: 's1', build_mode: 'edit' } as Space}
        onRevise={() => (revised += 1)}
      />,
    );
    const revise = [...m.host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Revise',
    );
    await click(revise!);
    expect(tracked()).toEqual([{ event: { event: 'plan_revised' } }]);
    expect(revised).toBe(1);
  });
});

describe('what the sharing copy promises', () => {
  it('says an account id is attached, and never calls it anonymous', () => {
    expect(TELEMETRY_CLAIM).toContain('account');
    expect(TELEMETRY_CLAIM).not.toContain('Not linked');
    for (const row of SHARE_ROWS) {
      expect(row.hint).toContain('account');
      expect(row.label.toLowerCase()).not.toContain('anonymous');
    }
  });
});
