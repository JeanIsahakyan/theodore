/**
 * Account errors, the same kinds as the desktop's `AccountError`
 * (`account.network`, `account.rejected`, …). No token ever lands in a
 * message.
 *
 * | kind            | means                                              | session  |
 * | --------------- | -------------------------------------------------- | -------- |
 * | `network`       | offline, 5xx, 429, a 4xx without the server's JSON | kept     |
 * | `rejected`      | the provider's (or `cloud.rejected`) answer        | refresher: ends it |
 * | `invalid_token` | signature, issuer, expiry, subject, org mismatch   | refresher: ends it |
 * | `protocol`      | an answer we can't use                             | kept     |
 * | `config`        | no cloud URL / client id                           | kept     |
 */
export type AuthErrorKind =
  'network' | 'rejected' | 'invalid_token' | 'protocol' | 'config';

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }

  /** `account.<kind>`, like the desktop's error codes. */
  get code(): string {
    return `account.${this.kind}`;
  }
}

export const isAuthError = (
  e: unknown,
  ...kinds: AuthErrorKind[]
): e is AuthError =>
  e instanceof AuthError && (kinds.length === 0 || kinds.includes(e.kind));

/** An unexpected throw (fetch's TypeError, …) as a network error. */
export function asAuthError(e: unknown): AuthError {
  if (e instanceof AuthError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AuthError('network', message.slice(0, 200));
}

/** What the sign-in screens show for an error. */
export function describe(e: unknown): string {
  const err = asAuthError(e);
  switch (err.kind) {
    case 'network':
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    case 'rejected':
      return `Sign-in was refused (${err.message}).`;
    case 'invalid_token':
      return `The sign-in couldn't be verified (${err.message}).`;
    default:
      return err.message;
  }
}
