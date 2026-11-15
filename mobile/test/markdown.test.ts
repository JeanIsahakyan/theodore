import { describe, expect, it } from 'vitest';
import {
  linkNote,
  parseInline,
  parseMarkdown,
  plainInline,
} from '../src/ui/markdownBlocks';

describe('markdown blocks', () => {
  it('parses headings, paragraphs, code, rules and quotes', () => {
    const blocks = parseMarkdown(
      [
        '## Plan',
        'one line',
        'joined',
        '',
        '```ts',
        'const a = 1;',
        '',
        '```',
        '---',
        '> quoted **text**',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'code',
      'rule',
      'quote',
    ]);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(
      plainInline((blocks[1] as unknown as { inline: never }).inline),
    ).toBe('one line joined');
    expect(blocks[2]).toEqual({
      type: 'code',
      lang: 'ts',
      text: 'const a = 1;\n',
    });
  });

  it('parses nested and ordered lists', () => {
    const [list] = parseMarkdown(
      ['3. first', '   - a', '   - b', '4. second', 'lazy'].join('\n'),
    );
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 3 });
    const items = (list as { items: { type: string }[][] }).items;
    expect(items).toHaveLength(2);
    expect(items[0]!.map((b) => b.type)).toEqual(['paragraph', 'list']);
    // A two-space nested bullet under a dash.
    const [bullets] = parseMarkdown('- top\n  - nested\n- next');
    const b = (bullets as { items: { type: string }[][] }).items;
    expect(b).toHaveLength(2);
    expect(b[0]!.map((x) => x.type)).toEqual(['paragraph', 'list']);
  });

  it('parses a table', () => {
    const [t] = parseMarkdown('| a | b \\| c |\n|---|:-:|\n| 1 | 2 |');
    expect(t).toMatchObject({ type: 'table' });
    const table = t as unknown as { header: never[][]; rows: never[][][] };
    expect(table.header.map((c) => plainInline(c))).toEqual(['a', 'b | c']);
    expect(table.rows.map((r) => r.map((c) => plainInline(c)))).toEqual([
      ['1', '2'],
    ]);
  });

  it('never recurses without end', () => {
    const deep = '>'.repeat(200) + ' x';
    expect(() => parseMarkdown(deep)).not.toThrow();
    expect(() => parseInline('*'.repeat(5000))).not.toThrow();
  });
});

describe('markdown inline', () => {
  it('parses code, strong, em, del', () => {
    expect(parseInline('a `b*c*` **d** *e* _f_ ~~g~~')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b*c*' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'd' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'e' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'f' }] },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'g' }] },
    ]);
  });

  it('leaves snake_case and lone stars alone', () => {
    expect(plainInline(parseInline('run_shell_command and 2 * 3 * 4'))).toBe(
      'run_shell_command and 2 * 3 * 4',
    );
    expect(parseInline('run_shell_command')).toEqual([
      { type: 'text', text: 'run_shell_command' },
    ]);
  });

  it('keeps links as words and an address, images as alt text', () => {
    expect(
      parseInline(
        'see [the **diff**](https://x.dev/a_(b)) ![shot](https://x/a.png)',
      ),
    ).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        url: 'https://x.dev/a_(b)',
        children: [
          { type: 'text', text: 'the ' },
          { type: 'strong', children: [{ type: 'text', text: 'diff' }] },
        ],
      },
      { type: 'text', text: ' ' },
      { type: 'image', alt: 'shot' },
    ]);
    expect(parseInline('<https://a.b/c>')[0]).toMatchObject({
      type: 'link',
      url: 'https://a.b/c',
    });
    expect(parseInline('\\*not em\\*')).toEqual([
      { type: 'text', text: '*not em*' },
    ]);
  });

  it("shows a link's address unless its words are it", () => {
    expect(linkNote('the diff', 'https://x.dev')).toBe('https://x.dev');
    expect(linkNote('x.dev', 'https://x.dev/')).toBeNull();
    expect(linkNote('a', '')).toBeNull();
  });
});
