import { describe, expect, it } from 'vitest';
import { identifierAt } from './extract';

describe('identifierAt', () => {
  it('extracts the word the offset falls inside', () => {
    const text = '  const widgetCount = 0;';
    const offset = text.indexOf('widgetCount') + 3; // inside the word
    expect(identifierAt(text, offset)).toBe('widgetCount');
  });

  it('extracts the word when the offset is at its start', () => {
    const text = 'fn widget() {}';
    const offset = text.indexOf('widget');
    expect(identifierAt(text, offset)).toBe('widget');
  });

  it('extracts the word when the offset is at its end', () => {
    const text = 'fn widget() {}';
    const offset = text.indexOf('widget') + 'widget'.length;
    expect(identifierAt(text, offset)).toBe('widget');
  });

  it('includes a leading dollar sign (JS private/observable convention)', () => {
    const text = 'this.$scope.widget';
    const offset = text.indexOf('$scope') + 2;
    expect(identifierAt(text, offset)).toBe('$scope');
  });

  it('returns null when the offset sits on punctuation with no word on either side', () => {
    const text = 'widget() ; other()';
    const offset = text.indexOf(';');
    expect(identifierAt(text, offset)).toBeNull();
  });

  it('resolves to the preceding word when the offset is right after it', () => {
    // The browser's caret can land here on a click right at a token's
    // trailing edge (e.g. just before an opening paren) — still a hit.
    const text = 'widget();';
    const offset = text.indexOf('(');
    expect(identifierAt(text, offset)).toBe('widget');
  });

  it('returns null when the offset sits on whitespace between words', () => {
    const text = 'const a = b;';
    const offset = text.indexOf(' = ') + 1;
    expect(identifierAt(text, offset)).toBeNull();
  });

  it('returns null for a token that starts with a digit', () => {
    const text = 'const x = 123abc;'; // not valid JS, but exercises the regex
    const offset = text.indexOf('123abc') + 1;
    expect(identifierAt(text, offset)).toBeNull();
  });

  it('returns null at the very start or end of an empty/boundary string', () => {
    expect(identifierAt('', 0)).toBeNull();
    expect(identifierAt('   ', 1)).toBeNull();
  });
});
