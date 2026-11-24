/**
 * The "Merged #N" chip (rules: `./merged.ts`): a small pill with a green dot
 * at the top of a space's chat. A tap opens its actions in a small sheet
 * over a dimmed backdrop (React Native's `Modal`: the same on iOS, Android
 * and web, like the web `Menu`); picking one, or tapping outside, closes it.
 *
 * ```text
 *  theodore · th/login · Edit
 *  ╭ ● Merged #12 ╮  ─ tap ─▶  ╭ Merged #12 ──────────────╮
 *                              │ Continue on a new branch │
 *                              │ Open PR #12              │
 *                              │ Archive                  │  danger color
 *                              ╰──────────────────────────╯
 * ```
 */
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MergedChipItem, MergedChipItemId } from './merged';
import { webStyles } from './native/rnStyles';
import { usePalette } from './theme';

export function MergedChip({
  number,
  items,
  onSelect,
  testID,
}: {
  number: number;
  items: readonly MergedChipItem[];
  onSelect: (id: MergedChipItemId) => void;
  testID?: string;
}) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const label = `Merged #${number}`;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        testID={testID}
        hitSlop={6}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: p.surfaceMuted,
            borderColor: p.border,
            opacity: pressed ? 0.75 : 1,
          },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: p.success }]} />
        <Text style={[styles.label, { color: p.text }]}>{label}</Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          accessibilityLabel="Close"
          style={styles.backdrop}
          onPress={() => setOpen(false)}
        >
          <Pressable
            // Taps inside the sheet don't close it.
            onPress={() => {}}
            accessibilityRole="menu"
            style={[
              webStyles.card,
              styles.sheet,
              { backgroundColor: p.surface },
            ]}
          >
            <Text
              style={[
                webStyles.sectionTitle,
                styles.heading,
                { color: p.muted },
              ]}
            >
              {label}
            </Text>
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                testID={testID ? `${testID}-${item.id}` : undefined}
                onPress={() => {
                  setOpen(false);
                  onSelect(item.id);
                }}
                style={({ pressed }) => [
                  webStyles.row,
                  pressed && { backgroundColor: p.surfaceMuted },
                ]}
              >
                <Text
                  style={[
                    webStyles.rowLabel,
                    { color: item.destructive ? p.danger : p.text },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  label: { fontSize: 13, fontWeight: '500' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: { width: '100%', maxWidth: 320, paddingBottom: 6 },
  heading: { paddingTop: 12, paddingBottom: 4 },
});
