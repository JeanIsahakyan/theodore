/**
 * The Select text sheet (docs/mobile.md "Select text"): the long-pressed
 * message as plain text in a read-only multiline field, so the system's
 * own selection handles, magnifier and Copy / Share work on part of it.
 * Code blocks keep monospace. "Copy all" takes the whole text.
 *
 * ```text
 * ╭──────────────────────────────────╮
 * │ Reply                 (Copy all) │
 * │ The tests pass, now the docs…    │  TextInput editable={false}, scrolls
 * │ ┃cargo test┃  ← monospace        │
 * ╰──────────────────────────────────╯
 * iOS: a formSheet route (/select-text) · Android: in the ModalBottomSheet
 * (an RNHostView) · web: the modal card. The text: src/state/selectText.
 * ```
 */
import { useMemo, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSelectText } from '../../state/selectText';
import {
  COPIED_TEXT,
  COPY_ALL_TEXT,
  KIND_TITLE,
  sheetText,
  textSegments,
} from '../../ui/messageMenu';
import { Button } from '../../ui/native';
import { mono, usePalette } from '../../ui/theme';
import { copied, copyText } from '../settings/feedback';

const web = Platform.OS === 'web';

export function SelectTextSheet({
  onClose: _onClose,
  /** Android: the sheet's height is the content's; the field is bounded. */
  maxHeight,
}: {
  onClose: () => void;
  maxHeight?: number;
}) {
  const p = usePalette();
  const { text: whole, kind } = useSelectText();
  const { height } = useWindowDimensions();
  const [done, setDone] = useState(false);
  const { text, cut } = useMemo(() => sheetText(whole), [whole]);
  const segments = useMemo(() => textSegments(text), [text]);
  const fieldMax = maxHeight ?? Math.round(height * 0.6);

  const copyAll = () => {
    void copyText(whole).then((ok) => {
      if (!ok) return;
      copied();
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    });
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: p.text }]}>
          {KIND_TITLE[kind]}
        </Text>
        <Button
          label={done ? COPIED_TEXT : COPY_ALL_TEXT}
          variant="plain"
          pill
          onPress={copyAll}
          testID="select-text-copy-all"
        />
      </View>
      <TextInput
        accessibilityLabel={`${KIND_TITLE[kind]}, selectable text`}
        multiline
        editable={false}
        selectTextOnFocus={false}
        contextMenuHidden={false}
        scrollEnabled
        showSoftInputOnFocus={false}
        textAlignVertical="top"
        style={[
          styles.field,
          { color: p.text, maxHeight: fieldMax },
          web ? ({ userSelect: 'text' } as const) : null,
        ]}
        testID="select-text-field"
        // A textarea takes no children: the web shows the text as one run.
        {...(web ? { value: text } : null)}
      >
        {web
          ? null
          : segments.map((s, i) => (
              <Text
                key={i}
                style={[
                  styles.span,
                  s.kind === 'code' ? [mono, styles.code] : null,
                  { color: p.text },
                ]}
              >
                {s.kind === 'code' ? `\n${s.text}\n` : s.text}
              </Text>
            ))}
      </TextInput>
      {cut ? (
        <Text style={[styles.note, { color: p.muted }]}>
          Showing the first {Math.round(text.length / 1000)} K characters. Copy
          all takes everything.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 17, fontWeight: '600', flex: 1 },
  field: {
    fontSize: 16,
    lineHeight: 22,
    minHeight: 80,
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  span: { fontSize: 16, lineHeight: 22 },
  code: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12 },
});
