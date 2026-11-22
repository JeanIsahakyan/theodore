/**
 * Files named in a space's chat open the viewer (docs/mobile.md "Files").
 * A space screen provides where its files live (`FileLinkProvider`); the
 * markdown's inline code and a bubble's attachment chips read it:
 *
 * ```text
 * `src/app.tsx` in a reply  ─▶ filePathOf ─▶ a path ─▶ tap ─▶ /file/<space>?path=src/app.tsx
 * [screen.png] on your bubble (the host's row)      ─▶ /file/<space>?path=.context/screen.png
 * no provider (Home, a sub-space's parent list)     ─▶ plain text
 * ```
 */
import { router, type Href } from 'expo-router';
import { createContext, useContext, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import type { Attachment as RowAttachment } from '../../fleet/contract';
import { filePathOf } from '../../ui/filePaths';
import { usePalette } from '../../ui/theme';

export interface FileLinkTarget {
  /** The space on the host (an `rs_` id, or a sub-space's local id). */
  space: string;
  hostDevice: string;
  hostName: string;
  spaceName: string;
}

const FileLinkContext = createContext<FileLinkTarget | null>(null);

export function FileLinkProvider({
  target,
  children,
}: {
  target: FileLinkTarget | null;
  children: ReactNode;
}) {
  return (
    <FileLinkContext.Provider value={target}>
      {children}
    </FileLinkContext.Provider>
  );
}

export const useFileLink = (): FileLinkTarget | null =>
  useContext(FileLinkContext);

/** `/file/<space>?path=…&host=…`: the viewer, pushed with Back. */
export function fileHref(target: FileLinkTarget, path: string): Href {
  // Hand-built: Hermes's URLSearchParams has no object constructor.
  const q = Object.entries({
    path,
    host: target.hostDevice,
    hostName: target.hostName,
    spaceName: target.spaceName,
  })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `/file/${encodeURIComponent(target.space)}?${q}` as Href;
}

export function openFile(target: FileLinkTarget, path: string): void {
  router.push(fileHref(target, path));
}

/** Inline code: a path in a space's chat is a tap to the viewer. */
export function InlineCode({
  value,
  style,
}: {
  value: string;
  style?: TextStyle;
}) {
  const target = useFileLink();
  const p = usePalette();
  const path = target ? filePathOf(value) : null;
  if (!target || !path) return <Text style={style}>{value}</Text>;
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={`Open ${path}`}
      onPress={() => openFile(target, path)}
      style={[style, { color: p.accent, textDecorationLine: 'underline' }]}
    >
      {value}
    </Text>
  );
}

/** The files on one of your messages as the host mirrors them: chips, each
 *  a tap to `.context/<name>` on the host. */
export function AttachmentChips({
  attachments,
}: {
  attachments: readonly RowAttachment[];
}) {
  const target = useFileLink();
  const p = usePalette();
  return (
    <View style={styles.chips}>
      {attachments.map((a) => {
        const chip = (
          <Text
            numberOfLines={1}
            style={[
              styles.chip,
              { borderColor: p.border, color: target ? p.accent : p.muted },
            ]}
          >
            {a.name}
          </Text>
        );
        return target ? (
          <Pressable
            key={a.id || a.name}
            accessibilityRole="link"
            accessibilityLabel={`Open ${a.name}`}
            onPress={() => openFile(target, `.context/${a.name}`)}
          >
            {chip}
          </Pressable>
        ) : (
          <View key={a.id || a.name}>{chip}</View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 6,
  },
  chip: {
    fontSize: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 220,
  },
});
