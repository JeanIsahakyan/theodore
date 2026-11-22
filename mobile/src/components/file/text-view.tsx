/**
 * A text, log or code file in the viewer: monospace, highlighted when the
 * name says a language the code block knows (`languages.ts`), scrolling
 * both ways; very long text is cut with a note.
 */
import { ScrollView, StyleSheet, Text } from 'react-native';
import { TEXT_SHOWN_MAX, textToShow } from '../../ui/fileViewer';
import { languageHint } from '../../ui/filePaths';
import { usePalette } from '../../ui/theme';
import { CodeBlock } from '../markdown/code-block';

export function TextView({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const p = usePalette();
  const { text, cut } = textToShow(bytes);
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <CodeBlock
        code={text}
        language={languageHint(name)}
        textStyle={styles.code}
      />
      {cut ? (
        <Text style={[styles.note, { color: p.muted }]}>
          Showing the first {Math.round(TEXT_SHOWN_MAX / 1000)} K characters.
          Save the file to read all of it.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 8 },
  code: { fontSize: 12, lineHeight: 17 },
  note: { fontSize: 12, textAlign: 'center' },
});
