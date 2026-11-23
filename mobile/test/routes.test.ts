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
  it('has Home, a space, a space link, its sub-spaces, its files, Devices, Settings, the sheets and the /start redirect', () => {
    expect(screens(app)).toEqual([
      'accounts-sheet.tsx',
      'activity-sheet.tsx',
      'computer-picker.tsx',
      'devices.tsx',
      'file/',
      'index.tsx',
      'model-picker.tsx',
      'project-picker.tsx',
      's/',
      'settings/',
      'space/',
      'start.tsx',
      'sub-space/',
    ]);
    expect(readdirSync(join(app, 'space'))).toEqual(['[id].tsx']);
    // A space link, https://theodore.cloud/s/<id> (docs/mobile.md "Space
    // links"): the space by its id on its host, else the missing state.
    expect(readdirSync(join(app, 's'))).toEqual(['[id].tsx']);
    // A file of a space on its host: /file/<space>?path=…&host=…, pushed
    // with Back (docs/mobile.md "Files").
    expect(readdirSync(join(app, 'file'))).toEqual(['[space].tsx']);
    // A sub-space of a followed space, by its local id on the host:
    // /sub-space/<space>/<child>, pushed with Back.
    expect(readdirSync(join(app, 'sub-space'))).toEqual(['[space]']);
    expect(readdirSync(join(app, 'sub-space', '[space]'))).toEqual([
      '[child].tsx',
    ]);
    // Settings at /settings, its drill-down pages under it.
    expect(readdirSync(join(app, 'settings')).sort()).toEqual([
      'about.tsx',
      'collected.tsx',
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
      's/[id]',
      'devices',
      'settings/index',
      'settings/organization',
      'settings/device',
      'settings/about',
      'start',
      'model-picker',
      'computer-picker',
      'project-picker',
      'activity-sheet',
      'accounts-sheet',
      'sub-space/[space]/[child]',
      'file/[space]',
    ])
      expect(stack).toContain(`name="${name}"`);
  });

  it('polls a sub-space from its host while in front', () => {
    const screen = readFileSync(
      join(app, 'sub-space', '[space]', '[child].tsx'),
      'utf8',
    );
    expect(screen).toContain('useFocusEffect');
    expect(screen).toContain('SUB_SPACE_POLL_MS = 3000');
    expect(screen).toMatch(/fleet\s*\.readSpace\(/);
    expect(screen).toMatch(/fleet\s*\.sendTo\(/);
    expect(screen).toMatch(/fleet\s*\.answerSpace\(/);
  });

  it('presents the picker sheets as form sheets with detents', () => {
    const stack = readFileSync(join(app, '_layout.tsx'), 'utf8');
    expect(stack).toContain("presentation: 'formSheet'");
    expect(stack).toContain('sheetAllowedDetents: [0.5, 1]');
    expect(stack).toContain('sheetGrabberVisible: true');
  });

  it('opens the app from https://theodore.cloud/s/<id> (Universal Links, App Links)', () => {
    const conf = JSON.parse(
      readFileSync(join(__dirname, '..', 'app.json'), 'utf8'),
    ) as {
      expo: {
        scheme: string;
        ios: { bundleIdentifier: string; associatedDomains: string[] };
        android: {
          package: string;
          intentFilters: {
            action: string;
            autoVerify: boolean;
            data: { scheme: string; host: string; pathPrefix: string }[];
            category: string[];
          }[];
        };
      };
    };
    expect(conf.expo.scheme).toBe('theodore-mobile');
    expect(conf.expo.ios.associatedDomains).toEqual([
      'applinks:theodore.cloud',
      'applinks:staging.theodore.cloud',
    ]);
    const [filter] = conf.expo.android.intentFilters;
    expect(filter?.action).toBe('VIEW');
    expect(filter?.autoVerify).toBe(true);
    expect(filter?.category).toEqual(['BROWSABLE', 'DEFAULT']);
    expect(
      filter?.data.map((d) => `${d.scheme}://${d.host}${d.pathPrefix}`),
    ).toEqual([
      'https://theodore.cloud/s/',
      'https://staging.theodore.cloud/s/',
    ]);
    // The site's association files name this very app (site/public/.well-known).
    const wellKnown = join(
      __dirname,
      '..',
      '..',
      'site',
      'public',
      '.well-known',
    );
    const aasa = JSON.parse(
      readFileSync(join(wellKnown, 'apple-app-site-association'), 'utf8'),
    ) as {
      applinks: {
        details: { appIDs: string[]; components: { '/': string }[] }[];
      };
    };
    expect(aasa.applinks.details[0]?.appIDs).toEqual([
      `J33CB2C73P.${conf.expo.ios.bundleIdentifier}`,
    ]);
    expect(aasa.applinks.details[0]?.components.map((c) => c['/'])).toEqual([
      '/s/*',
    ]);
    const assetlinks = JSON.parse(
      readFileSync(join(wellKnown, 'assetlinks.json'), 'utf8'),
    ) as {
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(assetlinks[0]?.target.package_name).toBe(conf.expo.android.package);
    expect(assetlinks[0]?.target.sha256_cert_fingerprints).toHaveLength(1);
  });

  it('sends /start to Home', () => {
    const start = readFileSync(join(app, 'start.tsx'), 'utf8');
    expect(start).toContain('<Redirect');
    expect(start).toContain("'/'");
  });
});
