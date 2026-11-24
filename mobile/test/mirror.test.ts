import { describe, expect, it } from 'vitest';
import {
  MESSAGES_KEPT,
  SUB_SPACES_KEPT,
  applyMirror,
  emptyMirror,
  latestReply,
  liveSteps,
  mirrorStatus,
  mirrorTitle,
  mirrored,
  stepId,
  type SpaceMirror,
} from '../src/fleet/mirror';

const SP = 'rs_abc';
const RUN = `space:${SP}:m1`;

const spaceRow = (over: object = {}) => ({
  id: SP,
  project: 'p1',
  name: 'fix-bug',
  goal: 'Fix the bug\nin login',
  branch: 'th/fix',
  status: 'running',
  agent: 'claude',
  mode: 'edit',
  turns: 1,
  run: RUN,
  worktree: '',
  created_at: 1,
  updated_at: 2,
  ...over,
});

const message = (over: object = {}) => ({
  id: 'm1',
  pr: `space:${SP}`,
  author: { kind: 'me' },
  text: 'Fix it',
  refs: [],
  at: 10,
  ...over,
});

const reply = (over: object = {}) =>
  message({
    id: 'm2',
    author: { kind: 'agent', agent: 'claude' },
    text: 'Done',
    at: 20,
    run: RUN,
    activity: [
      { kind: 'tool', name: 'Bash', target: 'ls', ok: true },
      { kind: 'nope', text: 'unknown kinds go' },
    ],
    ...over,
  });

const apply = (m: SpaceMirror, model: string, id: string, data: unknown) =>
  applyMirror(m, SP, model, id, data);

const child = (id: string, over: object = {}) => ({
  space: id,
  parent: SP,
  title: `Child ${id}`,
  status: 'running',
  mode: 'edit',
  done: false,
  ...over,
});

describe('mirror reducer', () => {
  it('keeps sub-spaces, latest per id, and drops them on null', () => {
    let m = apply(emptyMirror(), 'sub_space', 'c1', child('c1'));
    m = apply(m, 'sub_space', 'c2', child('c2', { parent: 'c1' }));
    m = apply(
      m,
      'sub_space',
      'c1',
      child('c1', { status: 'idle', done: true }),
    );
    // Updates keep the order first seen.
    expect(Object.keys(m.subSpaces)).toEqual(['c1', 'c2']);
    expect(m.subSpaces.c1).toEqual({
      space: 'c1',
      parent: SP,
      title: 'Child c1',
      status: 'idle',
      mode: 'edit',
      done: true,
    });
    // Not a sub-space row: another id inside, no mode, its own parent, the
    // space itself, an unsafe id.
    const before = m;
    m = apply(m, 'sub_space', 'c3', child('c4'));
    m = apply(m, 'sub_space', 'c3', child('c3', { mode: 'god' }));
    m = apply(m, 'sub_space', 'c3', child('c3', { parent: 'c3' }));
    m = apply(m, 'sub_space', SP, child(SP));
    m = apply(m, 'sub_space', 'a/b', child('a/b'));
    expect(m).toBe(before);
    expect(apply(m, 'sub_space', 'nope', null)).toBe(m);
    m = apply(m, 'sub_space', 'c1', null);
    expect(Object.keys(m.subSpaces)).toEqual(['c2']);
    // A sub-space alone doesn't make the chat the mirror's.
    expect(mirrored(m)).toBe(false);
  });

  it(`keeps at most ${SUB_SPACES_KEPT} sub-spaces, updates still land`, () => {
    let m = emptyMirror();
    for (let i = 0; i < SUB_SPACES_KEPT; i++)
      m = apply(m, 'sub_space', `c${i}`, child(`c${i}`));
    const full = m;
    expect(apply(m, 'sub_space', 'extra', child('extra'))).toBe(full);
    m = apply(m, 'sub_space', 'c0', child('c0', { status: 'failed' }));
    expect(m.subSpaces.c0!.status).toBe('failed');
  });

  it('keeps the space row, shape-checked, and deletes it on null', () => {
    const m = apply(emptyMirror(), 'space', SP, spaceRow({ mode: 'bogus' }));
    expect(m.space).toMatchObject({
      id: SP,
      status: 'running',
      mode: 'edit',
      run: RUN,
    });
    expect(m.space).not.toHaveProperty('worktree');
    expect(mirrored(m)).toBe(true);
    expect(apply(m, 'space', SP, null).space).toBeNull();
  });

  it('keeps base and done_at, bounded', () => {
    const m = apply(
      emptyMirror(),
      'space',
      SP,
      spaceRow({ base: 'main', done_at: 1_700_000_000_000 }),
    );
    expect(m.space).toMatchObject({ base: 'main', done_at: 1_700_000_000_000 });
    const odd = apply(
      emptyMirror(),
      'space',
      SP,
      spaceRow({ base: 42, done_at: 'soon' }),
    );
    expect(odd.space).toMatchObject({ base: '', done_at: null });
  });

  it("drops another space's row and unknown models", () => {
    const m0 = emptyMirror();
    expect(apply(m0, 'space', 'rs_other', spaceRow({ id: 'rs_other' }))).toBe(
      m0,
    );
    expect(apply(m0, 'space', SP, spaceRow({ id: 'rs_other' }))).toBe(m0);
    expect(apply(m0, 'file', 'x', {})).toBe(m0);
    expect(applyMirror(m0, SP, 'space', 42, spaceRow())).toBe(m0);
  });

  it('upserts and deletes messages of this chat only', () => {
    let m = apply(emptyMirror(), 'chat_message', 'm1', message());
    m = apply(m, 'chat_message', 'm2', reply());
    expect(Object.keys(m.messages)).toEqual(['m1', 'm2']);
    expect(m.messages.m2!.activity).toEqual([
      expect.objectContaining({ kind: 'tool', name: 'Bash', ok: true }),
    ]);
    // Another chat's row, an id that isn't the row's, a bad author.
    const before = m;
    m = apply(m, 'chat_message', 'x', message({ id: 'x', pr: 'space:rs_b' }));
    m = apply(m, 'chat_message', 'y', message({ id: 'z' }));
    m = apply(m, 'chat_message', 'w', message({ id: 'w', author: 'me' }));
    expect(m).toBe(before);
    m = apply(m, 'chat_message', 'm1', message({ text: 'edited' }));
    expect(m.messages.m1!.text).toBe('edited');
    m = apply(m, 'chat_message', 'm1', null);
    expect(Object.keys(m.messages)).toEqual(['m2']);
  });

  it('keeps live steps per run until its reply lands', () => {
    let m = apply(emptyMirror(), 'space', SP, spaceRow());
    m = apply(m, 'turn_step', `${RUN}:1`, {
      kind: 'tool',
      name: 'Read',
      target: 'a.rs',
      ok: null,
    });
    m = apply(m, 'turn_step', `${RUN}:0`, { kind: 'text', text: 'Looking' });
    // `{run, step}` around it works too.
    m = apply(m, 'turn_step', `${RUN}:2`, {
      run: RUN,
      step: { kind: 'thinking', text: 'hmm' },
    });
    expect(liveSteps(m, RUN).map((s) => s.kind)).toEqual([
      'text',
      'tool',
      'thinking',
    ]);
    // The call ended: the same id again, updated.
    m = apply(m, 'turn_step', `${RUN}:1`, {
      kind: 'tool',
      name: 'Read',
      target: 'a.rs',
      ok: true,
    });
    expect(liveSteps(m, RUN)[1]).toMatchObject({ ok: true });
    m = apply(m, 'chat_message', 'm2', reply());
    expect(m.steps).toEqual({});
    // A step that comes after its reply isn't shown again.
    expect(apply(m, 'turn_step', `${RUN}:3`, { kind: 'text', text: 'x' })).toBe(
      m,
    );
  });

  it("drops steps of another space's run, bad ids, bad steps", () => {
    const m0 = emptyMirror();
    const step = { kind: 'text', text: 'x' };
    expect(apply(m0, 'turn_step', 'space:rs_other:m1:0', step)).toBe(m0);
    expect(apply(m0, 'turn_step', `${RUN}:x`, step)).toBe(m0);
    expect(apply(m0, 'turn_step', `${RUN}`, step)).toBe(m0);
    expect(apply(m0, 'turn_step', `${RUN}:0`, { kind: 'bogus' })).toBe(m0);
    expect(stepId(`${RUN}:7`, SP)).toEqual({ run: RUN, n: 7 });
  });

  it('drops live steps once the space row is not running', () => {
    let m = apply(emptyMirror(), 'turn_step', `${RUN}:0`, {
      kind: 'text',
      text: 'x',
    });
    m = apply(m, 'space', SP, spaceRow());
    expect(Object.keys(m.steps)).toHaveLength(1);
    m = apply(m, 'space', SP, spaceRow({ status: 'idle', run: null }));
    expect(m.steps).toEqual({});
  });

  it('keeps the newest messages past the cap', () => {
    let m = emptyMirror();
    for (let i = 0; i <= MESSAGES_KEPT; i += 1) {
      m = apply(m, 'chat_message', `m${i}`, message({ id: `m${i}`, at: i }));
    }
    expect(Object.keys(m.messages)).toHaveLength(MESSAGES_KEPT);
    expect(m.messages.m0).toBeUndefined();
    expect(m.messages[`m${MESSAGES_KEPT}`]).toBeDefined();
  });
});

describe('mirror readers', () => {
  it('says the status as the list does', () => {
    const row = (o: object) =>
      apply(emptyMirror(), 'space', SP, spaceRow(o)).space!;
    expect(mirrorStatus(row({}))).toBe('running');
    expect(
      mirrorStatus(
        row({
          question: { id: 'q1', run: RUN, questions: [], asked_at: 1 },
        }),
      ),
    ).toBe('waiting');
    expect(mirrorStatus(row({ status: 'idle' }))).toBe('idle');
    expect(mirrorStatus(row({ status: 'failed' }))).toBe('failed');
    expect(mirrorStatus(row({ status: 'archived' }))).toBe('stopped');
  });

  it('titles a space like the desktop', () => {
    const base = { name: 'fix-bug', branch: 'th/fix', title: null };
    expect(mirrorTitle({ ...base, goal: 'Fix it.', title: 'Login fix' })).toBe(
      'Login fix',
    );
    expect(mirrorTitle({ ...base, goal: '\n  Fix the bug.\nmore' })).toBe(
      'Fix the bug',
    );
    expect(mirrorTitle({ ...base, name: 'space-2', goal: '' })).toBe('th/fix');
    const long = mirrorTitle({ ...base, goal: 'word '.repeat(30) });
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });

  it("the last reply is the newest agent message that didn't fail", () => {
    let m = apply(emptyMirror(), 'chat_message', 'm1', message());
    expect(latestReply(m)).toBeNull();
    m = apply(m, 'chat_message', 'm2', reply());
    m = apply(
      m,
      'chat_message',
      'm3',
      reply({ id: 'm3', at: 30, failed: 'boom', text: 'partial' }),
    );
    expect(latestReply(m)).toBe('Done');
  });
});
