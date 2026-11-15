/**
 * The markdown an agent writes, parsed into blocks a `Text` tree can draw.
 * Fleet text is from another device: a link is its words and its address as
 * plain text (nothing opens it), an image is its alt text (nothing loads).
 *
 * ```text
 * blocks   # heading · paragraph · ``` code · > quote · - / 1. list (nested)
 *          --- rule · | table |
 * inline   `code` · **strong** · *em* / _em_ · ~~del~~ · [words](url)
 *          ![alt](src) · <https://…> · \escape
 * ```
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; children: Inline[]; url: string }
  | { type: 'image'; alt: string };

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] };

/** Nesting this deep is drawn flat: a list or quote can't recurse forever. */
const DEPTH_MAX = 8;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) =>
  line.replace(/\t/g, '    ').match(/^ */)![0].length;
const blank = (line: string) => line.trim() === '';

/** Strips up to `n` columns of leading spaces (tabs as 4). */
function dedent(line: string, n: number): string {
  const l = line.replace(/^\t+/, (t) => '    '.repeat(t.length));
  let i = 0;
  while (i < n && l[i] === ' ') i += 1;
  return l.slice(i);
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line)
  );
}

/** A table row's cells; `\|` is a pipe inside one. */
function cells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < l.length; i += 1) {
    if (l[i] === '\\' && l[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (l[i] === '|') {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += l[i];
    }
  }
  out.push(cell.trim());
  return out;
}

export function parseMarkdown(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, '\n').split('\n'), 0);
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (
          l.trim().startsWith(marker[0]!.repeat(marker.length)) &&
          /^\s*([`~])\1*\s*$/.test(l)
        ) {
          i += 1;
          break;
        }
        body.push(l);
        i += 1;
      }
      out.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({
        type: 'heading',
        level: heading[1]!.length,
        inline: parseInline(heading[2] ?? ''),
      });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: 'rule' });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(QUOTE, ''));
        i += 1;
      }
      out.push(
        depth >= DEPTH_MAX
          ? { type: 'paragraph', inline: parseInline(body.join(' ')) }
          : { type: 'quote', blocks: blocks(body, depth + 1) },
      );
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, depth, out);
      continue;
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_RULE.test(lines[i + 1]!) &&
      lines[i + 1]!.includes('-')
    ) {
      const header = cells(line).map((c) => parseInline(c));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes('|')) {
        rows.push(cells(lines[i]!).map((c) => parseInline(c)));
        i += 1;
      }
      out.push({ type: 'table', header, rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]!)) {
      if (para.length > 0 && startsBlock(lines[i]!)) break;
      para.push(lines[i]!.trim());
      i += 1;
    }
    out.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
  }
  return out;
}

/** A list from `lines[start]`; returns where it ended. */
function list(
  lines: string[],
  start: number,
  depth: number,
  out: Block[],
): number {
  const first = ITEM.exec(lines[start]!)!;
  const base = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const items: string[][] = [];
  let content = 0;
  let i = start;
  let gap = false;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = ITEM.exec(line);
    const indent = indentOf(line);
    if (item && indent <= base + 1 && /\d/.test(item[2]!) === ordered) {
      content = indent + item[2]!.length + Math.max(1, item[3]!.length);
      items.push([item[4] ?? '']);
      gap = false;
      i += 1;
      continue;
    }
    if (blank(line)) {
      gap = true;
      items.at(-1)!.push('');
      i += 1;
      continue;
    }
    if (indent > base) {
      // Nested under the item (a list two spaces in, too).
      items.at(-1)!.push(dedent(line, Math.min(indent, content)));
      gap = false;
      i += 1;
      continue;
    }
    if (!gap && !startsBlock(line)) {
      // A lazy continuation of the item's paragraph.
      items.at(-1)!.push(line.trim());
      i += 1;
      continue;
    }
    break;
  }
  out.push({
    type: 'list',
    ordered,
    start: ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1,
    items: items.map((body) =>
      depth >= DEPTH_MAX
        ? [{ type: 'paragraph', inline: parseInline(body.join(' ')) }]
        : blocks(body, depth + 1),
    ),
  });
  return i;
}

// ── inline ──────────────────────────────────────────────────────────────────

const PUNCT = /[\\`*_{}[\]()#+\-.!|~<>"']/;
/** A letter or digit (no `\p{…}`: not every engine has it). */
const wordChar = (c: string | undefined) =>
  !!c && (/[0-9]/.test(c) || c.toLowerCase() !== c.toUpperCase());

/** Where the `]` that closes the `[` at `open` is, or -1. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '[') depth += 1;
    if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `(url "title")` at `at`: the url and where it ends, or null. */
function target(s: string, at: number): { url: string; end: number } | null {
  if (s[at] !== '(') return null;
  let depth = 0;
  for (let i = at; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        const inner = s
          .slice(at + 1, i)
          .trim()
          .replace(/\s+("[^"]*"|'[^']*')$/, '');
        return { url: inner.replace(/^<(.*)>$/, '$1'), end: i + 1 };
      }
    }
  }
  return null;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  const nest = (inner: string) =>
    depth >= DEPTH_MAX
      ? [{ type: 'text' as const, text: inner }]
      : parseInline(inner, depth + 1);
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const code = s.slice(i + run.length, end);
        out.push({
          type: 'code',
          text: /^ .* $/.test(code) ? code.slice(1, -1) : code,
        });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const close = closeBracket(s, i + 1);
      const t = close > 0 ? target(s, close + 1) : null;
      if (t) {
        flush();
        out.push({ type: 'image', alt: s.slice(i + 2, close) });
        i = t.end;
        continue;
      }
    }
    if (c === '[') {
      const close = closeBracket(s, i);
      const t = close > 0 ? target(s, close + 1) : null;
      if (t) {
        flush();
        out.push({
          type: 'link',
          children: nest(s.slice(i + 1, close)),
          url: t.url,
        });
        i = t.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/.exec(s.slice(i));
      if (auto) {
        flush();
        out.push({
          type: 'link',
          children: [{ type: 'text', text: auto[1]! }],
          url: auto[1]!,
        });
        i += auto[0].length;
        continue;
      }
    }
    if ((c === '*' || c === '_' || c === '~') && s[i + 1] === c) {
      const mark = c + c;
      const end = s.indexOf(mark, i + 2);
      const opens =
        s[i + 2] !== undefined &&
        !/\s/.test(s[i + 2]!) &&
        (c !== '_' || !wordChar(s[i - 1]));
      if (opens && end > i + 2 && !/\s/.test(s[end - 1]!)) {
        flush();
        out.push({
          type: c === '~' ? 'del' : 'strong',
          children: nest(s.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== c) {
      const opens =
        s[i + 1] !== undefined &&
        !/\s/.test(s[i + 1]!) &&
        (c !== '_' || !wordChar(s[i - 1]));
      if (opens) {
        let end = -1;
        for (let j = i + 1; j < s.length; j += 1) {
          if (s[j] === '\\') {
            j += 1;
            continue;
          }
          if (
            s[j] === c &&
            s[j + 1] !== c &&
            s[j - 1] !== c &&
            !/\s/.test(s[j - 1]!) &&
            (c !== '_' || !wordChar(s[j + 1]))
          ) {
            end = j;
            break;
          }
        }
        if (end > i + 1) {
          flush();
          out.push({ type: 'em', children: nest(s.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

/** The words of an inline tree, as plain text. */
export function plainInline(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'image':
          return n.alt;
        default:
          return plainInline(n.children);
      }
    })
    .join('');
}

/** What a link shows after its words: its address, unless the words are it. */
export function linkNote(words: string, url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const bare = (x: string) =>
    x.replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '');
  return bare(words.trim()) === bare(u) ? null : u;
}
