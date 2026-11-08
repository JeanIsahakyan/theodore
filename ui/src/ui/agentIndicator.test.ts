import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnStep } from '../gen/contract';
import {
  DWELL_MS,
  HeldIndicator,
  indicatorState,
  nextHold,
  ONE_SHOT_MS,
  type Hold,
} from './agentIndicator';

const call = (name: string, ok: boolean | null = null): TurnStep => ({
  kind: 'tool',
  name,
  target: null,
  ok,
  id: name,
});
const text = (t: string): TurnStep => ({ kind: 'text', text: t });
const thinking: TurnStep = { kind: 'thinking', text: 'hm' };

describe('indicatorState', () => {
  const running = (steps: TurnStep[]) =>
    indicatorState({ running: true, steps });

  it('a turn with no step yet is thinking', () => {
    expect(indicatorState({ running: true })).toBe('thinking');
    expect(running([])).toBe('thinking');
  });

  it('the latest step is what it says', () => {
    expect(running([text('a'), thinking])).toBe('thinking');
    expect(running([thinking, text('reply')])).toBe('writing');
  });

  it.each([
    ['Read'],
    ['Grep'],
    ['Glob'],
    ['WebFetch'],
    ['WebSearch'],
    ['read the diff'],
    ['read_file'],
  ])('%s reads', (name) => {
    expect(running([call(name)])).toBe('reading');
  });

  it.each([['Edit'], ['Write'], ['MultiEdit'], ['replace the thing']])(
    '%s writes',
    (name) => {
      expect(running([call(name)])).toBe('writing');
    },
  );

  it.each([
    ['Bash'],
    ['mcp__server__do_thing'],
    ['Agent'],
    ['TodoWrite'],
    ['run the tests'],
  ])('%s is loading', (name) => {
    expect(running([call(name)])).toBe('loading');
  });

  it('a call that waits for you is your turn', () => {
    expect(running([call('ask you')])).toBe('turn');
    expect(running([call('ExitPlanMode')])).toBe('turn');
    expect(indicatorState({ running: true, waiting: true })).toBe('turn');
  });

  it('a finished call means the agent is deciding what next', () => {
    expect(running([call('Read', true)])).toBe('thinking');
  });

  it('parallel calls: the newest still going, whichever ended last', () => {
    expect(
      running([call('Grep'), call('Bash', true), call('Edit', true)]),
    ).toBe('reading');
  });

  it("a background call is the agent's, not the turn's", () => {
    expect(running([{ ...call('Bash'), background: true } as TurnStep])).toBe(
      'thinking',
    );
  });

  it('blank text is no step', () => {
    expect(running([call('Read'), text('  ')])).toBe('reading');
  });

  it('a stalled run has nothing to animate', () => {
    expect(indicatorState({ running: true, stalled: true })).toBe('idle');
  });

  it('grouping and such are loading; nothing going on is idle', () => {
    expect(indicatorState({ busy: true })).toBe('loading');
    expect(indicatorState({})).toBe('idle');
  });

  it('the end of a turn wins', () => {
    expect(
      indicatorState({ ended: 'done', running: true, waiting: true }),
    ).toBe('done');
    expect(indicatorState({ ended: 'error' })).toBe('error');
  });
});

describe('nextHold', () => {
  const at = (shown: Hold['shown'], since: number): Hold => ({ shown, since });

  it('waits out the dwell before swapping', () => {
    const held = at('reading', 1000);
    const step = nextHold(held, 'writing', 1000 + DWELL_MS - 50);
    expect(step.hold).toBe(held);
    expect(step.wakeIn).toBe(50);
  });

  it('swaps once the dwell is over', () => {
    const step = nextHold(at('reading', 1000), 'writing', 1000 + DWELL_MS);
    expect(step.hold.shown).toBe('writing');
    expect(step.wakeIn).toBeNull();
  });

  it('a one-shot never waits', () => {
    const step = nextHold(at('reading', 1000), 'done', 1001);
    expect(step.hold.shown).toBe('done');
  });

  it('the same state changes nothing', () => {
    const held = at('reading', 1000);
    expect(nextHold(held, 'reading', 2000).hold).toBe(held);
  });
});

describe('HeldIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const fake = () =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const noEnd = () => null;

  it("a burst of calls doesn't flash: the state holds", () => {
    fake();
    const held = new HeldIndicator(null, null);
    held.update('thinking', 'r', noEnd);
    expect(held.get()).toBe('thinking');
    held.update('reading', 'r', noEnd);
    held.update('loading', 'r', noEnd);
    held.update('writing', 'r', noEnd);
    expect(held.get()).toBe('thinking');
    vi.advanceTimersByTime(DWELL_MS);
    expect(held.get()).toBe('writing');
  });

  it('done plays once when its run ends, then the fallback', () => {
    fake();
    const held = new HeldIndicator(null, null);
    held.update('writing', 'r', noEnd);
    vi.advanceTimersByTime(DWELL_MS);
    const seen: (string | null)[] = [];
    held.subscribe(() => seen.push(held.get()));
    held.update(null, null, () => 'done');
    expect(held.get()).toBe('done');
    vi.advanceTimersByTime(ONE_SHOT_MS.done);
    expect(held.get()).toBeNull();
    expect(seen).toEqual(['done', null]);
  });

  it('error plays once, as long as it lasts', () => {
    fake();
    const held = new HeldIndicator('loading', 'r');
    held.update(null, null, () => 'error');
    expect(held.get()).toBe('error');
    vi.advanceTimersByTime(ONE_SHOT_MS.error - 1);
    expect(held.get()).toBe('error');
    vi.advanceTimersByTime(1);
    expect(held.get()).toBeNull();
  });

  it('a stopped run plays nothing', () => {
    fake();
    const held = new HeldIndicator('loading', 'r');
    vi.advanceTimersByTime(DWELL_MS);
    held.update(null, null, () => null);
    expect(held.get()).toBeNull();
  });

  it("the next run starting isn't an end", () => {
    fake();
    const held = new HeldIndicator('loading', 'r');
    held.update('thinking', 'r2', () => 'done');
    expect(held.get()).toBe('thinking');
    vi.advanceTimersByTime(ONE_SHOT_MS.done);
    expect(held.get()).toBe('thinking');
  });

  it('a live state outlives the one-shot: a plan to approve', () => {
    fake();
    const held = new HeldIndicator('writing', 'r');
    vi.advanceTimersByTime(DWELL_MS);
    held.update('turn', null, () => 'done');
    expect(held.get()).toBe('turn');
    vi.advanceTimersByTime(ONE_SHOT_MS.done);
    expect(held.get()).toBe('turn');
  });

  it('a state with no run to begin with is shown at once', () => {
    fake();
    const held = new HeldIndicator(null, null);
    held.update('turn', null, noEnd);
    expect(held.get()).toBe('turn');
  });
});
