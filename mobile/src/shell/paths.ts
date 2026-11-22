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

/**
 * A route's name for telemetry: the path with every dynamic segment
 * dropped (`/space/rs_1` ─▶ `space`, `/s/abc` ─▶ `s`, `/sub-space/a/b` ─▶
 * `sub-space`, `/file/rs_1` ─▶ `file`, `/settings/about` ─▶
 * `settings/about`, `/` ─▶ `home`).
 */
export function screenOfPath(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  if (!clean) return 'home';
  const parts = clean.split('/');
  if (ID_ROUTES.has(parts[0] ?? '')) return parts[0] ?? '';
  return parts.slice(0, 2).join('/');
}

/** Routes whose next segment is an id, never reported. */
const ID_ROUTES = new Set(['space', 's', 'sub-space', 'file']);
