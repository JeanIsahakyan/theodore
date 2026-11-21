/**
 * A followed space's sub-spaces, at the top of its chat: one compact row per
 * child, grandchildren one step in. The rows are `subSpaceTree.ts`'s. A child
 * isn't followed here, so a tap opens nothing; a long press copies its id.
 *
 * ```text
 * ╭ Sub-spaces ─────────────────────────────────────╮
 * │ Split the grouping crate        (Running)  Edit │
 * │    Move the eval types           (Merged)  Edit │
 * │ Cache the grammars      (Waiting for you)  Plan │
 * ╰─────────────────────────────────────────────────╯
 * ```
 */
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { copied, copyText } from '../components/settings/feedback';
import type { MirroredSubSpace } from '../gen/fleet';
import { Badge } from './kit';
import { MODE_LABEL } from './logic';
import {
  SUB_STATE_LABEL,
  SUB_STATE_TONE,
  subSpaceRows,
  type SubSpaceRow,
} from './subSpaceTree';
import { usePalette } from './theme';

const android = process.env.EXPO_OS === 'android';

/** One step in per level, the deepest ones no further than this. */
const INDENT = 16;
const MAX_INDENT_DEPTH = 3;

const Row = memo(function Row({ row }: { row: SubSpaceRow }) {
  const p = usePalette();
  const { sub, depth, state } = row;
  const title = sub.title || sub.space;
  const label = SUB_STATE_LABEL[state];
  return (
    <Pressable
      accessibilityLabel={`${title}, ${label}, ${MODE_LABEL[sub.mode]}`}
      accessibilityHint="Long-press to copy its id"
      onLongPress={() => {
        void copyText(sub.space).then((ok) => ok && copied());
      }}
      android_ripple={{ color: p.border }}
      style={({ pressed }) => [
        styles.row,
        { paddingLeft: Math.min(depth, MAX_INDENT_DEPTH) * INDENT },
        pressed && !android && styles.pressed,
      ]}
    >
      <Text numberOfLines={1} style={[styles.title, { color: p.text }]}>
        {title}
      </Text>
      <View>
        <Badge label={label} tone={SUB_STATE_TONE[state]} />
      </View>
      <Text style={[styles.mode, { color: p.muted }]}>
        {MODE_LABEL[sub.mode]}
      </Text>
    </Pressable>
  );
});

export function SubSpaces({
  root,
  subs,
}: {
  /** The followed space's `rs_` id: its children name it as their parent. */
  root: string;
  subs: Readonly<Record<string, MirroredSubSpace>>;
}) {
  const p = usePalette();
  const rows = useMemo(() => subSpaceRows(root, subs), [root, subs]);
  if (rows.length === 0) return null;
  return (
    <View
      className="rounded-2xl bg-card"
      style={[styles.card, { borderColor: p.border }]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.small, { color: p.muted }]}
      >
        Sub-spaces
      </Text>
      {rows.map((r) => (
        <Row key={r.sub.space} row={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  small: { fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 30,
  },
  pressed: { opacity: 0.6 },
  title: { flex: 1, fontSize: 13 },
  mode: { fontSize: 12, minWidth: 28, textAlign: 'right' },
});
