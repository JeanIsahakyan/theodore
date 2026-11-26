/**
 * Account deletion (App Store guideline 5.1.1(v)): `DELETE /v1/account`
 * deletes the caller's Theodore account and what the cloud keeps of it.
 *
 * ```text
 * DELETE /v1/account + Bearer <access JWT> ─▶ verify ─▶ RL_USER
 *   ─▶ WorkOS user still there? no (404) ─▶ 204   (a retry after the last step)
 *   1 ─▶ MCP OAuth grants and tokens of the user revoked (OAUTH_KV)
 *   2 ─▶ memberships (any status) + personal org (external_id personal:<user>)
 *        ─▶ each other org: members besides the user?
 *             yes (shared) ─▶ OrgHub purge {scope: user}, R2 blobs the user uploaded
 *             no  (sole)   ─▶ goes like the personal org (3)
 *   3 ─▶ personal + sole orgs: OrgHub purge {scope: org}, every R2 blob of the org,
 *        WorkOS DELETE the org
 *   4 ─▶ PostHog: the person and its events (best effort, never blocks)
 *   5 ─▶ WorkOS DELETE the user (memberships, sessions go with it)
 *   ─▶ 204
 * ```
 *
 * Every step is idempotent and the WorkOS user goes last, so a failed step
 * leaves an account a retry finishes. Logs name the failed step and the
 * error kind only (`cloud.account_delete`), never an id or an email.
 */
import type { Deps } from './index';
import { purgeBlobs } from './fleet/blobs';
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
  const others = [...new Set(memberships.map((m) => m.organization_id))].filter(
    (org) => org !== personal?.id,
  );
  // An org with nobody else in it (any status: an invite pending counts as
  // someone) goes with the user; any other stays, without the user.
  const sole = new Set<string>();
  await step('org_members', () =>
    Promise.all(
      others.map(async (org) => {
        const members = await deps.workos.organizationMembers(org);
        if (members.every((m) => m.user_id === userId)) sole.add(org);
      }),
    ),
  );
  const shared = others.filter((org) => !sole.has(org));
  const gone = [...(personal ? [personal.id] : []), ...sole];

  const hub = deps.hub;
  if (hub) {
    await step('hubs', () =>
      Promise.all(
        shared.map((org) => purgeInHub(hub, origin, userId, org, 'user')),
      ),
    );
    await step('org_hubs', () =>
      Promise.all(
        gone.map((org) => purgeInHub(hub, origin, userId, org, 'org')),
      ),
    );
  }
  const blobs = deps.blobs;
  if (blobs) {
    await step('blobs', () =>
      Promise.all([
        ...shared.map((org) => purgeBlobs(blobs, org, userId)),
        ...gone.map((org) => purgeBlobs(blobs, org, null)),
      ]),
    );
  }
  for (const org of gone) {
    await step('delete_org', () => deps.workos.deleteOrganization(org));
  }

  const forget = deps.forgetPerson;
  if (forget) {
    // Never blocks the deletion: logged (the kind only) and skipped.
    await step('posthog', () => forget(userId)).catch(() => undefined);
  }

  await step('workos_user', () => deps.workos.deleteUser(userId));
}
