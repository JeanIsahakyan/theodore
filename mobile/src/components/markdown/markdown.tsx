// Adapted from EvanBacon/chat-template (MIT)
/** Markdown text drawn with React Native views (`parse.ts`, `render-rules.tsx`). */
import { memo, useMemo } from 'react';
import ASTRenderer from './ast-renderer';
import { parseMarkdown } from './parse';
import type { MarkdownProps } from './types';

const Markdown = memo(function Markdown({
  markdown,
  renderRules,
  styles,
  mergeStyle,
}: MarkdownProps) {
  const tree = useMemo(() => parseMarkdown(markdown), [markdown]);
  const renderer = useMemo(
    () => new ASTRenderer({ renderRules, styles, mergeStyle }),
    [renderRules, styles, mergeStyle],
  );
  return renderer.render(tree);
});

export default Markdown;
