/** "Ask AI" on a diff line shows on that line at once — before core has
 *  even answered the command — and touches only that line's hunk. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCounts } from '../core/perf';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { PR, mountBigPr } from '../test/bigPr';

describe('asking about a diff line', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;
  let resolve: (id: string) => void = () => {};

  beforeEach(async () => {
    const transport = new FakeTransport();
    transport.onCall('ask', () => new Promise<string>((r) => (resolve = r)));
    setTransport(transport);
    view = await mountBigPr();
  });

  afterEach(() => view.unmount());

  const hunk = () => view.host.querySelector('#H-f0h0')!;
  const askButtons = () =>
    hunk().querySelectorAll<HTMLButtonElement>(
      'button[aria-label="ask AI about this line"]',
    );

  it('shows "Asking claude…" under the line at once', async () => {
    expect(hunk().querySelector('.line-ask')).toBeNull();
    renderCounts.reset();
    await act(async () => askButtons()[2]!.click());

    const pill = hunk().querySelector('.line-ask');
    expect(pill?.textContent).toContain('Asking claude…');
    expect(hunk().querySelectorAll('.ln-asking')).toHaveLength(1);
    expect(view.host.querySelectorAll('.line-ask')).toHaveLength(1);
    expect(renderCounts.get('Hunk')).toBe(1);
  });

  it('turns into "Answered · View" when the reply lands, gone once viewed', async () => {
    await act(async () => askButtons()[2]!.click());
    await act(async () => resolve('q1'));
    await act(async () => {
      view.store.sync.pool.put('chat_message', 'q1', {
        id: 'q1',
        pr: PR,
        author: { kind: 'me' },
        text: 'explain',
        refs: [],
        at: 1,
        failed: null,
      });
      view.store.sync.pool.put('chat_message', 'r1', {
        id: 'r1',
        pr: PR,
        author: { kind: 'agent', agent: 'claude' },
        text: 'it computes',
        refs: [],
        at: 2,
        failed: null,
      });
    });
    const pill = hunk().querySelector('.line-ask')!;
    expect(pill.textContent).toContain('Answered · View');
    expect(hunk().querySelectorAll('.ln-asking')).toHaveLength(0);

    await act(async () => pill.querySelector('button')!.click());
    expect(hunk().querySelector('.line-ask')).toBeNull();
    expect(view.store.ephemeral.askFocus?.message).toBe('r1');
  });
});
