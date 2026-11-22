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
  /**
   * Opens blobs sealed for this device (docs/fleet.md "Files (blobs)"):
   * X25519 with the secret derived from the seed, the seed itself never
   * exposed. Absent on a WebCrypto key (web), which can't derive it: that
   * device sends files but can't read them.
   */
  readonly blobOpener?: BlobOpener;
}

/** `src/fleet/blob.ts` `BlobOpener`, kept here so keys don't import fleet. */
export interface BlobOpener {
  readonly x25519PublicKey: Uint8Array;
  sharedSecret(peerPublicKey: Uint8Array): Uint8Array;
}

export interface KeyStore {
  /** The stored key, or a new one made and stored on first use. */
  deviceKey(): Promise<DeviceKey>;
  /** Forget the key (sign-out with "forget this device"). */
  forget(): Promise<void>;
}
