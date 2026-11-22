import { describe, expect, it } from 'vitest';
import {
  COPY,
  KIND_TITLE,
  SELECT_TEXT,
  SELECT_TEXT_MAX,
  messageMenuItems,
  sheetText,
  textSegments,
  type MessageKind,
} from '../src/ui/messageMenu';

describe('the long-press menu', () => {
  it('offers Copy and Select text on every kind of message', () => {
    for (const kind of ['reply', 'mine', 'step'] as MessageKind[]) {
      const items = messageMenuItems(kind, 'some words');
      expect(items.map((a) => a.id)).toEqual([COPY.id, SELECT_TEXT.id]);
      expect(items.map((a) => a.label)).toEqual(['Copy', 'Select text']);
      expect(KIND_TITLE[kind].length).toBeGreaterThan(0);
    }
    expect(KIND_TITLE.mine).toBe('Your message');
  });

  it('adds a row’s own actions after them, never twice', () => {
    const items = messageMenuItems('reply', 'x', [
      { id: 'copy', label: 'Copy again' },
      { id: 'cancel', label: 'Cancel' },
      { id: 'share', label: 'Share', destructive: false },
      { id: 'delete', label: 'Delete', destructive: true },
    ]);
    expect(items.map((a) => a.id)).toEqual([
      'copy',
      'select',
      'share',
      'delete',
    ]);
    expect(items[0]!.label).toBe('Copy');
    expect(items[3]!.destructive).toBe(true);
  });

  it('nothing to copy: no menu', () => {
    expect(messageMenuItems('reply', '')).toEqual([]);
    expect(messageMenuItems('step', '  \n')).toEqual([]);
  });
});

describe('the sheet’s text', () => {
  it('splits fenced code out, the fences gone, the code kept as written', () => {
    const md = 'Run this:\n\n```sh\ncargo test\n  --all\n```\n\nthen `x`.';
    expect(textSegments(md)).toEqual([
      { kind: 'text', text: 'Run this:\n\n' },
      { kind: 'code', text: 'cargo test\n  --all' },
      { kind: 'text', text: '\n\nthen `x`.' },
    ]);
    expect(textSegments('~~~\na\n~~~')).toEqual([{ kind: 'code', text: 'a' }]);
    expect(textSegments('plain words')).toEqual([
      { kind: 'text', text: 'plain words' },
    ]);
    // An unclosed fence is text.
    expect(textSegments('```\nnot closed')).toEqual([
      { kind: 'text', text: '```\nnot closed' },
    ]);
    expect(textSegments('')).toEqual([{ kind: 'text', text: '' }]);
  });

  it('cuts very long text with a note', () => {
    expect(sheetText('hi')).toEqual({ text: 'hi', cut: false });
    const long = sheetText('a'.repeat(SELECT_TEXT_MAX + 5));
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(SELECT_TEXT_MAX);
  });
});
