/**
 * Randomness for the fleet's blob crypto and ids. Web and Node (tests) have
 * the global Web Crypto; React Native doesn't (no `crypto.getRandomValues`
 * on Hermes without a polyfill), so `random.native.ts` uses expo-crypto.
 */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
