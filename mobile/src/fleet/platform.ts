/**
 * Node (tests, scripts): a standard WebSocket with the token as the
 * subprotocol, memory storage, no app lifecycle.
 */
import { memoryStorage } from '../keys/storage-types';
import type { FleetPlatform, FleetSocket } from './platform-types';

export function defaultPlatform(): FleetPlatform {
  return {
    kind: 'web',
    os: 'linux',
    name: 'Theodore web',
    appVersion: '0.0.0',
    closeInBackground: false,
    openSocket: (url, token) =>
      new WebSocket(url, [
        `bearer`,
        `bearer.${token}`,
      ]) as unknown as FleetSocket,
    randomUUID: () => crypto.randomUUID(),
    storage: memoryStorage(),
    onActive: () => () => {},
  };
}
