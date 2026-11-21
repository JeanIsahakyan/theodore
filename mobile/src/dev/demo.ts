/**
 * The demo behind "Try the demo" on the sign-in screen: the mock services
 * (src/dev/mock.ts) under a neutral account, so the app can be explored
 * without a Theodore account or a computer (App Review; docs/mobile.md
 * "Demo"). Nothing in it talks to a server; signing out leaves it.
 */
import type { Organization, Session } from '../auth/types';
import type { Services } from '../services';
import type { FleetSnapshot } from '../fleet/types';
import { createMock, mockDevices, mockMirrors, mockT0 } from './mock';

export const demoSession: Session = {
  userId: 'demo-user',
  email: 'demo@example.com',
  name: 'Demo',
  accessToken: 'demo',
  refreshToken: 'demo',
  expiresAt: Number.MAX_SAFE_INTEGER,
  organizationId: 'org-personal',
  role: 'admin',
};

export const demoOrganizations: Organization[] = [
  { id: 'org-personal', name: 'Personal', role: 'admin', personal: true },
  { id: 'org-acme', name: 'Acme', role: 'member', personal: false },
];

/** Timestamp keys in mirrored rows (`at`, `created_at`, `asked_at`, …). */
const isTime = (key: string) => key === 'at' || key.endsWith('_at');

/** `value` with every timestamp moved by `by` ms. */
function shiftTimes<T>(value: T, by: number): T {
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, by)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        isTime(k) && typeof v === 'number' ? v + by : shiftTimes(v, by),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Fresh demo services; seeds the fleet store with the fixture, its chat
 * moved to a few minutes ago (the fixture's fixed dates would read as
 * "working for 158 h").
 */
export function createDemo(now: number = Date.now()): Services {
  const snapshot: Partial<FleetSnapshot> = {
    devices: mockDevices.map((d) =>
      d.thisDevice ? { ...d, name: 'iPhone' } : { ...d },
    ),
    mirrors: shiftTimes(mockMirrors, now - mockT0 - 5 * 60_000),
  };
  return createMock({
    session: demoSession,
    organizations: demoOrganizations,
    snapshot,
  }).services;
}
