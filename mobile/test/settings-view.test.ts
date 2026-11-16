import { describe, expect, it } from 'vitest';
import type { Organization } from '../src/auth/types';
import {
  accountView,
  devicesSummary,
  organizationNote,
  serverHost,
  themeLabel,
} from '../src/ui/settingsView';

const orgs: Organization[] = [
  { id: 'org-a', name: 'Acme', role: 'admin', personal: false },
  { id: 'org-p', name: 'Personal', role: null, personal: true },
];

describe('Settings wording', () => {
  it('shows the server as its host', () => {
    expect(serverHost('https://cloud.example.com/v1/x')).toBe(
      'cloud.example.com',
    );
    expect(serverHost('http://localhost:8787')).toBe('localhost:8787');
  });

  it('names the theme as its menu does', () => {
    expect(themeLabel('light')).toBe('Light');
    expect(themeLabel('dark')).toBe('Dark');
    expect(themeLabel('system')).toBe('System');
  });

  it('counts your other devices online', () => {
    expect(devicesSummary([{ online: true, thisDevice: true }])).toBe(
      'None yet',
    );
    expect(
      devicesSummary([
        { online: true, thisDevice: true },
        { online: true, thisDevice: false },
        { online: false, thisDevice: false },
        { online: true, thisDevice: false },
      ]),
    ).toBe('2 online');
    expect(devicesSummary([{ online: false, thisDevice: false }])).toBe(
      '0 online',
    );
  });

  it('builds the account card: name, email, org and role', () => {
    const session = {
      name: 'Jean Isahakyan',
      email: 'jean@example.com',
      organizationId: 'org-a',
      role: 'member',
    };
    expect(accountView(session, orgs)).toEqual({
      title: 'Jean Isahakyan',
      email: 'jean@example.com',
      initials: 'JI',
      organization: 'Acme',
      // The org list's role wins over the token's.
      role: 'Admin',
    });
  });

  it('falls back to the email, and to the session role, before orgs load', () => {
    const v = accountView(
      {
        name: null,
        email: 'jean@example.com',
        organizationId: 'org-a',
        role: 'member',
      },
      [],
    );
    expect(v.title).toBe('jean@example.com');
    expect(v.email).toBeNull();
    expect(v.initials).toBe('J');
    expect(v.organization).toBeNull();
    expect(v.role).toBe('Member');
    expect(accountView(null, []).title).toBe('Signed in');
  });

  it('says why the switch failed, else what an org holds', () => {
    expect(organizationNote("Couldn't switch organization.", 2)).toBe(
      "Couldn't switch organization.",
    );
    expect(organizationNote(null, 2)).toBe(
      'Spaces and devices belong to the organization you are in.',
    );
    expect(organizationNote(null, 1)).toBeNull();
  });
});
