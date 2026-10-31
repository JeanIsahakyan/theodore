/** A file header's "also in …" links: one per other group however many of
 *  the file's hunks sit there, each just its number as in the groups pane
 *  (the title in its accessible name), and the row sized to give way before
 *  the file name and the Viewed toggle (#72). */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import type { FileDiff, Hunk, Revision } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { DiffPane } from './DiffPane';

const PR = 'gh:acme/app#1';
const HEAD = 'h'.repeat(40);

const hunk = (path: string, id: string, at: number): Hunk => ({
  id,
  path,
  old_start: at,
  old_lines: 0,
  new_start: at,
  new_lines: 1,
  header: '',
  lines: [{ kind: 'add', text: 'x', old_no: null, new_no: at }],
});

const file = (path: string, ids: string[]): FileDiff => ({
  path,
  old_path: null,
  status: 'modified',
  similarity: null,
  old_mode: null,
  new_mode: null,
  flags: [],
  additions: ids.length,
  deletions: 0,
  hunks: ids.map((id, i) => hunk(path, id, 1 + i * 40)),
});

const rev: Revision = {
  base: 'b'.repeat(40),
  head: HEAD,
  files: [
    file('src/a.ts', ['a0', 'a1', 'a2', 'a3', 'a4']),
    file('src/b.ts', ['b0']),
  ],
};

function seed(store: RootStore) {
  const pool = store.sync.pool;
  pool.put('pr', PR, {
    pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
    url: 'https://example.test/acme/app/pull/1',
    head_sha: HEAD,
  });
  pool.put('pr_detail', PR, { threads: [], checks: [], commits: [] });
  const g = (id: string, hunks: string[]) => ({
    id,
    title: `Group ${id}`,
    why: '',
    kind: 'normal',
    risk: null,
    check: [],
    hunks,
    outliers: [],
  });
  pool.put('grouping', PR, {
    rev: HEAD,
    groups: [
      g('g1', ['a0', 'b0']),
      // Pushed away entirely: not numbered, so the ones after it move up.
      g('gone', ['old']),
      g('g2', ['a1', 'a2', 'a3']),
      g('g3', ['a4']),
    ],
  });
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const noop = () => {};

describe('DiffPane "also in" links', () => {
  it('shows one numbered link per other group, compact and shrinkable', async () => {
    const store = new RootStore();
    seed(store);
    m = await mount(
      <RootStoreProvider store={store}>
        <DiffPane
          pr={PR}
          rev={rev}
          mode={{ mode: 'groups', group: 'g1', file: null }}
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
      </RootStoreProvider>,
    );
    const headers = [...m.host.querySelectorAll('.file-h')];
    expect(headers).toHaveLength(2);
    const links = (h: Element) => [...h.querySelectorAll('.also-in button')];

    // Three hunks of a.ts in g2 used to give three identical links.
    const a = links(headers[0]!);
    expect(a.map((b) => b.textContent)).toEqual(['2', '3']);
    // The title stays in the accessible name.
    expect(a.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Also in group 2 “Group g2”',
      'Also in group 3 “Group g3”',
    ]);
    // b.ts lives wholly in the open group.
    expect(links(headers[1]!)).toEqual([]);
    expect(headers[1]!.querySelector('.also-in')).toBeNull();

    // The row shrinks ahead of the file name instead of pushing it out —
    // or pushing the Viewed toggle out of the card.
    const row = headers[0]!.querySelector('.also-in')!;
    expect(row.className).toContain('shrink-[100]');
    expect(row.className).toContain('min-w-0');
    expect(row.className).toContain('overflow-hidden');
    expect(headers[0]!.querySelector('.viewed-toggle')).not.toBeNull();
  });
});
