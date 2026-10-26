import { beforeAll, describe, expect, it } from 'vitest';
import {
  hunkLineTokens,
  langOf,
  loadShiki,
  splitHunkSides,
  tokenizeLines,
  tokens,
} from './highlight';

describe('langOf', () => {
  it('maps common extensions to their language', () => {
    expect(langOf('a.ts')).toBe('ts');
    expect(langOf('a.tsx')).toBe('ts');
    expect(langOf('a.js')).toBe('ts');
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
