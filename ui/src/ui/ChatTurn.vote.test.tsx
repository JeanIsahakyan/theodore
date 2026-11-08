import { afterEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import type { ChatMessage as Message, MessageVote } from '../gen/contract';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { ChatMessage } from './ChatTurn';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const reply = (vote: MessageVote | null): Message => ({
  id: 'r1',
  pr: 'space:s1',
  author: { kind: 'agent', agent: 'claude' },
  text: 'the secret reply',
  refs: [],
  at: 1,
  vote,
});

const button = (label: string) =>
  m!.host.querySelector<HTMLElement>(`button[aria-label="${label}"]`);

async function shown(vote: MessageVote | null) {
  const transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('set_message_vote', () => null);
  m = await mount(<ChatMessage m={reply(vote)} />);
  return transport;
}

const voted = (t: FakeTransport) =>
  t.calls.filter((c) => c.cmd === 'set_message_vote').map((c) => c.args);

describe('voting on a reply', () => {
  it('shows the vote the reply holds', async () => {
    await shown('up');
    expect(button('Helpful')!.className).toContain('text-foreground');
    expect(button('Not helpful')!.className).not.toContain('text-foreground');
  });

  it('sends the vote by id, without the text', async () => {
    const t = await shown(null);
    await click(button('Not helpful'));
    await settle();
    expect(voted(t)).toEqual([{ req: { message: 'r1', vote: 'down' } }]);
    expect(JSON.stringify(voted(t))).not.toContain('secret');
  });

  it('takes the vote back when pressed again', async () => {
    const t = await shown('up');
    await click(button('Helpful'));
    await settle();
    expect(voted(t)).toEqual([{ req: { message: 'r1', vote: null } }]);
  });

  it('switches from one vote to the other', async () => {
    const t = await shown('up');
    await click(button('Not helpful'));
    await settle();
    expect(voted(t)).toEqual([{ req: { message: 'r1', vote: 'down' } }]);
  });
});
