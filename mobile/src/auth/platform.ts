/**
 * The real `AuthClient` for this device: wires `AuthKitClient` to the
 * browser (`expo-web-browser`), the redirect (`expo-auth-session`), the
 * session store and `fetch`.
 *
 * | Platform | Browser                                   | Redirect                  | Session store |
 * | -------- | ----------------------------------------- | ------------------------- | ------------- |
 * | iOS      | ASWebAuthenticationSession                | `theodore://callback`     | Keychain, after first unlock |
 * | Android  | Custom Tab + the scheme's intent          | `theodore://callback`     | Keystore-backed secure store |
 * | web      | popup; `/callback` posts back to the opener | `<origin>/callback`     | `localStorage` |
 * | Expo Go  | as iOS / Android                          | `exp://…/--/callback`     | as iOS / Android |
 *
 * Web trade-off: `localStorage` is readable by any script on the origin, so
 * an XSS on the web app could take the refresh token. There's no better
 * place for a public client without a backend session (an httpOnly cookie
 * would need the cloud to hold the tokens); the web app ships no third-party
 * scripts, and AuthKit's refresh tokens rotate and are single-use.
 */
import { makeRedirectUri } from 'expo-auth-session';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { config } from '../config';
import { AuthKitClient, type BrowserResult } from './client';
import { SESSION_KEY, type SessionStore } from './store';
import { WorkosApi, type HttpFetch } from './workos';

const secureOptions: SecureStore.SecureStoreOptions = {
  // A notification action answers from the background, maybe while the
  // phone is locked: the session must be readable then.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const secureStore: SessionStore = {
  load: () => SecureStore.getItemAsync(SESSION_KEY, secureOptions),
  save: (v) => SecureStore.setItemAsync(SESSION_KEY, v, secureOptions),
  clear: () => SecureStore.deleteItemAsync(SESSION_KEY, secureOptions),
};

const webStore: SessionStore = {
  load: async () => globalThis.localStorage?.getItem(SESSION_KEY) ?? null,
  save: async (v) => globalThis.localStorage?.setItem(SESSION_KEY, v),
  clear: async () => globalThis.localStorage?.removeItem(SESSION_KEY),
  subscribe(onChange) {
    if (typeof window === 'undefined') return () => {};
    const listener = (e: StorageEvent) => {
      if (e.key === SESSION_KEY || e.key === null) onChange();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  },
};

interface LockManager {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Tabs share one refresh token: one refresh at a time across them. */
function webLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)
    ?.locks;
  return locks ? locks.request('theodore.account.refresh', fn) : fn();
}

const httpFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

async function openBrowser(
  url: string,
  redirectUri: string,
): Promise<BrowserResult> {
  const r = await WebBrowser.openAuthSessionAsync(url, redirectUri);
  if (r.type === 'success') return { type: 'success', url: r.url };
  return { type: r.type === 'dismiss' ? 'dismiss' : 'cancel' };
}

/**
 * The redirect AuthKit sends the code to: the app's scheme on a device
 * (from app.json, `theodore://callback`), `<origin>/callback` on the web.
 */
export function redirectUri(): string {
  return makeRedirectUri({ path: 'callback' });
}

export function createAuthClient(): AuthKitClient {
  const web = Platform.OS === 'web';
  const warn = (m: string) => console.warn(`[auth] ${m}`);
  return new AuthKitClient({
    api: new WorkosApi(
      {
        apiBase: config.workosApiBase,
        clientId: config.workosClientId,
        cloudUrl: config.cloudUrl || null,
      },
      httpFetch,
      Date.now,
      warn,
    ),
    store: web ? webStore : secureStore,
    openBrowser,
    redirectUri,
    apiBase: config.workosApiBase,
    clientId: config.workosClientId,
    random: (n) => getRandomBytes(n),
    crossContextLock: web ? webLock : undefined,
    warn,
  });
}
