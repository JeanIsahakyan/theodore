/**
 * A file of a space on a computer, pushed with Back (docs/mobile.md
 * "Files"): asked for with `read_file`, fetched from the cloud, opened
 * with this device's key, shown by kind, kept for the session.
 *
 * ```text
 * [‹]   screen.png                                    /file/<space>?path=…&host=…
 *       mac-A · theodore · 340 KB            (⤓ Save or share)
 *       image: pinch-zoom · PDF: pages · text / log / code: monospace, highlighted
 *       over 8 MB: "Large file · Download anyway" (the protocol caps at 50 MB)
 *       not found / denied / offline ─▶ one line, Retry when it may help
 *
 * requesting ─▶ fleet.readFile(host, space, path, cap) ─▶ {blob}
 *   ─▶ downloading 0…1 ─▶ fleet.fetchBlob (opened, the blob deleted)
 *   ─▶ cached (src/fleet/file-cache.ts) ─▶ ready
 * the same file again this session ─▶ ready at once, nothing asked
 * ```
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FileBody } from '../../../src/components/file/file-body';
import { shareFile } from '../../../src/components/file/share';
import {
  cacheFile,
  fileKey,
  getCachedFile,
  type CachedFile,
} from '../../../src/fleet/file-cache';
import { useServices } from '../../../src/services';
import { track } from '../../../src/telemetry/log';
import { useGlassHeaderInset } from '../../../src/shell/glassHeader';
import { formatBytes } from '../../../src/ui/attachments';
import {
  DOWNLOAD_ANYWAY,
  initialViewer,
  reduceViewer,
  refusalCode,
  saveLabel,
  viewerSubtitle,
  type ViewerEvent,
  type ViewerState,
} from '../../../src/ui/fileViewer';
import { fileKind, fileName } from '../../../src/ui/filePaths';
import { Button, Progress } from '../../../src/ui/native';
import { errorText } from '../../../src/ui/logic';
import { Spinner } from '../../../src/ui/Spinner';
import { usePalette } from '../../../src/ui/theme';

const web = process.env.EXPO_OS === 'web';

export default function FileScreen() {
  const params = useLocalSearchParams<{
    space: string;
    path?: string;
    host?: string;
    hostName?: string;
    spaceName?: string;
  }>();
  const space = params.space;
  const path = params.path ?? '';
  const host = params.host ?? '';
  const hostName = params.hostName || 'the computer';
  const spaceName = params.spaceName ?? '';
  const name = fileName(path);
  const { fleet } = useServices();
  const p = usePalette();
  const top = useGlassHeaderInset();
  const insets = useSafeAreaInsets();
  const key = fileKey(host, space, path);

  const [state, dispatch] = useReducer(
    (s: ViewerState, e: ViewerEvent) => reduceViewer(s, e, hostName, path),
    null,
    (): ViewerState => {
      const cached = getCachedFile(key);
      return cached
        ? {
            phase: 'ready',
            bytes: cached.bytes,
            mime: cached.mime,
            name: cached.name,
            uri: cached.uri,
          }
        : initialViewer();
    },
  );
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // One request at a time; a late answer to an abandoned one is dropped.
  const run = useRef(0);

  const load = useCallback(
    async (cap: number) => {
      const mine = ++run.current;
      const alive = () => run.current === mine;
      const started = viewerClock();
      try {
        if (!(await fleet.canOpenBlobs())) {
          throw Object.assign(
            new Error(
              "This browser's key can't open files. Use the app on your phone.",
            ),
            { code: 'viewer.no_opener' },
          );
        }
        const ref = await fleet.readFile(host, space, path, cap);
        if (!alive()) return;
        dispatch({ type: 'blob', size: ref.size });
        const viewed = {
          media: fileKind(ref.name || name, ref.mime),
          bytes: ref.size,
        };
        const bytes = await fleet.fetchBlob(ref, (f) => {
          if (alive()) dispatch({ type: 'progress', fraction: f });
        });
        if (!alive()) return;
        dispatch({ type: 'opening' });
        const cached = await cacheFile(key, bytes, ref.name || name, ref.mime);
        if (!alive()) return;
        dispatch({
          type: 'ready',
          bytes: cached.bytes,
          mime: cached.mime,
          name: cached.name,
          uri: cached.uri,
        });
        track('file_viewed', {
          ...viewed,
          ms: viewerClock() - started,
          outcome: 'ok',
          code: null,
          surface: 'viewer',
        });
      } catch (e: unknown) {
        if (!alive()) return;
        track('file_viewed', {
          media: fileKind(name, null),
          bytes: null,
          ms: viewerClock() - started,
          outcome: 'failed',
          code: refusalCode(e),
          surface: 'viewer',
        });
        dispatch({
          type: 'refused',
          code: refusalCode(e),
          message: errorText(e),
        });
      }
    },
    [fleet, host, space, path, key, name],
  );

  // Every `requesting` state asks the host once, with its cap.
  const cap = state.phase === 'requesting' ? state.cap : null;
  useEffect(() => {
    if (cap !== null && host && path) void load(cap);
  }, [cap, host, path, load]);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const ready: CachedFile | null =
    state.phase === 'ready'
      ? {
          bytes: state.bytes,
          mime: state.mime,
          name: state.name,
          uri: state.uri,
        }
      : null;
  const kind = fileKind(ready?.name ?? name, ready?.mime ?? null);
  const subtitle = viewerSubtitle({
    hostName,
    spaceName,
    size: ready ? formatBytes(ready.bytes.length) : null,
  });

  const share = async () => {
    if (!ready || sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      await shareFile(ready);
    } catch (e: unknown) {
      setShareError(errorText(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: top }}>
      <Stack.Screen options={{ title: name || 'File' }} />
      <View style={[styles.meta, { borderBottomColor: p.border }]}>
        <View style={styles.metaText}>
          <Text numberOfLines={1} style={[styles.title, { color: p.text }]}>
            {name || 'File'}
          </Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: p.muted }]}>
            {subtitle}
          </Text>
        </View>
        {ready ? (
          <Button
            label={saveLabel(kind, web)}
            variant="plain"
            pill
            loading={sharing}
            onPress={() => void share()}
            testID="file-save"
          />
        ) : null}
      </View>
      {shareError ? (
        <Text
          accessibilityRole="alert"
          style={[styles.line, { color: p.danger }]}
        >
          {shareError}
        </Text>
      ) : null}
      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        {ready ? (
          <FileBody file={ready} kind={kind} />
        ) : state.phase === 'requesting' ? (
          <Centered>
            <Spinner color={p.muted} />
            <Text style={[styles.line, { color: p.muted }]}>
              Asking {hostName} for the file…
            </Text>
          </Centered>
        ) : state.phase === 'downloading' ? (
          <Centered>
            <Progress
              variant="linear"
              value={state.fraction}
              style={styles.bar}
            />
            <Text style={[styles.line, { color: p.muted }]}>
              Downloading · {Math.round(state.fraction * 100)}%
            </Text>
          </Centered>
        ) : state.phase === 'opening' ? (
          <Centered>
            <Spinner color={p.muted} />
            <Text style={[styles.line, { color: p.muted }]}>Opening…</Text>
          </Centered>
        ) : state.phase === 'large' ? (
          <Centered>
            <Text style={[styles.line, { color: p.text }]}>
              {state.message}
            </Text>
            <Text style={[styles.small, { color: p.muted }]}>
              It is over 8 MB. Files up to 50 MB can be fetched.
            </Text>
            <Button
              label={DOWNLOAD_ANYWAY}
              variant="secondary"
              onPress={() => dispatch({ type: 'downloadAnyway' })}
              testID="file-download-anyway"
            />
          </Centered>
        ) : state.phase === 'error' ? (
          <Centered>
            <Text
              accessibilityRole="alert"
              selectable
              style={[styles.line, { color: p.danger }]}
            >
              {state.message}
            </Text>
            {state.retry ? (
              <Button
                label="Retry"
                variant="secondary"
                onPress={() => dispatch({ type: 'retry' })}
                testID="file-retry"
              />
            ) : null}
          </Centered>
        ) : null}
      </View>
    </View>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  metaText: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 13 },
  body: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  line: { fontSize: 15, textAlign: 'center' },
  small: { fontSize: 13, textAlign: 'center' },
  bar: { width: 200 },
});

/** The clock for the viewer's timing (outside render: the React compiler's rule). */
const viewerClock = (): number => Date.now();
