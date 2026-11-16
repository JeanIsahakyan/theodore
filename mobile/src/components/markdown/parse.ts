// Adapted from EvanBacon/chat-template (MIT)
/**
 * Markdown to an mdast tree (micromark: CommonMark + GFM tables and
 * strikethrough), with a stable key on every node and `[x][ref]` links
 * resolved. No React Native here, so the tests read it.
 *
 * ```text
 * text ─▶ fromMarkdown ─▶ resolve references ─▶ keys ─▶ ASTRenderer
 * ```
 *
 * Fleet text is untrusted (it comes from another device): the renderer
 * shows a link's words and its address as text and opens nothing, an image
 * as its alt text, raw HTML as text. Walks here are iterative, so a deeply
 * nested message can't overflow the stack.
 */
import type { Definition, Node, Parent, Root } from 'mdast';
import { fromMarkdown, type Extension } from 'mdast-util-from-markdown';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';

declare module 'mdast' {
  interface Data {
    /** A stable React key: the node's place in the text. */
    key?: string;
  }
}

/** Deeper than this a node is drawn as its plain text. */
export const DEPTH_MAX = 16;

const childrenOf = (node: Node): Node[] | null =>
  'children' in node && Array.isArray((node as Parent).children)
    ? (node as Parent).children
    : null;

function keyOf(node: Node, index: number): string {
  const { start, end } = node.position ?? {};
  return start && end
    ? `${node.type}-${start.offset ?? `${start.line}:${start.column}`}-${end.offset ?? `${end.line}:${end.column}`}`
    : `${node.type}-i${index}`;
}

function addKeys(tree: Root): void {
  const stack: { node: Node; index: number }[] = [{ node: tree, index: 0 }];
  while (stack.length) {
    const { node, index } = stack.pop()!;
    node.data = { ...node.data, key: keyOf(node, index) };
    childrenOf(node)?.forEach((child, i) =>
      stack.push({ node: child, index: i }),
    );
  }
}

const normalize = (id: string) => id.trim().toLowerCase();

/** `[words][ref]` and `![alt][ref]` take their definition's url; the
 *  definitions themselves draw nothing. */
function resolveReferences(tree: Root): void {
  const definitions = new Map<string, Definition>();
  for (const node of tree.children) {
    if (node.type === 'definition')
      definitions.set(normalize(node.identifier), node);
  }
  if (definitions.size === 0) return;
  const stack: Node[] = [tree];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const ref = node as Node & { identifier: string };
      const def = definitions.get(normalize(ref.identifier));
      if (def) {
        const out = node as Node & { url: string; title: string | null };
        out.type = node.type === 'linkReference' ? 'link' : 'image';
        out.url = def.url;
        out.title = def.title ?? null;
      }
    }
    const kids = childrenOf(node);
    if (kids) stack.push(...kids);
  }
  tree.children = tree.children.filter((n) => n.type !== 'definition');
}

const KEYED: Extension = {
  transforms: [
    (tree) => {
      resolveReferences(tree);
      addKeys(tree);
    },
  ],
};

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      KEYED,
    ],
  });
}

/** The words under a node, as plain text (alt text for images). */
export function plainText(node: Node): string {
  let out = '';
  const stack: Node[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if ('value' in n && typeof n.value === 'string') out += n.value;
    else if (n.type === 'image' || n.type === 'imageReference')
      out += (n as Node & { alt?: string | null }).alt ?? '';
    else if (n.type === 'break') out += '\n';
    const kids = childrenOf(n);
    if (kids)
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  }
  return out;
}

/** What a link shows after its words: its address, unless the words are it. */
export function linkNote(words: string, url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  const bare = (x: string) =>
    x.replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '');
  return bare(words.trim()) === bare(u) ? null : u;
}

/**
 * Single newlines as hard breaks (two trailing spaces), so a reply reads
 * as it did while it streamed; fenced code is left alone.
 */
export function preserveNewlines(md: string): string {
  return md.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)|(\n)/g, (match, code) =>
    code ? match : '  \n',
  );
}
