import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../core/transport';
import type { RootStore } from '../../stores/RootStore';
import { FakeTransport } from '../../test/fakeTransport';
import {
  needsAutoRefresh,
  refreshProjectTracked,
  refreshingProjects,
  staleFetchedLabel,
} from './freshness';

const MIN = 60_000;

describe('needsAutoRefresh', () => {
  it('refreshes a never-fetched project or one older than 5 minutes', () => {
    const now = 100 * MIN;
    expect(needsAutoRefresh(null, now)).toBe(true);
    expect(needsAutoRefresh(undefined, now)).toBe(true);
    expect(needsAutoRefresh(now - 5 * MIN - 1, now)).toBe(true);
    expect(needsAutoRefresh(now - 5 * MIN, now)).toBe(false);
    expect(needsAutoRefresh(now - MIN, now)).toBe(false);
  });
});

describe('staleFetchedLabel', () => {
  it('says nothing for fresh or never-fetched data', () => {
    const now = Date.now();
    expect(staleFetchedLabel(null, now)).toBeNull();
    expect(staleFetchedLabel(now - 9 * MIN, now)).toBeNull();
    expect(staleFetchedLabel(now - 10 * MIN, now)).toBeNull();
  });

  it('says how old once past 10 minutes', () => {
    const now = Date.now();
    expect(staleFetchedLabel(now - 12 * MIN, now)).toBe('fetched 12m ago');
  });
});

describe('refreshProjectTracked', () => {
  let transport: FakeTransport;
  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
  });

  it('marks the project refreshing until the command settles, once', async () => {
    let release!: () => void;
    transport.onCall(
      'refresh_project',
      () => new Promise<null>((r) => (release = () => r(null))),
    );
    const store = {} as RootStore;

    const first = refreshProjectTracked(store, 'github:acme/web');
    expect(refreshingProjects.has('github:acme/web')).toBe(true);
    // A second trigger while one runs doesn't start another.
    await refreshProjectTracked(store, 'github:acme/web');
    expect(
      transport.calls.filter((c) => c.cmd === 'refresh_project'),
    ).toHaveLength(1);

    release();
    await first;
    expect(refreshingProjects.has('github:acme/web')).toBe(false);
  });

  it('clears the flag when the refresh fails', async () => {
    transport.queueResult(
      'refresh_project',
      Object.assign(new Error('boom'), { code: 'host', message: 'boom' }),
    );
    await refreshProjectTracked({} as RootStore, 'github:acme/web');
    expect(refreshingProjects.has('github:acme/web')).toBe(false);
  });
});
