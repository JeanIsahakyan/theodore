/** Colour swatches in rendered code: decoration only — the line's text,
 *  and its word-diff marks, come out exactly as without them. */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from './test/dom';
import { Code, Md, rich } from './highlight';
import { ColorPreviewHost } from './ui/ColorPreview';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const swatches = (el: Element) =>
  [...el.querySelectorAll('.cswatch')].map((s) => s.getAttribute('data-color'));

describe('colour swatches', () => {
  it('sit before each literal in a code line without changing its text', async () => {
    const s = "  color: #ff0000; background: rgb(0 0 255 / 50%); // '#fff'";
    m = await mount(<Code s={s} lang="css" />);
    const code = m.host.querySelector('code.src')!;
    expect(code.textContent).toBe(s);
    expect(swatches(code)).toEqual(['#ff0000', 'rgb(0 0 255 / 50%)', '#fff']);
    for (const sw of code.querySelectorAll('.cswatch')) {
      expect(sw.getAttribute('aria-hidden')).toBe('true');
      expect(sw.nextSibling?.textContent?.[0]).toMatch(/[#r]/);
    }
  });

  it('keep word-diff marks whole around a literal', async () => {
    const s = 'a = "#00ff00";';
    m = await mount(<Code s={s} lang="ts" marks={[[4, 13]]} />);
    const code = m.host.querySelector('code.src')!;
    expect(code.textContent).toBe(s);
    expect(
      [...code.querySelectorAll('.wd')].map((w) => w.textContent).join(''),
    ).toBe('"#00ff00"');
    expect(swatches(code)).toEqual(['#00ff00']);
  });

  it('show in markdown code and inline code spans, not in prose', async () => {
    m = await mount(
      <div>
        <Md
          text={
            'Brand #ff0000 here, `#00ff00` there.\n\n```css\na { color: hsl(240 100% 50%); }\n```'
          }
        />
        <p className="rich">{rich('use `oklch(0.7 0.1 200)` not #fff')}</p>
      </div>,
    );
    expect(swatches(m.host)).toEqual([
      '#00ff00',
      'hsl(240 100% 50%)',
      'oklch(0.7 0.1 200)',
    ]);
    expect(m.host.querySelector('pre code')!.textContent).toBe(
      'a { color: hsl(240 100% 50%); }\n',
    );
  });

  it('preview on hover from one shared host', async () => {
    m = await mount(
      <>
        <Code s="x: #ff8000;" lang="css" />
        <ColorPreviewHost />
      </>,
    );
    const sw = m.host.querySelector('.cswatch')!;
    await act(async () => {
      sw.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    const tip = document.body.querySelector('[role=tooltip]')!;
    expect(tip.textContent).toContain('#ff8000');
    expect(tip.textContent).toContain('rgb(255, 128, 0)');
    await act(async () => {
      m!.host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role=tooltip]')).toBeNull();
  });
});
