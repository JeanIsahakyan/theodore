/** The logo takes its colours from the build: blue in production (and
 *  before the app info arrives), a colour of its own everywhere else. */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import { act } from 'react';
import type { AppInfo } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { Logo } from './Logo';
import { LOGO_COLORS, logoColors } from './logoColors';
import { WelcomeLogo } from './Welcome';

describe('logoColors', () => {
  it('keeps production the blue it always was', () => {
    expect(logoColors('production')).toEqual({
      tile: '#3F86D6',
      blob: '#0C5BC0',
      shadow: '#03306B',
    });
  });

  it('gives each other build its own tile', () => {
    expect(logoColors('staging')).toBe(LOGO_COLORS.staging);
    expect(logoColors('nightly')).toBe(LOGO_COLORS.nightly);
    expect(logoColors('dev')).toBe(LOGO_COLORS.dev);
    const tiles = Object.values(LOGO_COLORS).map((c) => c.tile);
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it('falls back to production when the env is unknown or not loaded', () => {
    expect(logoColors(null)).toBe(LOGO_COLORS.production);
    expect(logoColors(undefined)).toBe(LOGO_COLORS.production);
    expect(logoColors('qa')).toBe(LOGO_COLORS.production);
    expect(logoColors('toString')).toBe(LOGO_COLORS.production);
  });
});

const appInfo = (build_env: string): AppInfo => ({
  version: '0.1.0',
  channel: 'stable',
  update: null,
  commit: 'abc',
  build_env,
  built_at: 0,
});

describe('the rendered logo', () => {
  let m: Mounted | null = null;
  afterEach(() => {
    m?.unmount();
    m = null;
  });

  const tiles = (host: HTMLElement) =>
    [...host.querySelectorAll('.logo-tile')].map((t) => t.getAttribute('fill'));

  it('is blue before the app info arrives, then takes the staging colour', async () => {
    const store = new RootStore();
    m = await mount(
      <RootStoreProvider store={store}>
        <Logo />
        <WelcomeLogo size={56} />
      </RootStoreProvider>,
    );
    expect(tiles(m.host)).toEqual([
      LOGO_COLORS.production.tile,
      LOGO_COLORS.production.tile,
    ]);
    await act(async () => store.ephemeral.setAppInfo(appInfo('staging')));
    expect(tiles(m.host)).toEqual([
      LOGO_COLORS.staging.tile,
      LOGO_COLORS.staging.tile,
    ]);
    const shadow = m.host.querySelector(
      `[fill="${LOGO_COLORS.staging.shadow}"]`,
    );
    expect(shadow).not.toBeNull();
  });

  it('renders in production blue outside a store', async () => {
    m = await mount(<Logo size={22} />);
    expect(tiles(m.host)).toEqual([LOGO_COLORS.production.tile]);
    expect(m.host.querySelector('svg')?.getAttribute('width')).toBe('22');
  });
});
