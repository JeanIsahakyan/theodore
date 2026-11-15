/**
 * An agent's markdown, drawn with `Text` (iOS, Android and web alike). Fleet
 * text is untrusted: a link shows its words and address as plain, selectable
 * text and opens nothing; an image shows its alt text and loads nothing.
 */
import { memo, useMemo, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import {
  linkNote,
  parseMarkdown,
  plainInline,
  type Block,
  type Inline,
} from './markdownBlocks';
import { mono, usePalette, type Palette } from './theme';

function inline(
  nodes: readonly Inline[],
  p: Palette,
  key: string,
): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.type) {
      case 'text':
        return n.text;
      case 'code':
        return (
          <Text
            key={k}
            style={[mono, styles.code, { backgroundColor: p.surfaceMuted }]}
          >
            {n.text}
          </Text>
        );
      case 'strong':
        return (
          <Text key={k} style={styles.strong}>
            {inline(n.children, p, k)}
          </Text>
        );
      case 'em':
        return (
          <Text key={k} style={styles.em}>
            {inline(n.children, p, k)}
          </Text>
        );
      case 'del':
        return (
          <Text key={k} style={styles.del}>
            {inline(n.children, p, k)}
          </Text>
        );
      case 'link': {
        const note = linkNote(plainInline(n.children), n.url);
        return (
          <Text key={k}>
            {inline(n.children, p, k)}
            {note ? (
              <Text style={[styles.note, { color: p.muted }]}> ({note})</Text>
            ) : null}
          </Text>
        );
      }
      case 'image':
        return (
          <Text key={k} style={[styles.em, { color: p.muted }]}>
            [image{n.alt ? `: ${n.alt}` : ''}]
          </Text>
        );
    }
  });
}

const HEADING_SIZE = [0, 20, 18, 16, 15, 15, 15];

function Blocks({
  blocks,
  p,
  base,
  size,
}: {
  blocks: readonly Block[];
  p: Palette;
  base: StyleProp<TextStyle>;
  size: number;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.type) {
          case 'heading':
            return (
              <Text
                key={k}
                selectable
                accessibilityRole="header"
                style={[
                  base,
                  styles.strong,
                  { fontSize: HEADING_SIZE[b.level] ?? size },
                ]}
              >
                {inline(b.inline, p, k)}
              </Text>
            );
          case 'paragraph':
            return (
              <Text key={k} selectable style={base}>
                {inline(b.inline, p, k)}
              </Text>
            );
          case 'code':
            return (
              <ScrollView
                key={k}
                horizontal
                style={[styles.codeBlock, { backgroundColor: p.surfaceMuted }]}
                contentContainerStyle={styles.codeInner}
              >
                <Text
                  selectable
                  style={[mono, styles.codeText, { color: p.text }]}
                >
                  {b.text}
                </Text>
              </ScrollView>
            );
          case 'quote':
            return (
              <View
                key={k}
                style={[styles.quote, { borderLeftColor: p.border }]}
              >
                <Blocks
                  blocks={b.blocks}
                  p={p}
                  base={[base, { color: p.muted }]}
                  size={size}
                />
              </View>
            );
          case 'list':
            return (
              <View key={k} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.item}>
                    <Text style={[base, styles.marker]}>
                      {b.ordered ? `${b.start + j}.` : '•'}
                    </Text>
                    <View style={styles.itemBody}>
                      <Blocks blocks={item} p={p} base={base} size={size} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case 'rule':
            return (
              <View
                key={k}
                style={[styles.rule, { backgroundColor: p.border }]}
              />
            );
          case 'table':
            return (
              <ScrollView key={k} horizontal>
                <View style={[styles.table, { borderColor: p.border }]}>
                  {[b.header, ...b.rows].map((row, r) => (
                    <View
                      key={r}
                      style={[
                        styles.tr,
                        { borderColor: p.border },
                        r === 0 && { backgroundColor: p.surfaceMuted },
                      ]}
                    >
                      {row.map((cell, c) => (
                        <Text
                          key={c}
                          selectable
                          style={[
                            base,
                            styles.td,
                            { borderColor: p.border },
                            r === 0 && styles.strong,
                          ]}
                        >
                          {inline(cell, p, `${k}.${r}.${c}`)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
        }
      })}
    </>
  );
}

export const Markdown = memo(function Markdown({
  text,
  size = 15,
  muted = false,
}: {
  text: string;
  size?: number;
  muted?: boolean;
}) {
  const p = usePalette();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const base = useMemo(
    () => ({
      fontSize: size,
      lineHeight: Math.round(size * 1.45),
      color: muted ? p.muted : p.text,
    }),
    [size, muted, p],
  );
  return (
    <View style={styles.root}>
      <Blocks blocks={blocks} p={p} base={base} size={size} />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 8, minWidth: 0 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  note: { fontSize: 12 },
  code: { fontSize: 13, borderRadius: 4, paddingHorizontal: 3 },
  codeBlock: { borderRadius: 8, borderCurve: 'continuous' },
  codeInner: { padding: 10 },
  codeText: { fontSize: 12, lineHeight: 17 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: 6 },
  marker: { minWidth: 16 },
  itemBody: { flex: 1, gap: 4, minWidth: 0 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  td: {
    minWidth: 90,
    maxWidth: 260,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
});
