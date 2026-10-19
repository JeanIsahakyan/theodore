import { describe, expect, it } from 'vitest';
import {
  filterMentions,
  insertMention,
  mentionQueryAt,
  moveMentionIndex,
} from './mention';

describe('mentionQueryAt', () => {
  it('finds a query right after an @ at the start of the text', () => {
    expect(mentionQueryAt('@bo', 3)).toEqual({ start: 0, end: 3, query: 'bo' });
  });

  it('finds a query after an @ following whitespace', () => {
    expect(mentionQueryAt('hi @bob', 7)).toEqual({
      start: 3,
      end: 7,
      query: 'bob',
    });
  });

  it('ignores text after the caret', () => {
    expect(mentionQueryAt('@bo b', 3)).toEqual({
      start: 0,
      end: 3,
      query: 'bo',
    });
  });

  it('is an empty query right after a bare @', () => {
    expect(mentionQueryAt('hi @', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('is null once a space finishes the mention', () => {
    expect(mentionQueryAt('hi @bob ', 8)).toBeNull();
  });

  it('is null for an email-like @ with no leading whitespace', () => {
    expect(mentionQueryAt('a@b', 3)).toBeNull();
  });

  it('is null with no @ at all', () => {
    expect(mentionQueryAt('just text', 9)).toBeNull();
  });
});

describe('filterMentions', () => {
  const people = [
    { login: 'alice' },
    { login: 'alicia' },
    { login: 'bob' },
    { login: 'ALAN' },
  ];

  it('matches by case-insensitive login prefix', () => {
    expect(filterMentions(people, 'al').map((p) => p.login)).toEqual([
      'alice',
      'alicia',
      'ALAN',
    ]);
  });

  it('returns everyone for an empty query', () => {
    expect(filterMentions(people, '')).toHaveLength(4);
  });

  it('excludes the viewer', () => {
    expect(filterMentions(people, 'al', 'alice').map((p) => p.login)).toEqual([
      'alicia',
      'ALAN',
    ]);
  });

  it('caps at the given limit', () => {
    expect(filterMentions(people, '', null, 2)).toHaveLength(2);
  });
});

describe('moveMentionIndex', () => {
  it('clamps at the last option going down', () => {
    expect(moveMentionIndex(3, 2, 1)).toBe(2);
  });

  it('clamps at the first option going up', () => {
    expect(moveMentionIndex(3, 0, -1)).toBe(0);
  });

  it('steps normally within range', () => {
    expect(moveMentionIndex(3, 0, 1)).toBe(1);
    expect(moveMentionIndex(3, 1, -1)).toBe(0);
  });

  it('is 0 for an empty option list', () => {
    expect(moveMentionIndex(0, 0, 1)).toBe(0);
  });
});

describe('insertMention', () => {
  it('replaces the query with @login and a trailing space', () => {
    const q = mentionQueryAt('hi @bo', 6)!;
    expect(insertMention('hi @bo', q, 'bob')).toEqual({
      text: 'hi @bob ',
      caret: 8,
    });
  });

  it('keeps text after the caret intact', () => {
    const q = mentionQueryAt('@bo, can you look?', 3)!;
    expect(insertMention('@bo, can you look?', q, 'bob')).toEqual({
      text: '@bob , can you look?',
      caret: 5,
    });
  });
});
