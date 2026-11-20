/** A space past a usage limit (docs/spaces.md "Usage limits"): the notice
 *  row in the chat is a muted system line inside the turn that hit the
 *  limit, not an agent reply; a paused space has a row above the composer
 *  with Continue now and Cancel. */
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../../test/dom';
import type { ChatMessage, Space } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { installChatLayout, uninstallChatLayout } from '../../test/chatLayout';
import { SpaceChat } from './SpacePage';
import { pairTurns } from './chatTurns';
import { spaceChatKey } from './spaces';
import { resetTime } from '../agentLimit';

Element.prototype.scrollIntoView ??= function () {};

const space = (over: Partial<Space> = {}): Space => ({
  id: 's1',
  project: 'local:app',
  name: 's1',
  goal: '',
  branch: 'theo/s1',
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: '/tmp/s1',
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 1,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const message = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
  id,
  pr: spaceChatKey('s1'),
  author: { kind: 'me' },
  text: '',
  refs: [],
  at: 1,
  failed: null,
  ...over,
});

const CONTINUE =
  'Continue from where you stopped (the previous account hit its usage limit).';
const RESET = Date.now() + 3_600_000;

/** you ─ failed reply ─ notice │ you (continue) ─ reply */
const LIMITED_CHAT: ChatMessage[] = [
  message('u1', { text: 'add a flag' }),
  message('a1', {
    author: { kind: 'agent', agent: 'claude' },
    text: '',
    failed: "You've hit your usage limit",
    at: 2,
  }),
  message('n1', {
    author: { kind: 'agent', agent: 'claude' },
    text: 'Claude · personal hit its limit: continuing on Claude · work',
    at: 3,
    notice: {
      kind: 'account_switch',
      from: 'Claude · personal',
      to: 'Claude · work',
      resets_at: RESET,
      continued: true,
    },
  }),
  message('u2', { text: CONTINUE, at: 4 }),
  message('a2', {
    author: { kind: 'agent', agent: 'claude' },
    text: 'Added `--flag`.',
    at: 5,
  }),
];

beforeAll(installChatLayout);
afterAll(uninstallChatLayout);

let m: Mounted | null = null;
let transport: FakeTransport;

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(s: Space, messages: ChatMessage[] = []) {
  transport = new FakeTransport();
  transport.onCall('detect_agents', () => []);
  transport.onCall('space_skills', () => []);
  transport.onCall('space_pause_continue', () => null);
  transport.onCall('space_pause_cancel', () => null);
  setTransport(transport);
  const store = new RootStore();
  store.sync.pool.put('space', s.id, s);
  for (const msg of messages) store.sync.pool.put('chat_message', msg.id, msg);
  m = await mount(
    <RootStoreProvider store={store}>
      <SpaceChat space={s} config={null} handle={createRef()} />
    </RootStoreProvider>,
  );
  await settle();
  return store;
}

describe('a notice row', () => {
  it('stays in the turn that hit the limit, before the continue message', () => {
    const turns = pairTurns(LIMITED_CHAT);
    expect(turns.map((t) => t.messages.map((x) => x.id))).toEqual([
      ['u1', 'a1', 'n1'],
      ['u2', 'a2'],
    ]);
  });

  it('renders as a muted system line, not an agent reply', async () => {
    await render(space(), LIMITED_CHAT);
    const row = m!.host.querySelector<HTMLElement>('[data-msg="n1"]');
    expect(row?.dataset.variant).toBe('notice');
    expect(row?.textContent).toBe(
      `Claude · personal hit its limit (resets ${resetTime(RESET, Date.now())}): continuing on Claude · work`,
    );
    // No vote, copy, agent tag or Back to here on it.
    expect(row?.querySelector('button')).toBeNull();
    expect(row?.querySelector('.agent-tag')).toBeNull();
    // The replies around it are still replies.
    expect(
      m!.host.querySelector<HTMLElement>('[data-msg="a2"]')?.dataset.variant,
    ).toBe('agent');
  });
});

describe('a paused space', () => {
  it('says when it continues, with Continue now and Cancel', async () => {
    await render(
      space({ paused: { until: RESET, agent: 'claude', since: 1 } }),
      LIMITED_CHAT.slice(0, 3),
    );
    const row = m!.host.querySelector('.space-paused');
    expect(row?.textContent).toContain(
      `Paused: limits reset at ${resetTime(RESET, Date.now())} · continues automatically`,
    );
    await click(row?.querySelector('.space-pause-continue'));
    await settle();
    expect(
      transport.calls.find((c) => c.cmd === 'space_pause_continue')?.args,
    ).toEqual({ req: { space: 's1' } });
    await click(row?.querySelector('.space-pause-cancel'));
    await settle();
    expect(
      transport.calls.find((c) => c.cmd === 'space_pause_cancel')?.args,
    ).toEqual({ req: { space: 's1' } });
  });

  it('no reset known: usage limits reached', async () => {
    await render(space({ paused: { until: null, agent: 'claude', since: 1 } }));
    const row = m!.host.querySelector('.space-paused');
    expect(row?.textContent).toContain('Paused: usage limits reached');
    expect(row?.querySelector('.space-pause-continue')).not.toBeNull();
    expect(row?.querySelector('.space-pause-cancel')).not.toBeNull();
  });

  it('not paused: no row', async () => {
    await render(space());
    expect(m!.host.querySelector('.space-paused')).toBeNull();
  });
});
