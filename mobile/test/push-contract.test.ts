import { describe, expect, it } from 'vitest';
import {
  MAX_BODY,
  askPresentation,
  classifyResponse,
  parsePushData,
  responseKey,
  showInForeground,
  spacePath,
} from '../src/push/contract';

const ask = {
  kind: 'ask',
  ask_id: 'a1',
  space: 'sp1',
  host_device: 'dev-mac',
  options: ['Yes', 'No'],
};

describe('parsePushData', () => {
  it('accepts an ask and a finished push', () => {
    expect(parsePushData(ask)?.ask_id).toBe('a1');
    const fin = parsePushData({
      kind: 'finished',
      space: 's',
      host_device: 'h',
    });
    expect(fin).toMatchObject({ kind: 'finished', options: [] });
  });

  it('rejects foreign or incomplete data', () => {
    expect(parsePushData(null)).toBeNull();
    expect(
      parsePushData({ kind: 'other', space: 's', host_device: 'h' }),
    ).toBeNull();
    expect(parsePushData({ ...ask, ask_id: undefined })).toBeNull();
    expect(parsePushData({ ...ask, host_device: '' })).toBeNull();
  });

  it('keeps at most four string options', () => {
    const d = parsePushData({ ...ask, options: ['a', 1, 'b', 'c', 'd', 'e'] });
    expect(d?.options).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('classifyResponse', () => {
  it('an option button answers with that option', () => {
    expect(classifyResponse({ actionIdentifier: 'opt1', data: ask })).toEqual({
      type: 'answer',
      space: 'sp1',
      askId: 'a1',
      hostDevice: 'dev-mac',
      answers: [['No']],
    });
  });

  it('a reply answers with the trimmed text', () => {
    const r = classifyResponse({
      actionIdentifier: 'reply',
      userText: '  use postgres  ',
      data: ask,
    });
    expect(r).toMatchObject({ type: 'answer', answers: [['use postgres']] });
  });

  it('degrades to open when it cannot answer safely', () => {
    const open = { type: 'open', space: 'sp1' };
    expect(classifyResponse({ actionIdentifier: 'opt3', data: ask })).toEqual(
      open,
    );
    expect(
      classifyResponse({
        actionIdentifier: 'reply',
        userText: '  ',
        data: ask,
      }),
    ).toEqual(open);
    expect(
      classifyResponse({
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        data: ask,
      }),
    ).toEqual(open);
    expect(classifyResponse({ actionIdentifier: 'open', data: ask })).toEqual(
      open,
    );
  });

  it('a finished push only opens, even for an answer action', () => {
    const data = { kind: 'finished', space: 'sp1', host_device: 'h' };
    expect(
      classifyResponse({ actionIdentifier: 'reply', userText: 'x', data }),
    ).toEqual({
      type: 'open',
      space: 'sp1',
    });
  });

  it('ignores data that is not ours', () => {
    expect(classifyResponse({ actionIdentifier: 'opt0', data: {} })).toEqual({
      type: 'ignore',
    });
  });
});

describe('askPresentation', () => {
  it('two or three options become numbered buttons', () => {
    const two = askPresentation('Which database?', ['SQLite', 'Postgres']);
    expect(two.categoryId).toBe('ask_opt2');
    expect(two.body).toBe('Which database?\n1) SQLite  2) Postgres');
    expect(askPresentation('Q?', ['a', 'b', 'c']).categoryId).toBe('ask_opt3');
  });

  it('no options, one option, or four fall back to reply + open', () => {
    expect(askPresentation('Q?', []).categoryId).toBe('ask_text');
    expect(askPresentation('Q?', ['a']).categoryId).toBe('ask_text');
    expect(askPresentation('Q?', ['a', 'b', 'c', 'd']).categoryId).toBe(
      'ask_text',
    );
  });

  it('never exceeds the body limit and shortens long questions', () => {
    const q = 'x'.repeat(500);
    const withOpts = askPresentation(q, ['one', 'two', 'three']);
    expect(withOpts.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(withOpts.body.endsWith('3) three')).toBe(true);
    const text = askPresentation(q, []);
    expect(text.body.length).toBe(MAX_BODY);
    expect(text.body.endsWith('…')).toBe(true);
  });

  it('long options are cut to stay as buttons', () => {
    const long = 'y'.repeat(100);
    const r = askPresentation('Pick one', [long, long, long]);
    expect(r.categoryId).toBe('ask_opt3');
    expect(r.body.length).toBeLessThanOrEqual(MAX_BODY);
  });
});

describe('small helpers', () => {
  it('spacePath encodes the id', () => {
    expect(spacePath('a b/c')).toBe('/space/a%20b%2Fc');
  });

  it('responseKey separates notification and action', () => {
    expect(responseKey('n1', 'opt0')).not.toBe(responseKey('n1', 'opt1'));
  });

  it('suppresses the banner only for the space on screen', () => {
    expect(showInForeground(ask, 'sp1')).toBe(false);
    expect(showInForeground(ask, 'other')).toBe(true);
    expect(showInForeground(ask, null)).toBe(true);
    expect(showInForeground({}, 'sp1')).toBe(true);
  });
});
