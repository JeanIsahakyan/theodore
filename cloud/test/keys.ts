// A throwaway RSA key per test run, standing in for WorkOS's signing key.
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';

export const API = 'https://api.workos.test';
export const CLIENT = 'client_01APP';

export async function signer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    claims: JWTPayload,
    opts: { exp?: number; kid?: string } = {},
  ) =>
    new SignJWT({ iss: `${API}/user_management/${CLIENT}`, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'k1' })
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
  return { keys, sign };
}
