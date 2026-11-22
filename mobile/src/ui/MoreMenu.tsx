/**
 * A "⋯" button opening a small menu of actions, in React Native (web, and
 * any screen without a native bar). The card sits under the button, at its
 * right edge; a tap outside, or on an item, closes it.
 *
 * ```text
 * [⋯] ─▶ ╭──────────╮
 *        │ Archive  │   destructive: the danger color
 *        ╰──────────╯
 * ```
 */
import { useRef, useState, type ComponentRef } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SymbolImage, type SymbolName } from '../components/symbol-image';
import { usePalette } from './theme';

export interface MoreMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

const CARD_WIDTH = 200;

export function MoreMenu({
  items,
  label = 'More',
  icon = 'more',
  size = 18,
  color,
  style,
  className,
  testID,
}: {
  items: readonly MoreMenuItem[];
  /** The button's accessible name. */
  label?: string;
  icon?: SymbolName;
  size?: number;
  /** The glyph's color; default the muted text color. */
  color?: string;
  style?: StyleProp<ViewStyle>;
  /** Tailwind classes of the button (hover, size). */
  className?: string;
  testID?: string;
}) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const button = useRef<ComponentRef<typeof View>>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const open = () => {
    const node = button.current;
    if (!node) return;
    node.measureInWindow((x, y, w, h) => {
      setAt({
        top: y + h + 4,
        left: Math.max(8, Math.min(x + w - CARD_WIDTH, width - CARD_WIDTH - 8)),
      });
    });
  };
  const close = () => setAt(null);

  return (
    <>
      <Pressable
        ref={button}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: at !== null }}
        testID={testID}
        hitSlop={4}
        style={style}
        className={className}
      >
        <SymbolImage name={icon} size={size} color={color ?? p.muted} />
      </Pressable>
      <Modal
        visible={at !== null}
        transparent
        animationType="none"
        onRequestClose={close}
      >
        <Pressable
          accessibilityLabel="Close menu"
          style={styles.backdrop}
          onPress={close}
        >
          {at ? (
            <View
              accessibilityRole="menu"
              style={[
                styles.card,
                { top: at.top, left: at.left },
                { backgroundColor: p.surface, borderColor: p.border },
              ]}
            >
              {items.map((it) => (
                <Pressable
                  key={it.label}
                  accessibilityRole="menuitem"
                  onPress={() => {
                    close();
                    it.onPress();
                  }}
                  style={({ pressed }) => [
                    styles.item,
                    pressed ? { backgroundColor: p.surfaceMuted } : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.itemText,
                      { color: it.destructive ? p.danger : p.text },
                    ]}
                  >
                    {it.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  card: {
    position: 'absolute',
    width: CARD_WIDTH,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  item: { paddingHorizontal: 14, paddingVertical: 10 },
  itemText: { fontSize: 15 },
});
