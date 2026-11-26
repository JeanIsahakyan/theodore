import { describe, expect, it } from 'vitest';
import type { ComputerSpaceView, SpaceView } from '../src/fleet/types';
import {
  COMPUTERS_SECTION,
  computerSections,
  computerSpaceDot,
  computerSubSummary,
  dayGroup,
  drawerClosesOn,
  initials,
  spaceDot,
  spaceSections,
  swipeOpensOn,
} from '../src/ui/drawer';

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

describe('swipeOpensOn', () => {
  it('opens on Home and a space, not on pushed screens', () => {
    expect(swipeOpensOn('/')).toBe(true);
    expect(swipeOpensOn('/space/x')).toBe(true);
    expect(swipeOpensOn('/space/a%20b?x=1')).toBe(true);
    expect(swipeOpensOn('/devices')).toBe(false);
    expect(swipeOpensOn('/settings')).toBe(false);
    expect(swipeOpensOn('/settings/about')).toBe(false);
    expect(swipeOpensOn('/sub-space/a/b')).toBe(false);
    expect(swipeOpensOn('/start')).toBe(false);
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

describe('drawerClosesOn', () => {
  it('a pick that opens a page closes the drawer', () => {
    expect(drawerClosesOn('/', '/space/rs_1')).toBe(true);
    expect(drawerClosesOn('/space/rs_1', '/devices')).toBe(true);
    expect(drawerClosesOn('/', '/settings')).toBe(true);
  });

  it('a sheet opened from it leaves it open, and so does coming back', () => {
    expect(drawerClosesOn('/', '/accounts-sheet')).toBe(false);
    expect(drawerClosesOn('/space/rs_1', '/model-picker?space=rs_1')).toBe(
      false,
    );
    expect(drawerClosesOn('/accounts-sheet', '/')).toBe(false);
    expect(drawerClosesOn('/activity-sheet?space=rs_1', '/space/rs_1')).toBe(
      false,
    );
  });

  it('the same route: nothing', () => {
    expect(drawerClosesOn('/', '/')).toBe(false);
  });
});

describe('computerSections', () => {
  const c = (
    id: string,
    over: Partial<ComputerSpaceView> = {},
  ): ComputerSpaceView => ({
    hostDevice: 'dev_mac',
    hostName: 'mac-A',
    space: id,
    name: id,
    title: `Title ${id}`,
    project: 'theodore',
    status: 'idle',
    mode: 'edit',
    activeAt: 1,
    online: true,
    subSpaces: [],
    ...over,
  });

  it('is one section after the days, or none', () => {
    expect(computerSections([])).toEqual([]);
    expect(computerSections([c('a'), c('b')])).toEqual([
      { title: COMPUTERS_SECTION, data: [c('a'), c('b')] },
    ]);
  });

  it('filters by title, name, project or computer', () => {
    const list = [c('a', { hostName: 'studio' }), c('b', { project: 'site' })];
    const ids = (q: string) =>
      computerSections(list, q).flatMap((s) => s.data.map((x) => x.space));
    expect(ids('STUDIO')).toEqual(['a']);
    expect(ids('site')).toEqual(['b']);
    expect(ids('title b')).toEqual(['b']);
    expect(ids('nothing')).toEqual([]);
  });

  it('dots by the listed status', () => {
    expect(computerSpaceDot(c('a', { status: 'question' }))).toBe('waiting');
    expect(computerSpaceDot(c('a', { status: 'setting_up' }))).toBe('running');
    expect(computerSpaceDot(c('a', { status: 'failed' }))).toBe('failed');
    expect(computerSpaceDot(c('a'))).toBeNull();
  });
});

describe('computerSubSummary', () => {
  const sub = (status: string) => ({ space: status, title: status, status });
  const of = (subSpaces: { space: string; title: string; status: string }[]) =>
    computerSubSummary({
      hostDevice: 'dev_mac',
      hostName: 'mac-A',
      space: 'a',
      name: 'a',
      title: 'A',
      project: '',
      status: 'idle',
      mode: null,
      activeAt: 0,
      online: true,
      subSpaces,
    });
  it('counts them, and the running ones', () => {
    expect(of([])).toBeNull();
    expect(of([sub('idle')])).toBe('1 sub-space');
    expect(of([sub('running'), sub('setting_up'), sub('idle')])).toBe(
      '3 sub-spaces, 2 running',
    );
  });
});
