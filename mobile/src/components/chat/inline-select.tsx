/**
 * Select text in place (docs/mobile.md "Select text"): the long-pressed
 * message turns, right where it is in the chat, into its plain text that
 * the system selects — handles, magnifier, Copy / Share on a part. No
 * sheet. Code blocks keep monospace. "Copy all" takes the whole text,
 * "Done" draws the message again.
 *
 * ```text
 * ╭╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮  accent border: selecting
 * ┆ The tests pass, now the ▐docs▌…  ┆  iOS  TextInput editable={false}
 * ┆ ┃cargo test┃  ← monospace        ┆       (a UITextView: partial selection)
 * ┆ Hold a word to select  Copy all  Done ┆  Android, web  Text selectable
 * ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯       (TextView / DOM: partial already)
 * ```
 *
 * iOS's `Text selectable` copies only the whole text (a UILabel), hence the
 * read-only field there; it grows with the text (no inner scroll), so the
 * chat's list scrolls it like any message.
 */
import { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  COPIED_TEXT,
  COPY_ALL_TEXT,
  DONE_TEXT,
  KIND_TITLE,
  SELECT_HINT,
  selectableText,
  textSegments,
  type MessageKind,
} from '../../ui/messageMenu';
import { mono, usePalette } from '../../ui/theme';
import { copied, copyText } from '../settings/feedback';

const ios = Platform.OS === 'ios';

export function InlineSelect({
  text: whole,
  kind,
  onDone,
}: {
  text: string;
  kind: MessageKind;
  onDone: () => void;
}) {
  const p = usePalette();
  const [done, setDone] = useState(false);
  const { text, cut } = useMemo(() => selectableText(whole), [whole]);
  const segments = useMemo(() => textSegments(text), [text]);

  const copyAll = () => {
    void copyText(whole).then((ok) => {
      if (!ok) return;
      copied();
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    });
  };

  const spans = segments.map((s, i) => (
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
  ));

  return (
    <View
      style={[
        styles.box,
        { borderColor: p.accent, backgroundColor: p.surface },
      ]}
      testID="inline-select"
    >
      {ios ? (
        <TextInput
          accessibilityLabel={`${KIND_TITLE[kind]}, selectable text`}
          multiline
          editable={false}
          scrollEnabled={false}
          selectTextOnFocus={false}
          contextMenuHidden={false}
          showSoftInputOnFocus={false}
          style={[styles.field, { color: p.text }]}
          testID="inline-select-field"
        >
          {spans}
        </TextInput>
      ) : (
        <Text
          selectable
          accessibilityLabel={`${KIND_TITLE[kind]}, selectable text`}
          style={[styles.field, styles.web, { color: p.text }]}
          testID="inline-select-field"
        >
          {spans}
        </Text>
      )}
      {cut ? (
        <Text style={[styles.note, { color: p.muted }]}>
          Showing the first {Math.round(text.length / 1000)} K characters. Copy
          all takes everything.
        </Text>
      ) : null}
      <View style={styles.bar}>
        <Text style={[styles.note, styles.hint, { color: p.muted }]}>
          {SELECT_HINT}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={copyAll}
          hitSlop={8}
          testID="inline-select-copy-all"
        >
          <Text style={[styles.action, { color: p.accent }]}>
            {done ? COPIED_TEXT : COPY_ALL_TEXT}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onDone}
          hitSlop={8}
          testID="inline-select-done"
        >
          <Text style={[styles.action, styles.strong, { color: p.accent }]}>
            {DONE_TEXT}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'stretch',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 6,
  },
  field: {
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  web: Platform.OS === 'web' ? ({ userSelect: 'text' } as const) : {},
  span: { fontSize: 16, lineHeight: 22 },
  code: { fontSize: 13, lineHeight: 18 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  hint: { flex: 1 },
  note: { fontSize: 12 },
  action: { fontSize: 15 },
  strong: { fontWeight: '600' },
});
