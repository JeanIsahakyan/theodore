import { describe, expect, it } from 'vitest';
import {
  extensionOf,
  fileKind,
  fileName,
  filePathOf,
  languageHint,
} from '../src/ui/filePaths';

describe('filePathOf: inline code that names a file', () => {
  it.each([
    ['src/app.tsx', 'src/app.tsx'],
    ['.context/screen.png', '.context/screen.png'],
    ['.context/notes', '.context/notes'],
    ['./docs/plan.md', 'docs/plan.md'],
    ['docs/plan.md:12', 'docs/plan.md'],
    ['docs/plan.md:12:4', 'docs/plan.md'],
    ['README.md', 'README.md'],
    ['package.json', 'package.json'],
    ['Cargo.lock', 'Cargo.lock'],
    ['crates/app/src/usecases/spaces.rs', 'crates/app/src/usecases/spaces.rs'],
    ['mobile/app/(app)/index.tsx', null], // parentheses: too shell-like to trust
    ['  src/a.ts  ', 'src/a.ts'],
    ['a/b/c.PNG', 'a/b/c.PNG'],
  ])('%s ─▶ %s', (code, want) => {
    expect(filePathOf(code)).toBe(want);
  });

  it.each([
    'pnpm test',
    'useState',
    'foo.bar',
    'foo.bar.baz',
    'foo()',
    'x = 1',
    '/etc/passwd',
    '/Users/me/app.tsx',
    'https://example.com/a.png',
    'C:\\x\\y.txt',
    '../secret.txt',
    'a/../b.txt',
    'src/',
    'src',
    '--flag',
    '$HOME/x.txt',
    '`x.md`',
    'a b.txt',
    '',
    'src/a.ts;rm',
  ])('not a path: %s', (code) => {
    expect(filePathOf(code)).toBeNull();
  });

  it('caps the length', () => {
    expect(filePathOf(`${'a/'.repeat(600)}b.txt`)).toBeNull();
  });
});

describe('file kinds', () => {
  it('reads the mime first, then the name', () => {
    expect(fileKind('x', 'image/png')).toBe('image');
    expect(fileKind('x.pdf', 'application/pdf')).toBe('pdf');
    expect(fileKind('x', 'text/plain')).toBe('text');
    expect(fileKind('x', 'application/json')).toBe('text');
    expect(fileKind('shot.PNG', null)).toBe('image');
    expect(fileKind('a/b.rs', '')).toBe('text');
    expect(fileKind('Dockerfile', null)).toBe('text');
    expect(fileKind('a.bin', 'application/octet-stream')).toBe('other');
    expect(fileKind('a.zip', null)).toBe('other');
  });

  it('extension, language hint, name', () => {
    expect(extensionOf('a/b.TSX')).toBe('tsx');
    expect(extensionOf('Makefile')).toBeNull();
    expect(extensionOf('.env')).toBeNull();
    expect(languageHint('src/a.rs')).toBe('rs');
    expect(languageHint('Dockerfile')).toBe('dockerfile');
    expect(languageHint('Makefile')).toBe('makefile');
    expect(languageHint('notes')).toBeNull();
    expect(fileName('.context/screen.png')).toBe('screen.png');
    expect(fileName('a/b/')).toBe('b');
  });
});
