/** The identifier at `offset` in `text` — the same charset a ⌘-click in
 *  the diff accepts (`DiffPane`'s `symbolAt`, which hit-tests the DOM and
 *  then defers here): `[A-Za-z_$][\w$]*`. Anything else under the click
 *  (punctuation, whitespace, a digit-led token) resolves to `null`, so
 *  `find_symbol` is never asked to search for something that was never a
 *  name to begin with. */
export function identifierAt(text: string, offset: number): string | null {
  let a = offset;
  let b = offset;
  while (a > 0 && /[\w$]/.test(text[a - 1]!)) a--;
  while (b < text.length && /[\w$]/.test(text[b]!)) b++;
  const word = text.slice(a, b);
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : null;
}
