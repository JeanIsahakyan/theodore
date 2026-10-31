/** Grouped review: the diff lists a group's files in the order the groups
 *  pane lists them — the group's own order, off-pattern files first — not
 *  the revision's file order, also while the grouping streams in. */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { mount, type Mounted } from '../test/dom';
import type {
  FileDiff,
  Group,
  Grouping,
  HunkId,
  Revision,
} from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { DiffPane } from './DiffPane';
import { GroupsPane, type ReviewMode } from './GroupsPane';
import { hunksInScope } from './review/hunks';

const PR = 'gh:acme/app#1';
const HEAD = 'h'.repeat(40);

const file = (path: string, hunks: string[]): FileDiff => ({
  path,
  old_path: null,
  status: 'modified',
  similarity: null,
  old_mode: null,
  new_mode: null,
  flags: [],
  additions: hunks.length,
  deletions: 0,
  hunks: hunks.map((id, i) => ({
    id,
    path,
    old_start: 1 + i * 50,
    old_lines: 0,
    new_start: 1 + i * 50,
    new_lines: 1,
    header: '',
    lines: [{ kind: 'add', text: id, old_no: null, new_no: 1 + i * 50 }],
  })),
});

// Diff order is alphabetical; the agent reads the model first, then the
// API that uses it, then its tests.
const rev: Revision = {
  base: 'b'.repeat(40),
  head: HEAD,
  files: [
    file('api/handler.ts', ['api1', 'api2']),
    file('model/user.ts', ['model1']),
    file('tests/user.test.ts', ['test1']),
  ],
};

const g = (id: string, hunks: string[], outliers: string[] = []): Group => ({
  id,
  title: `Group ${id}`,
  why: `Explains ${id}.`,
  kind: outliers.length ? 'skim' : 'normal',
  risk: null,
  check: [],
  hunks,
  outliers,
});

function seed(grouping: Grouping): RootStore {
  const store = new RootStore();
  store.sync.pool.put('pr', PR, {
    pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
    url: 'https://example.test/acme/app/pull/1',
    head_sha: HEAD,
  });
  store.sync.pool.put('pr_detail', PR, {
    threads: [],
    checks: [],
    commits: [],
  });
  store.sync.pool.put('grouping', PR, grouping);
  return store;
}

const noop = () => {};

/** Both panes over one store, the way `Review` lays them out. */
function view(store: RootStore, group: string) {
  const mode: ReviewMode = { mode: 'groups', group, file: null };
  return (
    <RootStoreProvider store={store}>
      <GroupsPane
        pr={PR}
        rev={rev}
        mode={mode}
        setMode={noop}
        since={null}
        sinceOnly={false}
      />
      <DiffPane
        pr={PR}
        rev={rev}
        mode={mode}
        setMode={noop}
        since={null}
        sinceOnly={false}
        baselineSha={null}
        focusHunk={null}
        setFocusHunk={noop}
        composer={null}
        setComposer={noop}
        expandHunk={null}
      />
    </RootStoreProvider>
  );
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

/** File paths of one group in the groups pane, top to bottom. */
const paneFiles = (group: string) => {
  const n = [...m!.host.querySelectorAll('.gtitle')].findIndex(
    (e) => e.textContent === `Group ${group}`,
  );
  return [
    ...m!.host.querySelectorAll(
      `.groups [aria-label="Files in group ${n + 1}"] .font-mono[title]`,
    ),
  ].map((e) => e.getAttribute('title'));
};
/** File paths in the diff, top to bottom. */
const diffFiles = () =>
  [...m!.host.querySelectorAll('.diff .file-h [title]')].map((e) =>
    e.getAttribute('title'),
  );

describe('grouped diff order', () => {
  it("lists the group's files in the groups pane's order, not the diff's", async () => {
    const store = seed({
      rev: HEAD,
      groups: [g('g1', ['model1', 'api2', 'test1', 'api1'])],
    });
    m = await mount(view(store, 'g1'));
    expect(paneFiles('g1')).toEqual([
      'model/user.ts',
      'api/handler.ts',
      'tests/user.test.ts',
    ]);
    expect(diffFiles()).toEqual(paneFiles('g1'));
    // A file keeps its hunks in diff order.
    expect(
      [...m.host.querySelectorAll('.diff .hunk')].map((e) => e.id),
    ).toEqual(['H-model1', 'H-api1', 'H-api2', 'H-test1']);
  });

  it('puts files with an off-pattern hunk first, as the groups pane does', async () => {
    const store = seed({
      rev: HEAD,
      groups: [g('g1', ['model1', 'api1', 'test1'], ['test1'])],
    });
    m = await mount(view(store, 'g1'));
    expect(paneFiles('g1')[0]).toBe('tests/user.test.ts');
    // "Show all": the outlier banner starts on "Only outliers".
    const showAll = [...m.host.querySelectorAll('.outliers button')].find(
      (b) => b.textContent === 'Show all',
    ) as HTMLButtonElement;
    await act(async () => showAll.click());
    expect(diffFiles()).toEqual(paneFiles('g1'));
  });

  it('keeps the two in step while the grouping streams in and reorders', async () => {
    const store = seed({
      rev: HEAD,
      groups: [g('g1', ['test1', 'model1'])],
      in_progress: true,
    });
    store.models.markGroupOpened(PR, 'g1');
    m = await mount(view(store, 'g1'));
    expect(diffFiles()).toEqual(['tests/user.test.ts', 'model/user.ts']);
    expect(diffFiles()).toEqual(paneFiles('g1'));

    // A part lands and its validated groups replace the streamed one.
    act(() =>
      store.sync.pool.put('grouping', PR, {
        rev: HEAD,
        groups: [g('g1', ['model1', 'test1']), g('g2', ['api1', 'api2'])],
        in_progress: true,
      }),
    );
    expect(diffFiles()).toEqual(['model/user.ts', 'tests/user.test.ts']);
    expect(diffFiles()).toEqual(paneFiles('g1'));

    // The final pass puts g2 first; g1 was opened, so it stays put.
    act(() =>
      store.sync.pool.put('grouping', PR, {
        rev: HEAD,
        groups: [g('g2', ['api2', 'api1']), g('g1', ['model1', 'test1'])],
      }),
    );
    expect(
      [...m.host.querySelectorAll('.gtitle')].map((e) => e.textContent),
    ).toEqual(['Group g1', 'Group g2']);
    expect(diffFiles()).toEqual(paneFiles('g1'));
  });
});

describe('hunksInScope in grouped mode', () => {
  it('steps through hunks in the order the diff shows them', () => {
    const group = g('g1', ['model1', 'api2', 'test1', 'api1']);
    const ids = (hs: { id: HunkId }[]) => hs.map((h) => h.id);
    expect(
      ids(
        hunksInScope(rev, { mode: 'groups', group: 'g1', file: null }, group),
      ),
    ).toEqual(['model1', 'api1', 'api2', 'test1']);
  });
});
