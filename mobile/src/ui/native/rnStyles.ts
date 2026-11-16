/** The React Native (web) look of the kit: inset grouped lists like iOS Settings. */
import { StyleSheet } from 'react-native';

export const webStyles = StyleSheet.create({
  form: { padding: 16, gap: 22 },
  section: { gap: 6 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 16,
  },
  footer: { fontSize: 13, paddingHorizontal: 16 },
  card: {
    borderRadius: 12,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 17 },
  rowDetail: { fontSize: 13 },
  rowValue: { fontSize: 17, flexShrink: 1, textAlign: 'right' },
  chevron: { fontSize: 22, lineHeight: 22 },
  slot: { paddingHorizontal: 16, paddingVertical: 10 },
});
