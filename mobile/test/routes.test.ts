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
  it('has Home, a space, Devices, Settings, the picker sheets and the /start redirect', () => {
    expect(screens(app)).toEqual([
      'computer-picker.tsx',
      'devices.tsx',
      'index.tsx',
      'model-picker.tsx',
      'project-picker.tsx',
      'settings/',
      'space/',
      'start.tsx',
    ]);
    expect(readdirSync(join(app, 'space'))).toEqual(['[id].tsx']);
    // Settings at /settings, its drill-down pages under it.
    expect(readdirSync(join(app, 'settings')).sort()).toEqual([
      'about.tsx',
      'device.tsx',
      'index.tsx',
      'organization.tsx',
    ]);
  });

  it('anchors the stack on Home and wraps it in the drawer', () => {
    const stack = readFileSync(join(app, '_layout.tsx'), 'utf8');
    expect(stack).toContain("anchor: 'index'");
    expect(stack).toContain('<AppShell>');
    for (const name of [
      'index',
      'space/[id]',
      'devices',
      'settings/index',
      'settings/organization',
      'settings/device',
      'settings/about',
      'start',
      'model-picker',
      'computer-picker',
      'project-picker',
    ])
      expect(stack).toContain(`name="${name}"`);
  });

  it('presents the picker sheets as form sheets with detents', () => {
    const stack = readFileSync(join(app, '_layout.tsx'), 'utf8');
    expect(stack).toContain("presentation: 'formSheet'");
    expect(stack).toContain('sheetAllowedDetents: [0.5, 1]');
    expect(stack).toContain('sheetGrabberVisible: true');
  });

  it('sends /start to Home', () => {
    const start = readFileSync(join(app, 'start.tsx'), 'utf8');
    expect(start).toContain('<Redirect');
    expect(start).toContain("'/'");
  });
});
