/**
 * The parts of react-syntax-highlighter's light build `code-block.tsx`
 * uses (TypeScript 6 doesn't load global @types packages by default).
 */
declare module 'react-syntax-highlighter/dist/esm/light' {
  import type { ComponentType, ReactNode } from 'react';

  export interface HighlighterProps {
    language: string;
    children: string;
    renderer: (props: { rows: unknown[] }) => ReactNode;
    PreTag?: ComponentType<object>;
    CodeTag?: ComponentType<object>;
    customStyle?: object;
    codeTagProps?: object;
  }

  const SyntaxHighlighter: ComponentType<HighlighterProps> & {
    registerLanguage(name: string, grammar: unknown): void;
  };
  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/dist/esm/languages/hljs/*' {
  const grammar: unknown;
  export default grammar;
}

declare module 'react-syntax-highlighter/dist/esm/styles/hljs/*' {
  const theme: Record<string, Record<string, unknown>>;
  export default theme;
}
