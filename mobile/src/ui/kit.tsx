/**
 * Small shared components: plain React Native + StyleSheet, light/dark aware,
 * all of them render on iOS, Android and web.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import type { Tone } from './logic';
import { mono, toneColor, usePalette } from './theme';

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: p.surface, borderColor: p.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const p = usePalette();
  return (
    <Text
      accessibilityRole="header"
      style={[styles.section, { color: p.muted }]}
    >
      {children}
    </Text>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'plain';

export function Button({
  label,
  onPress,
  kind = 'secondary',
  disabled,
  busy,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const off = disabled || busy;
  const bg =
    kind === 'primary'
      ? p.accent
      : kind === 'danger'
        ? p.danger
        : kind === 'secondary'
          ? p.surfaceMuted
          : 'transparent';
  const fg =
    kind === 'primary' || kind === 'danger'
      ? p.onAccent
      : kind === 'plain'
        ? p.accent
        : p.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/** A selectable pill: one of several choices. */
export function Chip({
  label,
  selected,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? p.accent : p.surfaceMuted,
          borderColor: selected ? p.accent : p.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text
        style={[styles.chipText, { color: selected ? p.onAccent : p.text }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  const p = usePalette();
  const c = toneColor(p, tone);
  return (
    <View style={[styles.badge, { borderColor: c }]}>
      <Text style={[styles.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

export function Dot({ on, label }: { on: boolean; label: string }) {
  const p = usePalette();
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.dot, { backgroundColor: on ? p.success : p.border }]}
    />
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const p = usePalette();
  const { label, style, ...rest } = props;
  return (
    <TextInput
      accessibilityLabel={label}
      placeholderTextColor={p.muted}
      {...rest}
      style={[
        styles.field,
        { backgroundColor: p.surface, borderColor: p.border, color: p.text },
        style,
      ]}
    />
  );
}

/** A line of feedback: an error, a note. */
export function Notice({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) {
  const p = usePalette();
  const c = toneColor(p, tone);
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={[styles.notice, { borderColor: c }]}
    >
      <Text selectable style={[styles.noticeText, { color: c }]}>
        {children}
      </Text>
    </View>
  );
}

export function Empty({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  const p = usePalette();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: p.text }]}>{title}</Text>
      {hint ? (
        <Text style={[styles.emptyHint, { color: p.muted }]}>{hint}</Text>
      ) : null}
      {children}
    </View>
  );
}

/** "a1b2 c3d4 …", all 8 groups, wrapping, selectable. */
export function Fingerprint({
  value,
  large,
}: {
  value: string;
  large?: boolean;
}) {
  const p = usePalette();
  return (
    <Text
      selectable
      accessibilityLabel={`Fingerprint ${value.split(' ').join(', ')}`}
      style={[
        mono,
        large ? styles.fingerprintLarge : styles.fingerprint,
        { color: p.text, backgroundColor: p.surfaceMuted },
      ]}
    >
      {value || '—'}
    </Text>
  );
}

/** An inline confirm (an Alert does not exist on web). */
export function Confirm({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={title}
      style={[
        styles.confirm,
        {
          borderColor: danger ? p.danger : p.warning,
          backgroundColor: p.surface,
        },
      ]}
    >
      <Text style={[styles.confirmTitle, { color: p.text }]}>{title}</Text>
      {children}
      <View style={styles.row}>
        <Button
          label="Cancel"
          kind="plain"
          onPress={onCancel}
          disabled={busy}
        />
        <Button
          label={confirmLabel}
          kind={danger ? 'danger' : 'primary'}
          busy={busy}
          onPress={onConfirm}
        />
      </View>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 8,
  },
  section: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 4,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 15, fontWeight: '500' },
  badge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  field: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  notice: {
    borderWidth: 1,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  noticeText: { fontSize: 14 },
  empty: { alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  emptyHint: { fontSize: 15, textAlign: 'center' },
  fingerprint: {
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  fingerprintLarge: {
    fontSize: 22,
    lineHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    overflow: 'hidden',
    textAlign: 'center',
  },
  confirm: {
    borderWidth: 1,
    borderRadius: 12,
    borderCurve: 'continuous',
    padding: 12,
    gap: 8,
  },
  confirmTitle: { fontSize: 15 },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
  },
});
