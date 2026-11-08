/** Reporting from a chat (docs/telemetry.md "Report from a chat"): `/report`
 *  is read off the composer, and "Report this" under a reply drafts the
 *  report about that message and opens the window on it. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import type { ChatMessage as Message, ReportDraft } from '../gen/contract';
import { ChatMessage } from './ChatTurn';
import { reportChat, reportCommand } from './reportChat';

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const drafted: ReportDraft = {
  id: 'd1',
  chat: 'space:s1',
  scope: 'turn',
  title: '',
  description: '',
  include_logs: true,
  about: 'Space turn 2 of 2 · claude',
  by_agent: false,
};

const reply = (o: Partial<Message> = {}): Message => ({
  id: 'r1',
  pr: 'space:s1',
  author: { kind: 'agent', agent: 'claude' },
  text: 'Done.',
  refs: [],
  at: 1,
  failed: null,
  ...o,
});

describe('reportCommand', () => {
  it('reads /report and what follows it', () => {
    expect(reportCommand('/report')).toBe('');
    expect(reportCommand('  /report the agent ignored me ')).toBe(
      'the agent ignored me',
    );
    expect(reportCommand('/report\nline two')).toBe('line two');
  });

  it('leaves everything else, and a skill of yours named report, alone', () => {
    expect(reportCommand('/reporting')).toBeNull();
    expect(reportCommand('please /report')).toBeNull();
    expect(reportCommand('/review')).toBeNull();
    expect(reportCommand('/report it', [{ id: 'report' }])).toBeNull();
  });
});

describe('reporting from a chat', () => {
  it('/report drafts about the latest reply with the text as the description', async () => {
    const store = new RootStore();
    transport.onCall('draft_report', () => drafted);
    await reportChat(store, 'space:s1', null, 'it ignored me');
    expect(transport.calls.find((c) => c.cmd === 'draft_report')?.args).toEqual(
      {
        req: { chat: 'space:s1', message: null, description: 'it ignored me' },
      },
    );
    expect(store.ui.modal).toBe('report-problem');
    expect(store.ui.reportDraft).toEqual(drafted);
    // The plain report, opened later, has no draft.
    store.ui.openModal('report-problem');
    expect(store.ui.reportDraft).toBeNull();
  });

  it('"Report this" under a reply drafts about that message', async () => {
    const store = new RootStore();
    transport.onCall('draft_report', () => drafted);
    m = await mount(
      <RootStoreProvider store={store}>
        <ChatMessage m={reply()} />
      </RootStoreProvider>,
    );
    await click(m.host.querySelector('[aria-label="Report this"]'));
    await settle();
    const req = transport.calls.find((c) => c.cmd === 'draft_report')?.args
      ?.req as Record<string, unknown>;
    expect(req).toMatchObject({ chat: 'space:s1', message: 'r1' });
    expect(store.ui.reportDraft?.id).toBe('d1');
  });

  it('a failed reply offers it next to why it failed', async () => {
    const store = new RootStore();
    m = await mount(
      <RootStoreProvider store={store}>
        <ChatMessage m={reply({ text: '', failed: 'agent crashed' })} />
      </RootStoreProvider>,
    );
    expect(m.host.querySelector('.report-this')?.textContent).toBe(
      'Report this',
    );
  });

  it('without the app around it (a bare render), there is none', async () => {
    m = await mount(<ChatMessage m={reply()} />);
    expect(m.host.querySelector('[aria-label="Report this"]')).toBeNull();
  });
});
