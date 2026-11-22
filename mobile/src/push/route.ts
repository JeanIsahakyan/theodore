/**
 * Which signed-in account a notification belongs to (docs/mobile.md
 * "Several accounts"). A push names a space and its host, not an org: the
 * space is looked up in the saved sets kept per `<user>.<org>`
 * (`src/fleet/saved.ts`). Pure, so the tests read it; the Expo layer
 * (`index.ts`) feeds it the sets and acts on the answer.
 *
 * ```text
 * push{space} ─▶ the active account's current org has it ─▶ open it here
 *            ─▶ another <user>.<org> has it ─▶ switch to that account and org, then open
 *            ─▶ nobody has it ─▶ open it as the active account (it may be new)
 * a button / Reply for another account's space ─▶ signed with that account's
 *            token in that org (`PushIdentity`), no switch
 * ```
 *
 * The cloud's title says "<host> · <space>"; the org isn't in the payload
 * (noted as a cloud follow-up), so the title can't name it yet.
 */
import { savedScope } from '../fleet/saved';
import type { AccountView } from '../auth/types';

export interface ScopeSpaces {
  userId: string;
  orgId: string;
  scope: string;
  spaces: readonly string[];
}

/** Every `<user>.<org>` the accounts here may have spaces in. */
export function accountScopes(
  accounts: readonly AccountView[],
): { userId: string; orgId: string; scope: string }[] {
  const out: { userId: string; orgId: string; scope: string }[] = [];
  const seen = new Set<string>();
  for (const a of accounts) {
    const orgs = [a.orgId, ...a.orgs.map((o) => o.id)].filter(
      (id): id is string => !!id,
    );
    for (const orgId of orgs) {
      const scope = savedScope(a.userId, orgId);
      if (seen.has(scope)) continue;
      seen.add(scope);
      out.push({ userId: a.userId, orgId, scope });
    }
  }
  return out;
}

export type PushTarget =
  /** The active account, in the org it is in (or nobody has the space). */
  | { kind: 'here' }
  /** Another account, or another org of the active one. */
  | { kind: 'switch'; userId: string; orgId: string };

/**
 * Where a push's space lives. The active account's current org wins when
 * it has the space (a space followed from two accounts opens without a
 * switch); else the first set that has it.
 */
export function pushTarget(
  space: string,
  sets: readonly ScopeSpaces[],
  active: { userId: string; orgId: string | null } | null,
): PushTarget {
  const owners = sets.filter((s) => s.spaces.includes(space));
  if (owners.length === 0) return { kind: 'here' };
  if (
    active &&
    owners.some((o) => o.userId === active.userId && o.orgId === active.orgId)
  )
    return { kind: 'here' };
  const o = owners[0];
  return { kind: 'switch', userId: o.userId, orgId: o.orgId };
}
