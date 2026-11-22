/**
 * This device's push token in the organizations of an account that isn't
 * the active one (docs/mobile.md "Several accounts"): for each org, a
 * short-lived fleet client as that account connects, sends `register_push`
 * (the token, or "" to remove it) and disconnects. The hub keeps one
 * connection per device, so the active account's connected org is never
 * swept here (its own link registers the token at its welcome).
 *
 * ```text
 * for org in orgs:
 *   the account's session not in org ─▶ refresh + organization_id (its client)
 *   fleet(auth, throwaway store).start() ─▶ connected ─▶ register_push ─▶ stop
 *   not connected within the wait ─▶ that org skipped
 * ```
 *
 * Pure apart from the clients handed in: tests pass fakes.
 */
import type { AuthClient } from '../auth/types';
import type { FleetClient, FleetSnapshot } from '../fleet/types';

/** A fleet client with a store to watch and a way to end it. */
export interface SweepFleet extends Pick<
  FleetClient,
  'start' | 'registerPush'
> {
  /** The connection state as it changes (`true` once welcomed, `false` on error). */
  onLink(listener: (state: FleetSnapshot['connection']) => void): () => void;
  dispose(): void;
}

export interface SweepOptions {
  /** From `start()` to the welcome. */
  connectMs?: number;
  /** The frame leaves before the socket closes. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SweepResult {
  /** Orgs the token was registered (or removed) in. */
  done: string[];
  /** Orgs that couldn't be reached or switched to. */
  skipped: string[];
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Registers `token` ("" removes it) in each of `orgs` as the account whose
 * client is `auth`. Its session ends up in the last org switched to; the
 * caller puts it back where it wants it.
 */
export async function registerPushIn(
  auth: AuthClient,
  orgs: readonly string[],
  token: string,
  makeFleet: (auth: AuthClient) => SweepFleet,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const connectMs = opts.connectMs ?? 15_000;
  const settleMs = opts.settleMs ?? 250;
  const sleep = opts.sleep ?? wait;
  const result: SweepResult = { done: [], skipped: [] };
  for (const org of orgs) {
    try {
      const s = await auth.current();
      if (!s) throw new Error('not signed in');
      if (s.organizationId !== org) await auth.switchOrganization(org);
      const fleet = makeFleet(auth);
      try {
        const linked = new Promise<boolean>((resolve) => {
          const off = fleet.onLink((state) => {
            if (state === 'connected') {
              off();
              resolve(true);
            } else if (state === 'error') {
              off();
              resolve(false);
            }
          });
          void sleep(connectMs).then(() => {
            off();
            resolve(false);
          });
        });
        await fleet.start();
        if (!(await linked)) throw new Error(`couldn't connect to ${org}`);
        await fleet.registerPush(token);
        await sleep(settleMs);
      } finally {
        fleet.dispose();
      }
      result.done.push(org);
    } catch {
      result.skipped.push(org);
    }
  }
  return result;
}
