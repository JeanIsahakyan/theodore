import { describe, expect, it } from 'vitest';
import { mdBlocks, mdDiff } from './mdDiff';

describe('mdBlocks', () => {
  it('splits on blank lines and keeps fenced code whole', () => {
    expect(
      mdBlocks('# A\n\npara one\nstill one\n\n```js\nx\n\ny\n```\n\ntail'),
    ).toEqual(['# A', 'para one\nstill one', '```js\nx\n\ny\n```', 'tail']);
  });
});

describe('mdDiff', () => {
  it('marks changed blocks, keeps the rest', () => {
    const d = mdDiff(
      '# T\n\nold para\n\nend',
      '# T\n\nnew para\n\nend\n\nmore',
    );
    expect(d.map((b) => b.kind)).toEqual(['same', 'del', 'add', 'same', 'add']);
  });
  it('handles a new file', () => {
    expect(mdDiff('', 'a\n\nb').map((b) => b.kind)).toEqual(['add', 'add']);
  });
});
