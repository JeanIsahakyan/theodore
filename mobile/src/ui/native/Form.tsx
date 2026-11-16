/**
 * Web: an inset grouped list in React Native (the iOS Settings look):
 * `Form` ─▶ `ScrollView`, `Section` ─▶ a titled card, rows split by hairlines.
 */
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { usePalette } from '../theme';
import { InForm } from './context';
import { webStyles } from './rnStyles';
import type { FormProps, FormSlotProps, RowProps, SectionProps } from './types';

export function Form({ children, testID }: FormProps) {
  const p = usePalette();
  return (
    <ScrollView
      testID={testID}
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: p.background }}
      contentContainerStyle={webStyles.form}
    >
      <InForm.Provider value>{children}</InForm.Provider>
    </ScrollView>
  );
}

/** Rows of a section, fragments flattened, `null`s dropped. */
function rows(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((c) =>
    isValidElement<{ children?: ReactNode }>(c) && c.type === Fragment
      ? rows(c.props.children)
      : [c],
  );
}

export function Section({ title, footer, children }: SectionProps) {
  const p = usePalette();
  const items = rows(children);
  return (
    <View style={webStyles.section}>
      {title ? (
        <Text
          accessibilityRole="header"
          style={[webStyles.sectionTitle, { color: p.muted }]}
        >
          {title}
        </Text>
      ) : null}
      <View style={[webStyles.card, { backgroundColor: p.surface }]}>
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 ? (
              <View
                style={[webStyles.separator, { backgroundColor: p.border }]}
              />
            ) : null}
            {item}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <Text style={[webStyles.footer, { color: p.muted }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

export function Row({
  label,
  detail,
  value,
  onPress,
  chevron,
  selected,
  destructive,
  loading,
  disabled,
  accessibilityLabel,
  testID,
}: RowProps) {
  const p = usePalette();
  const off = !!disabled || !!loading;
  const body = (
    <>
      <View style={webStyles.rowText}>
        <Text
          style={[
            webStyles.rowLabel,
            { color: destructive ? p.danger : p.text },
          ]}
        >
          {label}
        </Text>
        {detail ? (
          <Text style={[webStyles.rowDetail, { color: p.muted }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value != null ? (
        <Text
          selectable={!onPress}
          numberOfLines={1}
          style={[webStyles.rowValue, { color: p.muted }]}
        >
          {value}
        </Text>
      ) : null}
      {loading ? (
        <ActivityIndicator size="small" color={p.muted} />
      ) : selected ? (
        <Text style={[webStyles.rowLabel, { color: p.accent }]}>✓</Text>
      ) : chevron ? (
        <Text style={[webStyles.chevron, { color: p.border }]}>›</Text>
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        style={webStyles.row}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{
        disabled: off,
        busy: !!loading,
        selected: !!selected,
      }}
      testID={testID}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        webStyles.row,
        { opacity: disabled ? 0.45 : 1 },
        pressed && { backgroundColor: p.surfaceMuted },
      ]}
    >
      {body}
    </Pressable>
  );
}

export function FormSlot({ children }: FormSlotProps) {
  return (
    <View style={webStyles.slot}>
      <InForm.Provider value={false}>{children}</InForm.Provider>
    </View>
  );
}
