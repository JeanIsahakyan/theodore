import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../gen/contract';
import { budgetStatus, priorQuestion } from './SidePanel';

describe('budgetStatus', () => {
  it('has no bar when there is no budget set', () => {
    expect(budgetStatus(3, null)).toEqual({
      pct: 0,
      tone: 'default',
      over: false,
    });
  });

  it('has no bar when the budget is zero or negative', () => {
    expect(budgetStatus(0, 0)).toEqual({
      pct: 0,
      tone: 'default',
      over: false,
    });
    expect(budgetStatus(1, -5)).toEqual({
      pct: 0,
      tone: 'default',
      over: false,
    });
  });

  it('is the default tone comfortably under the limit', () => {
    expect(budgetStatus(1, 10)).toEqual({
      pct: 10,
      tone: 'default',
      over: false,
    });
  });

  it('turns warning past 75%', () => {
    expect(budgetStatus(7.6, 10)).toEqual({
      pct: 76,
      tone: 'warning',
      over: false,
    });
  });

  it('is not yet warning exactly at 75%', () => {
    expect(budgetStatus(7.5, 10).tone).toBe('default');
  });

  it('turns danger and reports over at the limit', () => {
    expect(budgetStatus(10, 10)).toEqual({
      pct: 100,
      tone: 'danger',
      over: true,
    });
  });

  it('clamps the bar at 100% past the limit', () => {
    expect(budgetStatus(25, 10)).toEqual({
      pct: 100,
      tone: 'danger',
      over: true,
    });
  });
});

function msg(id: string, partial: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    pr: 'github:acme/widgets#1',
    author: { kind: 'me' },
    text: '',
    refs: [],
    usage: null,
    at: 0,
    failed: null,
    ...partial,
  };
}

describe('priorQuestion', () => {
  it('finds the user message immediately before an agent reply', () => {
    const messages = [
      msg('m1', { author: { kind: 'me' }, text: 'why?' }),
      msg('m2', { author: { kind: 'agent', agent: 'claude' }, text: 'because' }),
    ];
    expect(priorQuestion(messages, messages[1]!)).toBe('why?');
  });

  it('skips past other agent replies to find the nearest question', () => {
    const messages = [
      msg('m1', { author: { kind: 'me' }, text: 'why?' }),
      msg('m2', { author: { kind: 'agent', agent: 'claude' }, text: 'because' }),
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
