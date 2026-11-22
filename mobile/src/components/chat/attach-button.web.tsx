/**
 * 📎 on web: a small round button; a tap opens a popover card over a
 * dimmed window with Photo library · File (a browser has no camera roll
 * to speak of: "Camera" opens the same file dialog where supported).
 */
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import type { PickSource } from './pick-files';

export const ATTACH_LABEL = 'Attach a file';
export const SOURCES: { source: PickSource; label: string }[] = [
  { source: 'library', label: 'Photo library' },
  { source: 'file', label: 'File' },
];

export function AttachButton({
  onPick,
  disabled,
  busy,
  testID,
}: {
  onPick: (source: PickSource) => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled || busy}
        accessibilityRole="button"
        accessibilityLabel={ATTACH_LABEL}
        accessibilityState={{
          disabled: !!disabled,
          busy: !!busy,
          expanded: open,
        }}
        testID={testID}
        className={`h-8 w-8 items-center justify-center rounded-xl bg-muted hover:opacity-85 ${disabled ? 'opacity-45' : ''}`}
      >
        <SymbolImage name="attach" size={16} color={busy ? p.muted : p.text} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          accessibilityLabel="Close"
          onPress={() => setOpen(false)}
          style={styles.backdrop}
        >
          <View
            accessibilityRole="menu"
            style={[
              styles.card,
              { backgroundColor: p.surface, borderColor: p.border },
            ]}
          >
            {SOURCES.map((s) => (
              <Pressable
                key={s.source}
                accessibilityRole="menuitem"
                onPress={() => {
                  setOpen(false);
                  onPick(s.source);
                }}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? p.surfaceMuted : 'transparent' },
                ]}
              >
                <Text style={[styles.label, { color: p.text }]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    minWidth: 220,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  label: { fontSize: 15 },
});
