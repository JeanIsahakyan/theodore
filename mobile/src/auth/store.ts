/**
 * Where a session lives: one entry holding the `Session` as JSON. Builds
 * before several accounts kept one, `theodore.account`; now each account
 * has its own, `theodore.account.<user id>`, named by the accounts index
 * (`accounts.ts`, `multi.ts`). The platform picks the backend (`platform.ts`):
 *
 * | Platform      | Backend                                  |
 * | ------------- | ---------------------------------------- |
 * | iOS           | Keychain (`expo-secure-store`), readable after first unlock (notification actions answer from the background) |
 * | Android       | Keystore-encrypted (`expo-secure-store`) |
 * | web           | `localStorage` (see `platform.ts` for the trade-off) |
 */
import type { Session } from './types';

export const SESSION_KEY = 'theodore.account';

export interface SessionStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
  /** Another context (a second browser tab) changed the entry. */
  subscribe?(onChange: () => void): () => void;
}

export function serializeSession(s: Session): string {
  return JSON.stringify(s);
}

/** A stored session, or null when it's missing or not a session. */
export function parseStoredSession(raw: string | null): Session | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) =>
    typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null;
  const userId = s('userId');
  const accessToken = s('accessToken');
  const refreshToken = s('refreshToken');
  if (!userId || !accessToken || !refreshToken) return null;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) {
    return null;
  }
  return {
    userId,
    email: typeof o.email === 'string' ? o.email : '',
    name: s('name'),
    accessToken,
    refreshToken,
    expiresAt: o.expiresAt,
    organizationId: s('organizationId'),
    role: s('role'),
  };
}

/** For tests and previews. */
export function memoryStore(initial: string | null = null): SessionStore & {
  value: string | null;
} {
  const store = {
    value: initial,
    async load() {
      return store.value;
    },
    async save(v: string) {
      store.value = v;
    },
    async clear() {
      store.value = null;
    },
  };
  return store;
}
