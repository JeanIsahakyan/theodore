/** `/space/<id>` ─▶ `<id>`: the space on screen, for the push handler. */
export function spaceIdFromPath(path: string): string | null {
  const m = /^\/space\/([^/?#]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
