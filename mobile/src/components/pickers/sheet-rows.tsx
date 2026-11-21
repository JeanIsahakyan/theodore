// Adapted from EvanBacon/chat-template (MIT)
/**
 * React Native pieces of the picker sheets (iOS formSheet routes, the web
 * modal), in the template's model-picker look: full-width rows, a muted
 * heading, a hairline between groups.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';

export function SheetTitle({
  children,
  leading,
}: {
  children: string;
  leading?: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-2 px-5 pt-5 pb-2">
      {leading}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        className="flex-1 text-[20px] font-semibold text-foreground"
      >
        {children}
      </Text>
    </View>
  );
}

/** A step's "‹" back to the sheet's previous step. */
export function SheetBack({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      className="-ml-1 h-8 w-8 items-center justify-center rounded-full active:bg-muted"
    >
      <SymbolImage
        name="chevron.right"
        size={16}
        color={p.accent}
        style={{ transform: [{ scaleX: -1 }] }}
      />
    </Pressable>
  );
}

export function SheetHeading({ children }: { children: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      className="px-5 pt-4 pb-1 text-[13px] font-semibold text-muted-foreground uppercase"
    >
      {children}
    </Text>
  );
}

export function SheetDivider() {
  return <View className="mx-5 my-2 h-px bg-border" />;
}

export function SheetRow({
  label,
  detail,
  selected,
  onPress,
  disabled,
  accent,
  dot,
  chevron,
  value,
  accessibilityLabel,
  testID,
}: {
  label: string;
  detail?: string | null;
  /** ✓ on the trailing side; read as selected. */
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** The label in the accent color (an action: Reset). */
  accent?: boolean;
  /** A leading status dot: online (success) or not (muted). */
  dot?: 'on' | 'off';
  /** "›": the row opens a list. */
  chevron?: boolean;
  /** Muted, on the trailing side ("Default (High)", "12"). */
  value?: string | null;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{
        disabled: !!disabled,
        ...(selected === undefined ? {} : { selected }),
      }}
      testID={testID}
      android_ripple={{ color: p.border }}
      className={`min-h-12 flex-row items-center gap-3.5 px-5 py-2.5 active:bg-muted ${disabled ? 'opacity-40' : ''}`}
    >
      {dot ? (
        <View
          className={`h-2.5 w-2.5 rounded-full ${dot === 'on' ? 'bg-success' : 'bg-muted-foreground/50'}`}
        />
      ) : null}
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className={`text-[17px] ${accent ? 'text-primary' : 'text-foreground'}`}
        >
          {label}
        </Text>
        {detail ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} className="text-[15px] text-muted-foreground">
          {value}
        </Text>
      ) : null}
      {selected ? (
        <SymbolImage
          name="check"
          size={17}
          weight="semibold"
          color={p.accent}
        />
      ) : null}
      {chevron ? (
        <SymbolImage name="chevron.right" size={14} color={p.muted} />
      ) : null}
    </Pressable>
  );
}
