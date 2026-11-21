/** A space was asked something (docs/spaces.md "Sub-spaces, and asking
 *  other spaces"): a muted line in its timeline, at its time between turns,
 *  naming who asked; the answer opens under it. */
import { createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../../test/dom';
import type { ChatMessage, Space, SpaceNote } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { installChatLayout, uninstallChatLayout } from '../../test/chatLayout';
import { SpaceChat } from './SpacePage';
import { chatRows, pairTurns } from './chatTurns';
import { spaceChatKey } from './spaces';

Element.prototype.scrollIntoView ??= function () {};

const space = (id: string, over: Partial<Space> = {}): Space => ({
  id,
  project: 'local:app',
  name: id,
  goal: '',
  branch: `theo/${id}`,
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: `/tmp/${id}`,
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 2,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const message = (id: string, at: number, agent = false): ChatMessage => ({
  id,
  pr: spaceChatKey('b'),
  author: agent ? { kind: 'agent', agent: 'claude' } : { kind: 'me' },
  text: `text ${id}`,
  refs: [],
  at,
  failed: null,
});

const note = (id: string, at: number, over: Partial<SpaceNote['ask']> = {}) =>
  ({
    id,
    pr: spaceChatKey('b'),
    at,
    ask: {
      from: { kind: 'space', space: 'a', title: 'Old title of A' },
      question: 'Which store did you pick?\nAnd why?',
      answer: 'SQLite, in `store.rs`.',
      failed: null,
      agent: 'claude',
      model: 'opus',
      how: 'fork',
      ...over,
    },
  }) satisfies SpaceNote;

const CHAT = [
  message('u1', 1),
  message('a1', 2, true),
  message('u2', 10),
  message('a2', 11, true),
];

beforeAll(installChatLayout);
afterAll(uninstallChatLayout);

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(notes: SpaceNote[]) {
  const transport = new FakeTransport();
  transport.onCall('detect_agents', () => []);
  transport.onCall('space_skills', () => []);
  setTransport(transport);
  const store = new RootStore();
  const b = space('b');
  store.sync.pool.put('space', 'a', space('a', { title: 'Plan the API' }));
  store.sync.pool.put('space', 'b', b);
  for (const msg of CHAT) store.sync.pool.put('chat_message', msg.id, msg);
  for (const n of notes) store.sync.pool.put('space_note', n.id, n);
  m = await mount(
    <RootStoreProvider store={store}>
      <SpaceChat space={b} config={null} handle={createRef()} />
    </RootStoreProvider>,
  );
  await settle();
  return store;
}

const order = () =>
  [...m!.host.querySelectorAll<HTMLElement>('[data-msg], [data-note]')].map(
    (e) => e.dataset.msg ?? `note:${e.dataset.note}`,
  );

describe('an ask note', () => {
  it('goes between the turns at its time', () => {
    const rows = chatRows(
      pairTurns(CHAT),
      { head: false, live: false, tail: false },
      [note('late', 20), note('mid', 5)],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'u1',
      'note:mid',
      'u2',
      'note:late',
    ]);
  });

  it('is one muted line naming the asking space; the answer opens on click', async () => {
    await render([note('n1', 5)]);
    expect(order()).toEqual(['u1', 'a1', 'note:n1', 'u2', 'a2']);
    const row = m!.host.querySelector<HTMLElement>('[data-note="n1"]')!;
    expect(row.dataset.variant).toBe('space-note');
    expect(row.className).toContain('text-muted');
    // Named as it is now, first line of the question only.
    expect(row.textContent).toBe(
      'Asked by Plan the API: Which store did you pick?…',
    );
    expect(row.querySelector('.space-note-answer')).toBeNull();

    await click(row.querySelector('.space-note-toggle'));
    const answer = row.querySelector('.space-note-answer');
    expect(answer?.textContent).toContain('SQLite, in store.rs.');
    expect(answer?.textContent).toContain('And why?');
    expect(row.querySelector('.space-note-by')?.textContent).toBe(
      'claude · Opus · forked session',
    );
    await click(row.querySelector('.space-note-toggle'));
    expect(row.querySelector('.space-note-answer')).toBeNull();
  });

  it('names the device for a remote ask, and says why there is no answer', async () => {
    await render([
      note('n2', 12, {
        from: { kind: 'device', name: 'mac-studio' },
        question: 'Done yet?',
        answer: null,
        failed: 'b gave no answer within 120 s; space_read it instead',
        how: 'fresh',
        model: null,
      }),
    ]);
    const row = m!.host.querySelector<HTMLElement>('[data-note="n2"]')!;
    expect(row.textContent).toBe('Asked by mac-studio: Done yet?');
    expect(row.querySelector('button.space-note-from')).toBeNull();
    await click(row.querySelector('.space-note-toggle'));
    expect(row.querySelector('.space-note-failed')?.textContent).toBe(
      'No answer: b gave no answer within 120 s; space_read it instead',
    );
    expect(row.querySelector('.space-note-by')?.textContent).toBe(
      'claude · default model · fresh read',
    );
  });
});
