import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { mount, type Mounted } from '../test/dom';
import {
  PINCE_NEZ_LABELS,
  PinceNezIndicator,
  type PinceNezState,
} from './PinceNezIndicator';

// The stylesheet as text: the runner skips CSS and the UI's types have no
// Node, so it's read through a typed dynamic import.
const fs = (await import('node' + ':fs')) as {
  readFileSync(path: string, encoding: 'utf8'): string;
};

const STATES: PinceNezState[] = [
  'idle',
  'turn',
  'thinking',
  'reading',
  'writing',
  'loading',
  'done',
  'error',
];

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe('PinceNezIndicator', () => {
  it.each(STATES)('%s: 20 px, its state on the root', async (state) => {
    m = await mount(<PinceNezIndicator state={state} />);
    const root = m.host.querySelector<HTMLElement>('.pn')!;
    expect(root.dataset.state).toBe(state);
    expect(root.style.width).toBe('20px');
    expect(root.style.height).toBe('20px');
  });

  it('labels are English, one per state', () => {
    expect(new Set(Object.values(PINCE_NEZ_LABELS)).size).toBe(8);
    for (const label of Object.values(PINCE_NEZ_LABELS)) {
      expect(label).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('names its state, or hides beside visible text', async () => {
    m = await mount(<PinceNezIndicator state="reading" />);
    const root = m.host.querySelector('.pn')!;
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe(PINCE_NEZ_LABELS.reading);
    m.unmount();
    m = await mount(<PinceNezIndicator state="reading" decorative />);
    const hidden = m.host.querySelector('.pn')!;
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
    expect(hidden.getAttribute('role')).toBeNull();
  });

  it('two on a page never share ids, and url() still reaches them', async () => {
    m = await mount(
      <>
        <PinceNezIndicator state="reading" />
        <PinceNezIndicator state="reading" />
      </>,
    );
    const ids = [...m.host.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[\w-]+$/);
    const [a, b] = [...m.host.querySelectorAll('.pn')];
    const glass = (root: Element) =>
      root.querySelector('.pn-glass-l')!.getAttribute('fill');
    expect(glass(a!)).not.toBe(glass(b!));
    expect(ids.some((id) => glass(a!) === `url(#${id})`)).toBe(true);
  });

  it('a new SVG on a state change, so a one-shot starts over', async () => {
    const El = ({ state }: { state: PinceNezState }) => (
      <PinceNezIndicator state={state} />
    );
    m = await mount(<El state="loading" />);
    const before = m.host.querySelector('svg')!;
    await act(async () => {
      m!.root.render(<El state="done" />);
    });
    expect(m.host.querySelector('svg')).not.toBe(before);
  });
});

describe('its CSS', () => {
  const css = fs.readFileSync('src/ui/pince-nez-indicator.css', 'utf8');
  const motion = /prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(
    css,
  )?.[1];

  it('reduced motion turns every animation off', () => {
    expect(motion).toContain('.pn *');
    expect(motion).toContain('animation: none !important');
  });

  it('the theme switch uses what the app sets', () => {
    expect(css).toMatch(/\.dark \.pn/);
    expect(css).toMatch(/\[data-theme='dark'\] \.pn/);
  });

  it('error takes the danger token', () => {
    expect(css).toMatch(/--pn-error: var\(--danger/);
  });

  it('keeps the designed timings', () => {
    expect(css).toContain('pn-pop 2.4s ease-out 1');
    expect(css).toContain('pn-shake 1.6s ease-in-out 1');
    expect(css).toContain('pn-pulse 1.8s ease-in-out infinite');
    expect(css).toContain('pn-alt 1.2s ease-in-out infinite');
    expect(css).toContain('pn-scroll 1.4s linear infinite');
    expect(css).toContain('pn-type 2.6s ease-out infinite');
    expect(css).toContain('pn-spin 1.1s linear infinite');
  });
});
