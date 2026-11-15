/**
 * iOS / Android: the key's 32-byte seed in the Keychain / Keystore
 * (expo-secure-store, after first unlock, this device only), random bytes
 * from expo-crypto, signing with noble. The seed is read only to sign.
 */
import { getRandomBytes } from 'expo-crypto';
import { seedKeyStore } from './seed-store';
import { createSecureStorage } from './storage';
import type { KeyStore } from './types';

export function createKeyStore(): KeyStore {
  return seedKeyStore(createSecureStorage(), (n) => getRandomBytes(n));
}
