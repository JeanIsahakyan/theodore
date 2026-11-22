/**
 * The files attached to the message being written, above the field
 * (docs/mobile.md "Files"): a thumbnail per image, a chip per other file,
 * each with its upload progress, ✓ once uploaded, ↻ when it failed, and ✕.
 *
 * ```text
 * ┌────┐ ┌────┐ ┌──────────┐
 * │ 🖼 │ │ 🖼 │ │ 📄 log.txt│
 * │▓▓░░│ │ ✓  │ │  1.2 MB ↻│
 * └─✕──┘ └─✕──┘ └────✕─────┘
 * ```
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  attachmentLabel,
  formatBytes,
  type Attachment,
  type SentFile,
} from '../../ui/attachments';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { Image } from '../tw';

const THUMB = 64;

function Thumb({ file }: { file: SentFile | Attachment }) {
  const p = usePalette();
  if (file.image && file.uri) {
    return (
      <Image
        source={{ uri: file.uri }}
        contentFit="cover"
        accessibilityLabel={file.name}
        style={styles.thumb}
      />
    );
  }
  return (
    <View
      accessibilityLabel={file.name}
      style={[styles.thumb, styles.doc, { backgroundColor: p.surfaceMuted }]}
    >
      <SymbolImage name="step.read" size={18} color={p.muted} />
      <Text numberOfLines={1} style={[styles.docName, { color: p.text }]}>
        {file.name}
      </Text>
      <Text style={[styles.docSize, { color: p.muted }]}>
        {formatBytes(file.size)}
      </Text>
    </View>
  );
}

function Tile({
  a,
  onRetry,
  onRemove,
}: {
  a: Attachment;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const p = usePalette();
  const label = attachmentLabel(a);
  return (
    <View
      accessible
      accessibilityLabel={`${a.name}, ${label}`}
      style={styles.tile}
      testID="attachment"
    >
      <View
        style={[
          styles.frame,
          { borderColor: a.state === 'failed' ? p.danger : p.border },
        ]}
      >
        <Thumb file={a} />
        {a.state === 'uploading' ? (
          <View style={styles.overlay}>
            <View
              style={[
                styles.track,
                { backgroundColor: 'rgba(255,255,255,0.35)' },
              ]}
            >
              <View
                style={[
                  styles.bar,
                  {
                    width: `${Math.round(a.progress * 100)}%`,
                    backgroundColor: p.accent,
                  },
                ]}
              />
            </View>
          </View>
        ) : a.state === 'done' ? (
          <View style={[styles.mark, { backgroundColor: p.success }]}>
            <SymbolImage name="check" size={10} color="#fff" weight="bold" />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Retry ${a.name}`}
            onPress={onRetry}
            style={[styles.overlay, styles.retry]}
          >
            <SymbolImage name="retry" size={20} color="#fff" />
          </Pressable>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${a.name}`}
        onPress={onRemove}
        hitSlop={6}
        style={[styles.close, { backgroundColor: p.text }]}
      >
        <SymbolImage
          name="close"
          size={10}
          color={p.background}
          weight="bold"
        />
      </Pressable>
    </View>
  );
}

export function AttachmentStrip({
  list,
  notice,
  onRetry,
  onRemove,
}: {
  list: readonly Attachment[];
  /** Why the last pick added nothing. */
  notice: string | null;
  onRetry: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const p = usePalette();
  if (!list.length && !notice) return null;
  return (
    <View style={styles.strip}>
      {list.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.row}
        >
          {list.map((a) => (
            <Tile
              key={a.key}
              a={a}
              onRetry={() => onRetry(a.key)}
              onRemove={() => onRemove(a.key)}
            />
          ))}
        </ScrollView>
      ) : null}
      {notice ? (
        <Text
          accessibilityRole="alert"
          numberOfLines={2}
          style={[styles.notice, { color: p.danger }]}
        >
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

/** The files of a sent bubble: thumbnails from the local copy, chips for
 *  the rest, no controls. */
export function SentFiles({ files }: { files: readonly SentFile[] }) {
  const p = usePalette();
  if (!files.length) return null;
  return (
    <View style={[styles.row, styles.end]}>
      {files.map((f, i) => (
        <View
          key={`${f.name}-${i}`}
          style={[styles.frame, { borderColor: p.border }]}
          accessible
          accessibilityLabel={f.name}
        >
          <Thumb file={f} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: 6, paddingHorizontal: 10, paddingTop: 10 },
  row: { flexDirection: 'row', gap: 10, paddingRight: 6, paddingTop: 6 },
  end: { flexWrap: 'wrap', justifyContent: 'flex-end' },
  tile: { position: 'relative' },
  frame: {
    width: THUMB,
    height: THUMB,
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  thumb: { width: THUMB, height: THUMB },
  doc: { alignItems: 'center', justifyContent: 'center', gap: 2, padding: 4 },
  docName: { fontSize: 10, maxWidth: THUMB - 8 },
  docSize: { fontSize: 9 },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    padding: 6,
  },
  retry: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 2 },
  mark: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { fontSize: 12, paddingBottom: 2 },
});
