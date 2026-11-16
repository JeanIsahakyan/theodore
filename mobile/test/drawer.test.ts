import { describe, expect, it } from 'vitest';
import type { SpaceView } from '../src/fleet/types';
import { dayGroup, initials, spaceDot, spaceSections } from '../src/ui/drawer';

const space = (id: string, over: Partial<SpaceView> = {}): SpaceView => ({
  space: id,
  hostDevice: 'mac',
  hostName: 'mac-A',
  originDevice: '',
  projectName: 'theodore',
  name: id,
  branch: '',
  status: 'idle',
  mode: 'edit',
  lastReply: null,
  question: null,
  startedHere: true,
  error: null,
  ...over,
});

// Local noon, so day boundaries don't depend on the machine's zone.
const now = new Date(2026, 10, 15, 12, 0, 0).getTime();
const at = (day: number, hour = 9) =>
  new Date(2026, 10, day, hour, 0, 0).getTime();

describe('dayGroup', () => {
  it('groups by local day', () => {
    expect(dayGroup(at(15, 0), now)).toBe('Today');
    expect(dayGroup(at(14, 23), now)).toBe('Yesterday');
    expect(dayGroup(at(14, 0), now)).toBe('Yesterday');
    expect(dayGroup(at(13), now)).toBe('Previous 7 days');
    expect(dayGroup(at(7), now)).toBe('Previous 7 days');
    expect(dayGroup(at(6), now)).toBe('Older');
    expect(dayGroup(undefined, now)).toBe('Older');
  });
});

describe('spaceSections', () => {
  it('lists newest first, in day sections, empty ones left out', () => {
    const list = [
      space('old', { activeAt: at(1) }),
      space('today-early', { activeAt: at(15, 8) }),
      space('yesterday', { activeAt: at(14) }),
      space('today-late', { activeAt: at(15, 11) }),
      space('unknown'),
    ];
    expect(
      spaceSections(list, now).map((s) => [
        s.title,
        s.data.map((x) => x.space),
      ]),
    ).toEqual([
      ['Today', ['today-late', 'today-early']],
      ['Yesterday', ['yesterday']],
      ['Older', ['old', 'unknown']],
    ]);
  });

  it('filters by title, project or host', () => {
    const list = [
      space('a', { name: 'Fix login', activeAt: at(15) }),
      space('b', { name: '', branch: 'feat/x', projectName: 'cloud' }),
      space('c', { name: 'Docs', hostName: 'linux-box' }),
    ];
    const ids = (q: string) =>
      spaceSections(list, now, q).flatMap((s) => s.data.map((x) => x.space));
    expect(ids('LOGIN')).toEqual(['a']);
    expect(ids('feat')).toEqual(['b']);
    expect(ids('cloud')).toEqual(['b']);
    expect(ids('linux')).toEqual(['c']);
    expect(ids('  ')).toEqual(['a', 'b', 'c']);
    expect(ids('nothing')).toEqual([]);
  });
});

describe('spaceDot', () => {
  it('shows waiting before running, failed in red, nothing when quiet', () => {
    expect(spaceDot(space('a', { status: 'waiting' }))).toBe('waiting');
    expect(
      spaceDot(
        space('a', {
          status: 'running',
          question: { askId: 'q', space: 'a', from: '', questions: [] },
        }),
      ),
    ).toBe('waiting');
    expect(spaceDot(space('a', { status: 'starting' }))).toBe('running');
    expect(spaceDot(space('a', { status: 'running' }))).toBe('running');
    expect(spaceDot(space('a', { status: 'failed' }))).toBe('failed');
    expect(spaceDot(space('a', { status: 'idle' }))).toBeNull();
    expect(spaceDot(space('a', { status: 'stopped' }))).toBeNull();
  });
});

describe('initials', () => {
  it('reads a name, else the email', () => {
    expect(initials('Jean Isahakyan')).toBe('JI');
    expect(initials('Ada Byron Lovelace')).toBe('AL');
    expect(initials('jean')).toBe('JE');
    expect(initials(null, 'ji@vk.com')).toBe('J');
    expect(initials(null)).toBe('?');
  });
});
