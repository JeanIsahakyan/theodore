/**
 * The demo behind "Try the demo" on the sign-in screen: the mock services
 * (src/dev/mock.ts) under a neutral account, so the app can be explored
 * without a Theodore account or a computer (App Review; docs/mobile.md
 * "Demo"). Nothing in it talks to a server; signing out leaves it.
 */
import type { Organization, Session } from '../auth/types';
import type { Services } from '../services';
import { createMock, mockDevices } from './mock';

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

/** Fresh demo services; seeds the fleet store with the fixture. */
export function createDemo(): Services {
  return createMock({
    session: demoSession,
    organizations: demoOrganizations,
    snapshot: {
      devices: mockDevices.map((d) =>
        d.thisDevice ? { ...d, name: 'iPhone' } : { ...d },
      ),
    },
  }).services;
}
