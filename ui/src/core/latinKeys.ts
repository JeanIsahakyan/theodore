/**
 * Shortcuts are letters (J, K, R, T, G I …). On a non-Latin layout (e.g.
 * Russian) the physical R key reports `e.key === 'к'`, so every handler
 * would miss it. This capture listener runs before all others and rewrites
 * `e.key` from the physical key (`e.code`) — outside text fields only, so
 * typing is untouched.
 */
export function installLatinKeys(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input,textarea,[contenteditable=true]')) return;
    const m = /^Key([A-Z])$/.exec(e.code);
    if (!m || /^[a-z]$/i.test(e.key)) return;
    const letter = e.shiftKey ? m[1]! : m[1]!.toLowerCase();
    Object.defineProperty(e, 'key', { value: letter, configurable: true });
  };
  target.addEventListener('keydown', onKey, true);
  return () => target.removeEventListener('keydown', onKey, true);
}
