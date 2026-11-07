/** A long chat's scrolling: it follows new content only from the bottom,
 *  leaves you where you scrolled, reopens by row and offset, and a row's own
 *  toggle moves nothing. jsdom has no layout: `chatLayout` stands in for it. */
import { act, useState } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { mount, type Mounted } from '../../test/dom';
import {
  chatLayout,
  frames,
  installChatLayout,
  layoutRows,
  layoutView,
  uninstallChatLayout,
  userScroll,
} from '../../test/chatLayout';
import { useKeptOpen, useSteadyChange } from '../rowState';
import { VirtualChat } from './VirtualChat';

let m: Mounted | null = null;
let scopes = 0;
const scope = () => `scope-${(scopes += 1)}`;

beforeAll(installChatLayout);
afterAll(uninstallChatLayout);

beforeEach(() => {
  chatLayout.heights.clear();
  chatLayout.rowHeight = 100;
  chatLayout.view = 400;
});

afterEach(() => {
  m?.unmount();
  m = null;
});

type Item = { key: string };
const rows = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ key: `t${i}` }));
const estimate = () => 100;

function chat(items: Item[], id: string, isPinned?: (i: Item) => boolean) {
  return (
    <VirtualChat
      scope={id}
      items={items}
      estimate={estimate}
      isPinned={isPinned}
      renderItem={(item) => <Row id={item.key} />}
    />
  );
}

/** A row with a toggle, like a turn's "Worked" line. */
function Row({ id }: { id: string }) {
  const [open, setOpen] = useKeptOpen(`test:${id}`);
  const [typed, setTyped] = useState('');
  const steady = useSteadyChange();
  return (
    <div className="row" data-row={id} data-open={open}>
      <button type="button" onClick={() => steady(() => setOpen(!open))}>
        toggle
      </button>
      <input value={typed} onChange={(e) => setTyped(e.target.value)} />
    </div>
  );
}

async function open(items: Item[], id: string, pin?: (i: Item) => boolean) {
  m?.unmount();
  m = await mount(chat(items, id, pin));
  layoutRows();
  await frames();
}

async function update(items: Item[], id: string) {
  await act(async () => m!.root.render(chat(items, id)));
  layoutRows();
}

const log = () => m!.host.querySelector<HTMLElement>('.chat-log')!;
const pill = () => m!.host.querySelector<HTMLButtonElement>('.chat-jump');
const end = () => log().scrollHeight - log().clientHeight;
const mounted = () =>
  [...m!.host.querySelectorAll('[data-row]')].map((r) =>
    r.getAttribute('data-row'),
  );
const row = (id: string) =>
  m!.host.querySelector<HTMLElement>(`[data-row="${id}"]`);

/** The row's position in the scrolled content. */
const rowTop = (id: string) => {
  const item = row(id)!.closest('[data-index]') as HTMLElement;
  return Number(/translateY\((-?[\d.]+)px\)/.exec(item.style.transform)![1]);
};
/** Where the row shows in the view. */
const onScreen = (id: string) => rowTop(id) - log().scrollTop;

describe('a virtual chat', () => {
  it('opens at the bottom, mounting only the rows near it', async () => {
    await open(rows(200), scope());
    expect(log().scrollTop).toBe(end());
    expect(pill()).toBeNull();
    expect(mounted()).toContain('t199');
    expect(mounted()).not.toContain('t0');
    expect(mounted().length).toBeLessThan(20);
  });

  it('a new turn is followed from the bottom', async () => {
    const id = scope();
    await open(rows(50), id);
    await update(rows(51), id);
    await frames();
    expect(mounted()).toContain('t50');
    expect(log().scrollTop).toBe(end());
  });

  it('a running turn growing is followed from the bottom', async () => {
    await open(rows(50), scope());
    chatLayout.heights.set(49, 900);
    layoutRows();
    await frames();
    expect(log().scrollTop).toBe(end());
    expect(pill()).toBeNull();
  });

  it('scrolled up: nothing moves through new content, the pill brings it back', async () => {
    const id = scope();
    await open(rows(50), id);
    userScroll(log(), 1000);
    expect(pill()?.textContent).toContain('Jump to latest');

    // The running turn grows below the view, a new one lands below that.
    chatLayout.heights.set(49, 900);
    layoutRows();
    await update(rows(51), id);
    await frames();
    expect(log().scrollTop).toBe(1000);

    await act(async () => pill()!.click());
    await frames();
    expect(log().scrollTop).toBe(end());
    expect(pill()).toBeNull();
    chatLayout.heights.set(50, 700);
    layoutRows();
    await frames();
    expect(log().scrollTop).toBe(end());
  });

  it('a small scroll up while text streams is not pulled back', async () => {
    await open(rows(50), scope());
    const at = end() - 30;
    userScroll(log(), at);
    chatLayout.heights.set(49, 300);
    layoutRows();
    await frames();
    expect(log().scrollTop).toBe(at);
    expect(pill()).not.toBeNull();
  });

  it('scrolling back near the bottom follows again', async () => {
    await open(rows(50), scope());
    userScroll(log(), 1000);
    userScroll(log(), end() - 40);
    expect(pill()).toBeNull();
    chatLayout.heights.set(49, 500);
    layoutRows();
    await frames();
    expect(log().scrollTop).toBe(end());
  });

  it('stays at the bottom when the view shrinks (a taller composer)', async () => {
    await open(rows(50), scope());
    chatLayout.view = 300;
    layoutView();
    await frames();
    expect(log().scrollTop).toBe(end());
    expect(pill()).toBeNull();
  });

  it('a row above the view measuring taller leaves what you read where it is', async () => {
    await open(rows(50), scope());
    userScroll(log(), 1000);
    const before = onScreen('t10');
    chatLayout.heights.set(9, 400);
    // A row re-measures only while mounted; bring it through the range.
    userScroll(log(), 950);
    layoutRows();
    await frames();
    expect(Math.abs(onScreen('t10') - (before + 50))).toBeLessThanOrEqual(1);
  });

  it('keeps a pinned row mounted, and what you typed in it, while scrolled away', async () => {
    const items = [...rows(50), { key: 'tail' }];
    await open(items, scope(), (i) => i.key === 'tail');
    const box = row('tail')!.querySelector('input')!;
    userScroll(log(), 100);
    await frames();
    expect(row('t1')).not.toBeNull();
    expect(row('tail')?.querySelector('input')).toBe(box);
  });

  it('a row keeps its node while the list around it changes', async () => {
    const id = scope();
    await open(rows(20), id);
    const node = row('t19');
    await update(rows(21), id);
    expect(row('t19')).toBe(node);
  });
});

describe('reopening a chat', () => {
  it('restores the row and the offset into it, not the raw position', async () => {
    const id = scope();
    await open(rows(50), id);
    userScroll(log(), 1030); // 10px into a row, under 20px of padding
    const key = 't10';
    expect(rowTop(key) - 1030).toBe(-10);
    m!.unmount();

    // More turns came, and an earlier row's size changed.
    m = await mount(chat(rows(60), id));
    layoutRows();
    await frames(6);
    expect(rowTop(key) - log().scrollTop).toBe(-10);
    expect(pill()).not.toBeNull();
  });

  it('left at the bottom, reopens at the bottom, past what came since', async () => {
    const id = scope();
    await open(rows(50), id);
    await open(rows(60), id);
    expect(log().scrollTop).toBe(end());
    expect(mounted()).toContain('t59');
    expect(pill()).toBeNull();
  });

  it('a row that is gone: at the bottom', async () => {
    const id = scope();
    await open(rows(50), id);
    userScroll(log(), 1000);
    await open(
      rows(50).map((r) => ({ key: `new-${r.key}` })),
      id,
    );
    expect(log().scrollTop).toBe(end());
    expect(pill()).toBeNull();
  });

  it('the jump forgets the place', async () => {
    const id = scope();
    await open(rows(50), id);
    userScroll(log(), 1000);
    await act(async () => pill()!.click());
    await open(rows(50), id);
    expect(log().scrollTop).toBe(end());
  });

  it('any input of yours cancels the restore', async () => {
    for (const input of [
      new WheelEvent('wheel', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }),
      new Event('pointerdown', { bubbles: true }),
      new Event('touchstart', { bubbles: true }),
    ]) {
      const id = scope();
      await open(rows(50), id);
      userScroll(log(), 1000);
      m!.unmount();

      m = await mount(chat(rows(50), id));
      // You take over before the rows above have been measured.
      act(() => {
        document.body.dispatchEvent(input);
        log().scrollTop = 300;
        log().dispatchEvent(new Event('scroll'));
      });
      layoutRows();
      await frames(4);
      expect(log().scrollTop).toBe(300);
    }
  });

  it('a first open has no place to go back to', async () => {
    await open(rows(50), scope());
    expect(log().scrollTop).toBe(end());
  });
});

describe('a row toggled in place', () => {
  const toggle = async (id: string) => {
    await act(async () =>
      row(id)!.querySelector<HTMLButtonElement>('button')!.click(),
    );
  };

  it('opening it at the bottom keeps it where it is', async () => {
    await open(rows(50), scope());
    const before = onScreen('t49');
    await toggle('t49');
    chatLayout.heights.set(49, 900);
    layoutRows();
    await frames();
    expect(onScreen('t49')).toBe(before);
    // What it pushed down is below you now.
    expect(pill()).not.toBeNull();
  });

  it('closing it at the bottom keeps it where it is, and the room melts as you scroll up', async () => {
    chatLayout.heights.set(49, 900);
    await open(rows(50), scope());
    const top = log().scrollTop;
    const before = onScreen('t49');
    await toggle('t49');
    chatLayout.heights.delete(49);
    layoutRows();
    await frames();
    expect(log().scrollTop).toBe(top);
    expect(onScreen('t49')).toBe(before);
    expect(pill()).toBeNull();

    // Nothing to read below: the held room goes as you leave it.
    userScroll(log(), top - 300);
    expect(log().scrollHeight).toBe(top - 300 + log().clientHeight);
    expect(log().scrollTop).toBe(top - 300);
    userScroll(log(), 1000);
    const sizer = log().firstElementChild as HTMLElement;
    expect(sizer.style.minHeight).toBe('');
  });

  it('a row spanning the top of the view stays too', async () => {
    chatLayout.heights.set(30, 600);
    await open(rows(50), scope());
    userScroll(log(), 3100);
    layoutRows();
    await frames();
    const before = onScreen('t30');
    const top = log().scrollTop;
    expect(before).toBeLessThan(0);
    await toggle('t30');
    chatLayout.heights.set(30, 1600);
    layoutRows();
    await frames();
    expect(onScreen('t30')).toBe(before);
    expect(log().scrollTop).toBe(top);
  });

  it('its open state survives being scrolled away and back', async () => {
    await open(rows(50), scope());
    await toggle('t48');
    await frames();
    expect(row('t48')?.getAttribute('data-open')).toBe('true');
    userScroll(log(), 0);
    await frames();
    expect(row('t48')).toBeNull();
    userScroll(log(), end());
    await frames();
    expect(row('t48')?.getAttribute('data-open')).toBe('true');
  });
});
