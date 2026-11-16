import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The signed-in shell is one stack under the drawer, Home (`/`) at its
// root; the URLs push notifications and old links use stay.
const app = join(__dirname, '..', 'app', '(app)');
const screens = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .filter((n) => n !== '_layout.tsx')
    .sort();

describe('signed-in routes', () => {
  it('has Home, a space, Devices, Settings and the /start redirect', () => {
    expect(screens(app)).toEqual([
      'devices.tsx',
      'index.tsx',
      'settings.tsx',
      'space/',
      'start.tsx',
    ]);
    expect(readdirSync(join(app, 'space'))).toEqual(['[id].tsx']);
  });

  it('anchors the stack on Home and wraps it in the drawer', () => {
    const stack = readFileSync(join(app, '_layout.tsx'), 'utf8');
    expect(stack).toContain("anchor: 'index'");
    expect(stack).toContain('<AppShell>');
    for (const name of ['index', 'space/[id]', 'devices', 'settings', 'start'])
      expect(stack).toContain(`name="${name}"`);
  });

  it('sends /start to Home', () => {
    const start = readFileSync(join(app, 'start.tsx'), 'utf8');
    expect(start).toContain('<Redirect');
    expect(start).toContain("'/'");
  });
});
