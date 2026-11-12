/** A fleet space's page: its lines by kind, the composer and Stop, the
 *  question card, and a space hosted here. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetSpaceLine, FleetSpaceStatus } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import {
  device,
  question,
  remoteSpace,
  status,
  thisDevice,
} from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import { FleetSpacePage } from './FleetSpacePage';

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

const LINES: FleetSpaceLine[] = [
  { seq: 1, kind: 'started', text: 'Started in app' },
  { seq: 2, kind: 'turn', text: 'fix the login bug' },
  { seq: 3, kind: 'tool', text: 'Read src/login.ts' },
  { seq: 4, kind: 'reply', text: 'Found it: **a typo**' },
  { seq: 5, kind: 'question', text: 'Which database?' },
  { seq: 6, kind: 'gap', text: 'history missing' },
  { seq: 7, kind: 'status', text: 'idle' },
  { seq: 8, kind: 'ended', text: 'Turn ended' },
];

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('fleet_space_lines', () => LINES);
  transport.onCall('fleet_send', () => null);
  transport.onCall('fleet_stop', () => null);
  transport.onCall('fleet_answer', () => null);
  setTransport(transport);
  store = new RootStore();
  store.fleet.setStatus(
    status({ devices: [thisDevice(), device({ device_id: 'd2' })] }),
  );
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(s = remoteSpace(), id = s.space): Promise<void> {
  store.fleet.upsertSpace(s);
  m = await mount(
    <RootStoreProvider store={store}>
      <FleetSpacePage id={id} />
    </RootStoreProvider>,
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) =>
  m!.host.querySelector<T>(sel);
const all = (sel: string) => [...m!.host.querySelectorAll<HTMLElement>(sel)];
const box = () =>
  q<HTMLTextAreaElement>('textarea[aria-label="Message to the space"]')!;
const stop = () => q<HTMLButtonElement>('button[aria-label="Stop"]');
const calls = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe('lines', () => {
  it('are loaded on open, after nothing held', async () => {
    await render();
    expect(calls('fleet_space_lines')).toEqual([{ space: 'rs_1', since: 0 }]);
  });

  it('render by kind, in order', async () => {
    await render();
    const lines = all('.fleet-line');
    expect(lines.map((l) => l.dataset.kind)).toEqual(LINES.map((l) => l.kind));
    const of = (kind: string) => lines.find((l) => l.dataset.kind === kind)!;
    expect(of('turn').textContent).toBe('fix the login bug');
    expect(of('turn').className).toContain('justify-end');
    expect(of('tool').className).toContain('font-mono');
    expect(of('tool').textContent).toBe('Read src/login.ts');
    expect(of('reply').querySelector('strong, b')?.textContent).toBe('a typo');
    expect(of('question').textContent).toContain('Which database?');
    expect(of('gap').className).toContain('border-dashed');
    expect(of('ended').textContent).toContain('Turn ended');
    expect(of('started').textContent).toBe('Started in app');
  });

  it('a live line shows up', async () => {
    await render();
    store.fleet.handle({
      type: 'fleet_space_line',
      space: 'rs_1',
      line: { seq: 9, kind: 'reply', text: 'one more thing' },
    });
    await settle();
    expect(all('.fleet-line').at(-1)!.textContent).toContain('one more thing');
  });

  it('a reply from the other device loads no image and has no link to follow', async () => {
    transport.onCall('fleet_space_lines', () => [
      {
        seq: 1,
        kind: 'reply',
        text: [
          '![x](https://evil.example/p.png)',
          '[link](https://evil.example)',
          'https://evil.example/bare',
          '<img src="https://evil.example/raw.png" alt="raw">',
          '<a href="https://evil.example/raw">raw link</a>',
          '<picture><source srcset="https://evil.example/s.png"><img alt="pic"></picture>',
        ].join('\n\n'),
      },
    ]);
    await render();
    const reply = q('.fleet-line[data-kind="reply"]')!;
    expect(reply.querySelector('img')).toBeNull();
    expect(reply.querySelector('a')).toBeNull();
    expect(reply.querySelector('source')).toBeNull();
    expect(reply.querySelector('[href], [src], [srcset]')).toBeNull();
    expect(reply.innerHTML).not.toContain('evil.example/p.png');
    // What it said still reads: alt text and link text.
    expect(reply.textContent).toContain('x');
    expect(reply.textContent).toContain('link');
    expect(reply.textContent).toContain('raw link');
  });
});

describe('header', () => {
  it('names the host, project, mode and status', async () => {
    await render(remoteSpace({ status: 'running' }));
    expect(q('header')!.textContent).toContain('on Studio Mac');
    expect(q('header')!.textContent).toContain('app');
    expect(q('header')!.textContent).toContain('Edit');
    expect(q('.fleet-status')!.textContent).toBe('Running');
  });

  it('shows why a space failed to start', async () => {
    await render(remoteSpace({ status: 'failed', error: 'no such project' }));
    expect(q('.fleet-error')!.textContent).toBe('no such project');
  });

  it('is told when the space is gone', async () => {
    await render(remoteSpace(), 'rs_missing');
    expect(m!.host.textContent).toContain("isn't in your fleet");
  });
});

describe('composer and Stop', () => {
  const states: [FleetSpaceStatus, boolean, boolean][] = [
    ['idle', false, false],
    ['waiting', false, false],
    ['running', true, true],
    ['starting', true, false],
    ['stopped', true, false],
    ['failed', true, false],
  ];
  for (const [st, disabled, stoppable] of states) {
    it(`${st}: composer ${disabled ? 'disabled' : 'open'}, Stop ${stoppable ? 'shown' : 'hidden'}`, async () => {
      await render(remoteSpace({ status: st }));
      expect(box().disabled).toBe(disabled);
      expect(stop() !== null).toBe(stoppable);
    });
  }

  it('sends the message and clears the box', async () => {
    await render(remoteSpace({ status: 'idle' }));
    await typeInto(box(), ' now add tests ');
    await click(q('button[aria-label="Send"]'));
    await settle();
    expect(calls('fleet_send')).toEqual([
      { req: { space: 'rs_1', text: 'now add tests' } },
    ]);
    expect(box().value).toBe('');
  });

  it('Stop stops the space', async () => {
    await render(remoteSpace({ status: 'running' }));
    await click(stop());
    expect(calls('fleet_stop')).toEqual([{ space: 'rs_1' }]);
  });

  it('keeps the text when the send is refused', async () => {
    transport.onCall('fleet_send', () => {
      throw { code: 'fleet.offline', message: 'offline' };
    });
    await render(remoteSpace({ status: 'idle' }));
    await typeInto(box(), 'hello');
    await click(q('button[aria-label="Send"]'));
    await settle();
    expect(box().value).toBe('hello');
  });
});

describe('the open question', () => {
  const withQuestion = (multi = false) =>
    remoteSpace({
      status: 'waiting',
      question: question({
        questions: [
          {
            question: 'Which database?',
            options: ['sqlite', 'postgres'],
            multi,
          },
          { question: 'Why?', options: ['a', 'b'], multi: false },
        ],
      }),
    });

  it('shows the card, and answers with a pick and a free text', async () => {
    await render(withQuestion());
    expect(q('.fleet-question')!.textContent).toContain('Which database?');
    const send = q<HTMLButtonElement>('.fleet-answer')!;
    expect(send.disabled).toBe(true);

    await click(all('.fleet-option').find((b) => b.textContent === 'postgres'));
    await typeInto(
      q('input[aria-label="Other answer to: Why?"]'),
      'because speed',
    );
    expect(send.disabled).toBe(false);
    await click(send);
    await settle();
    expect(calls('fleet_answer')).toEqual([
      {
        req: {
          space: 'rs_1',
          ask_id: 'ask1',
          answers: [['postgres'], ['because speed']],
        },
      },
    ]);
  });

  it('a multi question takes several options', async () => {
    await render(withQuestion(true));
    for (const o of ['sqlite', 'postgres']) {
      await click(all('.fleet-option').find((b) => b.textContent === o));
    }
    await click(all('.fleet-option').find((b) => b.textContent === 'b'));
    await click(q('.fleet-answer'));
    await settle();
    expect(
      (calls('fleet_answer')[0] as { req: { answers: string[][] } }).req
        .answers,
    ).toEqual([['sqlite', 'postgres'], ['b']]);
  });

  it('goes when the question is dismissed', async () => {
    await render(withQuestion());
    store.fleet.handle({ type: 'fleet_ask_dismissed', ask_id: 'ask1' });
    await settle();
    expect(q('.fleet-question')).toBeNull();
  });

  it('shows a routed question about this space too', async () => {
    await render(remoteSpace({ status: 'waiting' }));
    expect(q('.fleet-question')).toBeNull();
    store.fleet.handle({ type: 'fleet_ask', question: question() });
    await settle();
    expect(q('.fleet-question')).not.toBeNull();
  });
});

describe('a space hosted here', () => {
  it('says whom it runs for and links to the local space, with no composer', async () => {
    await render(
      remoteSpace({
        hosted_here: true,
        local_space: 'sp_local',
        origin_device: 'd2',
        host_device: 'd1',
        host_name: 'Laptop',
        status: 'running',
      }),
    );
    expect(q('header')!.textContent).toContain('Running here for Studio Mac');
    expect(q('.fleet-hosted')!.textContent).toContain(
      'Running here for Studio Mac',
    );
    expect(q('textarea')).toBeNull();
    expect(stop()).toBeNull();
    await click(q('.fleet-open-local'));
    expect(store.ui.route).toEqual({ name: 'space', id: 'sp_local' });
  });
});
