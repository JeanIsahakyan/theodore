/**
 * Browser: the token as the subprotocol `bearer.<token>` (a page can't set
 * WebSocket headers; the cloud takes it from the web app's origin only),
 * IndexedDB, page visibility as the lifecycle. The socket stays open in a
 * hidden tab; a lost one is redialed as soon as the tab is shown again.
 */
import Constants from 'expo-constants';
import { createSecureStorage } from '../keys/storage';
import type { FleetPlatform, FleetSocket } from './platform-types';

function browserOs(): { os: 'macos' | 'linux'; label: string } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return { os: 'macos', label: 'Mac' };
  if (/Windows/.test(ua)) return { os: 'linux', label: 'Windows' };
  if (/Android/.test(ua)) return { os: 'linux', label: 'Android' };
  return { os: 'linux', label: 'Linux' };
}

function browserName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

export function defaultPlatform(): FleetPlatform {
  const { os, label } = browserOs();
  return {
    kind: 'web',
    os,
    name: `${browserName()} on ${label}`,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    closeInBackground: false,
    openSocket: (url, token) =>
      new WebSocket(url, [`bearer.${token}`]) as unknown as FleetSocket,
    randomUUID: () => crypto.randomUUID(),
    storage: createSecureStorage(),
    onActive(listener) {
      if (typeof document === 'undefined') return () => {};
      const on = () => listener(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', on);
      return () => document.removeEventListener('visibilitychange', on);
    },
  };
}
