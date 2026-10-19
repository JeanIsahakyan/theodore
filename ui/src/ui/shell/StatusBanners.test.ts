import { describe, expect, it } from 'vitest';
import type { HostStatus } from '../../stores/EphemeralStore';
import { statusKind } from './StatusBanners';

const host = (overrides: Partial<HostStatus> = {}): HostStatus => ({
  online: true,
  rateLimitedUntil: null,
  authOk: true,
  ...overrides,
});

describe('statusKind', () => {
  it('shows nothing when everything is fine', () => {
    expect(statusKind('online', host(), Date.now())).toBeNull();
  });

  it('is offline when the sync client errored, even if the host looks fine', () => {
    expect(statusKind('error', host(), Date.now())).toBe('offline');
  });

  it('is offline when the host itself reports offline', () => {
    expect(statusKind('online', host({ online: false }), Date.now())).toBe(
      'offline',
    );
  });

  it('prefers offline over an auth failure', () => {
    expect(
      statusKind('error', host({ online: false, authOk: false }), Date.now()),
    ).toBe('offline');
  });

  it('is an auth failure once online and the token was rejected', () => {
    expect(statusKind('online', host({ authOk: false }), Date.now())).toBe(
      'auth',
    );
  });

  it('prefers auth failure over a rate limit', () => {
    const now = Date.now();
    expect(
      statusKind(
        'online',
        host({ authOk: false, rateLimitedUntil: now + 60_000 }),
        now,
      ),
    ).toBe('auth');
  });

  it('is rate-limited only while the reset time is still in the future', () => {
    const now = Date.now();
    expect(
      statusKind('online', host({ rateLimitedUntil: now + 60_000 }), now),
    ).toBe('rate');
    expect(
      statusKind('online', host({ rateLimitedUntil: now - 1 }), now),
    ).toBeNull();
  });
});
