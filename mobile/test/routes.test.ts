import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The tab bar is exactly the tabs navigator's children: a pushed screen
// inside it would be a hidden tab that screen readers still count.
const app = join(__dirname, '..', 'app', '(app)');
const screens = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .filter((n) => n !== '_layout.tsx')
    .sort();

describe('signed-in routes', () => {
  it('has exactly three tabs', () => {
    expect(screens(join(app, '(tabs)'))).toEqual([
      'devices.tsx',
      'index.tsx',
      'settings.tsx',
    ]);
  });

  it('pushes the space and Start over the tabs, at the same URLs', () => {
    expect(screens(app)).toEqual(['(tabs)/', 'space/', 'start.tsx']);
    expect(readdirSync(join(app, 'space'))).toEqual(['[id].tsx']);
  });

  it('goes back to the anchors: Spaces in the tabs, the tabs in the stack', () => {
    const tabs = readFileSync(join(app, '(tabs)', '_layout.tsx'), 'utf8');
    expect(tabs).toContain("anchor: 'index'");
    expect(tabs).toContain('backBehavior="initialRoute"');
    expect(tabs).not.toContain('href');
    const stack = readFileSync(join(app, '_layout.tsx'), 'utf8');
    expect(stack).toContain("anchor: '(tabs)'");
  });
});
