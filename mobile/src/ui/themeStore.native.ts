/**
 * iOS / Android: the Theme setting in secure-store (Keychain / Keystore),
 * read synchronously at start. Readable after the first unlock, like the
 * session: an app woken by a notification action draws in the chosen theme.
 * Kept across sign-out: it belongs to the device, not the account.
 */
import * as SecureStore from 'expo-secure-store';
import { THEME_KEY, parseTheme, type ThemePreference } from './appearance';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export function readTheme(): ThemePreference {
  try {
    return parseTheme(SecureStore.getItem(THEME_KEY, OPTIONS));
  } catch {
    return 'system';
  }
}

export function writeTheme(theme: ThemePreference): void {
  SecureStore.setItemAsync(THEME_KEY, theme, OPTIONS).catch((e: unknown) =>
    console.warn('theme: could not keep the setting', e),
  );
}
