/**
 * One space in the Spaces list, drawn the platform's way. The row is the
 * whole tap target; its accessibility label reads title, host and status.
 *
 * ```text
 * iOS, web   inset grouped list (Mail, Settings): rows share one rounded group
 *            ● Title ..................... Status ›
 *              host · project · mode
 *              last reply (or the error), two lines
 * Android    Material 3 segmented list: rounded rows 2 dp apart, ripple
 *            (T) Title ................... [Status]
 *                host · project · mode
 *                last reply (or the error)
 * ```
 *
 * The dot, the avatar and the status take the status tone (waiting is the
 * warning color), so a space that needs you stands out.
 */
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SpaceView } from '../fleet/types';
import {
  MODE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  plainExcerpt,
  spaceTitle,
} from './logic';
import { toneColor, usePalette, type Palette } from './theme';

const android = process.env.EXPO_OS === 'android';

/** `#RRGGBB` at `alpha` (0…1): the palette is all six-digit hex. */
const tint = (hex: string, alpha: number) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;

export interface SpaceRowProps {
  space: SpaceView;
  onPress: () => void;
  /** First and last of the list: the group's rounded ends. */
  first: boolean;
  last: boolean;
}

export function SpaceRow({ space, onPress, first, last }: SpaceRowProps) {
  const p = usePalette();
  const title = spaceTitle(space);
  const status = STATUS_LABEL[space.status];
  const tone = toneColor(p, STATUS_TONE[space.status]);
  const excerpt = plainExcerpt(space.lastReply);
  const meta = `${space.hostName} · ${space.projectName} · ${MODE_LABEL[space.mode]}`;
  const radius = android ? 20 : 12;
  const ends = {
    borderTopLeftRadius: first ? radius : android ? 4 : 0,
    borderTopRightRadius: first ? radius : android ? 4 : 0,
    borderBottomLeftRadius: last ? radius : android ? 4 : 0,
    borderBottomRightRadius: last ? radius : android ? 4 : 0,
  };

  const lines = (
    <>
      <Text numberOfLines={1} style={[styles.meta, { color: p.muted }]}>
        {meta}
      </Text>
      {space.error ? (
        <Text numberOfLines={2} style={[styles.excerpt, { color: p.danger }]}>
          {space.error}
        </Text>
      ) : excerpt ? (
        <Text numberOfLines={2} style={[styles.excerpt, { color: p.text }]}>
          {excerpt}
        </Text>
      ) : null}
    </>
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} on ${space.hostName}, ${status}`}
      onPress={onPress}
      android_ripple={{ color: p.surfaceMuted }}
      style={({ pressed }) => [
        android ? styles.androidRow : styles.iosRow,
        ends,
        {
          backgroundColor: pressed && !android ? p.surfaceMuted : p.surface,
        },
      ]}
    >
      {android ? (
        <>
          <Avatar title={title} tone={tone} />
          <View style={styles.body}>
            <View style={styles.top}>
              <Text
                numberOfLines={1}
                style={[styles.androidTitle, { color: p.text }]}
              >
                {title}
              </Text>
              <View
                style={[styles.chip, { backgroundColor: tint(tone, 0.14) }]}
              >
                <Text style={[styles.chipText, { color: tone }]}>{status}</Text>
              </View>
            </View>
            {lines}
          </View>
        </>
      ) : (
        <>
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <View style={styles.body}>
            <View style={styles.top}>
              <Text
                numberOfLines={1}
                style={[styles.iosTitle, { color: p.text }]}
              >
                {title}
              </Text>
              <Text style={[styles.status, { color: tone }]}>{status}</Text>
              <Chevron p={p} />
            </View>
            {lines}
          </View>
        </>
      )}
    </Pressable>
  );
}

/** Android: the space's initial in a circle of its status tone. */
function Avatar({ title, tone }: { title: string; tone: string }) {
  return (
    <View style={[styles.avatar, { backgroundColor: tint(tone, 0.16) }]}>
      <Text style={[styles.avatarText, { color: tone }]}>
        {(title.trim()[0] ?? '·').toUpperCase()}
      </Text>
    </View>
  );
}

/** A navigation row's chevron: the SF Symbol on iOS, "›" on the web. */
function Chevron({ p }: { p: Palette }) {
  if (process.env.EXPO_OS !== 'ios') {
    return <Text style={[styles.chevronText, { color: p.muted }]}>›</Text>;
  }
  return (
    <SymbolView
      name="chevron.right"
      size={13}
      weight="semibold"
      tintColor={p.muted}
      style={styles.chevron}
    />
  );
}

/** Between rows: iOS / web an inset hairline on the group, Android a gap. */
export function SpaceRowSeparator() {
  const p = usePalette();
  if (android) return <View style={styles.gap} />;
  return (
    <View style={[styles.separatorWrap, { backgroundColor: p.surface }]}>
      <View style={[styles.separator, { backgroundColor: p.border }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  iosRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 11,
    paddingLeft: 16,
    paddingRight: 14,
    borderCurve: 'continuous',
  },
  androidRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    overflow: 'hidden',
  },
  body: { flex: 1, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  iosTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  androidTitle: { flex: 1, fontSize: 16, fontWeight: '500' },
  status: { fontSize: 15 },
  chevron: { width: 13, height: 13 },
  chevronText: { fontSize: 20, lineHeight: 20 },
  chip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '500' },
  meta: { fontSize: 14 },
  excerpt: { fontSize: 15, lineHeight: 20 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 17, fontWeight: '600' },
  gap: { height: 2 },
  separatorWrap: { paddingLeft: 34 },
  separator: { height: StyleSheet.hairlineWidth },
});
