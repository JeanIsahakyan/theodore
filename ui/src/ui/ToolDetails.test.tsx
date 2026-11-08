/** A tool row opens in place: nothing is fetched until it does, it shows the
 *  call's own kind of detail, and a turn from before these were stored still
 *  opens and says so. */
import { act, type ReactNode } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import {
  chatLayout,
  frames,
  installChatLayout,
  layoutRows,
  uninstallChatLayout,
} from '../test/chatLayout';
import type { SavedKept, ToolPayload, TurnStep } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { VirtualChat } from './space/VirtualChat';
import { diffLines, formatBytes, savedNote } from './ToolDetails';
import { TimelineRows } from './TurnTimeline';
import { ToolRunContext, forgetToolPayloads } from './toolPayload';

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;
/** Each test's own: what a row keeps open outlives its test. */
let RUN = '';
let runs = 0;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  store = new RootStore();
  forgetToolPayloads();
  runs += 1;
  RUN = `run-${runs}`;
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(steps: TurnStep[], run: string | null = RUN) {
  m?.unmount();
  m = await mount(tree(steps, run));
}

function tree(steps: TurnStep[], run: string | null): ReactNode {
  return (
    <RootStoreProvider store={store}>
      <ToolRunContext.Provider value={run}>
        <TimelineRows steps={steps} />
      </ToolRunContext.Provider>
    </RootStoreProvider>
  );
}

const tool = (
  name: string,
  id: string | null,
  target: string | null,
  ok: boolean | null,
  extra: Partial<Extract<TurnStep, { kind: 'tool' }>> = {},
): TurnStep => ({ kind: 'tool', name, id, target, ok, ...extra });

const answer = (id: string, payload: ToolPayload | null) =>
  transport.onCall('tool_payload', (args) => {
    expect(args).toEqual({ run: RUN, call: id });
    return payload;
  });

const payloadCalls = () =>
  transport.calls.filter((c) => c.cmd === 'tool_payload').length;

const line = () => m!.host.querySelector<HTMLElement>('.turn-tool-line')!;
const details = () => m!.host.querySelector('.turn-tool-details');

const output = (text: string, original_bytes: number | null = null) => ({
  text,
  original_bytes,
});

const outcome = (overrides: Partial<ToolPayload['result']> = {}) =>
  ({
    ok: true,
    output: null,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration_ms: null,
    interrupted: false,
    background: false,
    ...overrides,
  }) as ToolPayload['result'];

async function open() {
  await click(line());
  await settle();
}

describe('a tool row', () => {
  it('fetches nothing until it opens, then once', async () => {
    answer('t1', {
      input: { value: { command: 'ls' }, original_bytes: null },
      result: outcome({ output: output('a') }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'ls', true)]);
    await settle();
    expect(payloadCalls()).toBe(0);
    expect(details()).toBeNull();
    expect(line().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(line().getAttribute('aria-expanded')).toBe('true');
    expect(details()).not.toBeNull();
    expect(payloadCalls()).toBe(1);
  });

  it('a command: whole, its description, exit and time, stdout and stderr', async () => {
    const command = 'cargo test --workspace\necho "and more"';
    answer('t1', {
      input: {
        value: { command, description: 'Run the tests' },
        original_bytes: null,
      },
      result: outcome({
        stdout: output('all green\n'),
        stderr: output('warning: x\n'),
        exit_code: 0,
        duration_ms: 72_000,
      }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'cargo test --workspace', true)]);
    await open();
    const text = details()!.textContent!;
    expect(text).toContain(command);
    expect(text).toContain('Run the tests');
    expect(text).toContain('exit 0');
    expect(text).toContain('1m 12s');
    expect(text).toContain('Stdout');
    expect(text).toContain('all green');
    expect(text).toContain('Stderr');
    expect(text).toContain('warning: x');
    // Copy buttons on the command and each stream.
    expect(m!.host.querySelectorAll('.turn-detail-copy').length).toBe(3);
  });

  // Real shape (2.1.319): both streams joined in `stdout`, `stderr` empty.
  it('one combined stream is Output, not Stdout', async () => {
    answer('t1', {
      input: { value: { command: 'x' }, original_bytes: null },
      result: outcome({
        stdout: output('to-stdout\nto-stderr'),
        exit_code: 0,
      }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'x', true)]);
    await open();
    const text = details()!.textContent!;
    expect(text).toContain('Output');
    expect(text).not.toContain('Stdout');
    expect(text).toContain('to-stdout');
  });

  // Real shape (2.1.319): a failure's text, its exit code read from it.
  it('a failed command: exit code and error text, in red', async () => {
    answer('t1', {
      input: { value: { command: 'ls nope' }, original_bytes: null },
      result: outcome({
        ok: false,
        output: output('Exit code 1\nout\nerr\nls: nope'),
        exit_code: 1,
      }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'ls nope', false)]);
    await open();
    expect(m!.host.querySelector('.turn-detail-exit')!.textContent).toBe(
      'exit 1',
    );
    expect(m!.host.querySelector('pre.text-danger')?.textContent).toContain(
      'ls: nope',
    );
    expect(details()!.textContent).toContain('Error');
    expect(details()!.textContent).not.toContain('Stdout');
  });

  it('says how much of output saved to a file it shows', async () => {
    const saved = (kept: SavedKept) => savedNote({ bytes: 1_288_895, kept });
    expect(saved('end')).toContain('Only the end');
    expect(saved('end')).toContain('1.2 MB');
    expect(saved('whole')).toContain('The whole output');
    expect(saved('preview')).toContain("couldn't be read");

    answer('t1', {
      input: { value: { command: 'seq 1 200000' }, original_bytes: null },
      result: outcome({
        stdout: output('199999\n200000\n'),
        saved: { bytes: 1_288_895, kept: 'end' },
        exit_code: 0,
      }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'seq 1 200000', true)]);
    await open();
    expect(m!.host.querySelector('.turn-detail-cut')!.textContent).toContain(
      '1.2 MB',
    );
    expect(details()!.textContent).toContain('Only the end');
  });

  it('says when an output was cut, and how large it was', async () => {
    answer('t1', {
      input: { value: { command: 'x' }, original_bytes: null },
      result: outcome({
        stdout: output('kept', 3_565_000),
      }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'x', true)]);
    await open();
    expect(m!.host.querySelector('.turn-detail-cut')!.textContent).toContain(
      '3.4 MB',
    );
  });

  it('a turn from before these were stored still opens, and says so', async () => {
    answer('old', null);
    await render([
      tool('Bash', 'old', 'cargo test', false, { detail: 'Run the tests' }),
    ]);
    await open();
    const text = details()!.textContent!;
    expect(text).toContain('cargo test');
    expect(text).toContain('Run the tests');
    expect(m!.host.querySelector('.turn-detail-missing')).not.toBeNull();
  });

  it('with no run to ask about, opens with what it knows', async () => {
    await render([tool('Read', null, 'a.rs', true)], null);
    await open();
    expect(payloadCalls()).toBe(0);
    expect(details()!.textContent).toContain('a.rs');
    expect(m!.host.querySelector('.turn-detail-missing')).not.toBeNull();
  });

  it('a read or search: its arguments and what it found', async () => {
    answer('t1', {
      input: {
        value: { pattern: 'fn main', path: 'src', output_mode: 'content' },
        original_bytes: null,
      },
      result: outcome({ output: output('src/a.rs:1:fn main()') }),
      report: null,
      ended: null,
    });
    await render([tool('Grep', 't1', 'fn main', true, { detail: 'fn main' })]);
    await open();
    const text = details()!.textContent!;
    expect(text).toContain('pattern: fn main');
    expect(text).toContain('output_mode: content');
    expect(text).toContain('src/a.rs:1:fn main()');
  });

  it('an edit: the change as a diff', async () => {
    answer('t1', {
      input: {
        value: {
          file_path: 'a.rs',
          old_string: 'keep\nold line\nend',
          new_string: 'keep\nnew line\nend',
        },
        original_bytes: null,
      },
      result: outcome({ output: output('updated') }),
      report: null,
      ended: null,
    });
    await render([tool('Edit', 't1', 'a.rs', true)]);
    await open();
    const lines = [...m!.host.querySelectorAll('[data-diff]')].map(
      (l) => `${l.getAttribute('data-diff')}${l.textContent}`,
    );
    expect(lines).toEqual(['   keep', '-- old line', '++ new line', '   end']);
  });

  it('a write: the content written', async () => {
    answer('t1', {
      input: {
        value: { file_path: 'b.txt', content: 'hello\nworld' },
        original_bytes: null,
      },
      result: outcome({ output: output('created') }),
      report: null,
      ended: null,
    });
    await render([tool('Write', 't1', 'b.txt', true)]);
    await open();
    expect(details()!.textContent).toContain('hello\nworld');
  });

  it('an MCP call: arguments and result, JSON pretty-printed', async () => {
    answer('t1', {
      input: { value: { issue: 42 }, original_bytes: null },
      result: outcome({ output: output('{"ok":true}') }),
      report: null,
      ended: null,
    });
    await render([tool('mcp__linear__get_issue', 't1', null, true)]);
    await open();
    const blocks = [...m!.host.querySelectorAll('pre')].map(
      (b) => b.textContent,
    );
    expect(blocks).toContain('{\n  "issue": 42\n}');
    expect(blocks).toContain('{\n  "ok": true\n}');
  });

  it('a background command: running, then its final output', async () => {
    answer('t1', {
      input: {
        value: { command: 'sleep 5', run_in_background: true },
        original_bytes: null,
      },
      result: outcome({ output: output('running as b1'), background: true }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'sleep 5', true, { background: true })]);
    await click(line());
    await settle();
    expect(line().textContent).toContain('in background');
    expect(details()!.textContent).toContain('Ran in the background');

    transport.onCall('tool_payload', () => ({
      input: { value: { command: 'sleep 5' }, original_bytes: null },
      result: outcome({ output: output('running as b1'), background: true }),
      report: null,
      ended: {
        status: 'completed',
        summary: 'exited with code 0',
        output: output('bg-finished'),
        duration_ms: 3000,
      },
    }));
    await act(async () =>
      m!.root.render(
        tree(
          [
            tool('Bash', 't1', 'sleep 5', true, {
              background: true,
              summary: 'exited with code 0',
            }),
          ],
          RUN,
        ),
      ),
    );
    await settle();
    expect(details()!.textContent).toContain('Ended: completed');
    expect(details()!.textContent).toContain('bg-finished');
    // The launch note went stale once its end came: one Output block.
    expect(details()!.textContent).not.toContain('running as b1');
    expect(m!.host.querySelectorAll('.turn-detail-copy').length).toBe(2);
  });

  it('a background call with no end says the turn ended first', async () => {
    answer('t1', {
      input: { value: { command: 'x' }, original_bytes: null },
      result: outcome({ background: true }),
      report: null,
      ended: null,
    });
    await render([tool('Bash', 't1', 'x', true, { background: true })]);
    await open();
    expect(details()!.textContent).toContain('the turn ended before it did');
  });

  it('opens on Enter and on Space, not on other keys', async () => {
    answer('t1', null);
    await render([tool('Read', 't1', 'a.rs', true)]);
    const press = (key: string) =>
      act(async () => {
        line().dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    await press('a');
    expect(line().getAttribute('aria-expanded')).toBe('false');
    await press('Enter');
    expect(line().getAttribute('aria-expanded')).toBe('true');
    await press(' ');
    expect(line().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open when scrolled away and back', async () => {
    answer('t1', null);
    const steps = [tool('Read', 't1', 'a.rs', true)];
    await render(steps);
    await click(line());
    await settle();
    await render(steps);
    expect(line().getAttribute('aria-expanded')).toBe('true');
    expect(details()).not.toBeNull();
    // Read from memory: no second fetch, no second layout.
    expect(payloadCalls()).toBe(1);
  });

  it('a row in a group opens too', async () => {
    answer('t2', {
      input: { value: { file_path: 'b.rs' }, original_bytes: null },
      result: outcome({ output: output('content of b') }),
      report: null,
      ended: null,
    });
    await render([
      tool('Read', 't1', 'a.rs', true),
      tool('Read', 't2', 'b.rs', true),
    ]);
    const group = m!.host.querySelector<HTMLButtonElement>('.turn-group-line');
    await click(group!);
    const rows = m!.host.querySelectorAll<HTMLElement>('.turn-tool-line');
    expect(rows.length).toBe(2);
    await click(rows[1]!);
    await settle();
    expect(details()!.textContent).toContain('content of b');
  });
});

describe('a subagent row', () => {
  /** Its own call id per test: a subagent's open state is by call id alone. */
  const agentId = () => `agent-${RUN}`;
  const agent = (over: Partial<Extract<TurnStep, { kind: 'tool' }>> = {}) =>
    tool('Agent', agentId(), null, true, {
      detail: 'Check the docs',
      ...over,
    });
  const agentLine = () =>
    m!.host.querySelector<HTMLElement>('.turn-agent-line')!;

  it('shows its prompt, type, status and whole report', async () => {
    const report = `First line\n${'more '.repeat(200)}`;
    answer(agentId(), {
      input: {
        value: {
          prompt: 'Read the docs and report',
          subagent_type: 'Explore',
          model: 'sonnet',
          description: 'Check the docs',
        },
        original_bytes: null,
      },
      result: outcome({ output: output('pointer') }),
      report: output(report),
      ended: null,
    });
    await render([
      agent({ summary: 'First line' }),
      {
        kind: 'tool',
        name: 'Read',
        id: 'n1',
        target: 'a.md',
        ok: true,
        parent: agentId(),
      },
    ]);
    await click(agentLine());
    await settle();
    const steps = m!.host.querySelector('.turn-agent-steps')!.textContent!;
    expect(steps).toContain('Read the docs and report');
    expect(m!.host.querySelector('.turn-detail-type')?.textContent).toBe(
      'Explore',
    );
    expect(m!.host.querySelector('.turn-detail-model')?.textContent).toBe(
      'sonnet',
    );
    expect(
      m!.host.querySelector('.turn-detail-agent-status')?.textContent,
    ).toBe('done');
    // Its steps, as they nest.
    expect(steps).toContain('a.md');
    expect(m!.host.querySelector('.turn-agent-summary')!.textContent).toBe(
      report,
    );
  });

  // Real shape (2.1.319): `tool_use_result.resolvedModel` over the input's.
  it('names the model it really ran on', async () => {
    answer(agentId(), {
      input: {
        value: { prompt: 'Go', model: 'sonnet' },
        original_bytes: null,
      },
      result: outcome({
        output: output('pointer'),
        resolved_model: 'claude-haiku-5-5',
      }),
      report: output('Done.'),
      ended: null,
    });
    await render([agent({ summary: 'Done.' })]);
    await click(agentLine());
    await settle();
    expect(m!.host.querySelector('.turn-detail-model')?.textContent).toBe(
      'claude-haiku-5-5',
    );
  });

  it('shows its report once: not its last message again', async () => {
    const report = 'The answer is 42.\nHere is why.';
    answer(agentId(), {
      input: { value: { prompt: 'Find it' }, original_bytes: null },
      result: outcome({ output: output('pointer') }),
      report: output(report),
      ended: null,
    });
    await render([
      agent({ summary: 'The answer is 42.' }),
      {
        kind: 'tool',
        name: 'Read',
        id: 'n1',
        target: 'a.md',
        ok: true,
        parent: agentId(),
      },
      { kind: 'text', text: report, parent: agentId() },
    ]);
    await click(agentLine());
    await settle();
    const steps = m!.host.querySelector('.turn-agent-steps')!.textContent!;
    expect(steps.split('The answer is 42.').length - 1).toBe(1);
    expect(steps).toContain('a.md');
  });

  it('with nothing stored, what it knows and a quiet note', async () => {
    answer(agentId(), null);
    await render([agent({ summary: 'It was fine' })]);
    await click(agentLine());
    await settle();
    expect(m!.host.querySelector('.turn-agent-summary')!.textContent).toBe(
      'It was fine',
    );
    expect(m!.host.querySelector('.turn-detail-missing')).not.toBeNull();
  });

  it('opens even with no steps and no summary', async () => {
    answer(agentId(), null);
    await render([agent()]);
    expect(agentLine().tagName).toBe('BUTTON');
    await click(agentLine());
    await settle();
    expect(payloadCalls()).toBe(1);
  });
});

describe('helpers', () => {
  it('a diff keeps what is shared at either end', () => {
    expect(diffLines('a\nb\nc', 'a\nx\ny\nc')).toEqual([
      { kind: ' ', line: 'a' },
      { kind: '-', line: 'b' },
      { kind: '+', line: 'x' },
      { kind: '+', line: 'y' },
      { kind: ' ', line: 'c' },
    ]);
    expect(diffLines('', 'new')).toEqual([{ kind: '+', line: 'new' }]);
  });

  it('a diff has no empty line from a final newline', () => {
    expect(diffLines('a\nb\n', 'a\nc\n')).toEqual([
      { kind: ' ', line: 'a' },
      { kind: '-', line: 'b' },
      { kind: '+', line: 'c' },
    ]);
    expect(diffLines('', 'one\ntwo\n')).toEqual([
      { kind: '+', line: 'one' },
      { kind: '+', line: 'two' },
    ]);
  });

  it('sizes read as a person would say them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(3_565_000)).toBe('3.4 MB');
    expect(formatBytes(50_000_000)).toBe('48 MB');
  });
});

describe('in a virtual chat', () => {
  beforeAll(installChatLayout);
  afterAll(uninstallChatLayout);
  beforeEach(() => {
    chatLayout.heights.clear();
    chatLayout.rowHeight = 100;
    chatLayout.view = 400;
  });

  const items = Array.from({ length: 50 }, (_, i) => ({ key: `t${i}` }));
  const chatScope = () => `tool-details-${Math.random()}`;

  const chat = (id: string) => (
    <RootStoreProvider store={store}>
      <VirtualChat
        scope={id}
        items={items}
        estimate={() => 100}
        renderItem={(item) => (
          <div data-row={item.key}>
            <ToolRunContext.Provider value={RUN}>
              <TimelineRows steps={[tool('Bash', item.key, 'ls', true)]} />
            </ToolRunContext.Provider>
          </div>
        )}
      />
    </RootStoreProvider>
  );

  const log = () => m!.host.querySelector<HTMLElement>('.chat-log')!;
  const rowLine = (id: string) =>
    m!.host.querySelector<HTMLElement>(`[data-row="${id}"] .turn-tool-line`)!;
  const onScreen = (id: string) => {
    const item = m!.host
      .querySelector(`[data-row="${id}"]`)!
      .closest('[data-index]') as HTMLElement;
    const top = Number(
      /translateY\((-?[\d.]+)px\)/.exec(item.style.transform)![1],
    );
    return top - log().scrollTop;
  };

  it('stays where you clicked it as its output lands and grows the row', async () => {
    let answerNow!: (p: ToolPayload) => void;
    transport.onCall(
      'tool_payload',
      () => new Promise((resolve) => (answerNow = resolve)),
    );
    m = await mount(chat(chatScope()));
    layoutRows();
    await frames();
    const before = onScreen('t49');

    await act(async () => rowLine('t49').click());
    chatLayout.heights.set(49, 200);
    layoutRows();
    await frames();
    expect(onScreen('t49')).toBe(before);

    // The fetch lands after the toggle settled: the row measures taller again.
    await act(async () =>
      answerNow({
        input: { value: { command: 'ls' }, original_bytes: null },
        result: outcome({ output: output('line\n'.repeat(100)) }),
        report: null,
        ended: null,
      }),
    );
    chatLayout.heights.set(49, 900);
    layoutRows();
    await frames();
    expect(onScreen('t49')).toBe(before);
    expect(m!.host.querySelector('.chat-jump')).toBeNull();
  });
});
