import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceView } from '../src/fleet/types';
import { lateConnecting } from '../src/ui/connection';
import { NO_DRAFT } from '../src/ui/homeDraft';
import {
  UNREACHABLE_AFTER_MS,
  UNREACHABLE_HINT,
  homeLoadState,
  lastPicksPreview,
  loadState,
  unreachableHint,
} from '../src/ui/load';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('first connection load state', () => {
  it('loads until the first devices list, whatever the socket does', () => {
    expect(loadState('off', false, false)).toBe('loading');
    expect(loadState('connecting', false, false)).toBe('loading');
    // Welcome in, devices not yet: still loading, no empty state flashes.
    expect(loadState('connected', false, false)).toBe('loading');
  });

  it('is ready once welcomed, also through a later redial', () => {
    expect(loadState('connected', true, false)).toBe('ready');
    expect(loadState('connecting', true, true)).toBe('ready');
    expect(loadState('error', true, false)).toBe('ready');
    expect(loadState('off', true, false)).toBe('ready');
  });

  it('is unreachable on an error, or connecting too long, before a welcome', () => {
    expect(loadState('error', false, false)).toBe('unreachable');
    expect(loadState('connecting', false, true)).toBe('unreachable');
    // Late only counts while connecting.
    expect(loadState('off', false, true)).toBe('loading');
  });

  it('Home: empty only after the fleet answered with no startable computer', () => {
    expect(homeLoadState('connecting', false, false, false)).toBe('loading');
    expect(homeLoadState('connected', false, false, false)).toBe('loading');
    expect(homeLoadState('connected', true, false, false)).toBe('empty');
    expect(homeLoadState('connected', true, true, false)).toBe('ready');
    expect(homeLoadState('error', false, false, false)).toBe('unreachable');
  });

  it('turns unreachable after 10 s of connecting, back to loading when it stops', () => {
    const seen: boolean[] = [];
    const w = lateConnecting((v) => seen.push(v), UNREACHABLE_AFTER_MS);
    w.update('connecting');
    vi.advanceTimersByTime(UNREACHABLE_AFTER_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true]);
    expect(loadState('connecting', false, true)).toBe('unreachable');
    w.update('connected');
    expect(seen).toEqual([true, false]);
    w.dispose();
  });

  it('says why when the fleet said, a hint otherwise', () => {
    expect(unreachableHint(null)).toBe(UNREACHABLE_HINT);
    expect(unreachableHint('fleet.version')).toBe('fleet.version');
  });
});

const space = (over: Partial<SpaceView>): SpaceView => ({
  space: 'rs_1',
  hostDevice: 'dev-a',
  hostName: 'mac-A',
  originDevice: 'dev-me',
  projectName: 'theodore',
  name: '',
  branch: '',
  status: 'idle',
  mode: 'edit',
  lastReply: null,
  question: null,
  startedHere: true,
  error: null,
  ...over,
});

describe('last picks preview', () => {
  it('nothing picked, or nothing saved on it: skeletons', () => {
    expect(lastPicksPreview(NO_DRAFT, [space({})])).toEqual({
      host: null,
      project: null,
    });
    expect(
      lastPicksPreview({ ...NO_DRAFT, deviceId: 'dev-b' }, [space({})]),
    ).toEqual({ host: null, project: null });
  });

  it('names the host and the project last started in there', () => {
    const draft = { ...NO_DRAFT, deviceId: 'dev-a', projectId: 'p2' };
    const saved = [
      space({ space: 'rs_1', projectName: 'theodore', activeAt: 10 }),
      space({ space: 'rs_2', projectName: 'cloud', activeAt: 20 }),
      // Followed: not started here, its project isn't a pick of ours.
      space({
        space: 'rs_3',
        projectName: 'other',
        startedHere: false,
        activeAt: 30,
      }),
      space({ space: 'rs_4', hostDevice: 'dev-b', hostName: 'mac-B' }),
    ];
    expect(lastPicksPreview(draft, saved)).toEqual({
      host: 'mac-A',
      project: 'cloud',
    });
  });

  it('a host known only from a followed space: its name, no project', () => {
    const draft = { ...NO_DRAFT, deviceId: 'dev-a' };
    expect(lastPicksPreview(draft, [space({ startedHere: false })])).toEqual({
      host: 'mac-A',
      project: null,
    });
  });
});
