/**
 * Local copies of the files this phone sent (docs/mobile.md "Files"): the
 * host keeps each as `<worktree>/.context/<name>`; while this phone still
 * has the picked copy, a step that reads it draws that copy without asking.
 * Memory only; cleared with the file cache on sign-out.
 *
 * ```text
 * send with [shot.png] ─▶ remember(space, "shot.png", file:///…/shot.jpg)
 * Read .context/shot.png in that space ─▶ localCopyOf ─▶ file:///…  (nothing fetched)
 * ```
 */

/** `<space>|.context/<name>` ─▶ the local URI the picker gave. */
const copies = new Map<string, string>();
const LOCAL_COPIES_MAX = 500;

export function rememberLocalCopy(
  space: string,
  name: string,
  uri: string,
): void {
  if (!space || !name || !uri) return;
  if (copies.size >= LOCAL_COPIES_MAX) {
    const oldest = copies.keys().next().value;
    if (oldest !== undefined) copies.delete(oldest);
  }
  copies.set(`${space}|.context/${name}`, uri);
}

/** The local URI of `path` in `space`, when this phone sent it. */
export const localCopyOf = (space: string, path: string): string | null =>
  copies.get(`${space}|${path}`) ?? null;

export function clearLocalCopies(): void {
  copies.clear();
}
