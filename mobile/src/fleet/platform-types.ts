/**
 * What the fleet client needs from the platform (Metro picks
 * `platform.native.ts` or `platform.web.ts`; `platform.ts` is Node's).
 * Tests inject their own.
 */
import type { DeviceOs } from '../gen/fleet';
import type { SecretStorage } from '../keys/storage-types';

/** The part of a WebSocket the client uses (browser, RN and test fakes). */
export interface FleetSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** A WebSocket ping frame (React Native only; browsers can't send one). */
  ping?: () => void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface FleetPlatform {
  kind: 'mobile' | 'web';
  /** The OS it runs on (a browser: the OS the browser runs on). */
  os: DeviceOs;
  /** How other devices list this one (sanitized by them when pinned). */
  name: string;
  appVersion: string;
  /** iOS suspends a backgrounded app's sockets: close, reopen on foreground. */
  closeInBackground: boolean;
  /**
   * Native sends `Authorization: Bearer`; a browser can't set headers on a
   * WebSocket, so it offers the token as the subprotocol `bearer.<token>`.
   */
  openSocket(url: string, token: string): FleetSocket;
  randomUUID(): string;
  storage: SecretStorage;
  /** `true` when the app comes to the foreground, `false` when it leaves. */
  onActive(listener: (active: boolean) => void): () => void;
}
