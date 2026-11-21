/** `@` mentions of other spaces (docs/spaces.md "Mentions"): the picker
 *  filters and orders the spaces, a pick becomes a chip, the send carries
 *  the ids and the sent message links each space. */
import { act, createRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount, settle, typeInto, type Mounted } from '../../test/dom';
import type { ChatMessage, Space } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { installChatLayout, uninstallChatLayout } from '../../test/chatLayout';
import { SpaceChat } from './SpacePage';
import { spaceChatKey } from './spaces';
import { matchMentionSpaces, mentionPicks, mentionQuery } from './spaceMention';

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
  turns: 1,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const SPACES: Space[] = [
  space('s1', { title: 'This one', updated_at: 50 }),
  space('s2', { title: 'Port the parser', updated_at: 5 }),
  space('s3', {
    title: 'Fix login',
    updated_at: 10,
    status: 'running',
    remote: {
      space: 'rs_3',
      host_device: 'd2',
      host_name: 'Studio',
      project_name: 'web',
      started_here: true,
    },
  }),
  space('s4', { title: 'Old parser work', updated_at: 99, status: 'archived' }),
];

describe('mentionQuery', () => {
  it('is the @word the text ends in', () => {
    expect(mentionQuery('@')).toEqual({ query: '', start: 0 });
    expect(mentionQuery('look at @par')).toEqual({ query: 'par', start: 8 });
    expect(mentionQuery('look at @par ')).toBeNull();
    expect(mentionQuery('mail me@home')).toBeNull();
    expect(mentionQuery('no mention')).toBeNull();
  });
});

describe('matchMentionSpaces', () => {
  const name = () => 'app';
  it('lists the others, recent first, archived only once searched for', () => {
    const rows = matchMentionSpaces(SPACES, 's1', '', name);
    expect(rows.map((r) => r.id)).toEqual(['s3', 's2']);
    expect(rows[0]).toMatchObject({
      title: 'Fix login',
      project: 'web',
      status: 'running',
      host: 'Studio',
    });
    expect(rows[1]).toMatchObject({ project: 'app', host: null });
    // Searched: archived ones too, after the rest.
    const parser = matchMentionSpaces(SPACES, 's1', 'PARSER', name);
    expect(parser.map((r) => [r.id, r.status])).toEqual([
      ['s2', 'idle'],
      ['s4', 'archived'],
    ]);
  });

  it('matches the host, the project and the branch; skips the taken', () => {
    const ids = (q: string, taken?: string[]) =>
      matchMentionSpaces(SPACES, 's1', q, name, taken).map((r) => r.id);
    expect(ids('studio')).toEqual(['s3']);
    expect(ids('web')).toEqual(['s3']);
    expect(ids('theo/s2')).toEqual(['s2']);
    expect(ids('', ['s3'])).toEqual(['s2']);
  });

  it('offers @terminal first while the word fits, on this device only', () => {
    const rows = matchMentionSpaces(SPACES, 's1', '', name);
    expect(mentionPicks(rows, 'ter', true)[0]).toEqual({ kind: 'terminal' });
    expect(mentionPicks(rows, 'x', true).every((p) => p.kind === 'space')).toBe(
      true,
    );
    expect(mentionPicks(rows, '', false).every((p) => p.kind === 'space')).toBe(
      true,
    );
  });
});

beforeAll(installChatLayout);
afterAll(uninstallChatLayout);

let m: Mounted | null = null;
let transport: FakeTransport;

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(messages: ChatMessage[] = []) {
  transport = new FakeTransport();
  transport.onCall('detect_agents', () => []);
  transport.onCall('space_skills', () => []);
  transport.onCall('space_send', () => 'stored');
  setTransport(transport);
  const store = new RootStore();
  for (const s of SPACES) store.sync.pool.put('space', s.id, s);
  for (const msg of messages) store.sync.pool.put('chat_message', msg.id, msg);
  m = await mount(
    <RootStoreProvider store={store}>
      <SpaceChat space={SPACES[0]!} config={null} handle={createRef()} />
    </RootStoreProvider>,
  );
  await settle();
  return store;
}

const box = () => m!.host.querySelector<HTMLTextAreaElement>('textarea')!;
const menu = () => m!.host.querySelector('.mention-menu');
const key = (k: string) =>
  act(async () => {
    box().dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });

describe('the composer', () => {
  it('@ opens the picker, filtered as you type; Esc shuts it', async () => {
    await render();
    await typeInto(box(), 'compare @');
    await settle();
    const rows = () =>
      [...menu()!.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent,
      );
    expect(menu()!.textContent).toContain('Spaces');
    expect(rows()[0]).toContain('@terminal');
    expect(rows()[1]).toContain('Fix login');
    expect(rows()[1]).toContain('web · on Studio');
    expect(rows()[2]).toContain('Port the parser');
    expect(menu()!.textContent).not.toContain('This one');
    expect(menu()!.textContent).not.toContain('Old parser work');

    await typeInto(box(), 'compare @port');
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Port the parser');

    await key('Escape');
    await settle();
    expect(menu()).toBeNull();
  });

  it('a pick is a chip, and the send carries it', async () => {
    await render();
    await typeInto(box(), 'compare @port');
    await settle();
    await key('Enter');
    await settle();
    expect(transport.calls.some((c) => c.cmd === 'space_send')).toBe(false);
    expect(box().value).toBe('compare ');
    const chip = m!.host.querySelector('.mention-strip .mention-chip');
    expect(chip?.textContent).toContain('Port the parser');
    expect(menu()).toBeNull();

    await key('Enter');
    await settle();
    const sent = transport.calls.filter((c) => c.cmd === 'space_send');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args?.req).toMatchObject({
      space: 's1',
      text: 'compare',
      mentions: ['s2'],
    });
    expect(m!.host.querySelector('.mention-chip')).toBeNull();
  });

  it('a chip alone sends, and × or Backspace takes one out', async () => {
    await render();
    for (const q of ['@fix', '@port']) {
      await typeInto(box(), q);
      await settle();
      await key('Enter');
      await settle();
    }
    const chips = () =>
      [...m!.host.querySelectorAll('.mention-chip')].map((c) => c.textContent);
    expect(chips()).toEqual(['Fix login', 'Port the parser']);
    await key('Backspace');
    await settle();
    expect(chips()).toEqual(['Fix login']);
    const send = m!.host.querySelector<HTMLButtonElement>(
      '.chat-input button[aria-label="Send"]',
    )!;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    await settle();
    const sent = transport.calls.filter((c) => c.cmd === 'space_send');
    expect(sent[0]!.args?.req).toMatchObject({ text: '', mentions: ['s3'] });
  });
});

describe('a sent message', () => {
  it('shows its mentions, each opening its space', async () => {
    const store = await render([
      {
        id: 'u1',
        pr: spaceChatKey('s1'),
        author: { kind: 'me' },
        text: 'compare',
        refs: [],
        at: 1,
        failed: null,
        mentions: [
          { space: 's2', title: 'Port the parser', host: null },
          { space: 'gone', title: 'Deleted one', host: null },
        ],
      },
    ]);
    const links = m!.host.querySelectorAll('.mention-link');
    expect([...links].map((l) => l.textContent)).toEqual([
      'Port the parser',
      'Deleted one',
    ]);
    expect(links[1]!.tagName).toBe('SPAN');
    await act(async () => (links[0] as HTMLButtonElement).click());
    expect(store.ui.route).toEqual({ name: 'space', id: 's2' });
  });
});
