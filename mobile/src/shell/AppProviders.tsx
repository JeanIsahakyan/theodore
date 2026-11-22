/**
 * The app's wiring: the accounts (`MultiAccountClient`: one `AuthClient`
 * per account, the active one's session as `auth`) and one `FleetClient`
 * for the app's life, the session state the navigator gates on, and the
 * fleet's lifecycle.
 *
 * ```text
 * start ─▶ auth.current() ─▶ status: signed_in | signed_out
 * session with an org ─▶ fleet.start() ─▶ registerForPush(fleet)
 *                     ─▶ inactive accounts due: their orgs get the token too (accountHooks)
 * org or account switched ─▶ the fleet client redials as it (it watches the session);
 *                            "Switching to <target>…" until welcomed (src/state/accounts.ts)
 * sign-out            ─▶ the active account leaves: push off in its orgs, its saved
 *                        sets and picks removed; the next account's session takes over,
 *                        or the sign-in screen when none is left
 * account / org       ─▶ Home's last picks read back (src/state/compose.ts)
 * "Try the demo"      ─▶ the demo services (src/dev/demo.ts) stand in for
 *                        all clients until sign-out; no push, no server
 * ```
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { OrganizationChoice, Session } from '../auth/types';
import { getPushToken, registerForPush, setupNotifications } from '../push';
import { ServicesProvider, type Services } from '../services';
import { createAuthClient } from '../auth/platform';
import type { MultiAccountClient } from '../auth/multi';
import { createFleetClient } from '../fleet/client';
import { savedScope } from '../fleet/saved';
import { setSwitching, useAccountSwitch } from '../state/accounts';
import { persistPicks, picksStore, restorePicks } from '../state/compose';
import { useFleetState } from '../state/fleet';
import { resetPending } from '../state/pending';
import { resetAttachments } from '../state/attachments';
import { clearFileCache } from '../fleet/file-cache';
import { createDemo } from '../dev/demo';
import { resetFleetState } from '../dev/mock';
import type { FleetClient } from '../fleet/types';
import { accountHooks } from './accountHooks';

export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';

export interface AuthState {
  status: AuthStatus;
  /**
   * Who is signed in and where (identity fields only stay current: read
   * tokens through `auth.accessToken()`).
   */
  session: Session | null;
  /** Organizations offered by a sign-in waiting for a pick. */
  choices: OrganizationChoice[] | null;
  setChoices(choices: OrganizationChoice[] | null): void;
  /** Signed in to the demo, not a real account. */
  demo: boolean;
  /** Enters the demo; signing out leaves it. */
  startDemo(): void;
}

const AuthStateContext = createContext<AuthState | null>(null);

export function useAuthState(): AuthState {
  const s = useContext(AuthStateContext);
  if (!s) throw new Error('useAuthState outside AppProviders');
  return s;
}

interface Clients {
  services: Services;
  accounts: MultiAccountClient;
  hooks: ReturnType<typeof accountHooks>;
}

/**
 * One set per JS runtime, kept on `globalThis`: Fast Refresh re-runs this
 * module, and a module-level `let` would start a second fleet client on
 * the same device key while the first one still runs. The cloud keeps one
 * connection per device (close 4000), so the two would take the link from
 * each other forever. Editing the fleet or auth client in dev therefore
 * needs a full reload to take effect.
 */
const runtime = globalThis as { __theodoreClients?: Clients };

function getClients(): Clients {
  if (!runtime.__theodoreClients) {
    const hooks = accountHooks({
      fleet: () => getClients().services.fleet,
      pushToken: getPushToken,
    });
    const accounts = createAuthClient(hooks);
    const fleet = createFleetClient(accounts);
    runtime.__theodoreClients = {
      services: { auth: accounts, fleet, accounts },
      accounts,
      hooks,
    };
  }
  return runtime.__theodoreClients;
}

const sameAccount = (a: Session | null, b: Session | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.role === b.role &&
    a.email === b.email &&
    a.name === b.name);

/** The space on screen, for the push handler (no banner for it). */
let activeSpace: string | null = null;
export function setActiveSpace(id: string | null): void {
  activeSpace = id;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const clients = useMemo(() => getClients(), []);
  const real = clients.services;
  const [demo, setDemo] = useState<Services | null>(null);
  const services = demo ?? real;
  const { auth, fleet } = services;
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [choices, setChoices] = useState<OrganizationChoice[] | null>(null);

  useEffect(() => {
    void setupNotifications({ activeSpaceId: () => activeSpace }).catch(
      (e: unknown) => console.warn('[shell] notifications setup failed', e),
    );
  }, []);

  useEffect(() => {
    let live = true;
    const apply = (s: Session | null) => {
      if (!live) return;
      // A token rotation alone (every few minutes) re-renders nothing.
      setSession((prev) => (sameAccount(prev, s) ? prev : s));
      setStatus(s ? 'signed_in' : 'signed_out');
      if (s) setChoices(null);
      else setSwitching(null);
      // Signing out of the demo leaves it: back to the real clients and
      // an empty store.
      if (!s && auth !== real.auth) {
        setDemo(null);
        resetFleetState();
      }
    };
    const off = auth.onChange(apply);
    auth.current().then(apply, () => apply(null));
    return () => {
      live = false;
      off();
    };
  }, [auth, real]);

  // The fleet runs while signed in to an organization. An org or account
  // switch is the fleet client's own business (it watches the session);
  // here only on ─▶ off and off ─▶ on, and which client: the one that
  // started is the one stopped, so leaving the demo never stops (and
  // flushes the demo store through) the real client.
  const fleetOn = session?.organizationId != null;
  const running = useRef<FleetClient | null>(null);
  const swept = useRef(false);
  useEffect(() => {
    const want = fleetOn ? fleet : null;
    if (running.current === want) return;
    running.current?.stop();
    running.current = want;
    if (!want) return;
    want
      .start()
      .catch((e: unknown) => console.warn('[shell] fleet start failed', e))
      .then(async () => {
        if (want !== real.fleet) return;
        await registerForPush(want);
        // Once per app run: the other accounts' orgs get the token too.
        if (swept.current) return;
        swept.current = true;
        await clients.hooks
          .sweepInactive(clients.accounts)
          .catch((e: unknown) => console.warn('[shell] push sweep failed', e));
      });
  }, [clients, fleet, fleetOn, real]);

  // "Switching to <target>…" ends with the new link's first devices list,
  // or its failure.
  useEffect(
    () =>
      useFleetState.subscribe((s) => {
        if (!useAccountSwitch.getState().switching) return;
        if (s.welcomed || s.connection === 'error') setSwitching(null);
      }),
    [],
  );

  // Home's last picks, per account and organization.
  const scope = session?.organizationId
    ? savedScope(session.userId, session.organizationId)
    : null;
  useEffect(() => persistPicks(picksStore()), []);
  const lastScope = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastScope.current;
    lastScope.current = scope;
    // Another account or org (or none): nothing of the old one is pending,
    // attached, or kept of its files.
    if (prev !== scope) {
      resetPending();
      resetAttachments();
      clearFileCache();
    }
    // The last account signed out: its picks go (an account leaving while
    // another stays is the accounts client's hook).
    if (prev && !scope && status === 'signed_out')
      void picksStore()
        .clear(prev)
        .catch(() => {});
    void restorePicks(picksStore(), scope).catch((e: unknown) =>
      console.warn('[shell] last picks not read', e),
    );
  }, [scope, status]);

  const startDemo = useCallback(() => setDemo(createDemo()), []);
  const state = useMemo<AuthState>(
    () => ({
      status,
      session,
      choices,
      setChoices,
      demo: demo !== null,
      startDemo,
    }),
    [status, session, choices, demo, startDemo],
  );

  return (
    <ServicesProvider services={services}>
      <AuthStateContext.Provider value={state}>
        {children}
      </AuthStateContext.Provider>
    </ServicesProvider>
  );
}
