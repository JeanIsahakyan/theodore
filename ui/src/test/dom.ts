/** What rendering HeroUI under jsdom needs, for `.test.tsx` files that
 *  mount components: act(), ResizeObserver and matchMedia. Import it
 *  before anything that renders. */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

/** A mounted tree: `host` to query, `unmount` in afterEach. */
export interface Mounted {
  host: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    root,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Lets pending promises (fake transport answers) settle inside act(). */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Clicks inside act(). */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click: no element');
  await act(async () => {
    (el as HTMLElement).click();
  });
}
