import { afterEach, describe, expect, it } from 'vitest';
import { mount, settle, type Mounted } from './test/dom';
import { Md } from './highlight';

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

  it('keeps footnotes and fenced code languages', async () => {
    const host = await render(
      'Note[^1]\n\n```ts\nconst a = 1;\n```\n\n[^1]: The footnote.',
    );
    expect(host.querySelector('sup a')).not.toBeNull();
    expect(host.textContent).toContain('The footnote.');
    expect(host.querySelector('code.language-ts')).not.toBeNull();
  });
});
