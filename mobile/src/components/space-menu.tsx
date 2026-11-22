/**
 * Web: a right-click on the row, or its ⋯ button (at the right; shown on
 * hover, focus or the active row, else only while the button itself has the
 * focus), opens a small menu under the row's right edge. A click outside or
 * Escape closes it. Archive in the danger color, inside the menu only.
 *
 * ```text
 *   Fix the login redirect        ●  ⋯   ── click ──▶   ╭ ⌸ Archive ╮
 * ```
 */
import { useCallback, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from 'react-native';
import { usePalette } from '../ui/theme';
import type { SpaceMenuProps } from './space-menu-types';
import { SymbolImage } from './symbol-image';

const MENU_WIDTH = 180;

interface Anchor {
  top: number;
  left: number;
}

export function SpaceMenu({
  title,
  items,
  onSelect,
  revealed,
  testID,
  children,
}: SpaceMenuProps) {
  const p = usePalette();
  const box = useRef<ViewInstance>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const open = useCallback(() => {
    box.current?.measureInWindow((x, y, width, h) => {
      setAnchor({ top: y + h + 2, left: Math.max(8, x + width - MENU_WIDTH) });
    });
  }, []);
  const close = useCallback(() => setAnchor(null), []);
  if (items.length === 0) return <>{children({})}</>;

  const trailing = (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${title} options`}
      accessibilityState={{ expanded: anchor !== null }}
      testID={testID ? `${testID}-more` : undefined}
      hitSlop={4}
      className={`-mr-2 h-7 w-7 items-center justify-center rounded-md hover:bg-muted ${revealed || anchor ? 'opacity-100' : 'opacity-0 focus:opacity-100'}`}
    >
      <SymbolImage name="more" size={16} color={p.muted} />
    </Pressable>
  );

  return (
    <View
      ref={box}
      testID={testID}
      {...({
        // The browser's context menu event (react-native-web forwards it).
        onContextMenu: (e: { preventDefault: () => void }) => {
          e.preventDefault();
          open();
        },
      } as object)}
    >
      {children({ trailing })}
      <Modal
        visible={anchor !== null}
        transparent
        animationType="none"
        onRequestClose={close}
      >
        <Pressable
          accessibilityLabel="Close"
          style={styles.backdrop}
          onPress={close}
        />
        {anchor ? (
          <View
            accessibilityRole="menu"
            style={[
              styles.menu,
              anchor,
              { backgroundColor: p.surface, borderColor: p.border },
            ]}
          >
            {items.map((item) => {
              const color = item.destructive ? p.danger : p.text;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  testID={testID ? `${testID}-${item.id}` : undefined}
                  onPress={() => {
                    close();
                    onSelect(item.id);
                  }}
                  style={styles.item}
                  className="hover:bg-muted active:bg-muted"
                >
                  <SymbolImage name={item.icon} size={16} color={color} />
                  <Text style={[styles.label, { color }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 4,
    borderRadius: 6,
  },
  label: { fontSize: 14 },
});
