/**
 * This device's fleet key (docs/mobile.md "Trust"). The private half never
 * leaves secure storage: iOS Keychain / Android Keystore via
 * expo-secure-store, or a non-extractable WebCrypto key in IndexedDB on web.
 */
export interface DeviceKey {
  /** Base64 of the raw 32-byte ed25519 public key (same as Rust). */
  readonly publicKey: string;
  /** Base64 ed25519 signature over `message` (already domain-tagged). */
  sign(message: Uint8Array): Promise<string>;
}

export interface KeyStore {
  /** The stored key, or a new one made and stored on first use. */
  deviceKey(): Promise<DeviceKey>;
  /** Forget the key (sign-out with "forget this device"). */
  forget(): Promise<void>;
}
