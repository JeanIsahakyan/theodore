/** iOS / Android: expo-crypto (the system CSPRNG); no global Web Crypto here. */
import { getRandomBytes, randomUUID as expoRandomUUID } from 'expo-crypto';

export function randomBytes(n: number): Uint8Array {
  return getRandomBytes(n);
}

export function randomUUID(): string {
  return expoRandomUUID();
}
