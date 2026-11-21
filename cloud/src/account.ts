/**
 * Account deletion (App Store guideline 5.1.1(v)): `DELETE /v1/account`
 * deletes the caller's Theodore account and what the cloud keeps of it.
 *
 * ```text
 * DELETE /v1/account + Bearer <access JWT> ─▶ verify ─▶ RL_USER
 *   ─▶ WorkOS user still there? no (404) ─▶ 204   (a retry after the last step)
 *   1 ─▶ MCP OAuth grants and tokens of the user revoked (OAUTH_KV)
 *   2 ─▶ memberships (any status) + personal org (external_id personal:<user>)
 *        ─▶ each other org's OrgHub: purge {scope: user}  (the user's rows only)
 *   3 ─▶ personal org's OrgHub: purge {scope: org} ─▶ WorkOS DELETE the org
 *   4 ─▶ WorkOS DELETE the user (memberships, sessions go with it)
 *   ─▶ 204
 * ```
 *
 * Every step is idempotent and the WorkOS user goes last, so a failed step
 * leaves an account a retry finishes. Logs name the failed step and the
 * error kind only.
 */
import type { Deps } from './index';
import { purgeInHub } from './fleet/route';
import { revokeUserGrants } from './mcp/oauth';
import { personalExternalId } from './orgs';
import { WorkosError } from './workos';

/** Runs one step; a failure is logged as the step and its kind, rethrown. */
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    console.error(
      'cloud.account_delete',
      name,
      e instanceof Error ? e.name : typeof e,
    );
    throw e;
  }
}

export async function deleteAccount(
  userId: string,
  deps: Deps,
  origin: string,
): Promise<void> {
  const exists = await step('user', async () => {
    try {
      await deps.workos.user(userId);
      return true;
    } catch (e) {
      if (e instanceof WorkosError && e.status === 404) return false;
      throw e;
    }
  });
  // The user is deleted last: gone means every step before it is done.
  if (!exists) return;

  const kv = deps.oauthKv;
  if (kv)
    await step('mcp_grants', () => revokeUserGrants(kv, origin, userId, deps));

  const [memberships, personal] = await step('orgs', () =>
    Promise.all([
      deps.workos.memberships({ userId }),
      deps.workos.organizationByExternalId(personalExternalId(userId)),
    ]),
  );
  const hub = deps.hub;
  if (hub) {
    const others = [
      ...new Set(memberships.map((m) => m.organization_id)),
    ].filter((org) => org !== personal?.id);
    await step('hubs', () =>
      Promise.all(
        others.map((org) => purgeInHub(hub, origin, userId, org, 'user')),
      ),
    );
    if (personal) {
      await step('personal_hub', () =>
        purgeInHub(hub, origin, userId, personal.id, 'org'),
      );
    }
  }
  if (personal) {
    await step('personal_org', () =>
      deps.workos.deleteOrganization(personal.id),
    );
  }
  await step('workos_user', () => deps.workos.deleteUser(userId));
}
