/**
 * The shell's toast (`src/state/toast.ts`): a dark capsule over the bottom
 * of the screen, its text and one action, gone after `TOAST_MS` or a tap on
 * the action. Mounted once by the app shell.
 *
 * ```text
 * ╭──────────────────────────────╮
 * │ Archived                Undo │
 * ╰──────────────────────────────╯
 * ```
 */
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOAST_MS, hideToast, useToast } from '../state/toast';
import { useScheme } from './theme';

export function ToastHost() {
  const toast = useToast((s) => s.toast);
  const insets = useSafeAreaInsets();
  const dark = useScheme() === 'dark';

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => hideToast(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  const bg = dark ? '#F5F5F7' : '#1C1C1E';
  const fg = dark ? '#111114' : '#F5F5F7';
  const accent = dark ? '#2F74C8' : '#8DBDF5';
  return (
    <View
      pointerEvents="box-none"
      style={[styles.layer, { bottom: Math.max(insets.bottom, 12) + 8 }]}
    >
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        testID="toast"
        style={[styles.toast, { backgroundColor: bg }]}
      >
        <Text numberOfLines={2} style={[styles.text, { color: fg }]}>
          {toast.text}
        </Text>
        {toast.action ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              hideToast(toast.id);
              toast.action?.onPress();
            }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.action,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <Text style={[styles.actionText, { color: accent }]}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 100,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    maxWidth: 480,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 24,
    borderCurve: 'continuous',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { flexShrink: 1, fontSize: 15, lineHeight: 20 },
  action: { paddingVertical: 2 },
  actionText: { fontSize: 15, fontWeight: '600' },
});
