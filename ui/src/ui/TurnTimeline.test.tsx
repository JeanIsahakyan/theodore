/** A turn's rows, the folded line above a finished reply, and the live chat
 *  bubble's two looks: a space's timeline and the AI panel's text and tools. */
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, type Mounted } from '../test/dom';
import type { ChatMessage as Message, TurnStep } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { ChatLive, ChatMessage } from './ChatTurn';
import {
  TimelineRows,
  TurnActivity,
  formatDuration,
  workedLine,
} from './TurnTimeline';

let m: Mounted | null = null;
let store: RootStore;

beforeEach(() => {
  setTransport(new FakeTransport());
  store = new RootStore();
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(node: ReactNode) {
  m?.unmount();
  m = await mount(<RootStoreProvider store={store}>{node}</RootStoreProvider>);
}

const steps: TurnStep[] = [
  { kind: 'text', text: 'Reading the config.' },
  { kind: 'tool', name: 'Read', target: 'config/load.rs', ok: true },
  { kind: 'thinking', text: 'Where\nis it?' },
  { kind: 'text', text: 'Now running it.' },
  { kind: 'tool', name: 'Bash', target: 'cargo test', ok: false },
  { kind: 'tool', name: 'ask you', target: null, ok: null },
];

const rowsOf = (root: Element) =>
  [...root.querySelector('.turn-timeline')!.children].map(
    (r) => r.classList[0],
  );

describe('TimelineRows', () => {
  it('lists every step flat, in the order given', async () => {
    await render(<TimelineRows steps={steps} />);
    expect(rowsOf(m!.host)).toEqual([
      'turn-text',
      'turn-tool',
      'turn-thinking',
      'turn-text',
      'turn-tool',
      'turn-tool',
    ]);
  });

  it('a tool row: its kind, a human label, its target, a failure', async () => {
    await render(<TimelineRows steps={steps} />);
    const [read, bash, ask] = [...m!.host.querySelectorAll('.turn-tool')];
    expect(read!.getAttribute('data-kind')).toBe('read');
    expect(read!.textContent).toBe('Readconfig/load.rs');
    expect(read!.querySelector('[title="config/load.rs"]')).not.toBeNull();
    expect(read!.querySelector('.turn-tool-failed')).toBeNull();

    expect(bash!.getAttribute('data-kind')).toBe('run');
    expect(bash!.textContent).toContain('Run');
    expect(bash!.querySelector('.turn-tool-failed')).not.toBeNull();

    expect(ask!.textContent).toBe('Ask you');
    expect(ask!.querySelector('.turn-tool-failed')).toBeNull();
  });

  it('thinking is one line until a click opens it', async () => {
    await render(<TimelineRows steps={steps} />);
    const row = m!.host.querySelector<HTMLButtonElement>('.turn-thinking')!;
    const text = () => row.querySelector('.turn-thinking-text')!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(text().textContent).toBe('Where is it?');
    expect(text().className).toContain('truncate');
    await click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(text().textContent).toBe('Where\nis it?');
  });

  it('spins on the newest row only while running', async () => {
    const spinners = () =>
      m!.host.querySelectorAll(
        '[data-slot="spinner"], .spinner, [role="progressbar"]',
      ).length;
    await render(<TimelineRows steps={steps} />);
    const still = spinners();
    await render(<TimelineRows steps={steps} running />);
    expect(spinners()).toBe(still + 1);
    const last = [...m!.host.querySelectorAll('.turn-tool')].at(-1)!;
    expect(last.querySelector('svg.size-3\\.5')).toBeNull();
  });

  it('skips a text step with nothing to show yet', async () => {
    await render(
      <TimelineRows
        steps={[
          { kind: 'tool', name: 'Read', target: null, ok: true },
          { kind: 'text', text: '\n\n' },
        ]}
      />,
    );
    expect(rowsOf(m!.host)).toEqual(['turn-tool']);
  });
});

describe('a finished reply', () => {
  const reply = (over: Partial<Message> = {}): Message => ({
    id: 'a1',
    pr: 'space:s1',
    author: { kind: 'agent', agent: 'claude' },
    text: 'All done.',
    refs: [],
    at: 1_700_000_000_000,
    activity: steps,
    duration_ms: 72_000,
    ...over,
  });

  it('folds its steps to one line above the reply, the footer beside the actions', async () => {
    await render(<ChatMessage m={reply()} />);
    const line = m!.host.querySelector('.turn-activity-summary')!;
    expect(line.textContent).toContain('Worked 1m 12s · 6 steps');
    expect(m!.host.querySelector('.turn-timeline')).toBeNull();
    // Above the reply's text.
    const order = line.compareDocumentPosition(
      [...m!.host.querySelectorAll('p')].find(
        (p) => p.textContent === 'All done.',
      )!,
    );
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const footer = m!.host.querySelector('.turn-footer')!;
    expect(footer.textContent).toContain('1m 12s');
    expect(
      footer.parentElement!.querySelector('.message-actions'),
    ).not.toBeNull();
  });

  it('opens on a click, and stays open across a remount; another reply stays closed', async () => {
    await render(
      <TurnActivity reply="kept-open" steps={steps} durationMs={1000} />,
    );
    await click(m!.host.querySelector('.turn-activity-summary'));
    expect(m!.host.querySelector('.turn-timeline')).not.toBeNull();

    await render(
      <TurnActivity reply="kept-open" steps={steps} durationMs={1000} />,
    );
    expect(m!.host.querySelector('.turn-timeline')).not.toBeNull();

    await render(
      <TurnActivity reply="never-opened" steps={steps} durationMs={1000} />,
    );
    expect(m!.host.querySelector('.turn-timeline')).toBeNull();
  });

  it('a stopped one keeps its steps, text and footer next to why it ended', async () => {
    await render(<ChatMessage m={reply({ failed: 'stopped' })} />);
    expect(m!.host.querySelector('.turn-activity-summary')).not.toBeNull();
    expect(m!.host.querySelector('.agent-failed')?.textContent).toContain(
      'stopped',
    );
    expect(m!.host.textContent).toContain('All done.');
    expect(m!.host.querySelector('.turn-footer')).not.toBeNull();
    expect(m!.host.querySelector('.message-actions')).toBeNull();
  });

  it('an AI panel reply, or an older row: no line, no footer', async () => {
    await render(
      <ChatMessage
        m={reply({ activity: undefined, duration_ms: undefined })}
      />,
    );
    expect(m!.host.querySelector('.turn-activity')).toBeNull();
    expect(m!.host.querySelector('.turn-footer')).toBeNull();
    expect(m!.host.querySelector('.message-actions')).not.toBeNull();
  });
});

describe('ChatLive', () => {
  const delta = (text: string) =>
    act(() =>
      store.ephemeral.handle({
        type: 'agent_delta',
        run: 'r1',
        agent: 'claude',
        text,
      }),
    );
  const log = (line: string) =>
    act(() =>
      store.ephemeral.handle({
        type: 'run_log',
        run: 'r1',
        agent: 'claude',
        line,
      }),
    );
  const stall = () =>
    act(() =>
      store.ephemeral.handle({
        type: 'run_stalled',
        run: 'r1',
        agent: 'claude',
      }),
    );

  it('as a timeline: dots, then the rows growing in the order they came', async () => {
    await render(<ChatLive run="r1" agent="claude" timeline />);
    expect(
      m!.host.querySelector('[aria-label="Agent is thinking"]'),
    ).not.toBeNull();
    delta('Looking');
    delta(' around.');
    log('tool: Read · src/a.rs');
    log('tool result ok=true');
    delta('Found it.');
    expect(rowsOf(m!.host)[0]).toBe('turn-text');
    expect(rowsOf(m!.host).slice(1, 3)).toEqual(['turn-tool', 'turn-text']);
    expect(m!.host.querySelector('.turn-text')?.textContent).toBe(
      'Looking around.',
    );
    expect(
      m!.host.querySelector('[aria-label="Agent is thinking"]'),
    ).toBeNull();
  });

  it('as a timeline, stalled: the note goes under the text, not over it', async () => {
    await render(<ChatLive run="r1" agent="claude" timeline />);
    delta('Half an answer');
    stall();
    const text = m!.host.querySelector('.turn-text')!;
    const hint = m!.host.querySelector('.agent-stalled')!;
    expect(text.textContent).toBe('Half an answer');
    expect(
      text.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('in the AI panel: text, then folded tools, the stall note under them', async () => {
    await render(<ChatLive run="r1" agent="claude" />);
    delta('Half an answer');
    log('tool: Read · src/a.rs');
    stall();
    expect(m!.host.querySelector('.live-text')?.textContent).toBe(
      'Half an answer',
    );
    expect(m!.host.querySelector('.turn-timeline')).toBeNull();
    expect(m!.host.querySelector('.runlog, [aria-expanded]')).not.toBeNull();
    expect(m!.host.querySelector('.agent-stalled')).not.toBeNull();
  });

  it('stalled before any text: only the note, no dots', async () => {
    await render(<ChatLive run="r1" agent="claude" />);
    stall();
    expect(m!.host.querySelector('.agent-stalled')).not.toBeNull();
    expect(
      m!.host.querySelector('[aria-label="Agent is thinking"]'),
    ).toBeNull();
  });
});

describe('the lines', () => {
  it('formats a duration', () => {
    expect(formatDuration(400)).toBe('<1s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(59_600)).toBe('1m 0s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });

  it('counts steps', () => {
    expect(workedLine(1, 72_000)).toBe('Worked 1m 12s · 1 step');
    expect(workedLine(12, null)).toBe('Worked · 12 steps');
  });
});
