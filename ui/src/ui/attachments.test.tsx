/** Attachments as chips: nothing big in the row, the photo on hover or focus,
 *  and a sent image's data fetched only when someone looks at it. */
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import type { Attachment } from '../gen/contract';
import { FakeTransport } from '../test/fakeTransport';
import {
  AttachmentStrip,
  MessageAttachments,
  type Attachments,
  type Pending,
} from './attachments';

// jsdom has no `CSS`; the popover reads it to find its keyboard layout meta.
globalThis.CSS ??= { escape: (s: string) => s } as unknown as typeof CSS;

let m: Mounted | null = null;
let transport: FakeTransport;
/** The data URL cache outlives a test: each gets ids of its own. */
let nextId = 0;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('attachment_data', () => 'data:image/png;base64,AAAA');
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

const render = async (node: ReactNode) => {
  m = await mount(node);
};

const sent = (name: string, mime: string): Attachment => ({
  id: `a${++nextId}`,
  name,
  mime,
  size: 3,
  path: `/data/attachments/${name}`,
});

const pending = (next: Partial<Pending>): Pending => ({
  key: 'k1',
  name: 'shot.png',
  mime: 'image/png',
  preview: 'blob:shot',
  saved: sent('shot.png', 'image/png'),
  error: null,
  ...next,
});

function strip(items: Pending[], remove: (key: string) => void = () => {}) {
  const at: Attachments = {
    items,
    add: () => {},
    addSaved: () => {},
    remove,
    clear: () => {},
    ids: [],
    saved: [],
    busy: false,
  };
  return <AttachmentStrip at={at} />;
}

const hover = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
const unhover = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const escape = () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

const chip = () => m!.host.querySelector('.attachment')!;
const card = () => document.querySelector('.attachment-hover-card');
const photo = () => card()?.querySelector('img') ?? null;
const fetches = () =>
  transport.calls.filter((c) => c.cmd === 'attachment_data');

describe('in the box', () => {
  it('shows a chip per kind, with no picture until hovered', async () => {
    await render(
      strip([
        pending({ key: 'i' }),
        pending({
          key: 'f',
          name: 'notes.pdf',
          mime: 'application/pdf',
          preview: null,
        }),
      ]),
    );
    const [image, file] = [...m!.host.querySelectorAll('.attachment')];
    expect(image!.getAttribute('data-kind')).toBe('image');
    expect(image!.querySelector('[data-file-type="image"]')).not.toBeNull();
    expect(image!.textContent).toContain('shot.png');
    expect(file!.getAttribute('data-kind')).toBe('file');
    expect(file!.querySelector('[data-file-type="file"]')).not.toBeNull();
    expect(m!.host.querySelector('img')).toBeNull();
  });

  it('hover shows the photo after the delay', async () => {
    await render(strip([pending({})]));
    await hover(chip());
    await elapse(299);
    expect(card()).toBeNull();
    await elapse(1);
    expect(photo()?.getAttribute('src')).toBe('blob:shot');
    expect(photo()?.getAttribute('alt')).toBe('shot.png');
    // An object URL is already here.
    expect(fetches()).toHaveLength(0);
  });

  it('a file that is no image has no card', async () => {
    await render(
      strip([pending({ name: 'a.txt', mime: 'text/plain', preview: null })]),
    );
    await hover(chip());
    await elapse(1000);
    expect(card()).toBeNull();
  });

  it('stays open moving into the card, closes off both', async () => {
    await render(strip([pending({})]));
    await hover(chip());
    await elapse(300);
    await unhover(chip());
    await hover(card()!.firstElementChild!);
    await elapse(1000);
    expect(card()).not.toBeNull();
    await unhover(card()!.firstElementChild!);
    await elapse(120);
    expect(card()).toBeNull();
  });

  it('focus shows it, Escape closes it', async () => {
    await render(strip([pending({})]));
    const label = m!.host.querySelector<HTMLElement>('[role="img"]')!;
    expect(label.getAttribute('aria-label')).toBe('shot.png');
    expect(label.tabIndex).toBe(0);
    await act(async () => label.focus());
    await elapse(300);
    expect(photo()).not.toBeNull();
    await escape();
    expect(card()).toBeNull();
  });

  it('× is there without a hover and removes the file', async () => {
    const remove = vi.fn();
    await render(strip([pending({})], remove));
    const x = m!.host.querySelector('[aria-label="Remove shot.png"]')!;
    expect(x.className).not.toContain('hidden');
    await click(x);
    expect(remove).toHaveBeenCalledWith('k1');
  });

  it('× takes the focus without opening the photo', async () => {
    await render(strip([pending({})]));
    const x = m!.host.querySelector<HTMLElement>(
      '[aria-label="Remove shot.png"]',
    )!;
    await act(async () => x.focus());
    await elapse(1000);
    expect(card()).toBeNull();
  });

  it('shows the spinner while saving', async () => {
    await render(strip([pending({ saved: null })]));
    expect(chip().querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it('shows ! with the reason in the title', async () => {
    await render(strip([pending({ saved: null, error: 'Over 25 MB' })]));
    expect(chip().textContent).toContain('!');
    expect(chip().getAttribute('title')).toBe('shot.png: Over 25 MB');
    expect(chip().querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it('a saved image with no object URL loads from the store', async () => {
    const saved = sent('tail.png', 'image/png');
    await render(strip([pending({ name: 'tail.png', preview: null, saved })]));
    expect(fetches()).toHaveLength(0);
    await hover(chip());
    await elapse(300);
    expect(fetches()).toHaveLength(1);
    expect(photo()?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});

describe('on a sent message', () => {
  it('fetches nothing until someone looks', async () => {
    await render(
      <MessageAttachments
        attachments={[
          sent('a.png', 'image/png'),
          sent('b.png', 'image/png'),
          sent('c.pdf', 'application/pdf'),
        ]}
      />,
    );
    await elapse(1000);
    expect(fetches()).toHaveLength(0);
    expect(m!.host.querySelector('img')).toBeNull();
  });

  it('a pointer passing over fetches nothing', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await hover(chip());
    await elapse(100);
    await unhover(chip());
    await elapse(1000);
    expect(fetches()).toHaveLength(0);
  });

  it('hover loads the photo once, and the cache serves it again', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await hover(chip());
    await elapse(299);
    expect(fetches()).toHaveLength(0);
    await elapse(1);
    expect(fetches()).toHaveLength(1);
    expect(photo()?.getAttribute('src')).toBe('data:image/png;base64,AAAA');

    await unhover(chip());
    await elapse(120);
    expect(card()).toBeNull();
    await hover(chip());
    await elapse(300);
    expect(photo()).not.toBeNull();
    expect(fetches()).toHaveLength(1);
  });

  it('the card adds nothing to the row, so a row keeps its height', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    const before = m!.host.innerHTML;
    await hover(chip());
    await elapse(300);
    expect(photo()).not.toBeNull();
    expect(m!.host.contains(card())).toBe(false);
    expect(m!.host.innerHTML).toBe(before);
  });

  it('focus shows it, Escape closes it', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await act(async () => (chip() as HTMLElement).focus());
    await elapse(300);
    expect(photo()).not.toBeNull();
    await escape();
    expect(card()).toBeNull();
  });

  it('click opens the large view over everything, loading only then', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await click(chip());
    await elapse(0);
    expect(fetches()).toHaveLength(1);
    const big = document.querySelector('[role="dialog"]')!;
    expect(big.parentElement).toBe(document.body);
    expect(big.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );

    await click(big);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Enter on a chip with its card up swaps the card for the large view', async () => {
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await act(async () => (chip() as HTMLElement).focus());
    await elapse(300);
    expect(card()).not.toBeNull();
    // A button turns Enter into a click.
    await click(chip());
    await elapse(0);
    expect(card()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says so when the data does not come', async () => {
    transport.onCall('attachment_data', () => {
      throw new Error('gone');
    });
    await render(
      <MessageAttachments attachments={[sent('a.png', 'image/png')]} />,
    );
    await hover(chip());
    await elapse(300);
    expect(card()?.textContent).toContain('No preview');
  });

  it('a file that is no image is a plain chip: no card, no large view', async () => {
    await render(
      <MessageAttachments attachments={[sent('c.pdf', 'application/pdf')]} />,
    );
    expect(chip().tagName).toBe('SPAN');
    await hover(chip());
    await elapse(1000);
    await click(chip());
    expect(card()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetches()).toHaveLength(0);
  });
});
