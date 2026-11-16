import type { Node, Parent, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX,
  codeLanguage,
} from '../src/components/markdown/languages';
import {
  linkNote,
  parseMarkdown,
  plainText,
  preserveNewlines,
} from '../src/components/markdown/parse';

const types = (n: Parent) => n.children.map((c) => c.type);

function findAll(tree: Node, type: string): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === type) out.push(n);
    if ('children' in n) stack.push(...[...(n as Parent).children].reverse());
  }
  return out;
}

const find = (tree: Node, type: string) => findAll(tree, type)[0];

function depth(tree: Node): number {
  let max = 0;
  const stack: [Node, number][] = [[tree, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    max = Math.max(max, d);
    if ('children' in n)
      for (const c of (n as Parent).children) stack.push([c, d + 1]);
  }
  return max;
}

describe('markdown parse', () => {
  it('parses headings, paragraphs, code, rules and quotes', () => {
    const tree = parseMarkdown(
      [
        '## Plan',
        '',
        'one line',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '---',
        '',
        '> quoted **text**',
      ].join('\n'),
    );
    expect(types(tree)).toEqual([
      'heading',
      'paragraph',
      'code',
      'thematicBreak',
      'blockquote',
    ]);
    expect(tree.children[0]).toMatchObject({ depth: 2 });
    expect(tree.children[2]).toMatchObject({
      lang: 'ts',
      value: 'const a = 1;',
    });
    expect(plainText(tree.children[4]!)).toBe('quoted text');
  });

  it('parses GFM tables and strikethrough', () => {
    const tree = parseMarkdown('| a | b \\| c |\n|---|:-:|\n| 1 | ~~2~~ |');
    const table = tree.children[0] as Parent;
    expect(table.type).toBe('table');
    expect(table.children.map((r) => plainText(r))).toEqual(['ab | c', '12']);
    expect(find(tree, 'delete')).toBeDefined();
  });

  it('gives every node a stable key', () => {
    const md = '- a\n- **b**\n\n[x][ref]\n\n[ref]: https://x.dev';
    const one = parseMarkdown(md);
    const two = parseMarkdown(md);
    const keys = (t: Root) => {
      const out: string[] = [];
      const stack: Node[] = [t];
      while (stack.length) {
        const n = stack.pop()!;
        out.push(n.data?.key ?? '');
        if ('children' in n) stack.push(...(n as Parent).children);
      }
      return out;
    };
    expect(keys(one)).toEqual(keys(two));
    expect(keys(one).every(Boolean)).toBe(true);
    expect(new Set(keys(one).slice(1)).size).toBe(keys(one).length - 1);
  });

  it('resolves reference links and drops their definitions', () => {
    const tree = parseMarkdown('see [the diff][d]\n\n[d]: https://x.dev/pr/1');
    expect(types(tree)).toEqual(['paragraph']);
    expect(find(tree, 'link')).toMatchObject({ url: 'https://x.dev/pr/1' });
  });

  it('keeps links, images and HTML as nodes the renderer shows as text', () => {
    const tree = parseMarkdown(
      'a [link](https://evil.example) ![shot](https://x/a.png) <b>hi</b> <https://a.b/c>',
    );
    expect(findAll(tree, 'link')).toMatchObject([
      { url: 'https://evil.example' },
      { url: 'https://a.b/c' },
    ]);
    expect(find(tree, 'image')).toMatchObject({ alt: 'shot' });
    expect(find(tree, 'html')).toMatchObject({ value: '<b>' });
    expect(plainText(tree)).toContain('link');
    expect(plainText(tree)).toContain('shot');
  });

  it("shows a link's address unless its words are it", () => {
    expect(linkNote('the diff', 'https://x.dev')).toBe('https://x.dev');
    expect(linkNote('x.dev', 'https://x.dev/')).toBeNull();
    expect(linkNote('a', '')).toBeNull();
  });

  it('survives deep nesting without recursing', () => {
    const deep = '>'.repeat(3000) + ' x';
    const tree = parseMarkdown(deep);
    expect(depth(tree)).toBeGreaterThan(100);
    expect(plainText(tree)).toBe('x');
    expect(() => parseMarkdown('*'.repeat(5000))).not.toThrow();
    expect(() => parseMarkdown('- '.repeat(2000) + 'x')).not.toThrow();
  });

  it('turns single newlines into hard breaks, code left alone', () => {
    expect(preserveNewlines('a\nb')).toBe('a  \nb');
    expect(preserveNewlines('```\na\nb\n```')).toBe('```\na\nb\n```');
    const tree = parseMarkdown(preserveNewlines('one\ntwo'));
    expect(find(tree, 'break')).toBeDefined();
  });
});

describe('code block language', () => {
  it('highlights only registered languages, by name or alias', () => {
    expect(codeLanguage('ts', 'x')).toBe('typescript');
    expect(codeLanguage('TypeScript', 'x')).toBe('typescript');
    expect(codeLanguage('sh', 'x')).toBe('bash');
    expect(codeLanguage('toml', 'x')).toBe('ini');
    expect(codeLanguage('brainfuck', 'x')).toBeNull();
    expect(codeLanguage(undefined, 'x')).toBeNull();
    expect(codeLanguage('', 'x')).toBeNull();
  });

  it('leaves long blocks plain', () => {
    expect(codeLanguage('ts', 'x'.repeat(HIGHLIGHT_MAX + 1))).toBeNull();
  });
});
