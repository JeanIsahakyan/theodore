import { describe, expect, it } from 'vitest';
import { findColors, formatColor, parseColor } from './colors';

const texts = (line: string, hash = false) =>
  findColors(line, hash).map((h) => h.text);
const hexOf = (text: string) => {
  const c = parseColor(text);
  return c && formatColor(c).hex;
};

describe('parseColor', () => {
  it('reads every hex length, case-insensitively', () => {
    expect(hexOf('#f00')).toBe('#ff0000');
    expect(hexOf('#F008')).toBe('#ff000088');
    expect(hexOf('#00ff00')).toBe('#00ff00');
    expect(hexOf('#0000ff80')).toBe('#0000ff80');
    expect(parseColor('#ff00')?.a).toBeCloseTo(0);
    expect(parseColor('#fffff')).toBeNull();
  });

  it('reads rgb()/rgba() in comma and space syntax, with alpha', () => {
    expect(hexOf('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(hexOf('rgba(0, 0, 255, 0.5)')).toBe('#0000ff80');
    expect(hexOf('rgb(0 255 0 / 50%)')).toBe('#00ff0080');
    expect(hexOf('rgb(100% 0% 0%)')).toBe('#ff0000');
    expect(hexOf('rgb(300, -5, 0)')).toBe('#ff0000');
  });

  it('reads hsl()/hsla() with bare and unit hues', () => {
    expect(hexOf('hsl(120, 100%, 50%)')).toBe('#00ff00');
    expect(hexOf('hsl(240deg 100% 50%)')).toBe('#0000ff');
    expect(hexOf('hsl(0.5turn 100% 50%)')).toBe('#00ffff');
    expect(hexOf('hsla(0, 100%, 50%, 0.5)')).toBe('#ff000080');
    expect(hexOf('hsl(-120 100% 50%)')).toBe('#0000ff');
  });

  it('converts oklch() and oklab() to sRGB, flagging out-of-gamut', () => {
    expect(hexOf('oklch(62.8% 0.2577 29.23)')).toBe('#ff0000');
    expect(hexOf('oklab(0.628 0.2249 0.1258)')).toBe('#ff0000');
    expect(hexOf('oklch(1 0 0)')).toBe('#ffffff');
    expect(hexOf('oklch(0 0 0 / 0.5)')).toBe('#00000080');
    expect(parseColor('oklch(0.7 0.1 200)')?.clipped).toBe(false);
    expect(parseColor('oklch(0.9 0.4 145)')?.clipped).toBe(true);
  });

  it('rejects what is not a literal colour', () => {
    expect(parseColor('rgb(r, g, b)')).toBeNull();
    expect(parseColor('rgb(1, 2)')).toBeNull();
    expect(parseColor('rgb(1 2 3 4)')).toBeNull();
    expect(parseColor('rgb(1px, 2, 3)')).toBeNull();
    expect(parseColor('hsl(10%, 50%, 50%)')).toBeNull();
    expect(parseColor('oklch(0.5, 0.1, 20)')).toBeNull();
    expect(parseColor('rgb(1 2 3 / 0.5 / 1)')).toBeNull();
  });
});

describe('formatColor', () => {
  it('lists hex, rgb and hsl, with alpha only when translucent', () => {
    expect(formatColor(parseColor('#ff8000')!)).toEqual({
      hex: '#ff8000',
      rgb: 'rgb(255, 128, 0)',
      hsl: 'hsl(30, 100%, 50%)',
    });
    expect(formatColor(parseColor('rgba(0, 0, 0, 0.25)')!)).toEqual({
      hex: '#00000040',
      rgb: 'rgba(0, 0, 0, 0.25)',
      hsl: 'hsla(0, 0%, 0%, 0.25)',
    });
  });
});

describe('findColors', () => {
  it('finds every literal on a line with its range', () => {
    const line = "a: '#fff', b: rgb(1 2 3), c: oklch(0.5 0.1 20 / 50%)";
    const hits = findColors(line);
    expect(hits.map((h) => h.text)).toEqual([
      '#fff',
      'rgb(1 2 3)',
      'oklch(0.5 0.1 20 / 50%)',
    ]);
    for (const h of hits) expect(line.slice(h.start, h.end)).toBe(h.text);
  });

  it('finds CSS colours after whitespace in curly-brace languages', () => {
    expect(texts('  color: #1a2b3c;')).toEqual(['#1a2b3c']);
    expect(texts('  border: 1px solid hsla(0, 0%, 0%, .1);')).toEqual([
      'hsla(0, 0%, 0%, .1)',
    ]);
  });

  it('skips hex inside words, entities, ids and odd lengths', () => {
    expect(texts('a#fff')).toEqual([]);
    expect(texts('&#123;')).toEqual([]);
    expect(texts('##fff')).toEqual([]);
    expect(texts('#fffff #fffffff')).toEqual([]);
    expect(texts('#abcdefg')).toEqual([]);
    expect(texts('#define FOO')).toEqual([]);
  });

  it('reads short all-digit hex as an issue number unless digits repeat', () => {
    expect(texts('// fixes #123 and #4567')).toEqual([]);
    expect(texts("c = '#333'; d = '#0000'")).toEqual(['#333', '#0000']);
    expect(texts("e = '#123456'")).toEqual(['#123456']);
  });

  it('treats a # after whitespace as a comment in hash-comment languages', () => {
    expect(texts('#add the thing', true)).toEqual([]);
    expect(texts('x = 1  #bad', true)).toEqual([]);
    expect(texts('color = "#bad"', true)).toEqual(['#bad']);
    expect(texts('COLOR=#fff', true)).toEqual(['#fff']);
  });

  it('skips function calls that are not literal colours', () => {
    expect(texts('rgb(r, g, b)')).toEqual([]);
    expect(texts('rgb(var(--x))')).toEqual([]);
    expect(texts('torgb(1, 2, 3)')).toEqual([]);
    expect(texts('const x = f(a);')).toEqual([]);
  });
});
