/**
 * What a file read from a computer looks like on web: an image fit to the
 * window, a PDF in an iframe over its blob URL, text highlighted, the rest
 * "No preview" (Download).
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CachedFile } from '../../fleet/file-cache';
import { NO_PREVIEW_TEXT } from '../../ui/fileViewer';
import type { FileKind } from '../../ui/filePaths';
import { usePalette } from '../../ui/theme';
import { Image } from '../tw';
import { TextView } from './text-view';

export function FileBody({ file, kind }: { file: CachedFile; kind: FileKind }) {
  const p = usePalette();
  if (kind === 'image' && file.uri) {
    return (
      <ScrollView style={styles.fill} contentContainerStyle={styles.center}>
        <Image
          source={{ uri: file.uri }}
          contentFit="contain"
          accessibilityLabel={file.name}
          style={styles.image}
        />
      </ScrollView>
    );
  }
  if (kind === 'pdf' && file.uri) {
    return (
      <View style={styles.fill}>
        <iframe
          title={file.name}
          src={file.uri}
          style={{ border: 'none', width: '100%', height: '100%' }}
        />
      </View>
    );
  }
  if (kind === 'text') return <TextView bytes={file.bytes} name={file.name} />;
  return (
    <View style={[styles.fill, styles.center, styles.pad]}>
      <Text style={[styles.note, { color: p.muted }]}>{NO_PREVIEW_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24 },
  image: { width: '100%', height: '100%', minHeight: 240 },
  note: { fontSize: 15, textAlign: 'center' },
});
