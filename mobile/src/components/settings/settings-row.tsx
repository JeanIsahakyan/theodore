// Adapted from EvanBacon/chat-template (MIT)
/**
 * A settings row, the template's flat look: icon, label, detail, chevron.
 *
 * ```text
 * iOS, web   [20 pt icon]  Label                  Detail  ›     px 20, py 14
 *                          subtitle (13, muted)
 * Android    [24 dp icon]  Label                                Material 3 list item:
 *                          Detail (supporting)                  56 / 72 dp, ripple,
 *                                                               no chevron
 * ```
 *
 * `href` pushes a page (a link on web); `onPress` acts in place. A row with
 * neither is plain text (About's values). `destructive` paints the label
 * and icon red (Sign out).
 */
import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { mono as monoFont, usePalette } from '../../ui/theme';
import { SymbolImage, type SymbolName } from '../symbol-image';

const android = process.env.EXPO_OS === 'android';

export interface SettingsRowProps {
  icon: SymbolName;
  label: string;
  /** iOS and web: on the trailing side; Android: the supporting line. */
  detail?: string;
  /** A second line under the label, on every platform. */
  subtitle?: string;
  /** Opens a page (drill-down): a chevron on iOS and web. */
  href?: Href;
  onPress?: () => void;
  /** A checkmark: the chosen one of a list of rows. */
  selected?: boolean;
  destructive?: boolean;
  /** A spinner on the trailing side; not pressable meanwhile. */
  loading?: boolean;
  disabled?: boolean;
  /** Monospace detail and subtitle (a fingerprint). */
  mono?: boolean;
  /** Text the user can select (About's values). */
  selectable?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

/** The row's look, shared with the toggle and menu rows. */
export const ROW_CLASS = android
  ? 'flex-row items-center gap-4 px-4 py-2'
  : 'flex-row items-center gap-4 px-5 py-3.5';

export const ROW_ICON_SIZE = android ? 24 : 20;
export const LABEL_CLASS = android
  ? 'text-base text-foreground'
  : 'text-[17px] text-foreground';
const DANGER_LABEL_CLASS = android
  ? 'text-base text-danger'
  : 'text-[17px] text-danger';
export const SUBTITLE_CLASS = android
  ? 'text-sm leading-5 text-muted-foreground'
  : 'text-[13px] leading-snug text-muted-foreground';

export function SettingsRow({
  icon,
  label,
  detail,
  subtitle,
  href,
  onPress,
  selected,
  destructive,
  loading,
  disabled,
  mono,
  selectable,
  accessibilityLabel,
  testID,
}: SettingsRowProps) {
  const p = usePalette();
  const pressable = !!href || !!onPress;
  const off = !!disabled || !!loading;
  const tint = destructive ? p.danger : android ? p.muted : p.text;
  const monoStyle = mono ? monoFont : null;
  const twoLine = !!subtitle || (android && !!detail);

  const content: ReactNode = (
    <>
      <SymbolImage name={icon} size={ROW_ICON_SIZE} color={tint} />
      <View
        // iOS/web: the label keeps its width; the detail on the right is
        // what gets cut ("Organization  Personal (jean…").
        className={android ? 'flex-1 gap-0.5' : 'grow gap-0.5'}
        style={android ? undefined : { flexShrink: 0 }}
      >
        <Text
          numberOfLines={1}
          className={destructive ? DANGER_LABEL_CLASS : LABEL_CLASS}
        >
          {label}
        </Text>
        {android && detail ? (
          <Text
            selectable={selectable}
            numberOfLines={2}
            className={SUBTITLE_CLASS}
            style={monoStyle}
          >
            {detail}
          </Text>
        ) : null}
        {subtitle ? (
          <Text
            selectable={selectable}
            className={SUBTITLE_CLASS}
            style={monoStyle}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {!android && detail ? (
        <Text
          selectable={selectable}
          numberOfLines={1}
          className="max-w-[55%] shrink text-[15px] text-muted-foreground"
          style={monoStyle}
        >
          {detail}
        </Text>
      ) : null}
      {loading ? (
        <ActivityIndicator size="small" color={p.muted} />
      ) : selected ? (
        <SymbolImage name="check" size={android ? 24 : 17} color={p.accent} />
      ) : href && !android ? (
        <SymbolImage name="chevron.right" size={13} color={p.muted} />
      ) : null}
    </>
  );

  const cls = `${ROW_CLASS} ${android ? (twoLine ? 'min-h-[72px]' : 'min-h-14') : ''} ${off ? 'opacity-50' : ''}`;
  const name =
    accessibilityLabel ?? (detail && pressable ? `${label}, ${detail}` : label);

  if (!pressable) {
    return (
      <View
        className={cls}
        accessible
        accessibilityLabel={name}
        testID={testID}
      >
        {content}
      </View>
    );
  }

  const row = (
    <Pressable
      // Only when set: under a Link (asChild) the link supplies it.
      {...(onPress ? { onPress } : {})}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{
        disabled: off,
        busy: !!loading,
        ...(selected !== undefined ? { selected } : {}),
      }}
      testID={testID}
      android_ripple={{ color: p.border }}
      className={`${cls} ${android ? '' : 'active:bg-muted'}`}
    >
      {content}
    </Pressable>
  );
  if (!href) return row;
  return (
    <Link href={href} asChild>
      {row}
    </Link>
  );
}
