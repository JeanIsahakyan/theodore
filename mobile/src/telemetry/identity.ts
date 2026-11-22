/**
 * Who a record is from (docs/telemetry.md "Who a record is from").
 *
 * ```text
 * install id   made once, never changes: the hashing key, service.instance.id
 * anon id      the install id until the first sign-out or the moment linking
 *              starts; then a fresh random id, so what the old one sent stays
 *              unlinked. sign-out ─▶ a NEW anon id
 * account      the provider's user id (`user_…`), never the email; refused
 *              when it isn't shaped like one (treated as signed out)
 *
 * usageAccount()  = account, only while "Share usage data" is on at consent 2
 * errorsAccount() = account, only while "Send error reports" is on at consent 2
 * distinctId()    = usageAccount() ?? anon id
 * ```
 */
import type { DataStorage } from '../fleet/data';
import { linksErrors, linksUsage, type Choice } from './consent';

export const INSTALL_ID_KEY = 'theodore.telemetry.install_id';
export const ANON_ID_KEY = 'theodore.telemetry.anon_id';

/** A WorkOS user id: `user_` and 20+ upper-case alphanumerics. */
export const isAccountId = (v: unknown): v is string =>
  typeof v === 'string' && /^user_[A-Z0-9]{10,64}$/.test(v);

export interface Identity {
  installId(): string;
  anonId(): string;
  /** The signed-in account's provider id, or `null`. */
  account(): string | null;
  /** Sign-in: `null` or a value not shaped like a provider id = signed out. */
  setAccount(id: string | null): void;
  /** Sign-out: later events aren't linked to that person. */
  rotateAnon(): Promise<string>;
  usageAccount(choice: Choice): string | null;
  errorsAccount(choice: Choice): string | null;
  /** PostHog's `distinct_id`. */
  distinctId(choice: Choice): string;
}

export async function loadIdentity(
  storage: DataStorage,
  randomUUID: () => string,
): Promise<Identity> {
  let install = await storage.get(INSTALL_ID_KEY).catch(() => null);
  if (!install || !/^[A-Za-z0-9-]{8,64}$/.test(install)) {
    install = randomUUID();
    await storage.set(INSTALL_ID_KEY, install).catch(() => {});
  }
  let anon = await storage.get(ANON_ID_KEY).catch(() => null);
  if (anon && !/^[A-Za-z0-9-]{8,64}$/.test(anon)) anon = null;
  let account: string | null = null;
  const installId = install;
  const anonId = () => anon ?? installId;
  const usageAccount = (c: Choice) => (linksUsage(c) ? account : null);
  const identity: Identity = {
    installId: () => installId,
    anonId,
    account: () => account,
    setAccount(id) {
      account = isAccountId(id) ? id : null;
    },
    async rotateAnon() {
      anon = randomUUID();
      await storage.set(ANON_ID_KEY, anon).catch(() => {});
      return anon;
    },
    usageAccount,
    errorsAccount: (c) => (linksErrors(c) ? account : null),
    distinctId: (c) => usageAccount(c) ?? anonId(),
  };
  return identity;
}
