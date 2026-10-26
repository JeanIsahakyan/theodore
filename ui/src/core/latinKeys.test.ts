import { describe, expect, it } from 'vitest';
import { installLatinKeys } from './latinKeys';

describe('installLatinKeys', () => {
  it('maps a non-Latin letter to its physical Latin key', () => {
    const off = installLatinKeys(window);
    let seen = '';
    const read = (e: KeyboardEvent) => (seen = e.key);
    window.addEventListener('keydown', read);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'к', code: 'KeyR' }),
    );
    window.removeEventListener('keydown', read);
    off();
    expect(seen).toBe('r');
  });

  it('leaves text fields alone', () => {
    const off = installLatinKeys(window);
    const input = document.createElement('input');
    document.body.append(input);
    let seen = '';
    input.addEventListener('keydown', (e) => (seen = e.key));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'к', code: 'KeyR', bubbles: true }),
    );
    off();
    input.remove();
    expect(seen).toBe('к');
  });
});
