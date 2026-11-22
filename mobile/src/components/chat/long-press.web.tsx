/**
 * Web: the text is plain DOM text, selectable with the mouse or a finger
 * already (`user-select: text` on every selectable Text). A long press on
 * a touch screen still shows the small menu (Copy, Select text, a row's
 * actions); the right-click menu stays the browser's.
 */
import { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text } from 'react-native';
import { setSelectText } from '../../state/selectText';
import {
  CANCEL,
  COPY,
  KIND_TITLE,
  SELECT_TEXT,
  messageMenuItems,
} from '../../ui/messageMenu';
import { usePalette } from '../../ui/theme';
import { copied, copyText } from '../settings/feedback';
import { useSheet } from '../pickers/sheet-host';
import type { LongPressMenuProps } from './long-press';

export type { LongPressMenuProps } from './long-press';

export function LongPressMenu({
  text,
  kind,
  extras,
  onExtra,
  children,
  disabled,
}: LongPressMenuProps) {
  const p = usePalette();
  const sheet = useSheet('text');
  const [open, setOpen] = useState(false);
  const items = messageMenuItems(kind, text, extras);
  const pick = useCallback(
    (id: string) => {
      setOpen(false);
      if (id === COPY.id) {
        void copyText(text).then((ok) => ok && copied());
      } else if (id === SELECT_TEXT.id) {
        setSelectText(text, kind);
        sheet.open();
      } else if (id !== CANCEL.id) {
        onExtra?.(id);
      }
    },
    [text, kind, sheet, onExtra],
  );
  return (
    <>
      <Pressable
        onLongPress={
          disabled || !items.length ? undefined : () => setOpen(true)
        }
        delayLongPress={450}
        // A press wrapper must not take the text's own selection.
        style={styles.selectable}
      >
        {children}
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
          <Pressable
            onPress={() => {}}
            style={[styles.card, { backgroundColor: p.surface }]}
          >
            <Text style={[styles.title, { color: p.muted }]}>
              {KIND_TITLE[kind]}
            </Text>
            {items.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                onPress={() => pick(a.id)}
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: p.surfaceMuted },
                ]}
              >
                <Text
                  style={[
                    styles.label,
                    { color: a.destructive ? p.danger : p.text },
                  ]}
                >
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      {sheet.element}
    </>
  );
}

const styles = StyleSheet.create({
  // The row's full width (a bubble keeps its 80 % and its right side); the
  // text stays the browser's to select.
  selectable: { minWidth: 0, alignSelf: 'stretch', userSelect: 'text' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 16,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  title: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  label: { fontSize: 15 },
});
