/**
 * The Theodore account on this device: WorkOS AuthKit as a public client
 * (PKCE, no secret), like the desktop (docs/plan.md §6.12). Org selection
 * goes through the cloud; refresh and org switch are direct.
 */
export interface Session {
  userId: string;
  email: string;
  name: string | null;
  accessToken: string;
  refreshToken: string;
  /** Unix ms of the access token's `exp`. */
  expiresAt: number;
  organizationId: string | null;
  role: string | null;
}

export interface OrganizationChoice {
  id: string;
  name: string;
}

export interface Organization extends OrganizationChoice {
  role: string | null;
  personal: boolean;
}

export type SignInResult =
  | { kind: 'signed_in'; session: Session }
  | { kind: 'choose_organization'; organizations: OrganizationChoice[] }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export interface SignInOptions {
  /** Prefills the hosted page's email (`login_hint`): signing in again. */
  loginHint?: string | null;
}

export interface AuthClient {
  /** The stored session (refreshed when it's about to expire), or null. */
  current(): Promise<Session | null>;
  /** Signs in; with accounts already here, the new session joins them. */
  signIn(opts?: SignInOptions): Promise<SignInResult>;
  /** Finishes a sign-in that returned `choose_organization`. */
  chooseOrganization(organizationId: string): Promise<SignInResult>;
  switchOrganization(organizationId: string): Promise<Session>;
  organizations(): Promise<Organization[]>;
  /** A valid access token, refreshing first if needed; null when signed out. */
  accessToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /**
   * Deletes the account and the cloud's data for it (App Store 5.1.1(v)),
   * then signs out here. Data on the user's computers stays.
   */
  deleteAccount(): Promise<void>;
  /** Called with the new session after every sign-in, refresh, switch; null on sign-out. */
  onChange(listener: (session: Session | null) => void): () => void;
}

/** An account signed in on this device, as the accounts sheet lists it. */
export interface AccountView {
  userId: string;
  /** The name, else the email. */
  label: string;
  initials: string;
  /** Shown on this device only. */
  email: string;
  /** The organization it is in (where a switch to it lands). */
  orgId: string | null;
  /** Its organizations, as last listed by the cloud. */
  orgs: OrganizationChoice[];
  /** Its session can't be refreshed: "Sign in again". */
  stale: boolean;
  active: boolean;
}

/**
 * Several accounts at once (docs/mobile.md "Several accounts"): the
 * `AuthClient` the app runs as is the active one's; these add, switch and
 * list them. Implemented by `src/auth/multi.ts`.
 */
export interface AccountsClient {
  /** The accounts here, in the order they were added (the active one marked). */
  accounts(): AccountView[];
  onAccountsChange(listener: (accounts: AccountView[]) => void): () => void;
  /** The normal sign-in; the new session joins the list and becomes active. */
  addAccount(): Promise<SignInResult>;
  /** Signs `userId` in again (its email as the login hint). */
  signInAgain(userId: string): Promise<SignInResult>;
  /**
   * Runs as `userId`, in `orgId` (default: the org it was last in). The
   * session changes; the fleet client reconnects as that account and org.
   */
  switchTo(userId: string, orgId?: string | null): Promise<Session>;
  /** Lists `userId`'s organizations from the cloud and remembers them. */
  loadOrganizations(userId: string): Promise<OrganizationChoice[]>;
  /** `userId`'s own client (for a background task: push registration). */
  clientOf(userId: string): AuthClient | null;
}
