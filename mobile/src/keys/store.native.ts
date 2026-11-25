/**
 * iOS / Android: the key's 32-byte seed in the Keychain / Keystore
 * (expo-secure-store, after first unlock, this device only), random bytes
 * from expo-crypto, signing with noble. The seed is read only to sign.
 *
 * One store per JS runtime: every fleet client (the app's, the short-lived
 * ones registering a push token in another org) reads the same key through
 * the same promise, so none can make a second key at first launch.
 */
import { getRandomBytes } from 'expo-crypto';
import { seedKeyStore } from './seed-store';
import { createSecureStorage } from './storage';
import type { KeyStore } from './types';

const runtime = globalThis as { __theodoreKeyStore?: KeyStore };

export function createKeyStore(): KeyStore {
  return (runtime.__theodoreKeyStore ??= seedKeyStore(
    createSecureStorage(),
    (n) => getRandomBytes(n),
  ));
}
