/** "Ask AI" on a diff line asks nothing by itself: it puts the line in the
 *  AI composer. The question sent from there shows on that line at once —
 *  before core has even answered the command — and touches only that
 *  line's hunk. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askAboutLine } from '../actions';
import { renderCounts } from '../core/perf';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { PR, mountBigPr } from '../test/bigPr';

describe('asking about a diff line', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;
  let resolve: (id: string) => void = () => {};
  let transport: FakeTransport;

  beforeEach(async () => {
    transport = new FakeTransport();
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

  /** The AI button, then the composer's send with `question`. */
  const askLine = async (i: number, question = 'what is v2?') => {
    await act(async () => askButtons()[i]!.click());
    const anchor = view.store.ephemeral.lineRefs.get(PR)!;
    await act(async () => {
      void askAboutLine(view.store, { pr: PR, anchor, question });
    });
  };

  it('the AI button references the line and asks nothing', async () => {
    await act(async () => askButtons()[2]!.click());
    expect(view.store.ephemeral.lineRefs.get(PR)).toMatchObject({
      path: 'src/mod0/file0.ts',
      side: 'new',
    });
    expect(view.store.ui.asideShown).toBe(true);
    expect(view.store.ephemeral.composerFocus?.pr).toBe(PR);
    expect(hunk().querySelector('.line-ask')).toBeNull();
    expect(transport.calls.some((c) => c.cmd === 'ask')).toBe(false);
  });

  it('shows "Asking claude…" under the line at once', async () => {
    expect(hunk().querySelector('.line-ask')).toBeNull();
    await act(async () => askButtons()[2]!.click());
    const anchor = view.store.ephemeral.lineRefs.get(PR)!;
    renderCounts.reset();
    await act(async () => {
      void askAboutLine(view.store, { pr: PR, anchor, question: 'why?' });
    });

    const pill = hunk().querySelector('.line-ask');
    expect(pill?.textContent).toContain('Asking claude…');
    expect(hunk().querySelectorAll('.ln-asking')).toHaveLength(1);
    expect(view.host.querySelectorAll('.line-ask')).toHaveLength(1);
    expect(renderCounts.get('Hunk')).toBe(1);
  });

  it('turns into "Answered · View" when the reply lands, gone once viewed', async () => {
    await askLine(2);
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

describe('a diff with no AI panel (askAi={false})', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;

  beforeEach(async () => {
    setTransport(new FakeTransport());
    view = await mountBigPr({ askAi: false });
  });

  afterEach(() => view.unmount());

  const menuIds = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    return view.store.ui.contextMenu?.items.map((i) => i.id) ?? [];
  };

  it('offers no AI ask on a line, its menu, its hunk or its comment box', async () => {
    const hunk = view.host.querySelector('#H-f0h0')!;
    expect(
      view.host.querySelector('button[aria-label="ask AI about this line"]'),
    ).toBeNull();

    const line = await menuIds(hunk.querySelectorAll('.ln')[2]!);
    expect(line).toContain('comment');
    expect(line).not.toContain('ask-agent');

    const header = await menuIds(hunk.firstElementChild!);
    expect(header).toContain('mark-read');
    expect(header).not.toContain('ask-agent');

    const anchor = view.rev.files[0]!.hunks[0]!.lines[2]!;
    await act(async () =>
      view.controls().setComposer({
        path: view.rev.files[0]!.path,
        side: 'new',
        line: anchor.new_no!,
      }),
    );
    const box = hunk.querySelector('.composer')!;
    expect(box.textContent).toContain('Suggestion');
    expect(box.textContent).not.toContain('Ask AI');
  });
});
