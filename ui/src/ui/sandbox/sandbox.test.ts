import { beforeEach, describe, expect, it } from 'vitest';
import type { AppInfo, SandboxInfo, SandboxStatus } from '../../gen/contract';
import { api } from '../../core/api';
import { setTransport } from '../../core/transport';
import { loadAppInfo } from '../../actions';
import { EphemeralStore } from '../../stores/EphemeralStore';
import type { RootStore } from '../../stores/RootStore';
import { FakeTransport } from '../../test/fakeTransport';
import { ownerAvatarUrl } from '../Projects';
import {
  formatDue,
  latestOnly,
  sandboxBadge,
  visibleSettingsPages,
  windowTitle,
} from './sandbox';

const info: SandboxInfo = {
  scenario: 'review-day',
  scenario_dir: '/tmp/scenarios/review-day',
  data_dir: '/tmp/theodore-sandbox',
};

const appInfo = (sandbox: SandboxInfo | null): AppInfo => ({
  version: '0.0.1',
  commit: 'a1b2c3d4e5f6',
  build_env: 'dev',
  built_at: 0,
  channel: 'stable',
  update: null,
  sandbox,
});

describe('sandboxBadge', () => {
  it('is hidden outside sandbox mode', () => {
    expect(sandboxBadge(null)).toBeNull();
  });

  it('reads SANDBOX and names the scenario and data dir', () => {
    const b = sandboxBadge(info)!;
    expect(b.label).toBe('SANDBOX');
    expect(b.tooltip).toContain('review-day');
    expect(b.tooltip).toContain('/tmp/theodore-sandbox');
  });
});

describe('windowTitle', () => {
  it('prefixes the title in sandbox mode', () => {
    expect(windowTitle('Theodore', info)).toBe('[SANDBOX] Theodore');
  });

  it('never stacks the prefix', () => {
    expect(windowTitle(windowTitle('Theodore', info), info)).toBe(
      '[SANDBOX] Theodore',
    );
  });

  it('leaves or strips it outside sandbox mode', () => {
    expect(windowTitle('Theodore', null)).toBe('Theodore');
    expect(windowTitle('[SANDBOX] Theodore', null)).toBe('Theodore');
  });
});

describe('formatDue', () => {
  it('is "manual" for on-demand events', () => {
    expect(formatDue(null)).toBe('manual');
  });

  it('formats seconds and minutes', () => {
    expect(formatDue(0)).toBe('at 0s');
    expect(formatDue(45_000)).toBe('at 45s');
    expect(formatDue(60_000)).toBe('at 1m');
    expect(formatDue(125_000)).toBe('at 2m 5s');
    expect(formatDue(1_499)).toBe('at 1s');
  });
});

describe('visibleSettingsPages', () => {
  const pages = [{ id: 'account' }, { id: 'about' }, { id: 'sandbox' }];

  it('hides the sandbox page outside sandbox mode', () => {
    expect(visibleSettingsPages(pages, null).map((p) => p.id)).toEqual([
      'account',
      'about',
    ]);
  });

  it('lists it in sandbox mode', () => {
    expect(visibleSettingsPages(pages, info).map((p) => p.id)).toEqual([
      'account',
      'about',
      'sandbox',
    ]);
  });
});

describe('latestOnly', () => {
  it('drops a reply to an older request that lands after a newer one', () => {
    const o = latestOnly();
    const poll = o.next();
    const toggle = o.next();
    expect(o.accept(toggle)).toBe(true);
    expect(o.accept(poll)).toBe(false);
  });

  it('accepts replies in order', () => {
    const o = latestOnly();
    const a = o.next();
    const b = o.next();
    expect(o.accept(a)).toBe(true);
    expect(o.accept(b)).toBe(true);
  });
});

describe('EphemeralStore.sandbox', () => {
  it('is null until app info arrives, and without a sandbox', () => {
    const e = new EphemeralStore();
    expect(e.appInfo).toBeNull();
    expect(e.sandbox).toBeNull();
    e.setAppInfo(appInfo(null));
    expect(e.sandbox).toBeNull();
  });

  it('exposes AppInfo.sandbox once set', () => {
    const e = new EphemeralStore();
    e.setAppInfo(appInfo(info));
    expect(e.sandbox).toEqual(info);
  });

  it('treats a missing sandbox field as not in sandbox mode', () => {
    const e = new EphemeralStore();
    const { sandbox: _, ...noSandbox } = appInfo(null);
    e.setAppInfo(noSandbox);
    expect(e.sandbox).toBeNull();
  });
});

describe('sandbox commands', () => {
  let transport: FakeTransport;
  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
  });

  it('loadAppInfo stores app_info', async () => {
    transport.queueResult('app_info', appInfo(info));
    const ephemeral = new EphemeralStore();
    await loadAppInfo({ ephemeral } as unknown as RootStore);
    expect(ephemeral.sandbox).toEqual(info);
  });

  it('loadAppInfo leaves the store empty when app_info fails', async () => {
    transport.queueResult('app_info', new Error('boom'));
    const ephemeral = new EphemeralStore();
    await loadAppInfo({ ephemeral } as unknown as RootStore);
    expect(ephemeral.appInfo).toBeNull();
  });

  it('wraps the generated command names and argument shapes', async () => {
    const status: SandboxStatus = {
      info,
      faults: [{ name: 'offline', on: true, detail: 'every call fails' }],
      events: [],
      viewer: 'octocat',
      prs: 3,
    };
    transport.onCall('sandbox_status', () => status);
    transport.onCall('sandbox_set_fault', () => status);
    transport.onCall('sandbox_fire_event', () => status);
    expect(await api.sandboxStatus()).toEqual(status);
    await api.sandboxSetFault({ name: 'offline', on: true });
    await api.sandboxFireEvent('ci-green');
    expect(transport.calls).toEqual([
      { cmd: 'sandbox_status', args: undefined },
      {
        cmd: 'sandbox_set_fault',
        args: { req: { name: 'offline', on: true } },
      },
      { cmd: 'sandbox_fire_event', args: { id: 'ci-green' } },
    ]);
  });
});

describe('ownerAvatarUrl', () => {
  it('uses the GitHub avatar URL outside sandbox mode', () => {
    expect(ownerAvatarUrl('github', 'acme', false)).toBe(
      'https://github.com/acme.png',
    );
  });

  it('makes no remote request in sandbox mode', () => {
    expect(ownerAvatarUrl('github', 'acme', true)).toBeNull();
  });

  it('has no avatar convention for other hosts', () => {
    expect(ownerAvatarUrl('gitlab', 'acme', false)).toBeNull();
  });
});
