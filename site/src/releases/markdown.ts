/**
 * Release notes are GitHub-flavoured markdown. This renders the subset they
 * use (headings, paragraphs, lists, code, links, tables, quotes, emphasis)
 * to HTML that is safe by construction: every piece of text goes through
 * `esc`, only these tags are ever emitted, and a link's href must be http,
 * https, mailto or a site path. Nothing from the input reaches the output
 * unescaped, so there is no HTML to sanitize afterwards.
 */

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function safeHref(url: string): string | null {
  const u = url.trim();
  if (
    /^(https?:|mailto:)/i.test(u) ||
    (u.startsWith('/') && !u.startsWith('//'))
  )
    return u;
  return null;
}

function link(href: string, text: string): string {
  const external = /^https?:/i.test(href);
  return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${text}</a>`;
}

/** Inline markdown of one already-split run of text. */
function inline(src: string): string {
  // Code spans first: nothing inside them is markdown.
  const parts = src.split(/(`+[^`]+`+)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1)
        return `<code>${esc(part.replace(/^`+|`+$/g, ''))}</code>`;
      return inlineText(part);
    })
    .join('');
}

function inlineText(src: string): string {
  const out: string[] = [];
  // Links and bare URLs are pulled out before emphasis, so an underscore
  // in a URL never turns into italics.
  const re =
    /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push(emphasis(esc(src.slice(last, m.index))));
    const image = m[0].startsWith('!');
    if (m[3] !== undefined) {
      out.push(link(m[3], esc(m[3])));
    } else {
      const href = safeHref(m[2] ?? '');
      const text = emphasis(esc(m[1] ?? ''));
      if (image) out.push(text);
      else if (href) out.push(link(href, text));
      else out.push(text);
    }
    last = m.index + m[0].length;
  }
  out.push(emphasis(esc(src.slice(last))));
  return out.join('');
}

/** `**bold**`, `*italic*`, `_italic_`, `~~struck~~` on escaped text. */
function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '<strong>$1</strong>')
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>');
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string[];
}

function renderList(items: ListItem[]): string {
  // Items nest by indentation: a deeper item becomes a sub-list of the one
  // before it.
  let i = 0;
  const walk = (indent: number): string => {
    const ordered = items[i]?.ordered ?? false;
    const out: string[] = [ordered ? '<ol>' : '<ul>'];
    while (i < items.length && items[i]!.indent >= indent) {
      const it = items[i]!;
      if (it.indent > indent) {
        // A deeper item without a parent at this level: treat as a child
        // of the last one.
        out.push(walk(it.indent));
        continue;
      }
      i += 1;
      let li = `<li>${inline(it.text.join(' '))}`;
      if (i < items.length && items[i]!.indent > indent)
        li += walk(items[i]!.indent);
      out.push(`${li}</li>`);
    }
    out.push(ordered ? '</ol>' : '</ul>');
    return out.join('');
  };
  const chunks: string[] = [];
  while (i < items.length) chunks.push(walk(items[i]!.indent));
  return chunks.join('');
}

function renderTable(rows: string[]): string {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => inline(c.trim()));
  const [head, , ...body] = rows;
  if (!head) return '';
  const th = cells(head)
    .map((c) => `<th>${c}</th>`)
    .join('');
  const trs = body
    .filter((r) => r.trim())
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c) => `<td>${c}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** Markdown to HTML. Headings are demoted (h1 and h2 become h3, the rest
 *  h4) so a release's notes sit under the release's own heading. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: ListItem[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(renderList(list));
    list = [];
  };
  const flushQuote = () => {
    if (quote.length)
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushAll();
      const tag = heading[1]!.length <= 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${inline(heading[2]!)}</${tag}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr />');
      continue;
    }
    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]!);
      continue;
    }
    flushQuote();
    if (
      line.trim().startsWith('|') &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')
    ) {
      flushAll();
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(lines[i]!);
        i += 1;
      }
      i -= 1;
      out.push(renderTable(rows));
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      flushQuote();
      list.push({
        indent: item[1]!.replace(/\t/g, '  ').length,
        ordered: /^\s*\d/.test(line),
        text: [item[2]!],
      });
      continue;
    }
    if (list.length && /^\s{2,}\S/.test(line)) {
      // A continuation line of the last list item.
      list[list.length - 1]!.text.push(line.trim());
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}
