/** A file card's header pins to the diff pane's top edge while the file
 *  scrolls under it. Whatever scrolls a hunk or a line to the top has to land
 *  below that header, whose height depends on the pane's width (its controls
 *  wrap in a narrow one). `--file-h` carries the measured height: on each card
 *  for its own header, and on the pane for cards not measured yet; styles.css
 *  turns it into `scroll-margin-top`. */

/** The var `scroll-margin-top` reads (styles.css). */
export const HEADER_VAR = '--file-h';

const headerOf = (card: Element): HTMLElement | null =>
  card.querySelector<HTMLElement>(':scope > .file-h');

function setVar(el: HTMLElement, px: number) {
  const v = `${Math.ceil(px)}px`;
  if (el.style.getPropertyValue(HEADER_VAR) !== v)
    el.style.setProperty(HEADER_VAR, v);
}

/** Records a header's `height` on its card, and on `pane` as the default. A
 *  header with no layout (a skipped, off-screen card) reports 0: kept as
 *  last measured. */
export function recordHeader(
  header: HTMLElement,
  height: number,
  pane: HTMLElement | null,
): void {
  if (height <= 0) return;
  const card = header.parentElement;
  if (card) setVar(card, height);
  if (pane) setVar(pane, height);
}

/** One `ResizeObserver` per pane over every file header in it. Headers
 *  register as they mount (`add`); the observer exists between `start` and
 *  `stop` (the pane's effect), so a header that mounts first is picked up. */
export class HeaderSizer {
  private readonly headers = new Set<HTMLElement>();
  private ro: ResizeObserver | null = null;
  private pane: HTMLElement | null = null;

  add(header: HTMLElement): () => void {
    this.headers.add(header);
    this.ro?.observe(header);
    return () => {
      this.headers.delete(header);
      this.ro?.unobserve(header);
    };
  }

  start(pane: HTMLElement | null): void {
    this.stop();
    this.pane = pane;
    if (typeof ResizeObserver === 'undefined') return;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const box = e.borderBoxSize as
          readonly ResizeObserverSize[] | undefined;
        recordHeader(el, box?.[0]?.blockSize ?? el.offsetHeight, this.pane);
      }
    });
    for (const h of this.headers) this.ro.observe(h);
  }

  stop(): void {
    this.ro?.disconnect();
    this.ro = null;
  }
}

/** Measures the header of the card `el` is in, now: the observer may not have
 *  seen a card that only just got laid out (`content-visibility`). */
export function syncClearance(el: Element, pane?: HTMLElement | null): void {
  const card = el.closest('.file');
  const header = card && headerOf(card);
  if (header) recordHeader(header, header.offsetHeight, pane ?? null);
}

/** `scrollIntoView` for a hunk or a line in the diff, clear of its file's
 *  pinned header. */
export function scrollIntoDiff(
  el: Element | null | undefined,
  opts: ScrollIntoViewOptions,
): void {
  if (!el) return;
  syncClearance(el);
  el.scrollIntoView(opts);
}

/** How far to scroll `pane` so `card`'s top sits at its top edge — where the
 *  pinned header was — or 0 when the card's top is already in view. */
export function scrollToKeepHeader(card: Element, pane: HTMLElement): number {
  const top = pane.getBoundingClientRect().top + pane.clientTop;
  const delta = card.getBoundingClientRect().top - top;
  return delta < 0 ? delta : 0;
}

/** Scrolls `pane` up so a just-folded `card`'s header is back at its top. */
export function keepHeaderAtTop(
  card: Element | null,
  pane: HTMLElement | null,
): void {
  if (!card || !pane) return;
  const by = scrollToKeepHeader(card, pane);
  if (by) pane.scrollTop += by;
}

/** J/K's block for a hunk in `pane`: `start` when its top is above the
 *  visible part — under the pinned header or past the pane's top edge, where
 *  `nearest` leaves a hunk taller than the view as it is — else `nearest`. */
export function hunkBlock(
  hunk: Element,
  pane: Element | null,
): 'start' | 'nearest' {
  if (!pane) return 'nearest';
  const top = pane.getBoundingClientRect().top + pane.clientTop;
  // Where `start` puts it: clear of the header (`scroll-margin-top`).
  const clear = parseFloat(getComputedStyle(hunk).scrollMarginTop) || 0;
  // A pixel of slack: a hunk `start` already put there stays put.
  return hunk.getBoundingClientRect().top < top + clear - 1
    ? 'start'
    : 'nearest';
}

/** Scrolls J/K's hunk into the diff: its top to the top edge, clear of the
 *  pinned header, when that top is out of sight above; else `nearest`. */
export function scrollToHunk(
  hunk: Element | null | undefined,
  behavior: ScrollBehavior,
): void {
  if (!hunk) return;
  syncClearance(hunk);
  const block = hunkBlock(hunk, hunk.closest('main.diff'));
  hunk.scrollIntoView({ block, behavior });
}
