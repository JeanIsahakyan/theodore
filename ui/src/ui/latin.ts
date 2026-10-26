/** Physical key → the Latin letter/digit a US layout would produce for it.
 *  `e.key` reflects the active layout (e.g. a Cyrillic character for the
 *  key physically labelled "J"), so single-letter shortcuts match on
 *  `e.code` instead — the same key works no matter what layout is active. */
const CODE_TO_LATIN: Record<string, string> = Object.fromEntries([
  ...'abcdefghijklmnopqrstuvwxyz'
    .split('')
    .map((c) => [`Key${c.toUpperCase()}`, c]),
  ...'0123456789'.split('').map((d) => [`Digit${d}`, d]),
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Slash', '/'],
  ['Backslash', '\\'],
  ['Comma', ','],
  ['Period', '.'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
]);

/** The shortcut letter for a keydown event, independent of keyboard layout.
 *  Falls back to `e.key` for keys with no letter/digit code (`Escape`,
 *  `Enter`, `/`, …), where layout differences don't come up in practice. */
export function latinKey(
  e: Pick<KeyboardEvent, 'code' | 'key'> & { shiftKey?: boolean },
): string {
  if (e.code === 'Slash' && e.shiftKey) return '?';
  return CODE_TO_LATIN[e.code] ?? e.key;
}
