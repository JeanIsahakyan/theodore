/**
 * The app's wiring: one `AuthClient` and one `FleetClient` for the app's
 * life, the session state the navigator gates on, and the fleet's lifecycle.
 *
 * ```text
 * start ─▶ auth.current() ─▶ status: signed_in | signed_out
 * session with an org ─▶ fleet.start() ─▶ registerForPush(fleet)
 * org switched        ─▶ the fleet client redials the new org's hub itself
 * sign-out            ─▶ the fleet client drops the push token on its socket ─▶ fleet.stop()
 * account / org       ─▶ Home's last picks read back (src/state/compose.ts);
 *                        sign-out removes them
 * "Try the demo"      ─▶ the demo services (src/dev/demo.ts) stand in for
 *                        both clients until sign-out; no push, no server
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
import { registerForPush, setupNotifications } from '../push';
import { ServicesProvider, type Services } from '../services';
import { createAuthClient } from '../auth/platform';
import { createFleetClient } from '../fleet/client';
import { savedScope } from '../fleet/saved';
import { persistPicks, picksStore, restorePicks } from '../state/compose';
import { resetPending } from '../state/pending';
import { createDemo } from '../dev/demo';
import { resetFleetState } from '../dev/mock';
import type { FleetClient } from '../fleet/types';

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
    const auth = createAuthClient();
    const fleet = createFleetClient(auth);
    runtime.__theodoreClients = { services: { auth, fleet } };
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
  const real = useMemo(() => getClients().services, []);
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

  // The fleet runs while signed in to an organization. An org switch is
  // the fleet client's own business (it watches the session); here only
  // on ─▶ off and off ─▶ on, and which client: the one that started is the
  // one stopped, so leaving the demo never stops (and flushes the demo
  // store through) the real client.
  const fleetOn = session?.organizationId != null;
  const running = useRef<FleetClient | null>(null);
  useEffect(() => {
    const want = fleetOn ? fleet : null;
    if (running.current === want) return;
    running.current?.stop();
    running.current = want;
    if (!want) return;
    want
      .start()
      .catch((e: unknown) => console.warn('[shell] fleet start failed', e))
      .then(() => (want === real.fleet ? registerForPush(want) : undefined));
  }, [fleet, fleetOn, real]);

  // Home's last picks, per account and organization.
  const scope = session?.organizationId
    ? savedScope(session.userId, session.organizationId)
    : null;
  useEffect(() => persistPicks(picksStore()), []);
  const lastScope = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastScope.current;
    lastScope.current = scope;
    // Another account or org (or none): nothing of the old one is pending.
    if (prev !== scope) resetPending();
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
