/** What a local-space tool's row says: which tool a step is, by label or
 *  raw name; the words for each tool while it runs, once done, and when it
 *  failed; titles from the store by id, falling back to the result's, then
 *  the id. */
import { describe, expect, it } from 'vitest';
import type { Space, ToolPayload } from '../gen/contract';
import {
  askAnswer,
  mergedFiles,
  phaseOf,
  spaceToolData,
  spaceToolLine,
  spaceToolOf,
  spaceToolPinned,
  spaceToolView,
  waitCounts,
  type SpaceLike,
  type SpaceToolData,
} from './spaceTools';
import { toolRow } from './toolSummary';

const space = (id: string, over: Partial<Space> = {}): SpaceLike =>
  ({
    id,
    name: id,
    goal: `Goal ${id}`,
    title: null,
    status: 'idle',
    mode: 'edit',
    turns: 1,
    head_sha: 'h',
    question: null,
    shipped: null,
    ...over,
  }) as SpaceLike;

const store = (...spaces: SpaceLike[]) => {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  return (id: string) => byId.get(id);
};

const data = (
  input: Record<string, unknown> | null,
  result: Record<string, unknown> | null = null,
): SpaceToolData => ({ input, result });

const done = { ok: true, target: null };
const going = { ok: null, target: null };

describe('spaceToolOf', () => {
  it('knows the core labels, the raw names and nothing else', () => {
    expect(spaceToolOf('start a sub-space')).toBe('start');
    expect(spaceToolOf('message a space')).toBe('send');
    expect(spaceToolOf('list the spaces')).toBe('list');
    expect(spaceToolOf('mcp__space-tools__space_wait')).toBe('wait');
    expect(spaceToolOf('space-tools__space_merge')).toBe('merge');
    expect(spaceToolOf('space_ask')).toBe('ask');
    expect(spaceToolOf('mcp__space-tools__ship')).toBeNull();
    expect(spaceToolOf('mcp__other__space_start')).toBeNull();
    expect(spaceToolOf('Bash')).toBeNull();
    expect(spaceToolOf('constructor')).toBeNull();
  });

  it('is its own kind of row, labelled', () => {
    expect(toolRow('start a sub-space')).toEqual({
      kind: 'space',
      label: 'Start a sub-space',
    });
    expect(toolRow('mcp__space-tools__space_wait').kind).toBe('space');
    // Not a command because it starts with "start", nor a stop.
    expect(toolRow('stop a sub-space').kind).toBe('space');
  });

  it('pins all but reading and listing', () => {
    expect(spaceToolPinned('start')).toBe(true);
    expect(spaceToolPinned('merge')).toBe(true);
    expect(spaceToolPinned('read')).toBe(false);
    expect(spaceToolPinned('list')).toBe(false);
  });
});

describe('spaceToolData', () => {
  const payload = (text: string | null, ok = true): ToolPayload => ({
    input: { value: { space: 's1' } },
    result: {
      ok,
      output: text == null ? null : { text },
      stdout: null,
      stderr: null,
      exit_code: null,
      duration_ms: null,
    },
  });

  it("reads the input and the result's JSON", () => {
    expect(spaceToolData(payload('{"space":"c1","title":"Port"}'))).toEqual({
      input: { space: 's1' },
      result: { space: 'c1', title: 'Port' },
    });
  });

  it('an error or plain text is no result; nothing stored is nothing', () => {
    expect(spaceToolData(payload('refused', false)).result).toBeNull();
    expect(spaceToolData(payload('not json')).result).toBeNull();
    expect(spaceToolData(payload('[1]')).result).toBeNull();
    expect(spaceToolData(null)).toEqual({ input: null, result: null });
  });
});

describe('phaseOf', () => {
  it('running only while its turn runs; no result after it is not done', () => {
    expect(phaseOf(null, true)).toBe('running');
    expect(phaseOf(true, true)).toBe('done');
    expect(phaseOf(false, true)).toBe('failed');
    expect(phaseOf(null, false)).toBe('failed');
  });
});

describe('spaceToolView', () => {
  it('start: the goal while it starts, then the child by its title, live', () => {
    const input = { goal: 'Port the parser\nto the new API', mode: 'edit' };
    const starting = spaceToolView('start', going, data(input), store(), true);
    expect(spaceToolLine(starting)).toBe(
      'Starting a sub-space: Port the parser to the new API',
    );
    expect(starting.space?.known).toBe(false);
    expect(starting.note).toBe('Edit');

    const lookup = store(
      space('c1', { title: 'Port parser', status: 'running', mode: 'plan' }),
    );
    const started = spaceToolView(
      'start',
      done,
      data(input, { space: 'c1', title: 'Old', mode: 'edit' }),
      lookup,
      true,
    );
    expect(spaceToolLine(started)).toBe('Sub-space started: Port parser');
    expect(started.space).toEqual({
      id: 'c1',
      title: 'Port parser',
      known: true,
    });
    expect(started.stage).toBe('running');
    // The child's own mode, as it is now.
    expect(started.note).toBe('Plan');
  });

  it("start: a child not here reads by the result's title, then its id", () => {
    const view = (result: Record<string, unknown>) =>
      spaceToolView('start', done, data({}, result), store(), false);
    expect(view({ space: 'c1', title: 'Port' }).space).toEqual({
      id: 'c1',
      title: 'Port',
      known: false,
    });
    expect(view({ space: 'c1' }).space?.title).toBe('c1');
    expect(view({ space: 'c1' }).stage).toBeNull();
    const failed = spaceToolView(
      'start',
      { ok: false, target: null },
      data({ goal: 'x' }),
      store(),
      false,
    );
    expect(failed.label).toBe('Start a sub-space');
  });

  it('wait: live counts of what it waits on, then what settled', () => {
    const lookup = store(
      space('a', { title: 'A' }),
      space('b', { title: 'B', status: 'running' }),
      space('c', { title: 'C', status: 'running', question: {} as never }),
    );
    const input = { spaces: ['a', 'b', 'c'] };
    const waiting = spaceToolView('wait', going, data(input), lookup, true);
    expect(waiting.label).toBe('Waiting for 3 sub-spaces');
    expect(waiting.note).toBe('1 done · 1 running · 1 waiting for you');

    const result = {
      settled: ['a', 'c'],
      spaces: [
        { space: 'a', title: 'A', status: 'idle' },
        { space: 'c', title: 'C', status: 'question' },
      ],
    };
    const waited = spaceToolView(
      'wait',
      done,
      data(input, result),
      lookup,
      true,
    );
    expect(waited.label).toBe('Waited for 3 sub-spaces');
    expect(waited.note).toBe('A done, C waiting for you');
    expect(
      spaceToolView(
        'wait',
        done,
        data({ spaces: ['a'] }, { settled: [], spaces: [] }),
        lookup,
        false,
      ).note,
    ).toBe('none settled');
  });

  it('merge: the child, its lines, files and conflicts to resolve', () => {
    const view = spaceToolView(
      'merge',
      { ok: true, target: 'c1' },
      data(
        { space: 'c1' },
        {
          space: { space: 'c1', title: 'Old title' },
          files: [
            { path: 'a.rs', additions: 10, deletions: 2 },
            { path: 'b.rs', additions: 3, deletions: 0 },
          ],
          additions: 13,
          deletions: 2,
          conflicts: ['b.rs'],
        },
      ),
      store(space('c1', { title: 'Port parser' })),
      false,
    );
    expect(spaceToolLine(view)).toBe('Merged Port parser');
    expect(view).toMatchObject({
      note: '2 files',
      added: 13,
      removed: 2,
      conflicts: 1,
    });
    const merging = spaceToolView(
      'merge',
      { ok: null, target: 'c1' },
      data(null),
      store(),
      true,
    );
    expect(spaceToolLine(merging)).toBe('Merging c1');
  });

  it('ask, send, answer, read, list, stop: words and names', () => {
    const lookup = store(space('s1', { title: 'Fix login' }));
    const line = (
      tool: Parameters<typeof spaceToolView>[0],
      input: Record<string, unknown> | null,
      result: Record<string, unknown> | null = null,
      step = { ok: true as boolean | null, target: 's1' as string | null },
      running = false,
    ) =>
      spaceToolLine(
        spaceToolView(tool, step, data(input, result), lookup, running),
      );
    expect(line('ask', { space: 's1', question: 'Which\n store?' })).toBe(
      'Asked Fix login: Which store?',
    );
    expect(
      line(
        'ask',
        { question: 'Which?' },
        null,
        { ok: null, target: 's1' },
        true,
      ),
    ).toBe('Asking Fix login: Which?');
    expect(line('send', { message: 'Rebase on main' })).toBe(
      'Sent to Fix login: Rebase on main',
    );
    expect(line('answer', { ask: 'q1' })).toBe("Answered Fix login's question");
    expect(line('read', null)).toBe('Read Fix login');
    expect(line('stop', null)).toBe('Stopped Fix login');
    expect(
      line('list', null, { spaces: [{}, {}] }, { ok: true, target: null }),
    ).toBe('Listed spaces');
    // An id the store doesn't know reads as the result's title, or itself.
    expect(
      line(
        'read',
        null,
        { space: { space: 'zz', title: 'Gone' } },
        {
          ok: true,
          target: 'zz',
        },
      ),
    ).toBe('Read Gone');
    expect(line('stop', null, null, { ok: false, target: 'zz' })).toBe(
      'Stop zz',
    );
  });
});

describe('waitCounts', () => {
  it('counts what it knows, merged as done; nothing known is nothing', () => {
    const lookup = store(
      space('a', {
        shipped: { how: 'merged_into_parent', head: 'h' } as never,
      }),
      space('b', { status: 'failed' }),
    );
    expect(waitCounts(['a', 'b', 'gone'], lookup)).toBe('1 done · 1 failed');
    expect(waitCounts(['gone'], lookup)).toBeNull();
  });
});

describe("a merge's files and an ask's answer", () => {
  it('marks conflicts, keeps one the merge did not list', () => {
    expect(
      mergedFiles({
        files: [{ path: 'a.rs', additions: 1, deletions: 2 }],
        conflicts: ['a.rs', 'gone.rs'],
      }),
    ).toEqual([
      { path: 'a.rs', additions: 1, deletions: 2, conflict: true },
      { path: 'gone.rs', additions: 0, deletions: 0, conflict: true },
    ]);
    expect(mergedFiles(null)).toEqual([]);
  });

  it('the answer, and who gave it', () => {
    expect(
      askAnswer({ answer: 'Redis', agent: 'claude', how: 'fork' }),
    ).toEqual({ answer: 'Redis', by: 'claude · fork' });
    expect(askAnswer({ answer: '' })).toBeNull();
  });
});
