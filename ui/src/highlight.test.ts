import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fitsWholeFile,
  grammarReady,
  hunkLineTokens,
  langOf,
  loadShiki,
  splitHunkSides,
  tokenizeFile,
  tokenizeLines,
  tokens,
  type Lang,
  WHOLE_FILE_MAX_CHARS,
  WHOLE_FILE_MAX_LINE,
} from './highlight';

describe('langOf', () => {
  it('maps common extensions to their language', () => {
    expect(langOf('a.ts')).toBe('ts');
    expect(langOf('a.tsx')).toBe('tsx');
    expect(langOf('a.js')).toBe('tsx');
    expect(langOf('a.jsx')).toBe('tsx');
    expect(langOf('a.sql')).toBe('sql');
    expect(langOf('a.prisma')).toBe('prisma');
    expect(langOf('a.yaml')).toBe('yaml');
    expect(langOf('a.css')).toBe('css');
    expect(langOf('a.rs')).toBe('rust');
    expect(langOf('a.py')).toBe('python');
    expect(langOf('a.go')).toBe('go');
    expect(langOf('a.swift')).toBe('swift');
    expect(langOf('a.kt')).toBe('kotlin');
    expect(langOf('a.java')).toBe('java');
    expect(langOf('a.php')).toBe('php');
    expect(langOf('a.rb')).toBe('ruby');
    expect(langOf('a.json')).toBe('json');
    expect(langOf('a.jsonc')).toBe('json');
    expect(langOf('a.md')).toBe('markdown');
    expect(langOf('a.sh')).toBe('shell');
    expect(langOf('a.bash')).toBe('shell');
    expect(langOf('a.zsh')).toBe('shell');
    expect(langOf('a.toml')).toBe('toml');
    expect(langOf('a.html')).toBe('html');
    expect(langOf('a.scss')).toBe('scss');
    expect(langOf('a.graphql')).toBe('graphql');
    expect(langOf('a.xml')).toBe('xml');
    expect(langOf('a.lua')).toBe('lua');
    expect(langOf('a.cs')).toBe('csharp');
    expect(langOf('a.dart')).toBe('dart');
    expect(langOf('a.vue')).toBe('vue');
    expect(langOf('a.svelte')).toBe('svelte');
  });

  it('groups C/C++ headers and sources under cpp, apart from plain C and Objective-C', () => {
    expect(langOf('a.h')).toBe('cpp');
    expect(langOf('a.hpp')).toBe('cpp');
    expect(langOf('a.cc')).toBe('cpp');
    expect(langOf('a.cpp')).toBe('cpp');
    expect(langOf('a.mm')).toBe('cpp');
    expect(langOf('a.c')).toBe('c');
    expect(langOf('a.m')).toBe('objc');
  });

  it('recognises a Dockerfile by name, case-insensitively, with or without a suffix', () => {
    expect(langOf('Dockerfile')).toBe('dockerfile');
    expect(langOf('dockerfile')).toBe('dockerfile');
    expect(langOf('Dockerfile.dev')).toBe('dockerfile');
    expect(langOf('services/api/Dockerfile')).toBe('dockerfile');
  });

  it('treats .tl as plain, explicitly, not as an unknown-extension guess', () => {
    expect(langOf('a.tl')).toBe('plain');
  });

  it('falls back to plain for unknown extensions', () => {
    expect(langOf('a.zzz')).toBe('plain');
    expect(langOf('noext')).toBe('plain');
  });
});

type FakeLine = { kind: 'ctx' | 'add' | 'del'; text: string };
const l = (kind: FakeLine['kind'], text: string): FakeLine => ({ kind, text });

describe('splitHunkSides', () => {
  it('puts context on both sides; deletions old-only, additions new-only', () => {
    const lines = [
      l('ctx', 'A'),
      l('del', 'B1'),
      l('del', 'B2'),
      l('add', 'C1'),
      l('ctx', 'D'),
      l('del', 'E'),
      l('add', 'F1'),
      l('add', 'F2'),
    ];
    const { oldIdx, newIdx, oldText, newText } = splitHunkSides(lines);
    expect(oldIdx).toEqual([0, 1, 2, 4, 5]);
    expect(newIdx).toEqual([0, 3, 4, 6, 7]);
    expect(oldText).toBe('A\nB1\nB2\nD\nE');
    expect(newText).toBe('A\nC1\nD\nF1\nF2');
  });

  it('handles a hunk that is pure context (no -/+ lines) the same on both sides', () => {
    const lines = [l('ctx', 'A'), l('ctx', 'B')];
    const { oldIdx, newIdx, oldText, newText } = splitHunkSides(lines);
    expect(oldIdx).toEqual([0, 1]);
    expect(newIdx).toEqual([0, 1]);
    expect(oldText).toBe(newText);
  });
});

describe('hunkLineTokens mapping (no grammar loaded — pure index alignment)', () => {
  it('returns one token array per line, in the original order', () => {
    const lines = [l('ctx', 'a'), l('del', 'b'), l('add', 'c'), l('ctx', 'd')];
    const out = hunkLineTokens(lines, 'plain');
    expect(out).toHaveLength(4);
    expect(out.map((toks) => toks.map((t) => t.s).join(''))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('multi-line grammar state (real Shiki)', () => {
  beforeAll(async () => {
    await loadShiki();
  });

  it('keeps a JSDoc comment colored as a comment across lines, inside a diff hunk', () => {
    const lines = [
      l('ctx', '/**'),
      l('ctx', ' * This spans'),
      l('del', ' * multiple lines of text, in OLD, with declare word ONE.'),
      l('add', ' * multiple lines of text, in NEW, with declare word ONE.'),
      l('ctx', ' */'),
      l('ctx', 'const x = 1;'),
    ];
    const toks = hunkLineTokens(lines, 'ts');
    const commentColor = toks[1]![0]!.c;
    expect(commentColor).toBeTruthy();
    // The deleted and added comment lines are each tokenized as part of
    // their own side's whole block — they must stay in the comment's scope,
    // not get parsed as bare top-level code with "of"/"in"/"declare" read
    // as keywords.
    for (const t of toks[2]!) expect(t.c).toBe(commentColor);
    for (const t of toks[3]!) expect(t.c).toBe(commentColor);
    // Sanity: "const" after the comment really is a keyword — proves real
    // Shiki ran here, not the instant regex fallback.
    const constTok = toks[5]!.find((t) => t.s === 'const');
    expect(constTok?.c).toBeTruthy();
    expect(constTok?.c).not.toBe(commentColor);
  });

  it('contrast: tokenizing that comment line alone — the old per-line bug — does colour its words as keywords', () => {
    const alone = tokens(
      ' * multiple lines of text, in OLD, with declare word ONE.',
      'ts',
    );
    const declareTok = alone.find((t) => t.s === 'declare');
    const ofTok = alone.find((t) => t.s === 'of');
    expect(declareTok?.c).toBe('var(--shiki-token-keyword)');
    expect(ofTok?.c).toBe('var(--shiki-token-keyword)');
  });

  it('tokenizes a whole block in one call, one array per input line', () => {
    const src = ['/**', ' * a', ' * b', ' */', 'const x = 1;'].join('\n');
    expect(tokenizeLines(src, 'ts')).toHaveLength(5);
  });
});

describe('a hunk that starts inside a string (real Shiki, #133)', () => {
  const STRING = 'var(--shiki-token-string-expression)';
  const KEYWORD = 'var(--shiki-token-keyword)';
  /** Line 3 closes the string line 1 opened. */
  const FILE = ['const a = `', '  first', '  second`;', 'const b = 1;'];
  const numbered = (kind: FakeLine['kind'], text: string, no: number) => ({
    ...l(kind, text),
    old_no: kind === 'add' ? null : no,
    new_no: kind === 'del' ? null : no,
  });
  const inside = [numbered('ctx', FILE[2]!, 3), numbered('ctx', FILE[3]!, 4)];
  const constOf = (toks: { s: string; c?: string }[][], line: number) =>
    toks[line]!.find((t) => t.s === 'const')?.c;
  const whole = async (text: string, lang: Lang = 'ts') => {
    const toks = await tokenizeFile(text, lang);
    expect(toks).not.toBeNull();
    return toks!;
  };

  beforeAll(async () => {
    await loadShiki();
  });

  afterEach(() => vi.restoreAllMocks());

  it('contrast: tokenized alone, the closing quote opens a string that runs on', () => {
    const toks = hunkLineTokens(inside, 'ts');
    expect(toks[1]).toEqual([{ s: 'const b = 1;', c: STRING, i: false }]);
  });

  it('takes each line from its whole file, so the code after the string is code', async () => {
    const head = await whole(FILE.join('\n'));
    const toks = hunkLineTokens(inside, 'ts', { head });
    expect(constOf(toks, 1)).toBe(KEYWORD);
    expect(toks[0]![0]!.c).toBe(STRING);
  });

  it('takes a deleted line from the base file, not the head', async () => {
    const baseFile = ['const a = `', '  gone', '`;', 'const old = 1;'];
    const base = await whole(baseFile.join('\n'));
    const head = await whole(FILE.join('\n'));
    const toks = hunkLineTokens(
      [numbered('del', baseFile[3]!, 4), numbered('ctx', FILE[3]!, 4)],
      'ts',
      { head, base },
    );
    expect(constOf(toks, 0)).toBe(KEYWORD);
    expect(constOf(toks, 1)).toBe(KEYWORD);
  });

  it('keeps a CRLF line, whose text still has its \\r', async () => {
    const head = await whole(FILE.join('\r\n'));
    const toks = hunkLineTokens(
      inside.map((x) => ({ ...x, text: `${x.text}\r` })),
      'ts',
      { head },
    );
    expect(constOf(toks, 1)).toBe(KEYWORD);
  });

  it('keeps a line coloured the same either way, so its row needs no re-render', async () => {
    const lines = [numbered('ctx', 'const b = 1;', 4)];
    const own = hunkLineTokens(lines, 'ts');
    const head = await whole(FILE.join('\n'));
    expect(hunkLineTokens(lines, 'ts', { head })[0]).toBe(own[0]);
  });

  it('falls back to the hunk where the file disagrees with the line', async () => {
    const head = await whole(FILE.join('\n'));
    const toks = hunkLineTokens([numbered('ctx', 'let z = 2;', 4)], 'ts', {
      head,
    });
    expect(toks[0]!.map((t) => t.s).join('')).toBe('let z = 2;');
  });

  it('carries grammar state across its slices, same as one big call', async () => {
    // Long enough that the string opened on line 2 crosses a slice boundary.
    const src = [
      'const x = 1;',
      'const a = `',
      ...Array.from({ length: 450 }, (_, i) => `  text ${i}`),
      '`;',
      'const b = 2;',
    ].join('\n');
    const toks = await whole(src);
    expect(toks).toEqual(tokenizeLines(src, 'ts'));
    expect(constOf(toks, 453)).toBe(KEYWORD);
  });

  it('keeps grammar state across slices of one line, blank ones included', async () => {
    // Every line reads as slow, so each ends its slice.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 10));
    const src = ['const a = `', '', '  text', '', '`;', 'const b = 2;'].join(
      '\n',
    );
    const toks = await whole(src);
    expect(toks).toEqual(tokenizeLines(src, 'ts'));
    expect(constOf(toks, 5)).toBe(KEYWORD);
  });

  it('gives up on a file that takes too long', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 1000));
    expect(await tokenizeFile('const a = 1;\n'.repeat(50), 'ts')).toBeNull();
  });

  it('checks both limits before a file is tokenized whole', () => {
    const line = (n: number) => 'x'.repeat(n);
    expect(fitsWholeFile('')).toBe(true);
    expect(fitsWholeFile(`a\n${line(WHOLE_FILE_MAX_LINE)}\nb`)).toBe(true);
    expect(fitsWholeFile(`a\n${line(WHOLE_FILE_MAX_LINE + 1)}\nb`)).toBe(false);
    expect(fitsWholeFile(`a\n${line(WHOLE_FILE_MAX_LINE + 1)}`)).toBe(false);
    // `\r\n` ends a line as `\n` does: the `\r` is not part of it.
    expect(fitsWholeFile(`${line(WHOLE_FILE_MAX_LINE)}\r\nb`)).toBe(true);
    expect(fitsWholeFile('a\n'.repeat(WHOLE_FILE_MAX_CHARS / 2))).toBe(true);
    expect(fitsWholeFile(`${'a\n'.repeat(WHOLE_FILE_MAX_CHARS / 2)}a`)).toBe(
      false,
    );
  });

  it('leaves a minified file to the hunks, and an oversized one', async () => {
    const minified = `const a = 1;\n${'x'.repeat(3000)}\nconst b = 2;`;
    expect(await tokenizeFile(minified, 'ts')).toBeNull();
    const huge = 'const a = 1;\n'.repeat(50_000);
    expect(await tokenizeFile(huge, 'ts')).toBeNull();
  });

  it('takes files one at a time, in order', async () => {
    const done: string[] = [];
    await Promise.all(
      [
        ['long', 'const a = 1;\n'.repeat(500)],
        ['short', 'const b = 2;'],
      ].map(([name, text]) =>
        tokenizeFile(text!, 'ts').then(() => done.push(name!)),
      ),
    );
    expect(done).toEqual(['long', 'short']);
  });

  it('follows JSX to the end of the file, a .tsx read with its own grammar', async () => {
    // The plain TypeScript grammar stays lost after a tag like this one.
    const src = [
      'const a = <T,>(x: T) => <div className="a">{x}</div>;',
      'export const B = () => <p>{"it\'s"} text</p>;',
      'const c = 1;',
    ].join('\n');
    expect(constOf(await whole(src, langOf('a.tsx')), 2)).toBe(KEYWORD);
  });

  it('keeps one entry per line, a trailing newline included', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`);
    const text = `${lines.join('\n')}\n`;
    expect(await whole(text)).toHaveLength(text.split('\n').length);
  });

  it('knows which grammars are loaded', () => {
    expect(grammarReady('ts')).toBe(true);
    expect(grammarReady('plain')).toBe(false);
  });
});
