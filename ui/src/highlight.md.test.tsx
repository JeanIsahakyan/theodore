import { afterEach, describe, expect, it } from 'vitest';
import { mount, settle, type Mounted } from './test/dom';
import { Md, stripHtmlComments } from './highlight';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(text: string) {
  m = await mount(<Md text={text} />);
  await settle();
  return m.host;
}

describe('Md raw HTML', () => {
  it('renders GitHub-allowed HTML: details, summary, kbd', async () => {
    const host = await render(
      'Before\n\n<details>\n<summary>Expandable</summary>\n\nHidden text.\n\n</details>\n\nPress <kbd>⌘K</kbd>',
    );
    const details = host.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')?.textContent).toBe('Expandable');
    expect(details!.textContent).toContain('Hidden text.');
    expect(host.querySelector('kbd')?.textContent).toBe('⌘K');
    expect(host.textContent).not.toContain('<details>');
  });

  it('drops scripts, styles and event handlers', async () => {
    const host = await render(
      '<script>window.hacked = 1</script><img src="x.png" onerror="window.hacked = 2"><style>body{display:none}</style>ok',
    );
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('style')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect((window as { hacked?: number }).hacked).toBeUndefined();
  });

  it('shows an HTML comment written in code as its literal text', async () => {
    const host = await render(
      'See `<!-- QA9 plan test -->` here\n\n```html\n<!-- fenced -->\n```\n\n    <!-- indented -->\n',
    );
    const codes = [...host.querySelectorAll('code')].map((c) => c.textContent);
    expect(codes[0]).toBe('<!-- QA9 plan test -->');
    expect(codes[1]).toContain('<!-- fenced -->');
    expect(codes[2]).toContain('<!-- indented -->');
  });

  it('hides real comments, and real HTML in prose stays harmless', async () => {
    const host = await render(
      'Fix it <!-- inline --> now\n\n<!-- theodore:m1 -->\n\n<!-- a\n\nb -->\n\n<img src="x.png" onerror="window.hacked = 3">\n\n<script>window.hacked = 4</script>',
    );
    expect(host.textContent).toContain('Fix it  now');
    expect(host.textContent).not.toContain('inline');
    expect(host.textContent).not.toContain('theodore:m1');
    expect(host.textContent).not.toContain('<!--');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect((window as { hacked?: number }).hacked).toBeUndefined();
  });

  it('keeps footnotes and fenced code languages', async () => {
    const host = await render(
      'Note[^1]\n\n```ts\nconst a = 1;\n```\n\n[^1]: The footnote.',
    );
    expect(host.querySelector('sup a')).not.toBeNull();
    expect(host.textContent).toContain('The footnote.');
    expect(host.querySelector('code.language-ts')).not.toBeNull();
  });
});

describe('stripHtmlComments', () => {
  it('removes real comments and trailing space', () => {
    expect(stripHtmlComments('Please fix.\n\n<!-- theodore:m1 -->\n')).toBe(
      'Please fix.',
    );
    expect(stripHtmlComments('a <!-- b\n\nc --> d')).toBe('a  d');
  });

  it('leaves comments in code alone', () => {
    const span = 'See `<!-- x -->` and ``a ` <!-- y -->``';
    expect(stripHtmlComments(span)).toBe(span);
    const fence = '```html\n<!-- x -->\n```';
    expect(stripHtmlComments(fence)).toBe(fence);
    const tilde = '~~~\n<!-- x -->\n~~~';
    expect(stripHtmlComments(tilde)).toBe(tilde);
    const open = '```\n<!-- x -->';
    expect(stripHtmlComments(open)).toBe(open);
  });

  it('still strips next to code', () => {
    expect(stripHtmlComments('`a` <!-- x --> `b`')).toBe('`a`  `b`');
  });
});
