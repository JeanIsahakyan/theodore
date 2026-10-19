/**
 * Grouped indexes over pooled rows. The whole group map is one MobX
 * `computed` (rebuilt in O(n) once per change of what it reads); each key is
 * read through its own cached `computed` with a shallow comparer, so an
 * observer re-renders only when its own slice changes — not on every write
 * to the model.
 */
import {
  _isComputingDerivation,
  compareShallow,
  computed,
  onBecomeUnobserved,
  type IComputedValue,
} from 'mobx';

const EMPTY: readonly never[] = Object.freeze([]);

export type GroupLookup<T> = (key: string) => readonly T[];

/** Joins key parts; NUL never occurs in ids, paths or numbers. */
export const groupKey = (...parts: (string | number)[]): string =>
  parts.join('\u0000');

/**
 * `build` calls `add(key, value)` for every entry; the lookup returns the
 * values of one key in insertion order (the pool's map order), or a shared
 * frozen empty array. Returned arrays are shared — never mutate them.
 */
export function groupedIndex<T>(
  build: (add: (key: string, value: T) => void) => void,
): GroupLookup<T> {
  const groups = computed(
    () => {
      const m = new Map<string, T[]>();
      build((key, value) => {
        const arr = m.get(key);
        if (arr) arr.push(value);
        else m.set(key, [value]);
      });
      return m;
    },
    // Kept alive so a read outside any reaction (an action handler) is an
    // O(1) lookup instead of a rebuild; recomputation stays lazy.
    { keepAlive: true },
  );
  const slices = new Map<string, IComputedValue<readonly T[]>>();
  return (key) => {
    // Outside a derivation nothing would ever unobserve a cached slice, so
    // it would leak; read the group map directly instead.
    if (!_isComputingDerivation()) return groups.get().get(key) ?? EMPTY;
    let slice = slices.get(key);
    if (!slice) {
      const created = computed(() => groups.get().get(key) ?? EMPTY, {
        equals: compareShallow,
      });
      slices.set(key, created);
      onBecomeUnobserved(created, () => {
        if (slices.get(key) === created) slices.delete(key);
      });
      slice = created;
    }
    return slice.get();
  };
}
