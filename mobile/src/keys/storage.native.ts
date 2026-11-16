/**
 * iOS Keychain / Android Keystore through expo-secure-store. Readable after
 * the first unlock (so a notification action can sign while the phone is
 * locked) and never synced or restored to another device.
 */
import * as SecureStore from 'expo-secure-store';
import type { SecretStorage } from './storage-types';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'theodore.fleet',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export function createSecureStorage(): SecretStorage {
  return {
    get: (k) => SecureStore.getItemAsync(k, OPTIONS),
    set: (k, v) => SecureStore.setItemAsync(k, v, OPTIONS),
    remove: (k) => SecureStore.deleteItemAsync(k, OPTIONS),
  };
}
