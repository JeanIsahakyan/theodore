/**
 * This device's fleet key and the storage it shares with the fleet client.
 * Per platform (Metro picks the file):
 *
 * | Platform | Private key | Pins, device id |
 * | --- | --- | --- |
 * | iOS / Android | 32-byte seed in Keychain / Keystore (expo-secure-store, after first unlock, this device only) | same |
 * | web | non-extractable WebCrypto Ed25519 `CryptoKey` in IndexedDB; seed in IndexedDB if the browser lacks Ed25519 | IndexedDB |
 * | Node (tests) | memory | memory |
 */
export { createKeyStore } from './store';
export { createSecureStorage } from './storage';
export { fingerprint } from './fingerprint';
export type { DeviceKey, KeyStore } from './types';
export type { SecretStorage } from './storage-types';
