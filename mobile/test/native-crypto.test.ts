import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// React Native (Hermes) has no global Web Crypto: code that runs on the
// phone must take randomness from src/fleet/random (expo-crypto on native).
// Only web-only files, the web/default half of random, and guarded
// fallbacks may touch `crypto.*` directly.
const ALLOWED = new Set([
  'src/fleet/random.ts',
  'src/fleet/platform.ts',
  'src/fleet/platform.web.ts',
  'src/keys/store.ts',
  'src/keys/store.web.ts',
  'src/telemetry/log.ts',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('native randomness', () => {
  it('no phone code calls the global crypto directly', () => {
    const root = join(__dirname, '..');
    const offenders = [...files(join(root, 'src')), ...files(join(root, 'app'))]
      .map((p) => p.slice(root.length + 1))
      .filter((p) => !ALLOWED.has(p) && !p.includes('.web.'))
      .filter((p) =>
        /\bcrypto\.(getRandomValues|randomUUID)\b/.test(
          readFileSync(join(root, p), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
