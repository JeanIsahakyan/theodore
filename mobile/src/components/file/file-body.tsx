/**
 * What a file read from a computer looks like (iOS, Android), by kind:
 *
 * | Kind | View |
 * | --- | --- |
 * | image | `expo-image` in a scroll view that pinch-zooms (iOS; Android: fit) |
 * | pdf | a WebView over the local copy (iOS); Android's WebView can't draw a PDF: Share |
 * | text | `TextView`: monospace, highlighted |
 * | other | "No preview": Save / Share |
 */
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
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
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.center}
        maximumZoomScale={6}
        minimumZoomScale={1}
        pinchGestureEnabled
        bouncesZoom
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      >
        <Image
          source={{ uri: file.uri }}
          contentFit="contain"
          accessibilityLabel={file.name}
          style={styles.image}
        />
      </ScrollView>
    );
  }
  if (kind === 'pdf' && file.uri && Platform.OS === 'ios') {
    return (
      <WebView
        source={{ uri: file.uri }}
        originWhitelist={['file://*']}
        allowingReadAccessToURL={file.uri}
        style={styles.fill}
      />
    );
  }
  if (kind === 'text') return <TextView bytes={file.bytes} name={file.name} />;
  return (
    <View style={[styles.fill, styles.center, styles.pad]}>
      <Text style={[styles.note, { color: p.muted }]}>
        {kind === 'pdf'
          ? 'Open the PDF in another app: Share.'
          : NO_PREVIEW_TEXT}
      </Text>
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
