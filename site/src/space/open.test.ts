import { describe, expect, it } from 'vitest';
import type { Platform } from '../download/platform';
import { channelFor, links, planFor, spaceIdFromPath, targetFor } from './open';

describe('spaceIdFromPath', () => {
  it('reads a space id and refuses anything else', () => {
    expect(spaceIdFromPath('/s/3f2a9c1b0d4e')).toBe('3f2a9c1b0d4e');
    expect(spaceIdFromPath('/s/fix-login_2/')).toBe('fix-login_2');
    expect(spaceIdFromPath('/s/')).toBeNull();
    expect(spaceIdFromPath('/s')).toBeNull();
    expect(spaceIdFromPath('/space/abc')).toBeNull();
    expect(spaceIdFromPath('/s/a/b')).toBeNull();
    expect(spaceIdFromPath('/s/..%2Fx')).toBeNull();
    expect(spaceIdFromPath('/s/%E0%A4%A')).toBeNull();
    expect(spaceIdFromPath(`/s/${'a'.repeat(65)}`)).toBeNull();
  });
});

describe('channelFor', () => {
  it('is production on theodore.cloud and staging anywhere else', () => {
    expect(channelFor('theodore.cloud').scheme).toBe('theodore');
    expect(channelFor('www.theodore.cloud').webApp).toBe(
      'https://app.theodore.cloud',
    );
    expect(channelFor('staging.theodore.cloud').scheme).toBe(
      'theodore-staging',
    );
    expect(channelFor('staging.theodore.cloud').webApp).toBe(
      'https://app-staging.theodore.cloud',
    );
    expect(channelFor('abc123.theodore-site.pages.dev').scheme).toBe(
      'theodore-staging',
    );
    expect(channelFor('localhost').scheme).toBe('theodore-staging');
  });
});

describe('planFor', () => {
  const prod = channelFor('theodore.cloud');

  it('groups platforms into phone, desktop and other', () => {
    const t: Record<Platform, string> = {
      ios: 'phone',
      android: 'phone',
      mac: 'desktop',
      'mac-arm64': 'desktop',
      'mac-x64': 'desktop',
      linux: 'desktop',
      'linux-x64': 'desktop',
      'linux-arm64': 'desktop',
      windows: 'other',
      unknown: 'other',
    };
    for (const [p, target] of Object.entries(t))
      expect(targetFor(p as Platform)).toBe(target);
  });

  it('tries the desktop scheme at once on a Mac or Linux, then offers three ways', () => {
    const plan = planFor('abc', 'mac-arm64', prod);
    expect(plan.autoOpen).toBe('theodore://space/abc');
    expect(plan.buttons.map((b) => [b.label, b.href])).toEqual([
      ['Open in Theodore', 'theodore://space/abc'],
      ['Open in the web app', 'https://app.theodore.cloud/space/abc'],
      ['Download Theodore', '/download'],
    ]);
    expect(plan.buttons[0]?.tone).toBe('primary');
    expect(planFor('abc', 'linux-x64', prod).autoOpen).toBe(
      'theodore://space/abc',
    );
  });

  it('offers the phone app, the web app and the store on a phone, with no auto-open', () => {
    const plan = planFor('abc', 'ios', prod);
    expect(plan.autoOpen).toBeNull();
    expect(plan.buttons.map((b) => b.label)).toEqual([
      'Open in Theodore Code',
      'Open in the web app',
      'Get the app',
    ]);
    expect(plan.buttons[0]?.href).toBe('theodore-mobile://space/abc');
    expect(planFor('abc', 'android', prod).buttons).toEqual(plan.buttons);
  });

  it('offers the web app and the download elsewhere', () => {
    for (const p of ['windows', 'unknown'] as Platform[]) {
      const plan = planFor('abc', p, prod);
      expect(plan.autoOpen).toBeNull();
      expect(plan.buttons.map((b) => b.label)).toEqual([
        'Open in the web app',
        'Download Theodore',
      ]);
      expect(plan.buttons[0]?.tone).toBe('primary');
    }
  });

  it('follows the staging channel', () => {
    const l = links('abc', channelFor('staging.theodore.cloud'));
    expect(l).toEqual({
      desktop: 'theodore-staging://space/abc',
      phone: 'theodore-mobile://space/abc',
      webApp: 'https://app-staging.theodore.cloud/space/abc',
    });
  });

  it('never carries anything but the id', () => {
    const plan = planFor('abc', 'mac', prod);
    for (const b of plan.buttons) expect(b.href).not.toMatch(/[?#]/);
  });
});
