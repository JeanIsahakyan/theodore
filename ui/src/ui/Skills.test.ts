import { describe, expect, it } from 'vitest';
import { SKILL_ID_RE } from './Skills';

describe('SKILL_ID_RE', () => {
  it('accepts a plain lowercase id', () => {
    expect(SKILL_ID_RE.test('my-skill')).toBe(true);
  });

  it('accepts digits, underscores, dots and hyphens after the first character', () => {
    expect(SKILL_ID_RE.test('a.b_c-9')).toBe(true);
  });

  it('accepts a single character', () => {
    expect(SKILL_ID_RE.test('a')).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(SKILL_ID_RE.test('')).toBe(false);
  });

  it('rejects an id starting with a dot', () => {
    expect(SKILL_ID_RE.test('.hidden')).toBe(false);
  });

  it('rejects spaces and slashes', () => {
    expect(SKILL_ID_RE.test('my skill')).toBe(false);
    expect(SKILL_ID_RE.test('my/skill')).toBe(false);
  });

  it('rejects an id over 100 characters', () => {
    expect(SKILL_ID_RE.test('a'.repeat(101))).toBe(false);
  });

  it('accepts an id at exactly 100 characters', () => {
    expect(SKILL_ID_RE.test('a'.repeat(100))).toBe(true);
  });
});
