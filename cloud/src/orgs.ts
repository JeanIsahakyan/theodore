/**
 * Every user has an organization: alone, a personal one. The fleet keys its
 * state by `org_id` (one Durable Object per org), so solo and team use run
 * the same path and nothing migrates when a team forms later.
 *
 * ```text
 * POST /v1/orgs/personal  (the caller's access token)
 *   ─▶ org with external_id personal:<user_id>? ── no ─▶ create it
 *        │                                              └─ taken meanwhile ─▶ look up again
 *   ─▶ caller's membership in it? ── no ─▶ create, role admin
 *        └─ not active ─▶ 409 cloud.membership_inactive (deactivated on purpose: not undone here)
 *   ─▶ { organization_id, created }
 * the app then refreshes its session with organization_id ─▶ token carries org_id, role
 * ```
 */
import { CloudError } from './errors';
import { WorkosError, type User, type Workos } from './workos';

/** The role the owner of a personal organization gets. */
export const PERSONAL_ROLE = 'admin';

export const personalExternalId = (userId: string) => `personal:${userId}`;

export function personalName(user: User): string {
  return `Personal (${user.email})`;
}

export interface EnsuredOrganization {
  organization_id: string;
  created: boolean;
}

// A 4xx from a create can mean another request created the same thing first
// (the app may call twice at once); a 5xx is just a failure.
const maybeRace = (e: unknown) =>
  e instanceof WorkosError && e.status >= 400 && e.status < 500;

export async function ensurePersonalOrganization(
  userId: string,
  workos: Workos,
): Promise<EnsuredOrganization> {
  const externalId = personalExternalId(userId);
  let created = false;
  let org = await workos.organizationByExternalId(externalId);
  if (!org) {
    const user = await workos.user(userId);
    try {
      org = await workos.createOrganization({
        name: personalName(user),
        externalId,
      });
      created = true;
    } catch (e) {
      if (!maybeRace(e)) throw e;
      org = await workos.organizationByExternalId(externalId);
      if (!org) throw e;
    }
  }

  const find = () =>
    workos.memberships({ userId, organizationId: org.id }).then((m) => m[0]);
  let membership = await find();
  if (!membership) {
    try {
      membership = await workos.createMembership({
        userId,
        organizationId: org.id,
        roleSlug: PERSONAL_ROLE,
      });
    } catch (e) {
      if (!maybeRace(e)) throw e;
      membership = await find();
      if (!membership) throw e;
    }
  }
  if (membership.status !== 'active') {
    throw new CloudError(
      409,
      'cloud.membership_inactive',
      `your membership in your personal organization is ${membership.status}`,
    );
  }
  return { organization_id: org.id, created };
}

export interface OrganizationEntry {
  id: string;
  name: string;
  role: string | null;
  personal: boolean;
}

/**
 * The caller's organizations for the app's switcher: active memberships only,
 * the personal one first, then by name. At most 100 (one page); nobody is in
 * more.
 */
export async function listOrganizations(
  userId: string,
  workos: Workos,
): Promise<OrganizationEntry[]> {
  const [memberships, personal] = await Promise.all([
    workos.memberships({ userId }),
    workos.organizationByExternalId(personalExternalId(userId)),
  ]);
  const active = memberships.filter((m) => m.status === 'active');
  const entries = await Promise.all(
    active.map(async (m) => ({
      id: m.organization_id,
      // Older API answers carry no organization_name: ask for the org.
      name:
        m.organization_name ??
        (await workos.organization(m.organization_id)).name,
      role: m.role?.slug ?? null,
      personal: m.organization_id === personal?.id,
    })),
  );
  return entries.sort(
    (a, b) =>
      Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name),
  );
}
