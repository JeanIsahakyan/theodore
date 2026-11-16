// Adapted from EvanBacon/chat-template (MIT)
/**
 * The renderer's default styles, merged with a caller's overrides. Each
 * style also gets a `_VIEW_SAFE_<name>` twin without text-only props, for
 * the `View`s (a list, a quote, a table).
 */
import {
  Platform,
  StyleSheet,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { StyleMap } from './types';

const monoFamily = Platform.select({
  ios: 'Menlo',
  default: 'monospace',
});

const defaultStyles: StyleMap = {
  root: { gap: 10, minWidth: 0 },
  heading1: { fontSize: 24, fontWeight: '700' },
  heading2: { fontSize: 20, fontWeight: '700' },
  heading3: { fontSize: 18, fontWeight: '600' },
  heading4: { fontSize: 16, fontWeight: '600' },
  heading5: { fontSize: 15, fontWeight: '600' },
  heading6: { fontSize: 14, fontWeight: '600' },
  paragraph: {},
  strong: { fontWeight: '700' },
  emphasis: { fontStyle: 'italic' },
  delete: { textDecorationLine: 'line-through' },
  text: {},
  linkNote: { fontSize: 13 },
  thematicBreak: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  blockquote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  codeText: { fontSize: 13, lineHeight: 19, fontFamily: monoFamily },
  inlineCode: { fontFamily: monoFamily, fontSize: 14 },
  list: { gap: 4 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  listBullet: { minWidth: 14 },
  listItemContent: { flex: 1, minWidth: 0, gap: 4 },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tableHeaderRow: {},
  tableCell: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  tableHeaderCell: {},
  tableCellText: { fontSize: 14 },
  tableHeaderCellText: { fontWeight: '600' },
};

const TEXT_ONLY = [
  'color',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textDecorationLine',
  'textDecorationStyle',
  'textDecorationColor',
  'textShadowColor',
  'textShadowOffset',
  'textShadowRadius',
  'textTransform',
  'includeFontPadding',
  'textAlignVertical',
  'fontVariant',
  'writingDirection',
] as const;

function viewSafe(style: TextStyle): ViewStyle {
  const out: Record<string, unknown> = { ...style };
  for (const key of TEXT_ONLY) delete out[key];
  return out as ViewStyle;
}

export function getMergedStyles(
  styles: StyleMap | null = null,
  merge = true,
): StyleMap {
  const output: Record<string, TextStyle | ViewStyle> = {};
  const keys = new Set([
    ...Object.keys(defaultStyles),
    ...Object.keys(styles ?? {}),
  ]);
  for (const key of keys) {
    const base = (StyleSheet.flatten(defaultStyles[key]) ?? {}) as TextStyle;
    const custom = (StyleSheet.flatten(styles?.[key]) ?? {}) as TextStyle;
    const final = merge
      ? { ...base, ...custom }
      : styles?.[key]
        ? custom
        : base;
    output[key] = final;
    output[`_VIEW_SAFE_${key}`] = viewSafe(final);
  }
  return output;
}

export const mono = { fontFamily: monoFamily } as const;
