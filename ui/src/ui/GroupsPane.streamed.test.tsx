/** Streamed grouping in the review: groups render as they arrive while
 *  `in_progress` is set, with a status row below them, and a later reorder
 *  never moves a group the user opened or read. */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { mount, type Mounted } from '../test/dom';
import type { FileDiff, Group, Grouping, Revision } from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { GroupsPane } from './GroupsPane';

const PR = 'gh:acme/app#1';
const HEAD = 'h'.repeat(40);

const file = (path: string, hunk: string): FileDiff => ({
  path,
  old_path: null,
  status: 'modified',
  similarity: null,
  old_mode: null,
  new_mode: null,
  flags: [],
  additions: 1,
  deletions: 0,
  hunks: [
    {
      id: hunk,
      path,
      old_start: 1,
      old_lines: 0,
      new_start: 1,
      new_lines: 1,
      header: '',
      lines: [{ kind: 'add', text: 'x', old_no: null, new_no: 1 }],
    },
  ],
});

const rev: Revision = {
  base: 'b'.repeat(40),
  head: HEAD,
  files: [
    file('src/a.ts', 'ha'),
    file('src/b.ts', 'hb'),
    file('src/c.ts', 'hc'),
  ],
};

const g = (id: string, hunks: string[]): Group => ({
  id,
  title: `Group ${id}`,
  why: `Explains ${id}.`,
  kind: 'normal',
  risk: null,
  check: [],
  hunks,
  outliers: [],
});

function put(store: RootStore, grouping: Grouping) {
  act(() => store.sync.pool.put('grouping', PR, grouping));
}

function seed(): RootStore {
  const store = new RootStore();
  store.sync.pool.put('pr', PR, {
    pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
    url: 'https://example.test/acme/app/pull/1',
    head_sha: HEAD,
  });
  store.ephemeral.handle({
    type: 'grouping',
    pr: PR,
    running: true,
    error: null,
  });
  return store;
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const titles = () =>
  [...m!.host.querySelectorAll('.gtitle')].map((e) => e.textContent);

function pane(store: RootStore, group: string | null = null) {
  return (
    <RootStoreProvider store={store}>
      <GroupsPane
        pr={PR}
        rev={rev}
        mode={{ mode: 'groups', group, file: null }}
        setMode={() => {}}
        since={null}
        sinceOnly={false}
      />
    </RootStoreProvider>
  );
}

describe('GroupsPane during a streamed grouping', () => {
  it('shows groups as they arrive, with a running status row, then removes it when done', async () => {
    const store = seed();
    store.sync.pool.put('grouping', PR, {
      rev: HEAD,
      groups: [g('g1', ['ha'])],
      in_progress: true,
    });
    m = await mount(pane(store));
    expect(titles()).toEqual(['Group g1']);
    expect(m.host.querySelector('.grouping-more')).not.toBeNull();
    expect(m.host.querySelector('.grouping-more')?.textContent).toContain(
      'Grouping…',
    );
    expect(m.host.textContent).toContain('0 of 1 group read so far');
    expect(m.host.textContent).not.toContain('All groups read');

    // A second group arrives: the row is replaced, groups append above it.
    put(store, {
      rev: HEAD,
      groups: [g('g1', ['ha']), g('g2', ['hb'])],
      in_progress: true,
    });
    expect(titles()).toEqual(['Group g1', 'Group g2']);
    expect(m.host.querySelector('.grouping-more')).not.toBeNull();
    expect(m.host.textContent).toContain('0 of 2 groups read so far');

    // The final grouping lands: the status row is gone, counters settle.
    put(store, {
      rev: HEAD,
      groups: [g('g1', ['ha']), g('g2', ['hb']), g('g3', ['hc'])],
    });
    expect(titles()).toEqual(['Group g1', 'Group g2', 'Group g3']);
    expect(m.host.querySelector('.grouping-more')).toBeNull();
    expect(m.host.querySelector('.grouping-stopped')).toBeNull();
    expect(m.host.textContent).toContain('0 of 3 groups read');
    expect(m.host.textContent).not.toContain('read so far');

    act(() => {
      store.sync.pool.put('hunk_read', `${PR}:ha`, { pr: PR, hunk: 'ha' });
      store.sync.pool.put('hunk_read', `${PR}:hb`, { pr: PR, hunk: 'hb' });
      store.sync.pool.put('hunk_read', `${PR}:hc`, { pr: PR, hunk: 'hc' });
    });
    expect(m.host.textContent).toContain('All groups read');
  });

  it('keeps an opened or read group where it was when the final order lands', async () => {
    const store = seed();
    store.sync.pool.put('grouping', PR, {
      rev: HEAD,
      groups: [g('g1', ['ha']), g('g2', ['hb'])],
      in_progress: true,
    });
    store.sync.pool.put('hunk_read', `${PR}:hb`, { pr: PR, hunk: 'hb' });
    store.models.markGroupOpened(PR, 'g1');
    m = await mount(pane(store, 'g1'));
    expect(titles()).toEqual(['Group g1', 'Group g2']);

    // One more group streams in, then the final pass wants g3 first.
    put(store, {
      rev: HEAD,
      groups: [g('g1', ['ha']), g('g2', ['hb']), g('g3', ['hc'])],
      in_progress: true,
    });
    expect(titles()).toEqual(['Group g1', 'Group g2', 'Group g3']);

    put(store, {
      rev: HEAD,
      groups: [g('g3', ['hc']), g('g2', ['hb']), g('g1', ['ha'])],
    });
    expect(titles()).toEqual(['Group g1', 'Group g2', 'Group g3']);
    expect(m.host.textContent).toContain('1 of 3 groups read');
  });

  it('shows the stopped row, not the running row, once the agent stops mid-run', async () => {
    const store = seed();
    store.ephemeral.handle({
      type: 'grouping',
      pr: PR,
      running: false,
      error: 'agent crashed',
    });
    store.sync.pool.put('grouping', PR, {
      rev: HEAD,
      groups: [g('g1', ['ha'])],
      in_progress: true,
    });
    m = await mount(pane(store));
    expect(m.host.querySelector('.grouping-more')).toBeNull();
    const stopped = m.host.querySelector('.grouping-stopped');
    expect(stopped).not.toBeNull();
    expect(stopped?.textContent).toContain(
      'Grouping stopped before it finished',
    );
    expect(stopped?.textContent).toContain('agent crashed');
    expect(stopped?.textContent).toContain('regroup to finish it');
  });
});
