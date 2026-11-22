/**
 * The accounts signed in on this device (docs/mobile.md "Several
 * accounts"): an index of who they are, and one stored session per account
 * (`store.ts` is still one session; `multi.ts` runs one `AuthKitClient`
 * per account over this index). Pure, so the tests read it.
 *
 * ```text
 * secure store
 *   theodore.accounts                 {v, active, accounts: [{userId, name, email, orgId,
 *                                                             orgs, stale, pushSweptAt, usedAt}]}
 *   theodore.account.<user id>        that account's Session, as `store.ts` writes it
 *   theodore.account                  the single session of older builds: adopted into
 *                                     the index at the first load, then removed
 *
 * add      ─▶ upsert (a user signing in again replaces their record), active
 * switch   ─▶ active = it, usedAt = now, orgId = the org it is in now
 * sign-out ─▶ removed; the next active is the most recently used that can
 *             still sign requests (not stale), else any, else none
 * stale    ─▶ its refresh was rejected: kept, "Sign in again" on its row
 * ```
 *
 * The email stays on this device: it is shown on the account's row and
 * passed as `login_hint` to the hosted sign-in page, never sent anywhere
 * else.
 */
import { storageKey } from '../keys/storage-types';
import { initials } from '../ui/drawer';
import type { OrganizationChoice, Session } from './types';

export const ACCOUNTS_KEY = 'theodore.accounts';
/** The single-account entry of builds before the index. */
export const LEGACY_SESSION_KEY = 'theodore.account';

const VERSION = 1;
const TEXT_MAX = 200;
/** Most accounts kept at once; the least recently used goes first. */
export const ACCOUNTS_MAX = 10;
/** An account's push token is registered in its orgs at most this often. */
export const PUSH_SWEEP_EVERY_MS = 24 * 60 * 60_000;

export interface AccountRecord {
  userId: string;
  name: string | null;
  /** Shown only on this device. */
  email: string;
  /** The organization it is in (a switch to the account lands there). */
  orgId: string | null;
  /** Its organizations as the cloud last listed them (the sheet's rows). */
  orgs: OrganizationChoice[];
  /** Its session couldn't be refreshed: the row reads "Sign in again". */
  stale: boolean;
  /** Unix ms this device's push token was last registered in its orgs; 0 never. */
  pushSweptAt: number;
  /** Unix ms it was last the active account. */
  usedAt: number;
}

export interface AccountIndex {
  /** The account whose session the app runs as; `null` when none is left. */
  active: string | null;
  accounts: AccountRecord[];
}

export const EMPTY_INDEX: AccountIndex = { active: null, accounts: [] };

/** Where an account's session is stored. */
export const accountKey = (userId: string): string =>
  storageKey(LEGACY_SESSION_KEY, userId);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = TEXT_MAX): string | null =>
  typeof v === 'string' && v !== '' ? v.slice(0, max) : null;
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function cleanOrgs(v: unknown): OrganizationChoice[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((o) => ({ id: text(o.id) ?? '', name: text(o.name) ?? '' }))
    .filter((o) => o.id !== '')
    .slice(0, 50);
}

function cleanRecord(v: unknown): AccountRecord | null {
  if (!isObj(v)) return null;
  const userId = text(v.userId);
  if (!userId) return null;
  return {
    userId,
    name: text(v.name),
    email: text(v.email, 320) ?? '',
    orgId: text(v.orgId),
    orgs: cleanOrgs(v.orgs),
    stale: v.stale === true,
    pushSweptAt: num(v.pushSweptAt),
    usedAt: num(v.usedAt),
  };
}

/** The stored index, shape-checked; `null` when there is none (or it isn't one). */
export function parseAccountIndex(raw: string | null): AccountIndex | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== VERSION || !Array.isArray(v.accounts)) return null;
  const seen = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const r of v.accounts) {
    const rec = cleanRecord(r);
    if (!rec || seen.has(rec.userId)) continue;
    seen.add(rec.userId);
    accounts.push(rec);
  }
  const active = text(v.active);
  return {
    active: active && seen.has(active) ? active : null,
    accounts,
  };
}

export function serializeAccountIndex(index: AccountIndex): string {
  return JSON.stringify({ v: VERSION, ...index });
}

// ── rules ──────────────────────────────────────────────────────────────────

/** The record of `userId`, if signed in here. */
export const accountOf = (
  index: AccountIndex,
  userId: string,
): AccountRecord | undefined => index.accounts.find((a) => a.userId === userId);

/** What a session says about its account (identity fields only). */
export function recordFromSession(
  s: Pick<Session, 'userId' | 'name' | 'email' | 'organizationId'>,
  now: number,
): AccountRecord {
  return {
    userId: s.userId,
    name: s.name,
    email: s.email,
    orgId: s.organizationId,
    orgs: [],
    stale: false,
    pushSweptAt: 0,
    usedAt: now,
  };
}

/**
 * An account signed in (or signed in again): its record added or replaced
 * (orgs and the push sweep time kept), active. More than `ACCOUNTS_MAX`:
 * the least recently used go.
 */
export function upsertAccount(
  index: AccountIndex,
  s: Pick<Session, 'userId' | 'name' | 'email' | 'organizationId'>,
  now: number,
): AccountIndex {
  const fresh = recordFromSession(s, now);
  const before = accountOf(index, s.userId);
  const rec: AccountRecord = before
    ? { ...fresh, orgs: before.orgs, pushSweptAt: before.pushSweptAt }
    : fresh;
  const others = index.accounts.filter((a) => a.userId !== s.userId);
  const kept = [...others]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, ACCOUNTS_MAX - 1);
  const keptIds = new Set(kept.map((a) => a.userId));
  return {
    active: s.userId,
    accounts: [...others.filter((a) => keptIds.has(a.userId)), rec],
  };
}

/** The accounts `upsertAccount` would drop (to remove their sessions too). */
export function droppedBy(before: AccountIndex, after: AccountIndex): string[] {
  const kept = new Set(after.accounts.map((a) => a.userId));
  return before.accounts.map((a) => a.userId).filter((id) => !kept.has(id));
}

/** `userId` becomes the active account, in `orgId` when given. */
export function activate(
  index: AccountIndex,
  userId: string,
  now: number,
  orgId?: string | null,
): AccountIndex {
  if (!accountOf(index, userId)) return index;
  return {
    active: userId,
    accounts: index.accounts.map((a) =>
      a.userId === userId
        ? { ...a, usedAt: now, orgId: orgId === undefined ? a.orgId : orgId }
        : a,
    ),
  };
}

/**
 * The account to run as when `index.active` is gone: the most recently
 * used one that can still sign requests, else the most recently used.
 */
export function nextActive(index: AccountIndex): string | null {
  const byUse = [...index.accounts].sort((a, b) => b.usedAt - a.usedAt);
  return (byUse.find((a) => !a.stale) ?? byUse[0])?.userId ?? null;
}

/** `userId` signed out: removed; the next active picked when it was active. */
export function removeAccount(
  index: AccountIndex,
  userId: string,
): AccountIndex {
  const accounts = index.accounts.filter((a) => a.userId !== userId);
  const rest = { active: index.active, accounts };
  return {
    active: index.active === userId ? nextActive(rest) : index.active,
    accounts,
  };
}

/** A field of `userId`'s record changed. */
export function patchAccount(
  index: AccountIndex,
  userId: string,
  patch: Partial<Omit<AccountRecord, 'userId'>>,
): AccountIndex {
  if (!accountOf(index, userId)) return index;
  return {
    ...index,
    accounts: index.accounts.map((a) =>
      a.userId === userId ? { ...a, ...patch } : a,
    ),
  };
}

/** The organizations the cloud lists for `userId`, remembered for the sheet. */
export function recordOrgs(
  index: AccountIndex,
  userId: string,
  orgs: readonly OrganizationChoice[],
): AccountIndex {
  return patchAccount(index, userId, {
    orgs: orgs.map((o) => ({ id: o.id, name: o.name })),
  });
}

/** Whether its push token should be registered in its orgs again. */
export function pushSweepDue(rec: AccountRecord, now: number): boolean {
  return !rec.stale && now - rec.pushSweptAt >= PUSH_SWEEP_EVERY_MS;
}

/** "Jean", else the email, else "Signed in". */
export function accountLabel(
  rec: Pick<AccountRecord, 'name' | 'email'>,
): string {
  return rec.name?.trim() || rec.email || 'Signed in';
}

/** The two letters on its avatar. */
export const accountInitials = (
  rec: Pick<AccountRecord, 'name' | 'email'>,
): string => initials(rec.name, rec.email);

/** The name of `orgId` as the account's record knows it, else `null`. */
export function orgName(
  rec: AccountRecord,
  orgId: string | null,
): string | null {
  if (!orgId) return null;
  return rec.orgs.find((o) => o.id === orgId)?.name || null;
}

/** "Jean · Personal": the drawer's bottom row. */
export function accountLine(
  rec: Pick<AccountRecord, 'name' | 'email' | 'orgId' | 'orgs'>,
  orgNameNow: string | null = null,
): string {
  const org =
    orgNameNow ?? rec.orgs.find((o) => o.id === rec.orgId)?.name ?? null;
  return org ? `${accountLabel(rec)} · ${org}` : accountLabel(rec);
}
