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

/**
 * The sheets as routes (iOS presents them as form sheets over the stack,
 * `app/(app)/_layout.tsx`; Android and web open theirs in place). Opening
 * one from the drawer leaves the drawer open under it (`drawerClosesOn`,
 * src/ui/drawer.ts).
 */
export const SHEET_PATHS = {
  model: '/model-picker',
  computer: '/computer-picker',
  project: '/project-picker',
  activity: '/activity-sheet',
  accounts: '/accounts-sheet',
} as const;

const SHEET_PATH_SET: ReadonlySet<string> = new Set(Object.values(SHEET_PATHS));

/** `/accounts-sheet?x=1` ─▶ true: a sheet route, its query dropped. */
export function isSheetPath(path: string): boolean {
  return SHEET_PATH_SET.has(path.replace(/[?#].*$/, ''));
}
