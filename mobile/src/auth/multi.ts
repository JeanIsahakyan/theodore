/**
 * Several accounts signed in at once (docs/mobile.md "Several accounts"):
 * one `AuthKitClient` per account over the index in `accounts.ts`, and the
 * `AuthClient` the rest of the app sees is the active account's.
 *
 * ```text
 * current / accessToken / onChange ─▶ the active account's client
 * signIn (add)   ─▶ a pending client on a memory store ─▶ signed in ─▶ its session
 *                   moved to theodore.account.<user>, the record upserted, active;
 *                   a user signing in again replaces their record (stale no more)
 * switchTo(u, o) ─▶ u's client; in another org ─▶ refresh + organization_id ─▶ active
 *                   ─▶ onChange(its session): the fleet client reconnects as it
 * signOut        ─▶ the active one only: beforeSignOut hook (push tokens off),
 *                   its session gone, record removed ─▶ the next most recently
 *                   used account (onChange with its session), or null
 * a refresh of any account rejected ─▶ its record marked stale ("Sign in again");
 *                   the active one ─▶ the next usable account, or signed out
 * inactive clients ─▶ no background refresher (refreshed when a task needs them)
 * ```
 *
 * Hooks let the shell act around these without this module knowing the
 * fleet: push registration for a new account's orgs before it becomes
 * active, push removal before a sign-out, and the removal of what was
 * kept per `<user>.<org>` once an account is gone.
 */
import {
  ACCOUNTS_KEY,
  EMPTY_INDEX,
  LEGACY_SESSION_KEY,
  accountInitials,
  accountKey,
  accountLabel,
  accountOf,
  activate,
  droppedBy,
  nextActive,
  parseAccountIndex,
  patchAccount,
  pushSweepDue,
  recordOrgs,
  removeAccount,
  serializeAccountIndex,
  upsertAccount,
  type AccountIndex,
  type AccountRecord,
} from './accounts';
import { AuthKitClient, Mutex } from './client';
import { AuthError, asAuthError } from './errors';
import {
  memoryStore,
  parseStoredSession,
  serializeSession,
  type SessionStore,
} from './store';
import type {
  AccountView,
  AccountsClient,
  AuthClient,
  Organization,
  OrganizationChoice,
  Session,
  SignInOptions,
  SignInResult,
} from './types';

/** The secure store, by key (the platform's; memory in tests). */
export interface AccountKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Another context (a browser tab) changed `key`. */
  subscribe?(key: string, onChange: () => void): () => void;
}

export interface MultiHooks {
  /**
   * A new account's session is here, before it becomes the active one
   * (register this device's push token in its organizations, `orgs` as
   * the cloud lists them). Failures are logged, never block the sign-in.
   */
  beforeActivate?(
    userId: string,
    client: AuthClient,
    orgs: string[],
  ): Promise<void>;
  /** The active account is about to sign out of this device (push off). */
  beforeSignOut?(
    userId: string,
    client: AuthClient,
    orgs: string[],
  ): Promise<void>;
  /** An account's session left this device: what was kept per org goes. */
  onRemoved?(userId: string, orgs: string[]): void;
}

export interface MultiDeps {
  kv: AccountKV;
  /** An account's client over its own store (the platform's deps). */
  make(store: SessionStore, autoRefresh: boolean): AuthKitClient;
  hooks?: MultiHooks;
  now?: () => number;
  warn?: (message: string) => void;
}

const EXPIRED = 'This sign-in has expired. Sign in again.';
const STALE = 'Sign in again to use this account.';

/** Every org a record names: the one it is in, then the listed ones. */
export function orgsOf(rec: AccountRecord): string[] {
  const ids = [rec.orgId, ...rec.orgs.map((o) => o.id)].filter(
    (id): id is string => !!id,
  );
  return [...new Set(ids)];
}

export class MultiAccountClient implements AuthClient, AccountsClient {
  private index: AccountIndex = EMPTY_INDEX;
  private readonly clients = new Map<string, AuthKitClient>();
  private readonly offs = new Map<string, () => void>();
  private pending: AuthKitClient | null = null;
  private loading: Promise<void> | null = null;
  /** The account whose sign-out is under way: its `null` isn't "stale". */
  private signingOut: string | null = null;
  private readonly listeners = new Set<(s: Session | null) => void>();
  private readonly accountListeners = new Set<(a: AccountView[]) => void>();
  private readonly writes = new Mutex();
  private readonly now: () => number;
  private readonly warn: (m: string) => void;

  constructor(private readonly deps: MultiDeps) {
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? (() => {});
  }

  // ── the index ──────────────────────────────────────────────────────────

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const kv = this.deps.kv;
      let index: AccountIndex | null = null;
      try {
        index = parseAccountIndex(await kv.get(ACCOUNTS_KEY));
      } catch (e) {
        this.warn(`couldn't read the accounts: ${asAuthError(e).message}`);
      }
      if (!index) {
        // A build before the index kept one session: it is the first account.
        index = EMPTY_INDEX;
        try {
          const legacy = await kv.get(LEGACY_SESSION_KEY);
          const s = parseStoredSession(legacy);
          if (legacy && s) {
            await kv.set(accountKey(s.userId), legacy);
            await kv.remove(LEGACY_SESSION_KEY);
            index = upsertAccount(EMPTY_INDEX, s, this.now());
            this.index = index;
            await this.persist();
          }
        } catch (e) {
          this.warn(
            `couldn't adopt the stored session: ${asAuthError(e).message}`,
          );
        }
      }
      this.index = index;
      if (index.active) this.ensure(index.active);
      this.emitAccounts();
    })();
    return this.loading;
  }

  private persist(): Promise<void> {
    const text = serializeAccountIndex(this.index);
    return this.writes.run(async () => {
      try {
        await this.deps.kv.set(ACCOUNTS_KEY, text);
      } catch (e) {
        this.warn(`couldn't write the accounts: ${asAuthError(e).message}`);
      }
    });
  }

  private storeFor(userId: string): SessionStore {
    const kv = this.deps.kv;
    const key = accountKey(userId);
    return {
      load: () => kv.get(key),
      save: (v) => kv.set(key, v),
      clear: () => kv.remove(key),
      subscribe: kv.subscribe
        ? (onChange) => kv.subscribe!(key, onChange)
        : undefined,
    };
  }

  /** `userId`'s client, made on first use. */
  private ensure(userId: string): AuthKitClient {
    let c = this.clients.get(userId);
    if (c) return c;
    c = this.deps.make(this.storeFor(userId), userId === this.index.active);
    this.clients.set(userId, c);
    this.offs.set(
      userId,
      c.onChange((s) => void this.onAccountChange(userId, s)),
    );
    return c;
  }

  private dropClient(userId: string): void {
    this.offs.get(userId)?.();
    this.offs.delete(userId);
    this.clients.get(userId)?.dispose();
    this.clients.delete(userId);
  }

  private setActive(userId: string | null): void {
    this.index = { ...this.index, active: userId };
    for (const [id, c] of this.clients) c.setAutoRefresh(id === userId);
  }

  /** Something happened to `userId`'s session: a rotation, a switch, its end. */
  private async onAccountChange(
    userId: string,
    s: Session | null,
  ): Promise<void> {
    const rec = accountOf(this.index, userId);
    if (!rec) return;
    // Signing out: the push sweep moves its session around, then ends it.
    if (this.signingOut === userId) return;
    if (s) {
      const active = this.index.active === userId;
      // An inactive account's org is where a background task (a push
      // sweep, an answer) put it, not where the user left it: the record
      // keeps the org the user was in.
      const orgId = active ? s.organizationId : rec.orgId;
      if (
        rec.name !== s.name ||
        rec.email !== s.email ||
        rec.orgId !== orgId ||
        rec.stale
      ) {
        this.index = patchAccount(this.index, userId, {
          name: s.name,
          email: s.email,
          orgId,
          stale: false,
        });
        await this.persist();
        this.emitAccounts();
      }
      if (active) this.emit(s);
      return;
    }
    // Its refresh was rejected: kept, to be signed in again.
    this.index = patchAccount(this.index, userId, { stale: true });
    if (this.index.active === userId) {
      const usable = {
        active: null,
        accounts: this.index.accounts.filter((a) => !a.stale),
      };
      const next = nextActive(usable);
      this.setActive(next);
      await this.persist();
      this.emitAccounts();
      if (!next) return this.emit(null);
      const session = await this.ensure(next).current();
      // `null` here: that one was stale too, and this ran again for it.
      if (session && this.index.active === next) this.emit(session);
      return;
    }
    await this.persist();
    this.emitAccounts();
  }

  // ── AuthClient: the active account ─────────────────────────────────────

  async current(): Promise<Session | null> {
    await this.load();
    // A refresh here may end the active session and move on to the next
    // account: answer for whoever is active once it settles.
    for (let i = 0; i < 4; i++) {
      const id = this.index.active;
      if (!id) return null;
      const s = await this.ensure(id).current();
      if (this.index.active === id) return s;
    }
    return null;
  }

  async accessToken(): Promise<string | null> {
    await this.load();
    for (let i = 0; i < 4; i++) {
      const id = this.index.active;
      if (!id) return null;
      const t = await this.ensure(id).accessToken();
      if (this.index.active === id) return t;
    }
    return null;
  }

  onChange(listener: (session: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(s: Session | null): void {
    for (const l of [...this.listeners]) {
      try {
        l(s);
      } catch (e) {
        this.warn(`auth listener failed: ${asAuthError(e).message}`);
      }
    }
  }

  signIn(opts: SignInOptions = {}): Promise<SignInResult> {
    if (this.pending) {
      return Promise.resolve({
        kind: 'failed',
        message: 'A sign-in is already open.',
      });
    }
    // Its own client until the user is known; everything up to the browser
    // runs in this tick (the web popup needs the click's own task).
    const pending = this.deps.make(memoryStore(), false);
    this.pending = pending;
    return pending.signIn(opts).then(
      (r) => this.afterSignIn(pending, r),
      (e: unknown) => {
        this.dropPending(pending);
        return { kind: 'failed', message: asAuthError(e).message };
      },
    );
  }

  private dropPending(pending: AuthKitClient): void {
    pending.dispose();
    if (this.pending === pending) this.pending = null;
  }

  private async afterSignIn(
    pending: AuthKitClient,
    r: SignInResult,
  ): Promise<SignInResult> {
    if (r.kind === 'choose_organization') return r;
    if (r.kind !== 'signed_in') {
      this.dropPending(pending);
      return r;
    }
    try {
      const session = await this.adopt(pending, r.session);
      return { kind: 'signed_in', session };
    } catch (e) {
      return { kind: 'failed', message: asAuthError(e).message };
    }
  }

  async chooseOrganization(organizationId: string): Promise<SignInResult> {
    const pending = this.pending;
    if (!pending) return { kind: 'failed', message: EXPIRED };
    const r = await pending.chooseOrganization(organizationId);
    if (r.kind === 'choose_organization') return r;
    return this.afterSignIn(pending, r);
  }

  /**
   * A fresh session joins the accounts: stored under its user, its own
   * client made, the shell's hook run (push for its orgs), then active.
   */
  private async adopt(
    pending: AuthKitClient,
    session: Session,
  ): Promise<Session> {
    this.dropPending(pending);
    await this.load();
    const userId = session.userId;
    await this.deps.kv.set(accountKey(userId), serializeSession(session));
    // An earlier client of this user (stale, or signed in twice) goes.
    this.dropClient(userId);
    const before = this.index;
    const next = upsertAccount(before, session, this.now());
    for (const gone of droppedBy(before, next)) await this.forgetAccount(gone);
    // Not active yet: the hook may move its org around.
    this.index = { ...next, active: before.active };
    const client = this.ensure(userId);
    await client.current();
    let orgs: OrganizationChoice[] = session.organizationId
      ? [{ id: session.organizationId, name: '' }]
      : [];
    try {
      orgs = await client.organizations();
      this.index = recordOrgs(this.index, userId, orgs);
    } catch (e) {
      this.warn(
        `couldn't list the new account's orgs: ${asAuthError(e).message}`,
      );
    }
    try {
      await this.deps.hooks?.beforeActivate?.(
        userId,
        client,
        orgs.map((o) => o.id),
      );
    } catch (e) {
      this.warn(`account hook failed: ${asAuthError(e).message}`);
    }
    let s = (await client.current()) ?? session;
    if (session.organizationId && s.organizationId !== session.organizationId) {
      try {
        s = await client.switchOrganization(session.organizationId);
      } catch (e) {
        this.warn(
          `couldn't return to the org signed in: ${asAuthError(e).message}`,
        );
      }
    }
    this.index = activate(this.index, userId, this.now(), s.organizationId);
    this.setActive(userId);
    await this.persist();
    this.emitAccounts();
    this.emit(s);
    return s;
  }

  async switchOrganization(organizationId: string): Promise<Session> {
    await this.load();
    const id = this.index.active;
    if (!id) throw new AuthError('config', 'Not signed in.');
    // The client's own change lands in onAccountChange (record, emit).
    return this.ensure(id).switchOrganization(organizationId);
  }

  async organizations(): Promise<Organization[]> {
    await this.load();
    const id = this.index.active;
    if (!id) throw new AuthError('config', 'Not signed in.');
    const list = await this.ensure(id).organizations();
    await this.rememberOrgs(id, list);
    return list;
  }

  private async rememberOrgs(
    userId: string,
    list: readonly OrganizationChoice[],
  ): Promise<void> {
    const rec = accountOf(this.index, userId);
    if (!rec) return;
    const same =
      rec.orgs.length === list.length &&
      rec.orgs.every((o, i) => o.id === list[i].id && o.name === list[i].name);
    if (same) return;
    this.index = recordOrgs(this.index, userId, list);
    await this.persist();
    this.emitAccounts();
  }

  /** The active account leaves this device; the next one takes over. */
  async signOut(): Promise<void> {
    await this.load();
    const id = this.index.active;
    if (!id) return;
    const rec = accountOf(this.index, id);
    const client = this.ensure(id);
    this.signingOut = id;
    try {
      if (rec) {
        try {
          await this.deps.hooks?.beforeSignOut?.(id, client, orgsOf(rec));
        } catch (e) {
          this.warn(`sign-out hook failed: ${asAuthError(e).message}`);
        }
      }
      await client.signOut();
    } finally {
      this.signingOut = null;
    }
    await this.leave(id);
  }

  async deleteAccount(): Promise<void> {
    await this.load();
    const id = this.index.active;
    if (!id) throw new AuthError('config', 'Not signed in.');
    const client = this.ensure(id);
    this.signingOut = id;
    try {
      await client.deleteAccount();
    } finally {
      this.signingOut = null;
    }
    await this.leave(id);
  }

  /** `userId`'s session is gone: its record too; whoever is next runs. */
  private async leave(userId: string): Promise<void> {
    await this.forgetAccount(userId);
    this.index = removeAccount(this.index, userId);
    const next = this.index.active;
    this.setActive(next);
    await this.persist();
    this.emitAccounts();
    if (!next) return this.emit(null);
    const s = await this.ensure(next).current();
    // `null`: stale, and onAccountChange moved on (or signed out).
    if (s && this.index.active === next) this.emit(s);
  }

  private async forgetAccount(userId: string): Promise<void> {
    const rec = accountOf(this.index, userId);
    this.dropClient(userId);
    try {
      await this.deps.kv.remove(accountKey(userId));
    } catch (e) {
      this.warn(`couldn't remove a session: ${asAuthError(e).message}`);
    }
    if (rec) {
      try {
        this.deps.hooks?.onRemoved?.(userId, orgsOf(rec));
      } catch (e) {
        this.warn(`account hook failed: ${asAuthError(e).message}`);
      }
    }
  }

  // ── AccountsClient ─────────────────────────────────────────────────────

  accounts(): AccountView[] {
    return this.index.accounts.map((a) => ({
      userId: a.userId,
      label: accountLabel(a),
      initials: accountInitials(a),
      email: a.email,
      orgId: a.orgId,
      orgs: a.orgs,
      stale: a.stale,
      active: a.userId === this.index.active,
    }));
  }

  onAccountsChange(listener: (accounts: AccountView[]) => void): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  private emitAccounts(): void {
    const list = this.accounts();
    for (const l of [...this.accountListeners]) {
      try {
        l(list);
      } catch (e) {
        this.warn(`accounts listener failed: ${asAuthError(e).message}`);
      }
    }
  }

  addAccount(): Promise<SignInResult> {
    return this.signIn();
  }

  signInAgain(userId: string): Promise<SignInResult> {
    const rec = accountOf(this.index, userId);
    return this.signIn({ loginHint: rec?.email || null });
  }

  async switchTo(userId: string, orgId?: string | null): Promise<Session> {
    await this.load();
    const rec = accountOf(this.index, userId);
    if (!rec)
      throw new AuthError('config', "That account isn't signed in here.");
    if (rec.stale) throw new AuthError('rejected', STALE);
    const client = this.ensure(userId);
    let s = await client.current();
    if (!s) {
      // Its refresh was rejected just now: onAccountChange marked it.
      throw new AuthError('rejected', STALE);
    }
    const target = orgId ?? rec.orgId ?? s.organizationId;
    if (target && s.organizationId !== target) {
      s = await client.switchOrganization(target);
    }
    this.index = activate(this.index, userId, this.now(), s.organizationId);
    this.setActive(userId);
    await this.persist();
    this.emitAccounts();
    this.emit(s);
    return s;
  }

  async loadOrganizations(userId: string): Promise<OrganizationChoice[]> {
    await this.load();
    const rec = accountOf(this.index, userId);
    if (!rec || rec.stale) return rec?.orgs ?? [];
    const list = await this.ensure(userId).organizations();
    await this.rememberOrgs(userId, list);
    return list.map((o) => ({ id: o.id, name: o.name }));
  }

  clientOf(userId: string): AuthClient | null {
    return accountOf(this.index, userId) ? this.ensure(userId) : null;
  }

  /** Whether `userId`'s push token should be registered in its orgs again. */
  pushSweepDue(userId: string, now: number): boolean {
    const rec = accountOf(this.index, userId);
    return !!rec && pushSweepDue(rec, now);
  }

  /** `userId`'s orgs got this device's push token at `now`. */
  async notePushSwept(userId: string, now: number): Promise<void> {
    if (!accountOf(this.index, userId)) return;
    this.index = patchAccount(this.index, userId, { pushSweptAt: now });
    await this.persist();
  }

  /** Test hook: the index as stored. */
  async settled(): Promise<AccountIndex> {
    await this.load();
    await this.writes.run(async () => {});
    return this.index;
  }
}
