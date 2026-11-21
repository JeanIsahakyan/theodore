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

export interface AuthClient {
  /** The stored session (refreshed when it's about to expire), or null. */
  current(): Promise<Session | null>;
  signIn(): Promise<SignInResult>;
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
