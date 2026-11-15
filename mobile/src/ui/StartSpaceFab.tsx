/**
 * iOS and web have no FAB: iOS puts "Start a space" in the header ("+"),
 * the web in the list's header. See `StartSpaceFab.android.tsx`.
 */
export const FAB_CLEARANCE = 0;

export function StartSpaceFab(_: { onPress: () => void }) {
  return null;
}
