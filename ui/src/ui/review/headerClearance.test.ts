/** What a line scrolled to the top clears: its file's pinned header, as
 *  measured, not a fixed guess (a wrapped header in a narrow pane is ~83px). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER_VAR,
  HeaderSizer,
  hunkBlock,
  recordHeader,
  scrollIntoDiff,
  scrollToHunk,
  scrollToKeepHeader,
} from './headerClearance';

/** `main.diff > .file > header.file-h + .ln`, like DiffPane renders it. */
function pane() {
  const main = document.createElement('main');
  const card = document.createElement('div');
  card.className = 'file';
  const header = document.createElement('header');
  header.className = 'file-h';
  const line = document.createElement('div');
  line.className = 'ln';
  card.append(header, line);
  main.append(card);
  document.body.append(main);
  return { main, card, header, line };
}

const rect = (top: number) => ({ top }) as DOMRect;

let observed: {
  cb: ResizeObserverCallback;
  targets: Set<Element>;
}[] = [];
const realRO = globalThis.ResizeObserver;
beforeEach(() => {
  observed = [];
  globalThis.ResizeObserver = class {
    private readonly o;
    constructor(cb: ResizeObserverCallback) {
      this.o = { cb, targets: new Set<Element>() };
      observed.push(this.o);
    }
    observe(el: Element) {
      this.o.targets.add(el);
    }
    unobserve(el: Element) {
      this.o.targets.delete(el);
    }
    disconnect() {
      this.o.targets.clear();
    }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = realRO;
  document.body.innerHTML = '';
});

/** Reports `height` for `el` to every observer watching it. */
function resize(el: Element, height: number) {
  for (const o of observed) {
    if (!o.targets.has(el)) continue;
    const entry = {
      target: el,
      borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
    } as unknown as ResizeObserverEntry;
    o.cb([entry], {} as ResizeObserver);
  }
}

describe('the pinned header clearance', () => {
  it('sets the measured height on the card and the pane', () => {
    const { main, card, header } = pane();
    const sizer = new HeaderSizer();
    // A header mounts before the pane's effect starts the observer.
    const remove = sizer.add(header);
    sizer.start(main);
    expect(observed).toHaveLength(1);
    resize(header, 83);
    expect(card.style.getPropertyValue(HEADER_VAR)).toBe('83px');
    expect(main.style.getPropertyValue(HEADER_VAR)).toBe('83px');
    // Narrower → wider: the header unwraps to one row.
    resize(header, 52.5);
    expect(card.style.getPropertyValue(HEADER_VAR)).toBe('53px');
    remove();
    expect(observed[0]!.targets.has(header)).toBe(false);
    sizer.stop();
  });

  it('keeps the last height of a header with no layout', () => {
    const { card, header } = pane();
    recordHeader(header, 83, null);
    // An off-screen card under `content-visibility` measures 0.
    recordHeader(header, 0, null);
    expect(card.style.getPropertyValue(HEADER_VAR)).toBe('83px');
  });

  it('observes a header that mounts after the observer started', () => {
    const { main, card, header } = pane();
    const sizer = new HeaderSizer();
    sizer.start(main);
    sizer.add(header);
    resize(header, 61);
    expect(card.style.getPropertyValue(HEADER_VAR)).toBe('61px');
    sizer.stop();
  });

  it('measures the header before it scrolls a line into view', () => {
    const { card, header, line } = pane();
    Object.defineProperty(header, 'offsetHeight', { value: 83 });
    const seen: string[] = [];
    line.scrollIntoView = vi.fn(() => {
      seen.push(card.style.getPropertyValue(HEADER_VAR));
    });
    scrollIntoDiff(line, { block: 'nearest' });
    expect(line.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(seen).toEqual(['83px']);
    // Nothing to scroll to: nothing happens.
    expect(() => scrollIntoDiff(null, { block: 'center' })).not.toThrow();
  });

  it('scrolls a folded card back to the top edge only when it is above it', () => {
    const { main, card } = pane();
    main.getBoundingClientRect = () => rect(100);
    // The card's top went 1200px above the pane while reading it.
    card.getBoundingClientRect = () => rect(-1100);
    expect(scrollToKeepHeader(card, main)).toBe(-1200);
    // A card already in view stays where it is.
    card.getBoundingClientRect = () => rect(300);
    expect(scrollToKeepHeader(card, main)).toBe(0);
  });
});

describe('J/K onto a hunk', () => {
  /** A pane at y=100 with one hunk, clear of an 83px header (+4). */
  function hunkIn(top: number) {
    const { main, card } = pane();
    main.className = 'diff';
    main.getBoundingClientRect = () => rect(100);
    const hunk = document.createElement('div');
    hunk.id = 'H-h1';
    hunk.style.scrollMarginTop = '87px';
    hunk.getBoundingClientRect = () => rect(top);
    hunk.scrollIntoView = vi.fn();
    card.append(hunk);
    return { main, hunk };
  }

  it('brings a tall hunk whose top is out of sight above to the top', () => {
    // K inside a tall hunk: its top is 2000px above the pane.
    const { main, hunk } = hunkIn(-1900);
    expect(hunkBlock(hunk, main)).toBe('start');
    scrollToHunk(hunk, 'smooth');
    expect(hunk.scrollIntoView).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });
  });

  it('counts a top under the pinned header as out of sight', () => {
    const { main, hunk } = hunkIn(150);
    expect(hunkBlock(hunk, main)).toBe('start');
  });

  it('keeps nearest for a hunk in view, already at the top, or below', () => {
    const shown = hunkIn(400);
    expect(hunkBlock(shown.hunk, shown.main)).toBe('nearest');
    // Where `start` put it: no re-scroll.
    const { main, hunk } = hunkIn(187);
    expect(hunkBlock(hunk, main)).toBe('nearest');
    const below = hunkIn(5000);
    scrollToHunk(below.hunk, 'smooth');
    expect(below.hunk.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'smooth',
    });
    // Outside a pane: nearest, as before.
    expect(hunkBlock(hunk, null)).toBe('nearest');
  });
});
