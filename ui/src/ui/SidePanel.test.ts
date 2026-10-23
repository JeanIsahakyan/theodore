import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../gen/contract';
import { hiddenFindingsNote, priorQuestion } from './SidePanel';

function msg(id: string, partial: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    pr: 'github:acme/widgets#1',
    author: { kind: 'me' },
    text: '',
    refs: [],
    at: 0,
    failed: null,
    ...partial,
  };
}

describe('priorQuestion', () => {
  it('finds the user message immediately before an agent reply', () => {
    const messages = [
      msg('m1', { author: { kind: 'me' }, text: 'why?' }),
      msg('m2', {
        author: { kind: 'agent', agent: 'claude' },
        text: 'because',
      }),
    ];
    expect(priorQuestion(messages, messages[1]!)).toBe('why?');
  });

  it('skips past other agent replies to find the nearest question', () => {
    const messages = [
      msg('m1', { author: { kind: 'me' }, text: 'why?' }),
      msg('m2', {
        author: { kind: 'agent', agent: 'claude' },
        text: 'because',
      }),
      msg('m3', { author: { kind: 'agent', agent: 'codex' }, failed: 'boom' }),
    ];
    expect(priorQuestion(messages, messages[2]!)).toBe('why?');
  });

  it('returns an empty string when there is no prior question', () => {
    const messages = [
      msg('m1', { author: { kind: 'agent', agent: 'claude' }, failed: 'boom' }),
    ];
    expect(priorQuestion(messages, messages[0]!)).toBe('');
  });
});

describe('hiddenFindingsNote', () => {
  it('names how many findings the repo config hid', () => {
    expect(hiddenFindingsNote({ hidden_findings: 1 })).toBe(
      '1 finding hidden by config',
    );
    expect(hiddenFindingsNote({ hidden_findings: 3 })).toBe(
      '3 findings hidden by config',
    );
  });

  it('says nothing when none were hidden', () => {
    expect(hiddenFindingsNote({ hidden_findings: 0 })).toBeNull();
    expect(hiddenFindingsNote({})).toBeNull();
  });
});
