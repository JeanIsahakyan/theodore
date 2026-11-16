/**
 * Web: a pill showing the label; tapping it opens a small sheet over a
 * dimmed backdrop with each group's heading and choices (checkmark on the
 * chosen one). Picking one, or tapping outside, closes it.
 */
import { Fragment, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { usePalette } from '../theme';
import { webStyles } from './rnStyles';
import type { MenuProps } from './types';

export function Menu({
  label,
  groups,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: MenuProps) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: p.surfaceMuted,
            opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
          },
          style,
        ]}
      >
        <Text numberOfLines={1} style={[styles.label, { color: p.text }]}>
          {label}
        </Text>
        <Text style={[styles.label, { color: p.muted }]}>⌄</Text>
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
            style={[
              webStyles.card,
              styles.sheet,
              { backgroundColor: p.surface },
            ]}
          >
            <ScrollView>
              {groups.map((g, i) => (
                <Fragment key={g.label}>
                  <Text
                    style={[
                      webStyles.sectionTitle,
                      styles.heading,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderColor: p.border,
                      },
                      { color: p.muted },
                    ]}
                  >
                    {g.label}
                  </Text>
                  {g.choices.map((c) => (
                    <Pressable
                      key={c.value}
                      accessibilityRole="button"
                      accessibilityLabel={c.accessibilityLabel ?? c.label}
                      accessibilityState={{ selected: c.value === g.value }}
                      onPress={() => {
                        setOpen(false);
                        if (c.value !== g.value) g.onChange(c.value);
                      }}
                      style={({ pressed }) => [
                        webStyles.row,
                        pressed && { backgroundColor: p.surfaceMuted },
                      ]}
                    >
                      <Text
                        style={[webStyles.rowLabel, { color: p.text, flex: 1 }]}
                      >
                        {c.label}
                      </Text>
                      {c.value === g.value ? (
                        <Text style={[webStyles.rowLabel, { color: p.accent }]}>
                          ✓
                        </Text>
                      ) : null}
                    </Pressable>
                  ))}
                </Fragment>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 220,
  },
  label: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: { width: '100%', maxWidth: 360, maxHeight: '80%', paddingBottom: 6 },
  heading: { paddingTop: 12, paddingBottom: 4 },
});
