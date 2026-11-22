/** Several Theodore accounts at once (docs/cloud.md "Several accounts"):
 *  what the sidebar's bottom row, its popover and Settings → Account show
 *  for each one. Pure, so the rows are easy to test. */
import type {
  AccountEntry,
  AccountOrganization,
  AccountStatus,
  AccountUser,
  Space,
} from '../gen/contract';

/** The active account's row, if someone is signed in. */
export function activeAccount(
  status: AccountStatus | null,
): AccountEntry | null {
  return status?.accounts.find((a) => a.active) ?? null;
}

/** First name if known, else the email: "Jean", "jean@acme.com". */
export function shortName(user: AccountUser): string {
  const name = user.name?.trim();
  if (name) return name.split(/\s+/)[0] ?? name;
  return user.email;
}

/** The personal organization is just "Personal"; a team keeps its name. */
export function orgLabel(o: AccountOrganization): string {
  return o.personal ? 'Personal' : o.name;
}

/** The organizations an account's row lists: the cloud's list, else its
 *  current one by id alone (the list hasn't loaded, or there is no cloud). */
export function listedOrganizations(
  entry: AccountEntry,
): AccountOrganization[] {
  if (entry.organizations.length) return entry.organizations;
  if (entry.organization) {
    return [
      {
        id: entry.organization.id,
        name: 'Organization',
        role: entry.organization.role,
        personal: false,
      },
    ];
  }
  return [];
}

/** The name of the organization the account's session is in, as the
 *  cloud last listed it; `null` while unknown. */
export function currentOrgLabel(entry: AccountEntry): string | null {
  const id = entry.organization?.id;
  if (!id) return null;
  const o = entry.organizations.find((x) => x.id === id);
  return o ? orgLabel(o) : null;
}

/** The sidebar's bottom row: "Jean · Personal" (the organization only
 *  once its name is known). */
export function rowLabel(entry: AccountEntry): string {
  const org = currentOrgLabel(entry);
  const name = shortName(entry.user);
  return org ? `${name} · ${org}` : name;
}

/** Running spaces per account (user id). Spaces from before the account
 *  was recorded, and remote ones, count for nobody. */
export function runningByAccount(
  spaces: readonly Space[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const s of spaces) {
    if (s.status !== 'running' || !s.account || s.remote) continue;
    out.set(s.account, (out.get(s.account) ?? 0) + 1);
  }
  return out;
}

/** "2 running", for another account's row; nothing at zero. */
export function runningLabel(n: number | undefined): string | null {
  return n ? `${n} running` : null;
}

/** The popover's item keys, one scheme for every action. */
export type AccountAction =
  | { kind: 'switch'; userId: string; organizationId: string | null }
  | { kind: 'sign-in-again'; userId: string }
  | { kind: 'add' }
  | { kind: 'settings' }
  | { kind: 'report' }
  | { kind: 'sign-out' };

export function actionKey(a: AccountAction): string {
  switch (a.kind) {
    case 'switch':
      return `switch:${a.userId}:${a.organizationId ?? ''}`;
    case 'sign-in-again':
      return `sign-in-again:${a.userId}`;
    default:
      return a.kind;
  }
}

export function parseActionKey(key: string): AccountAction | null {
  if (
    key === 'add' ||
    key === 'settings' ||
    key === 'report' ||
    key === 'sign-out'
  )
    return { kind: key };
  const [kind, userId, ...rest] = key.split(':');
  if (!userId) return null;
  if (kind === 'switch')
    return {
      kind,
      userId,
      organizationId: rest.join(':') || null,
    };
  if (kind === 'sign-in-again') return { kind, userId };
  return null;
}
