/** Lazy mounting of file bodies: near files mount, far ones wait behind a
 *  sized placeholder, and a jump target mounts before it is scrolled to. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountBigPr } from '../test/bigPr';

/** Records observed elements; `enter` plays the browser reporting one near. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  static enter(el: Element) {
    for (const io of FakeIntersectionObserver.all) {
      if (!io.targets.has(el)) continue;
      io.cb(
        [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
        io as unknown as IntersectionObserver,
      );
    }
  }
}

describe('DiffPane lazy file mounting', () => {
  let view: Awaited<ReturnType<typeof mountBigPr>>;

  beforeEach(async () => {
    FakeIntersectionObserver.all = [];
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    view = await mountBigPr();
  });

  afterEach(() => {
    view.unmount();
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver;
  });

  const files = () => [...view.host.querySelectorAll('.file')];
  const hunkOf = (id: string) => view.host.querySelector(`#H-${id}`);

  it('mounts the top files and leaves sized placeholders for the rest', () => {
    const all = files();
    const pending = view.host.querySelectorAll('.file-pending');
    // The default 40-file chunk is rendered; only a few of them in full.
    expect(all).toHaveLength(40);
    expect(hunkOf('f0h0')).not.toBeNull();
    expect(pending.length).toBeGreaterThan(30);
    expect(hunkOf('f39h0')).toBeNull();
    const h = (pending[0] as HTMLElement).style.height;
    expect(parseInt(h, 10)).toBeGreaterThan(300);
    // Every file header is still there for anchors and the sticky title.
    expect(view.host.querySelectorAll('.file-h')).toHaveLength(40);
  });

  it('mounts a file once it comes near and keeps it mounted', async () => {
    const far = files()[20]!;
    expect(hunkOf('f20h0')).toBeNull();
    await act(async () => FakeIntersectionObserver.enter(far));
    expect(hunkOf('f20h0')).not.toBeNull();
    expect(hunkOf('f21h0')).toBeNull();
  });

  it('force-mounts the focused hunk before the scroll effect runs', async () => {
    expect(hunkOf('f30h1')).toBeNull();
    await act(async () => view.controls().setFocus('f30h1'));
    expect(hunkOf('f30h1')?.className).toContain('focus');
    // Stays in the DOM after focus moves on.
    await act(async () => view.controls().setFocus('f0h0'));
    expect(hunkOf('f30h1')).not.toBeNull();
  });
});
