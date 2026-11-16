import { describe, expect, it } from 'vitest';
import { mockDevices, mockQuestion, mockSpaces } from '../src/dev/mock';
import type { SpaceLine, SpaceView } from '../src/fleet/types';
import {
  canSend,
  canStop,
  capMode,
  emptyDraft,
  isAnswered,
  mergeLines,
  modesUpTo,
  pickOption,
  plainExcerpt,
  questionFor,
  questionFrom,
  sortDevices,
  sortSpaces,
  spaceTitle,
  startableDevices,
  switchErrorText,
  toWireAnswers,
  typeOther,
} from '../src/ui/logic';

const space = (over: Partial<SpaceView>): SpaceView => ({
  ...mockSpaces[0]!,
  ...over,
});

describe('spaces list order', () => {
  it('puts waiting first, then running, then the rest, stably', () => {
    const sorted = sortSpaces([
      space({ space: 'a', status: 'idle' }),
      space({ space: 'b', status: 'running' }),
      space({ space: 'c', status: 'failed' }),
      space({ space: 'd', status: 'waiting' }),
      space({ space: 'e', status: 'running' }),
      space({ space: 'f', status: 'idle', question: mockQuestion }),
    ]);
    expect(sorted.map((s) => s.space)).toEqual(['d', 'f', 'b', 'e', 'a', 'c']);
  });

  it('sorts the fixtures: waiting, running, idle, failed', () => {
    expect(sortSpaces(mockSpaces).map((s) => s.status)).toEqual([
      'waiting',
      'running',
      'idle',
      'failed',
    ]);
  });

  it('does not mutate its input', () => {
    const before = mockSpaces.map((s) => s.space);
    sortSpaces(mockSpaces);
    expect(mockSpaces.map((s) => s.space)).toEqual(before);
  });

  it('titles a space by name, else branch', () => {
    expect(spaceTitle({ name: 'x', branch: 'b' })).toBe('x');
    expect(spaceTitle({ name: '', branch: 'b' })).toBe('b');
  });
});

describe('excerpt', () => {
  it('flattens markdown, links and code fences to plain text', () => {
    expect(
      plainExcerpt(
        '## Done\n\nMoved the **card**, see [diff](https://x.y).\n```ts\nlet a\n```',
      ),
    ).toBe('Done Moved the card, see diff. let a');
  });
  it('is empty for null', () => {
    expect(plainExcerpt(null)).toBe('');
  });
});

describe('device filtering', () => {
  it('offers only online, trusted computers that accept remote with projects', () => {
    expect(startableDevices(mockDevices).map((d) => d.deviceId)).toEqual([
      'dev-mac',
      'dev-box',
    ]);
  });

  it('drops phones and browsers, offline, untrusted, no projects', () => {
    const base = mockDevices[1]!;
    const devices = [
      { ...base, deviceId: 'phone', kind: 'mobile' },
      { ...base, deviceId: 'web', kind: 'web' },
      { ...base, deviceId: 'off', online: false },
      { ...base, deviceId: 'untrusted', trusted: false },
      { ...base, deviceId: 'closed', acceptsRemote: false },
      { ...base, deviceId: 'empty', projects: [] },
      { ...base, deviceId: 'ok' },
    ];
    expect(startableDevices(devices).map((d) => d.deviceId)).toEqual(['ok']);
  });

  it('lists this device first, then online, then by name', () => {
    expect(sortDevices(mockDevices).map((d) => d.deviceId)).toEqual([
      'dev-me',
      'dev-box',
      'dev-mac',
      'dev-new',
      'dev-work',
    ]);
  });
});

describe('modes', () => {
  it('allows every mode up to the cap', () => {
    expect(modesUpTo('ask')).toEqual(['ask']);
    expect(modesUpTo('edit')).toEqual(['ask', 'plan', 'edit']);
    expect(modesUpTo('run')).toEqual(['ask', 'plan', 'edit', 'run']);
  });
  it('caps a mode under the device max', () => {
    expect(capMode('run', 'edit')).toBe('edit');
    expect(capMode('ask', 'edit')).toBe('ask');
    expect(capMode('edit', 'edit')).toBe('edit');
  });
});

describe('composer and stop', () => {
  it('sends only when idle or waiting; stops only while running', () => {
    expect(
      (
        ['starting', 'running', 'idle', 'waiting', 'stopped', 'failed'] as const
      ).filter(canSend),
    ).toEqual(['idle', 'waiting']);
    expect(canStop('running')).toBe(true);
    expect(canStop('idle')).toBe(false);
  });
});

describe('lines', () => {
  const l = (seq: number, text = String(seq)): SpaceLine => ({
    seq,
    kind: 'reply',
    text,
  });
  it('merges by seq, store wins, ordered', () => {
    const merged = mergeLines([l(3, 'new'), l(4)], [l(1), l(3, 'old'), l(2)]);
    expect(merged.map((x) => `${x.seq}:${x.text}`)).toEqual([
      '1:1',
      '2:2',
      '3:new',
      '4:4',
    ]);
  });
});

describe('question for a space', () => {
  it('prefers its own, else a routed one by space id', () => {
    const own = space({ question: mockQuestion });
    expect(questionFor(own, [])).toBe(mockQuestion);
    const bare = space({ space: 'sp-waiting', question: null });
    expect(questionFor(bare, [mockQuestion])).toBe(mockQuestion);
    expect(
      questionFor(space({ space: 'other', question: null }), [mockQuestion]),
    ).toBeNull();
  });
});

describe('answers', () => {
  const single = mockQuestion.questions[0]!;
  const multi = mockQuestion.questions[1]!;

  it('a single-answer question keeps one option; Other replaces it', () => {
    let d = pickOption(single, emptyDraft(), 'vitest');
    d = pickOption(single, d, 'jest');
    expect(d).toEqual({ selected: ['jest'], other: '' });
    d = typeOther(single, d, 'mocha');
    expect(d).toEqual({ selected: [], other: 'mocha' });
    d = pickOption(single, d, 'vitest');
    expect(d).toEqual({ selected: ['vitest'], other: '' });
  });

  it('a multi question toggles options and keeps Other alongside', () => {
    let d = pickOption(multi, emptyDraft(), 'auth');
    d = pickOption(multi, d, 'tests');
    d = typeOther(multi, d, ' docs ');
    expect(d.selected).toEqual(['auth', 'tests']);
    d = pickOption(multi, d, 'auth');
    expect(d.selected).toEqual(['tests']);
  });

  it('needs every question answered', () => {
    expect(isAnswered([emptyDraft(), emptyDraft()])).toBe(false);
    expect(
      isAnswered([
        { selected: ['a'], other: '' },
        { selected: [], other: '  ' },
      ]),
    ).toBe(false);
    expect(
      isAnswered([
        { selected: ['a'], other: '' },
        { selected: [], other: 'x' },
      ]),
    ).toBe(true);
  });

  it('shapes the wire answers: options then trimmed free text', () => {
    expect(
      toWireAnswers([
        { selected: ['vitest'], other: '' },
        { selected: ['auth', 'tests'], other: ' docs ' },
        { selected: [], other: 'free' },
      ]),
    ).toEqual([['vitest'], ['auth', 'tests', 'docs'], ['free']]);
  });
});

describe('organization switch error', () => {
  it('keeps the provider sentence, drops area prefixes', () => {
    expect(
      switchErrorText(
        'account: rejected: organization_not_found: Organization not found.',
      ),
    ).toBe("Couldn't switch organization. Organization not found.");
  });
  it('says no connection for a network failure', () => {
    expect(switchErrorText('account: network error')).toBe(
      "Couldn't switch organization: no connection. Try again.",
    );
  });
  it('falls back when nothing is left', () => {
    expect(switchErrorText('account:')).toBe("Couldn't switch organization.");
  });
});

describe('errorText for fleet refusals', () => {
  it('turns a refusal code into what to do', async () => {
    const { errorText } = await import('../src/ui/logic');
    expect(
      errorText(
        new Error('the other device refused: fleet.untrusted_device: whatever'),
      ),
    ).toMatch(/doesn't trust this device yet/);
    expect(
      errorText(new Error('refused by the cloud: fleet.upgrade_required')),
    ).toMatch(/older Theodore/);
    expect(
      errorText(
        new Error(
          'the other device refused: fleet.agent_unavailable: codex is off',
        ),
      ),
    ).toBe(
      'That computer doesn’t offer this agent, model or effort any more. Pick another.',
    );
    expect(errorText(new Error('plain failure'))).toBe('plain failure');
    expect(errorText(42)).toBe('Something went wrong. Try again.');
  });
});

describe('who a question is from', () => {
  it('names the space as it is titled now, else keeps the ask’s words', () => {
    const q = { space: 'rs_1', from: 'mac-A · ask-me-red-or-blue' };
    const titled = space({
      space: 'rs_1',
      hostName: 'mac-A',
      name: 'Red or blue color file',
    });
    expect(questionFrom(q, [titled])).toBe('mac-A · Red or blue color file');
    expect(questionFrom(q, [])).toBe('mac-A · ask-me-red-or-blue');
  });
});
