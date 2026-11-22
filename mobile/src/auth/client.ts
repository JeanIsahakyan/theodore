/**
 * `AuthClient` over WorkOS AuthKit, as the desktop does it (plan §6.12,
 * `crates/app/src/usecases/account.rs`). Pure: the browser, storage,
 * network, clock and timers are injected (`platform.ts` wires the real ones).
 *
 * ```text
 * signIn ─▶ PKCE S256 + state ─▶ browser: hosted AuthKit page
 *          ─▶ redirect …/callback?code&state ─▶ state matches?
 *          ─▶ POST authenticate (code + verifier) ─▶ JWKS-checked session
 *             └─ org selection required ─▶ choose_organization (pending token in memory)
 *                 ─▶ chooseOrganization(id) ─▶ cloud select-organization
 *          ─▶ no org ─▶ background: cloud ensure personal ─▶ refresh into it
 * refresher ─▶ 60 s before exp: refresh (no org: keeps the session's)
 *             network error ─▶ retry 30 s, doubling to 10 min; session kept
 *             rejected / invalid token ─▶ signed out
 * switch   ─▶ refresh + organization_id; an error leaves the session as is
 * ```
 *
 * Refresh tokens are single-use: every rotation (refresher, switch, the org
 * step) runs under one lock and drops its result when a sign-in or
 * sign-out happened meanwhile (`generation`). Writes to the store go under
 * a second, short lock so a late refresh can't resurrect a signed-out
 * session.
 */
import type {
  AuthClient,
  Organization,
  OrganizationChoice,
  Session,
  SignInOptions,
  SignInResult,
} from './types';
import { AuthError, asAuthError, describe, isAuthError } from './errors';
import { peekClaims } from './jwt';
import { parseCallback, startAttempt, type RandomBytes } from './pkce';
import {
  parseStoredSession,
  serializeSession,
  type SessionStore,
} from './store';
import type { AccountApi, Authenticated } from './workos';

/** Refresh this long before the access token's `exp`. */
export const REFRESH_SKEW_MS = 60_000;
const MIN_REFRESH_WAIT_MS = 5_000;
const RETRY_AFTER_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** How long the refresher waits after `failures` failed refreshes in a row. */
export function refreshRetryDelay(failures: number): number {
  const doublings = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(RETRY_AFTER_MS * 2 ** doublings, RETRY_MAX_MS);
}

/** When the refresher should next run for a session. */
export function refreshDelay(expiresAt: number, now: number): number {
  return Math.max(expiresAt - REFRESH_SKEW_MS - now, MIN_REFRESH_WAIT_MS);
}

export type BrowserResult =
  { type: 'success'; url: string } | { type: 'cancel' | 'dismiss' };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AuthDeps {
  api: AccountApi;
  store: SessionStore;
  /**
   * Opens `url` and resolves with the redirect to `redirectUri`. Called in
   * the same tick as `signIn()` (a web popup needs the user's click).
   */
  openBrowser(url: string, redirectUri: string): Promise<BrowserResult>;
  redirectUri(): string;
  apiBase: string;
  clientId: string;
  random: RandomBytes;
  now?: () => number;
  timers?: Timers;
  /** Serializes refreshes across contexts (browser tabs share the token). */
  crossContextLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  warn?: (message: string) => void;
  /**
   * Run the background refresher (default). Off for an account that isn't
   * the active one: its token is refreshed when something needs it.
   */
  autoRefresh?: boolean;
}

/** A FIFO async mutex. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const sameSession = (a: Session | null, b: Session | null) =>
  a?.accessToken === b?.accessToken && a?.refreshToken === b?.refreshToken;

export class AuthKitClient implements AuthClient {
  private session: Session | null = null;
  private loading: Promise<void> | null = null;
  private generation = 0;
  private pending: {
    token: string;
    organizations: OrganizationChoice[];
  } | null = null;
  private signingIn = false;
  private failures = 0;
  private timer: unknown = null;
  private orgStep: Promise<void> | null = null;
  private readonly listeners = new Set<(s: Session | null) => void>();
  private readonly rotation = new Mutex();
  private readonly writes = new Mutex();
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly warn: (m: string) => void;
  private autoRefresh: boolean;
  private disposed = false;
  private readonly unsubscribeStore: (() => void) | undefined;

  constructor(private readonly deps: AuthDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.warn = deps.warn ?? (() => {});
    this.autoRefresh = deps.autoRefresh ?? true;
    this.unsubscribeStore = deps.store.subscribe?.(
      () => void this.adoptStored(),
    );
  }

  /**
   * Turns the background refresher on (the account became the active one)
   * or off (it stopped being it). Off, the session is still refreshed when
   * `current()` or `accessToken()` need a fresh token.
   */
  setAutoRefresh(on: boolean): void {
    if (this.autoRefresh === on) return;
    this.autoRefresh = on;
    if (on) this.schedule();
    else this.cancelTimer();
  }

  /**
   * Ends this client: no timers, no listeners, nothing in flight lands
   * (the account was signed out here, or its session moved to another
   * client). The store is left as it is.
   */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelTimer();
    this.listeners.clear();
    this.pending = null;
    this.unsubscribeStore?.();
  }

  // ── reading ────────────────────────────────────────────────────────────

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const since = this.generation;
      let raw: string | null = null;
      try {
        raw = await this.deps.store.load();
      } catch (e) {
        this.warn(
          `couldn't read the stored session: ${asAuthError(e).message}`,
        );
      }
      // A sign-in finished while we were reading: it wins.
      if (this.generation !== since) return;
      this.session = parseStoredSession(raw);
      if (this.session) {
        this.schedule();
        this.emit();
        if (!this.session.organizationId) this.ensureOrganization();
      }
    })();
    return this.loading;
  }

  private fresh(s: Session): boolean {
    return s.expiresAt - REFRESH_SKEW_MS > this.now();
  }

  async current(): Promise<Session | null> {
    await this.load();
    const s = this.session;
    if (this.disposed) return null;
    if (!s || this.fresh(s)) return s;
    try {
      return await this.refreshNow();
    } catch {
      // Offline: the session stays usable. Rejected: it's gone (null).
      return this.session;
    }
  }

  async accessToken(): Promise<string | null> {
    await this.load();
    const s = this.session;
    if (!s || this.disposed) return null;
    if (this.fresh(s)) return s.accessToken;
    const next = await this.refreshNow();
    return next?.accessToken ?? null;
  }

  onChange(listener: (session: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const s = this.session;
    for (const l of [...this.listeners]) {
      try {
        l(s);
      } catch (e) {
        this.warn(`auth listener failed: ${asAuthError(e).message}`);
      }
    }
  }

  // ── writing ────────────────────────────────────────────────────────────

  /**
   * Stores `next` unless the account changed since `since`; true when it
   * did. `newGeneration`: a sign-in (supersedes everything in flight).
   */
  private commit(next: Session, since: number | null): Promise<boolean> {
    return this.writes.run(async () => {
      if (since !== null && this.generation !== since) return false;
      if (since === null) this.generation += 1;
      await this.deps.store.save(serializeSession(next));
      this.session = next;
      this.failures = 0;
      this.schedule();
      this.emit();
      return true;
    });
  }

  /** Re-reads the store: another tab may have rotated or signed out. */
  private async adoptStored(): Promise<Session | null> {
    let raw: string | null;
    try {
      raw = await this.deps.store.load();
    } catch {
      return this.session;
    }
    const stored = parseStoredSession(raw);
    if (sameSession(stored, this.session)) return this.session;
    await this.writes.run(async () => {
      if (!stored) {
        this.generation += 1;
        this.session = null;
        this.pending = null;
        this.cancelTimer();
      } else {
        if (stored.userId !== this.session?.userId) this.generation += 1;
        this.session = stored;
        this.schedule();
      }
      this.emit();
    });
    return this.session;
  }

  // ── refresh ────────────────────────────────────────────────────────────

  private withRotation<T>(fn: () => Promise<T>): Promise<T> {
    const cross = this.deps.crossContextLock;
    return this.rotation.run(() => (cross ? cross(fn) : fn()));
  }

  /**
   * Rotates the session unless another caller (or tab) just did. Rejected
   * or invalid: signed out. Anything else: the session is kept, the error
   * thrown. Null when there's no session (anymore).
   */
  refreshNow(): Promise<Session | null> {
    return this.withRotation(async () => {
      const since = this.generation;
      if (!this.session) return null;
      if (this.deps.store.subscribe) await this.adoptStored();
      const current = this.session;
      if (!current || this.generation !== since) return this.session;
      if (this.fresh(current)) return current;
      let result: Authenticated;
      try {
        // No organization: the provider keeps the session's. Asking for
        // one is an explicit switch, whose rejection mustn't end it.
        result = await this.deps.api.refresh(current.refreshToken, null);
      } catch (e) {
        const err = asAuthError(e);
        if (err.kind === 'rejected' || err.kind === 'invalid_token') {
          // Another tab may have used this refresh token first.
          const adopted = this.deps.store.subscribe
            ? await this.adoptStored()
            : null;
          if (adopted && adopted.refreshToken !== current.refreshToken) {
            return adopted;
          }
          this.warn(
            `the session couldn't be refreshed; signed out: ${err.message}`,
          );
          await this.forget(since);
        } else {
          this.failures += 1;
          if (this.failures === 1) this.warn(`refresh failed: ${err.message}`);
        }
        throw err;
      }
      if (result.kind !== 'session') {
        this.failures += 1;
        throw new AuthError('protocol', 'refresh asked for an organization');
      }
      await this.commit(result.session, since);
      return this.session;
    });
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(delay?: number): void {
    this.cancelTimer();
    const s = this.session;
    if (!s || !this.autoRefresh || this.disposed) return;
    const since = this.generation;
    const wait = delay ?? refreshDelay(s.expiresAt, this.now());
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (!this.session || this.generation !== since) return;
      this.refreshNow().then(
        () => {
          // A commit reschedules; a no-op (still fresh) needs it here.
          if (this.timer === null) this.schedule();
        },
        (e) => {
          if (isAuthError(e, 'rejected', 'invalid_token')) return;
          if (this.session && this.timer === null) {
            this.schedule(refreshRetryDelay(this.failures));
          }
        },
      );
    }, wait);
  }

  private forget(since: number | null): Promise<void> {
    return this.writes.run(async () => {
      if (since !== null && this.generation !== since) return;
      this.generation += 1;
      this.session = null;
      this.pending = null;
      this.failures = 0;
      this.cancelTimer();
      try {
        await this.deps.store.clear();
      } catch (e) {
        this.warn(
          `couldn't clear the stored session: ${asAuthError(e).message}`,
        );
      }
      this.emit();
    });
  }

  // ── sign-in ────────────────────────────────────────────────────────────

  signIn(opts: SignInOptions = {}): Promise<SignInResult> {
    if (this.signingIn) {
      return Promise.resolve({
        kind: 'failed',
        message: 'A sign-in is already open.',
      });
    }
    // Everything up to openBrowser runs synchronously: on the web the
    // popup must open in the click's own task, or it's blocked.
    let attempt: ReturnType<typeof startAttempt>;
    let opened: Promise<BrowserResult>;
    try {
      attempt = startAttempt({
        apiBase: this.deps.apiBase,
        clientId: this.deps.clientId,
        redirectUri: this.deps.redirectUri(),
        random: this.deps.random,
        loginHint: opts.loginHint ?? null,
      });
      opened = this.deps.openBrowser(attempt.url, attempt.redirectUri);
    } catch (e) {
      return Promise.resolve({ kind: 'failed', message: describe(e) });
    }
    this.signingIn = true;
    this.pending = null;
    return this.finishSignIn(attempt, opened).finally(() => {
      this.signingIn = false;
    });
  }

  private async finishSignIn(
    attempt: { state: string; verifier: string },
    opened: Promise<BrowserResult>,
  ): Promise<SignInResult> {
    let result: BrowserResult;
    try {
      result = await opened;
    } catch (e) {
      return { kind: 'failed', message: describe(e) };
    }
    if (result.type !== 'success') return { kind: 'cancelled' };
    const cb = parseCallback(result.url, attempt.state);
    if (cb.kind === 'mismatch') {
      return {
        kind: 'failed',
        message: "The sign-in answer didn't match this attempt. Try again.",
      };
    }
    if (cb.kind === 'error') {
      if (cb.error === 'access_denied') return { kind: 'cancelled' };
      return {
        kind: 'failed',
        message: cb.description || `Sign-in failed (${cb.error}).`,
      };
    }
    try {
      await this.load();
      const auth = await this.deps.api.exchangeCode(cb.code, attempt.verifier);
      return await this.signedIn(auth);
    } catch (e) {
      return { kind: 'failed', message: describe(e) };
    }
  }

  private async signedIn(auth: Authenticated): Promise<SignInResult> {
    if (auth.kind === 'select') {
      // The pending token stays in memory only, and is single-use.
      this.pending = {
        token: auth.selection.pendingToken,
        organizations: auth.selection.organizations,
      };
      return {
        kind: 'choose_organization',
        organizations: auth.selection.organizations,
      };
    }
    await this.commit(auth.session, null);
    if (!auth.session.organizationId) this.ensureOrganization();
    return { kind: 'signed_in', session: auth.session };
  }

  async chooseOrganization(organizationId: string): Promise<SignInResult> {
    const p = this.pending;
    if (!p) {
      return {
        kind: 'failed',
        message: 'This sign-in has expired. Sign in again.',
      };
    }
    if (!p.organizations.some((o) => o.id === organizationId)) {
      return {
        kind: 'failed',
        message: 'Pick one of the organizations offered.',
      };
    }
    this.pending = null;
    try {
      await this.load();
      const session = await this.deps.api.selectOrganization(
        p.token,
        organizationId,
      );
      await this.commit(session, null);
      return { kind: 'signed_in', session };
    } catch (e) {
      return { kind: 'failed', message: describe(e) };
    }
  }

  // ── organizations ──────────────────────────────────────────────────────

  /**
   * After a sign-in (or a start) with no organization: the cloud's
   * personal org, then a refresh into it. Best effort: any failure keeps
   * the session as it is and is tried again at the next start.
   */
  private ensureOrganization(): void {
    this.orgStep ??= (async () => {
      try {
        const token = await this.accessToken();
        if (!token || this.session?.organizationId) return;
        const since = this.generation;
        const organizationId =
          await this.deps.api.ensurePersonalOrganization(token);
        await this.withRotation(async () => {
          const current = this.session;
          if (!current || this.generation !== since) return;
          if (current.organizationId) return;
          const result = await this.deps.api.refresh(
            current.refreshToken,
            organizationId,
          );
          if (result.kind === 'session')
            await this.commit(result.session, since);
        });
      } catch (e) {
        this.warn(
          `couldn't set up the personal organization: ${asAuthError(e).message}`,
        );
      } finally {
        this.orgStep = null;
      }
    })();
  }

  /** Test hook: resolves when the background org step is done. */
  async settled(): Promise<void> {
    await this.load();
    await this.orgStep;
  }

  async switchOrganization(organizationId: string): Promise<Session> {
    await this.load();
    return this.withRotation(async () => {
      const since = this.generation;
      const current = this.session;
      if (!current) throw new AuthError('config', 'Not signed in.');
      const result = await this.deps.api.refresh(
        current.refreshToken,
        organizationId,
      );
      if (result.kind !== 'session') {
        throw new AuthError('protocol', 'the switch asked for an organization');
      }
      if (!(await this.commit(result.session, since))) {
        throw new AuthError(
          'protocol',
          'The account changed during the switch.',
        );
      }
      return result.session;
    });
  }

  async organizations(): Promise<Organization[]> {
    const token = await this.accessToken();
    if (!token) throw new AuthError('config', 'Not signed in.');
    return this.deps.api.organizations(token);
  }

  // ── sign-out, account deletion ─────────────────────────────────────────

  /** The cloud deletes first; only then is the local session dropped. */
  async deleteAccount(): Promise<void> {
    const token = await this.accessToken();
    if (!token) throw new AuthError('config', 'Not signed in.');
    await this.deps.api.deleteAccount(token);
    // The user and its sessions are gone at WorkOS: no logout call.
    await this.forget(null);
  }

  async signOut(): Promise<void> {
    await this.load();
    const sid = this.session
      ? peekClaims(this.session.accessToken)?.sid
      : undefined;
    await this.forget(null);
    if (sid) {
      // Best effort, in the background: the local session is already gone.
      this.deps.api.logout(sid).catch((e: unknown) => {
        this.warn(`logout failed: ${asAuthError(e).message}`);
      });
    }
  }
}
