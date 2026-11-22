/**
 * What the shell does around the accounts (docs/mobile.md "Several
 * accounts"), wired into `MultiAccountClient`'s hooks by AppProviders:
 *
 * ```text
 * account added     ─▶ before it is active: this device's push token registered in
 *                      its other orgs (a short-lived fleet client each, src/push/sweep.ts);
 *                      its active org gets it from the main link's welcome
 * app start         ─▶ inactive accounts whose last sweep is a day old: the same, in
 *                      every org they are known to be in
 * active signs out  ─▶ the main link forgets the token in its org (dropPushHere), the
 *                      account's other orgs get "" the same way
 * account removed   ─▶ its saved spaces and last picks go, per <user>.<org>
 * ```
 *
 * Everything here is best effort and capped in time: a sweep that can't
 * reach the cloud is tried again at the next start.
 */
import type { MultiAccountClient, MultiHooks } from '../auth/multi';
import type { AuthClient } from '../auth/types';
import { createFleetClient } from '../fleet/client';
import { savedScope } from '../fleet/saved';
import { initialFleet } from '../state/fleet';
import type { FleetClient, FleetSnapshot } from '../fleet/types';
import { registerPushIn, type SweepFleet } from '../push/sweep';
import { picksStore } from '../state/compose';
import { create } from 'zustand';

/** A sweep (every org of one account) gives up after this long. */
export const SWEEP_CAP_MS = 25_000;
/** One org's connect within a sweep. */
const CONNECT_MS = 8_000;

export interface AccountHookDeps {
  /** The app's fleet client (the active account's link). */
  fleet: () => FleetClient;
  /** This device's push token, if pushes are possible here. */
  pushToken: () => Promise<string | null>;
  /** A fleet client that reports to nobody's screen. */
  makeFleet?: (auth: AuthClient) => SweepFleet;
  now?: () => number;
  warn?: (message: string) => void;
}

/** A fleet client over a throwaway store, for one org's push registration. */
export function sweepFleet(auth: AuthClient): SweepFleet {
  const store = create<FleetSnapshot>(() => initialFleet);
  const f = createFleetClient(auth, undefined, { store });
  return {
    start: () => f.start(),
    registerPush: (token) => f.registerPush(token),
    onLink: (listener) =>
      store.subscribe((s, prev) => {
        if (s.connection !== prev.connection) listener(s.connection);
      }),
    dispose: () => f.dispose(),
  };
}

const capped = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });

export function accountHooks(deps: AccountHookDeps): MultiHooks & {
  /** At start: inactive accounts due for a sweep get the token in their orgs. */
  sweepInactive(accounts: MultiAccountClient): Promise<void>;
} {
  const makeFleet = deps.makeFleet ?? sweepFleet;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((m: string) => console.warn(`[accounts] ${m}`));

  const sweep = async (
    client: AuthClient,
    orgs: readonly string[],
    token: string,
  ) => {
    if (!orgs.length) return;
    const r = await capped(
      registerPushIn(client, orgs, token, makeFleet, { connectMs: CONNECT_MS }),
      SWEEP_CAP_MS,
    );
    if (!r) warn('push registration for an account timed out');
    else if (r.skipped.length)
      warn(`push not registered in ${r.skipped.length} organization(s)`);
  };

  return {
    async beforeActivate(userId, client, orgs) {
      const token = await deps.pushToken();
      if (!token) return;
      const s = await client.current();
      await sweep(
        client,
        orgs.filter((o) => o !== s?.organizationId),
        token,
      );
    },

    async beforeSignOut(_userId, client, orgs) {
      const s = await client.current();
      // The connected org through the link that has it; the others briefly.
      try {
        await deps.fleet().dropPushHere();
      } catch {
        // the link is gone: nothing to tell
      }
      const token = await deps.pushToken();
      if (!token) return;
      await sweep(
        client,
        orgs.filter((o) => o !== s?.organizationId),
        '',
      );
    },

    onRemoved(userId, orgs) {
      const scopes = orgs.map((o) => savedScope(userId, o));
      void deps
        .fleet()
        .forgetSaved(scopes)
        .catch((e: unknown) => warn(`saved spaces not removed: ${String(e)}`));
      for (const scope of scopes)
        void picksStore()
          .clear(scope)
          .catch(() => {});
    },

    async sweepInactive(accounts) {
      const token = await deps.pushToken();
      if (!token) return;
      for (const a of accounts.accounts()) {
        if (a.active || a.stale || !accounts.pushSweepDue(a.userId, now()))
          continue;
        const client = accounts.clientOf(a.userId);
        if (!client) continue;
        let orgs = [a.orgId, ...a.orgs.map((o) => o.id)].filter(
          (o): o is string => !!o,
        );
        if (!orgs.length) {
          try {
            orgs = (await accounts.loadOrganizations(a.userId)).map(
              (o) => o.id,
            );
          } catch {
            continue;
          }
        }
        await sweep(client, [...new Set(orgs)], token);
        await accounts.notePushSwept(a.userId, now());
      }
    },
  };
}
