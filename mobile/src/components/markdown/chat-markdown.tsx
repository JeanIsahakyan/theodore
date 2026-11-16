// Adapted from EvanBacon/chat-template (MIT)
/**
 * An agent's markdown in the chat: the template's sizes (16/22 on the
 * phone, 15 on the web), colors from the palette (Material You roles on
 * Android 12+). Untrusted text: links are words plus their address, no
 * image loads (`render-rules.tsx`). `size` / `muted`: the smaller grey
 * text of a thinking block or a subagent's report.
 */
import { memo, useMemo } from 'react';
import { usePalette } from '../../ui/theme';
import Markdown from './markdown';
import { preserveNewlines } from './parse';
import type { StyleMap } from './types';

const web = process.env.EXPO_OS === 'web';

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  size,
  muted = false,
}: {
  children: string;
  size?: number;
  muted?: boolean;
}) {
  const p = usePalette();
  const fontSize = size ?? (web ? 15 : 16);
  const lineHeight = Math.round(fontSize * (web ? 1.6 : 1.375));
  const styles = useMemo<StyleMap>(() => {
    const ink = muted ? p.muted : p.text;
    return {
      text: { color: ink, fontSize, lineHeight },
      heading1: { fontSize: fontSize + 8, lineHeight: lineHeight + 8 },
      heading2: { fontSize: fontSize + 4, lineHeight: lineHeight + 6 },
      heading3: { fontSize: fontSize + 2, lineHeight: lineHeight + 4 },
      heading4: { fontSize },
      heading5: { fontSize },
      heading6: { fontSize, color: p.muted },
      link: { color: p.accent },
      linkNote: { color: p.muted, fontSize: Math.max(12, fontSize - 3) },
      thematicBreak: { backgroundColor: p.border },
      blockquote: { borderColor: p.border },
      codeText: { fontSize: Math.max(12, fontSize - 3) },
      inlineCode: {
        fontSize: fontSize - 2,
        color: ink,
        backgroundColor: p.surfaceMuted,
      },
      listBullet: { color: p.muted, fontVariant: ['tabular-nums'] },
      orderedBullet: { fontWeight: 'normal' },
      table: { borderColor: p.border },
      tableRow: { borderBottomColor: p.border },
      tableHeaderRow: { backgroundColor: p.surfaceMuted },
      tableCell: { borderRightColor: p.border },
      tableCellText: { fontSize: fontSize - 2, lineHeight: lineHeight - 2 },
    };
  }, [p, fontSize, lineHeight, muted]);
  return <Markdown styles={styles} markdown={preserveNewlines(children)} />;
});
