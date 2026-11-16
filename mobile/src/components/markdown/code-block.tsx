// Adapted from EvanBacon/chat-template (MIT)
/**
 * A fenced code block: highlighted (highlight.js through
 * react-syntax-highlighter's light build, GitHub Gist light / IR Black
 * dark), scrolling sideways, selectable. Only the languages registered
 * here, never auto-detected (`languages.ts`); the rest is plain text.
 *
 * ```text
 * ╭ ts ─────────────────────────────╮
 * │ const a = 1;           ⇠ scroll ⇢│
 * ╰─────────────────────────────────╯
 * ```
 */
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import {
  ScrollView,
  Text,
  useColorScheme,
  View,
  type TextStyle,
} from 'react-native';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/light';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/hljs/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/hljs/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/hljs/diff';
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile';
import go from 'react-syntax-highlighter/dist/esm/languages/hljs/go';
import ini from 'react-syntax-highlighter/dist/esm/languages/hljs/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/hljs/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/hljs/kotlin';
import makefile from 'react-syntax-highlighter/dist/esm/languages/hljs/makefile';
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/hljs/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/hljs/swift';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import githubGist from 'react-syntax-highlighter/dist/esm/styles/hljs/github-gist';
import irBlack from 'react-syntax-highlighter/dist/esm/styles/hljs/ir-black';
import { usePalette } from '../../ui/theme';
import { codeLanguage, type Language } from './languages';

const GRAMMARS: Record<Language, unknown> = {
  bash,
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(GRAMMARS)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

type HljsTheme = Record<string, Record<string, unknown>>;
type Sheet = Record<string, TextStyle>;

/** The theme's colors and weights as React Native text styles. */
function toSheet(theme: HljsTheme): Sheet {
  const out: Sheet = {};
  for (const [cls, css] of Object.entries(theme)) {
    out[cls] = {
      ...(typeof css.color === 'string' ? { color: css.color } : null),
      ...(css.fontWeight === 'bold' || css.fontWeight === 'normal'
        ? { fontWeight: css.fontWeight }
        : null),
      ...(css.fontStyle === 'italic' || css.fontStyle === 'normal'
        ? { fontStyle: css.fontStyle }
        : null),
    };
  }
  return out;
}

const DARK = toSheet(irBlack as HljsTheme);
const LIGHT = toSheet(githubGist as HljsTheme);

interface RendererNode {
  children?: RendererNode[];
  properties?: { className?: string[] };
  value?: string | number;
}

function trimNewlines(s: string): string {
  return s.replace(/^[\r\n]+|[\r\n]+$/g, '');
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  textStyle,
}: {
  code: string;
  language?: string | null;
  textStyle?: TextStyle;
}) {
  const dark = useColorScheme() === 'dark';
  const p = usePalette();
  const sheet = dark ? DARK : LIGHT;
  const lang = codeLanguage(language, code);
  const body = trimNewlines(code);

  const base = useMemo<TextStyle>(
    () => ({ ...textStyle, color: sheet.hljs?.color ?? p.text }),
    [textStyle, sheet, p.text],
  );

  const renderNodes = useCallback(
    (nodes: RendererNode[], key: string): ReactNode[] =>
      nodes.map((node, i) => {
        const k = `${key}.${i}`;
        if (node.children) {
          const styles = (node.properties?.className ?? [])
            .map((c) => sheet[c])
            .filter(Boolean);
          return (
            <Text key={k} style={styles}>
              {renderNodes(node.children, k)}
            </Text>
          );
        }
        return node.value != null ? trimNewlines(String(node.value)) : null;
      }),
    [sheet],
  );

  const renderer = useCallback(
    ({ rows }: { rows: RendererNode[] }) => (
      <Text selectable style={base}>
        {rows.map((row, i) => (
          <Text key={i}>
            {renderNodes(row.children ?? [], String(i))}
            {i < rows.length - 1 ? '\n' : null}
          </Text>
        ))}
      </Text>
    ),
    [base, renderNodes],
  );

  return (
    <View
      className="overflow-hidden rounded-xl"
      style={{
        backgroundColor: dark ? '#1a1a1a' : '#f6f8fa',
        borderCurve: 'continuous',
      }}
    >
      {language ? (
        <Text
          className="px-3 pt-2 text-[11px] text-muted-foreground"
          numberOfLines={1}
        >
          {language}
        </Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: 12, minWidth: '100%' }}
      >
        {lang ? (
          <SyntaxHighlighter
            language={lang}
            renderer={renderer as never}
            PreTag={View as never}
            CodeTag={View as never}
            customStyle={{ backgroundColor: 'transparent' }}
            codeTagProps={{}}
          >
            {body}
          </SyntaxHighlighter>
        ) : (
          <Text selectable style={base}>
            {body}
          </Text>
        )}
      </ScrollView>
    </View>
  );
});
