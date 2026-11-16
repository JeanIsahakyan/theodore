/** iOS / Android: RN WebSocket with a Bearer header, Keychain/Keystore, AppState. */
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import { AppState, Platform } from 'react-native';
import { createSecureStorage } from '../keys/storage';
import type { FleetPlatform, FleetSocket } from './platform-types';

/** RN's WebSocket takes headers as a third argument (not in the DOM type). */
type NativeWebSocket = new (
  url: string,
  protocols: string[] | null,
  options: { headers: Record<string, string> },
) => FleetSocket;

export function defaultPlatform(): FleetPlatform {
  const ios = Platform.OS === 'ios';
  return {
    kind: 'mobile',
    os: ios ? 'ios' : 'android',
    name: Device.deviceName ?? Device.modelName ?? (ios ? 'iPhone' : 'Android'),
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    closeInBackground: ios,
    openSocket: (url, token) =>
      new (WebSocket as unknown as NativeWebSocket)(url, null, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    randomUUID: () => randomUUID(),
    storage: createSecureStorage(),
    onActive(listener) {
      const sub = AppState.addEventListener('change', (s) =>
        listener(s === 'active'),
      );
      return () => sub.remove();
    },
  };
}
