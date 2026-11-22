/**
 * The image a step reads, drawn in its row as soon as the step shows
 * (docs/mobile.md "Files"; rules: `src/ui/stepImages.ts`). A tap opens the
 * viewer (pinch-zoom, Save or share).
 *
 * ```text
 * ▤ Read  .context/shot.png
 *   ┌──────────┐
 *   │  🖼       │   ≤ 2 MiB: fetched with read_file, cached for the session
 *   └──────────┘   you sent it: the local copy, nothing asked
 *   Large image · Tap to load      Couldn't load image · Retry
 * ```
 *
 * Two fetches at a time, one per file; a row drawn twice (the live turn,
 * then the reply) shares the request. Expo Image decodes off the JS thread.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cacheFile, fileKey, getCachedFile } from '../../fleet/file-cache';
import { localCopyOf } from '../../fleet/local-copies';
import type { FleetClient } from '../../fleet/types';
import { useServices } from '../../services';
import { track } from '../../telemetry/log';
import { fileName } from '../../ui/filePaths';
import { refusalCode } from '../../ui/fileViewer';
import { errorText } from '../../ui/logic';
import {
  COULDNT_LOAD_TEXT,
  LARGE_IMAGE_TEXT,
  RETRY_TEXT,
  TAP_TO_LOAD_TEXT,
  hostCantSendFiles,
  hostHasFiles,
  initialThumb,
  isContextPath,
  markHostWithoutFiles,
  reduceThumb,
  type ThumbEvent,
  type ThumbState,
} from '../../ui/stepImages';
import { usePalette } from '../../ui/theme';
import { Spinner } from '../../ui/Spinner';
import { Image } from '../tw';
import { openFile, useFileLink, type FileLinkTarget } from './file-link';

const THUMB_W = 160;
const THUMB_H = 110;
const AT_ONCE = 2;

// ── one fetch per file, two at a time ───────────────────────────────────────

const inFlight = new Map<string, Promise<string>>();
let running = 0;
const waiting: (() => void)[] = [];

function slot(): Promise<void> {
  if (running < AT_ONCE) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      running += 1;
      resolve();
    });
  });
}

function release(): void {
  running -= 1;
  waiting.shift()?.();
}

/** The cached file's URI for `path`, fetched if needed; throws a fleet error. */
function fetchThumb(
  fleet: FleetClient,
  target: FileLinkTarget,
  path: string,
  cap: number,
): Promise<string> {
  const key = fileKey(target.hostDevice, target.space, path);
  const cached = getCachedFile(key);
  if (cached?.uri) return Promise.resolve(cached.uri);
  const going = inFlight.get(`${key}|${cap}`);
  if (going) return going;
  const p = (async () => {
    await slot();
    const started = thumbClock();
    const name = fileName(path);
    try {
      const ref = await fleet.readFile(
        target.hostDevice,
        target.space,
        path,
        cap,
      );
      const bytes = await fleet.fetchBlob(ref);
      const file = await cacheFile(key, bytes, ref.name || name, ref.mime);
      if (!file.uri) throw new Error('No local copy could be made.');
      track('file_viewed', {
        media: 'image',
        bytes: ref.size,
        ms: thumbClock() - started,
        outcome: 'ok',
        code: null,
        surface: 'step_thumbnail',
      });
      return file.uri;
    } catch (e: unknown) {
      track('file_viewed', {
        media: 'image',
        bytes: null,
        ms: thumbClock() - started,
        outcome: 'failed',
        code: refusalCode(e),
        surface: 'step_thumbnail',
      });
      throw e;
    } finally {
      release();
      inFlight.delete(`${key}|${cap}`);
    }
  })();
  inFlight.set(`${key}|${cap}`, p);
  return p;
}

const thumbClock = (): number => Date.now();

// ── the view ────────────────────────────────────────────────────────────────

/** The row's image for `path`; nothing without a space to ask. */
export function StepThumbnail({ path }: { path: string }) {
  const target = useFileLink();
  if (!target) return null;
  return <Thumb path={path} target={target} />;
}

function Thumb({ path, target }: { path: string; target: FileLinkTarget }) {
  const { fleet } = useServices();
  const p = usePalette();
  const [state, dispatch] = useReducer(
    (s: ThumbState, e: ThumbEvent) => reduceThumb(s, e),
    null,
    (): ThumbState => {
      const local = isContextPath(path)
        ? localCopyOf(target.space, path)
        : null;
      const cached = getCachedFile(
        fileKey(target.hostDevice, target.space, path),
      );
      const uri = local ?? cached?.uri ?? null;
      if (uri) return { phase: 'ready', uri };
      if (!hostHasFiles(target.hostDevice)) return { phase: 'unavailable' };
      return initialThumb();
    },
  );
  // A late answer to a row that left is dropped.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback(
    async (cap: number) => {
      try {
        if (!(await fleet.canOpenBlobs())) {
          if (alive.current) dispatch({ type: 'unavailable' });
          return;
        }
        const uri = await fetchThumb(fleet, target, path, cap);
        if (alive.current) dispatch({ type: 'ready', uri });
      } catch (e: unknown) {
        const code = refusalCode(e);
        if (hostCantSendFiles(code)) markHostWithoutFiles(target.hostDevice);
        if (alive.current)
          dispatch({ type: 'refused', code, message: errorText(e) });
      }
    },
    [fleet, target, path],
  );

  useEffect(() => {
    if (state.phase === 'idle') dispatch({ type: 'request' });
  }, [state.phase]);
  const cap = state.phase === 'loading' ? state.cap : null;
  useEffect(() => {
    if (cap !== null) void load(cap);
  }, [cap, load]);

  const name = fileName(path);
  if (state.phase === 'unavailable' || state.phase === 'idle') return null;
  if (state.phase === 'ready') {
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${name}`}
        onPress={() => openFile(target, path)}
        style={[styles.frame, { borderColor: p.border }]}
        testID="step-thumbnail"
      >
        <Image
          source={{ uri: state.uri }}
          contentFit="cover"
          transition={120}
          accessibilityLabel={name}
          style={styles.image}
        />
      </Pressable>
    );
  }
  if (state.phase === 'loading') {
    return (
      <View
        accessibilityLabel={`Loading ${name}`}
        style={[
          styles.frame,
          styles.center,
          { borderColor: p.border, backgroundColor: p.surfaceMuted },
        ]}
      >
        <Spinner color={p.muted} />
      </View>
    );
  }
  if (state.phase === 'large') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${LARGE_IMAGE_TEXT}, ${TAP_TO_LOAD_TEXT}`}
        onPress={() => dispatch({ type: 'loadAnyway' })}
        hitSlop={6}
        style={styles.line}
      >
        <Text style={[styles.note, { color: p.muted }]}>
          {LARGE_IMAGE_TEXT} ·{' '}
          <Text style={{ color: p.accent }}>{TAP_TO_LOAD_TEXT}</Text>
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${COULDNT_LOAD_TEXT}, ${RETRY_TEXT}`}
      onPress={() => dispatch({ type: 'retry' })}
      hitSlop={6}
      style={styles.line}
      testID="step-thumbnail-retry"
    >
      <Text style={[styles.note, { color: p.muted }]}>
        {state.message} · <Text style={{ color: p.accent }}>{RETRY_TEXT}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: 10,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginLeft: 24,
  },
  image: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  line: { marginLeft: 24, minHeight: 20, justifyContent: 'center' },
  note: { fontSize: 12 },
});
