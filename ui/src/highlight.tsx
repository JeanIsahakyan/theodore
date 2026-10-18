import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { HighlighterCore } from 'shiki/core';

export type Lang = 'ts' | 'sql' | 'prisma' | 'yaml' | 'css' | 'plain';

/** Best-effort language from a file extension; falls back to plain text. */
export function langOf(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'ts';
  if (ext === 'sql') return 'sql';
  if (ext === 'prisma') return 'prisma';
  if (['yml', 'yaml'].includes(ext)) return 'yaml';
  if (ext === 'css') return 'css';
  return 'plain';
}

const KW: Record<Lang, RegExp> = {
  ts: /^(import|from|export|const|let|async|await|function|return|if|for|of|in|throw|new|class|extends|public|type|enum|void|true|false|null|undefined|this)$/,
  sql: /^(CREATE|TABLE|TYPE|AS|ENUM|NOT|NULL|REFERENCES|ON|DELETE|CASCADE|PRIMARY|KEY|ALTER|ADD|COLUMN|DEFAULT|INDEX|TEXT|INTEGER)$/,
  prisma: /^(model|enum|String|Int|DateTime|Boolean)$/,
  yaml: /^$/,
  css: /^(display|grid|flex|color|background|border|padding|margin|important)$/,
  plain: /^$/,
};

const TOKEN =
  /(\/\/.*$|--.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(@@?\w+)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

/** A highlighted piece of a line: text, CSS color, italic. */
export interface Tok {
  s: string;
  c?: string;
  i?: boolean;
}

/** Instant fallback while Shiki loads: a few regexes. */
function regexTokens(src: string, lang: Lang): Tok[] {
  if (lang === 'plain') return [{ s: src }];
  const out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ s: src.slice(last, i) });
    const [tok, comment, str, deco, num, word] = m;
    let c = '';
    if (comment && lang !== 'yaml') c = 'c';
    else if (str) c = 's';
    else if (deco && lang === 'prisma') c = 'd';
    else if (num) c = 'n';
    else if (word && KW[lang].test(word)) c = 'k';
    else if (word && /^[A-Z]/.test(word) && lang !== 'sql') c = 't';
    else if (word && src[i + word.length] === '(') c = 'f';
    out.push({
      s: tok ?? '',
      c: c ? `var(--tk-${c})` : undefined,
      i: c === 'c',
    });
    last = i + (tok ?? '').length;
  }
  if (last < src.length) out.push({ s: src.slice(last) });
  return out;
}

const SHIKI: Record<Exclude<Lang, 'plain'>, string> = {
  ts: 'typescript',
  sql: 'sql',
  prisma: 'prisma',
  yaml: 'yaml',
  css: 'css',
};
let shiki: HighlighterCore | null = null;
let loading = false;
let version = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, Tok[]>();

/** Real TextMate grammars, lazily; the theme maps scopes to CSS variables built on HeroUI tokens. */
export function loadShiki() {
  if (loading) return;
  loading = true;
  void (async () => {
    const [core, js] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    shiki = await core.createHighlighterCore({
      themes: [
        core.createCssVariablesTheme({
          name: 'heroui',
          variablePrefix: '--shiki-',
          fontStyle: true,
        }),
      ],
      langs: [
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/prisma.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/css.mjs'),
      ],
      engine: js.createJavaScriptRegexEngine(),
    });
    cache.clear();
    version++;
    listeners.forEach((f) => f());
  })();
}

export const shikiReady = () => shiki !== null;

export function tokens(src: string, lang: Lang): Tok[] {
  if (!shiki || lang === 'plain') return regexTokens(src, lang);
  const key = `${lang}\0${src}`;
  let t = cache.get(key);
  if (!t) {
    const [line = []] = shiki.codeToTokensBase(src, {
      lang: SHIKI[lang],
      theme: 'heroui',
    });
    t = line.map((x) => ({
      s: x.content,
      c: x.color,
      i: !!((x.fontStyle ?? 0) & 1),
    }));
    cache.set(key, t);
  }
  return t;
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** One line of code, highlighted; `marks` are character ranges changed within the line. */
export function Code({
  s,
  lang,
  marks,
}: {
  s: string;
  lang: Lang;
  marks?: [number, number][];
}) {
  useSyncExternalStore(subscribe, () => version);
  const out: ReactNode[] = [];
  let pos = 0;
  let k = 0;
  for (const t of tokens(s, lang)) {
    const end = pos + t.s.length;
    const cuts = [pos, end];
    for (const [a, b] of marks ?? []) {
      if (a > pos && a < end) cuts.push(a);
      if (b > pos && b < end) cuts.push(b);
    }
    cuts.sort((a, b) => a - b);
    for (let n = 0; n < cuts.length - 1; n++) {
      const a = cuts[n]!;
      const b = cuts[n + 1]!;
      if (a === b) continue;
      const hit = marks?.some(([x, y]) => a >= x && a < y);
      const text = s.slice(a, b);
      out.push(
        t.c || t.i || hit ? (
          <span
            key={k++}
            className={hit ? 'wd' : undefined}
            style={{ color: t.c, fontStyle: t.i ? 'italic' : undefined }}
          >
            {text}
          </span>
        ) : (
          text
        ),
      );
    }
    pos = end;
  }
  return <code className="src">{out}</code>;
}

/** `code` spans, **bold** and @mentions in chat / comment text. */
export function rich(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|@[\w-]+(?:\/[\w-]+)?)/g)
    .map((p, i) =>
      p.startsWith('`') ? (
        <code key={i}>{p.slice(1, -1)}</code>
      ) : p.startsWith('**') ? (
        <b key={i}>{p.slice(2, -2)}</b>
      ) : p.startsWith('@') && p.length > 1 ? (
        <span key={i} className="mention font-medium text-accent">
          {p}
        </span>
      ) : (
        p
      ),
    );
}

/** GitHub-flavoured markdown (headings, lists, tables, task lists, code) for
 *  PR descriptions and comments. Raw HTML is not rendered. */
export function Md({ text }: { text: string }) {
  return (
    <div className="rich md">
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {stripHtmlComments(text)}
      </Markdown>
    </div>
  );
}

/** HTML comments (e.g. Theodore's idempotency markers) never show. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trimEnd();
}

const mdComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-xl bg-default px-3 py-2 font-mono text-xs">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="md-table">{children}</table>
    </div>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-accent underline-offset-2 hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
};
