/**
 * A big synthetic PR for DOM tests of the diff: ~100 files, ~3000 lines,
 * ~50 findings, one group holding every hunk, and a harness that owns the
 * focus/composer state the way `Review` does.
 */
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DiffLine,
  FileDiff,
  Hunk,
  HunkId,
  Revision,
} from '../gen/contract';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { DiffPane, type ComposerState } from '../ui/DiffPane';
import type { ReviewMode } from '../ui/GroupsPane';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// HeroUI measures with ResizeObserver; jsdom has none and nothing here
// depends on a real size.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

export const PR = 'gh:acme/app#1';
const HEAD = 'h'.repeat(40);
const FILES = 100;
const HUNKS_PER_FILE = 2;
const LINES_PER_HUNK = 15;

function hunk(f: number, j: number): Hunk {
  const start = 1 + j * 60;
  const lines: DiffLine[] = [];
  let o = start;
  let n = start;
  for (let i = 0; i < LINES_PER_HUNK; i++) {
    const kind = i % 5 === 1 ? 'del' : i % 5 === 2 ? 'add' : 'ctx';
    lines.push({
      kind,
      text: `const v${i} = compute(${f}, ${j}, ${i}); // line`,
      old_no: kind === 'add' ? null : o,
      new_no: kind === 'del' ? null : n,
    });
    if (kind !== 'add') o++;
    if (kind !== 'del') n++;
  }
  return {
    id: `f${f}h${j}`,
    path: `src/mod${f}/file${f}.ts`,
    old_start: start,
    old_lines: o - start,
    new_start: start,
    new_lines: n - start,
    header: `function f${f}()`,
    lines,
  };
}

export function revision(): Revision {
  const files: FileDiff[] = [];
  for (let f = 0; f < FILES; f++) {
    const hunks = Array.from({ length: HUNKS_PER_FILE }, (_, j) => hunk(f, j));
    files.push({
      path: `src/mod${f}/file${f}.ts`,
      old_path: null,
      status: 'modified',
      similarity: null,
      old_mode: null,
      new_mode: null,
      flags: [],
      additions: 3 * HUNKS_PER_FILE,
      deletions: 3 * HUNKS_PER_FILE,
      hunks,
    });
  }
  return { base: 'b'.repeat(40), head: HEAD, files };
}

/** A new-side line of hunk `f{f}h0`, the `i`-th one in the hunk. */
export const newLine = (rev: Revision, f: number, i: number) =>
  rev.files[f]!.hunks[0]!.lines.filter((l) => l.new_no != null)[i]!.new_no!;

export function seed(store: RootStore, rev: Revision) {
  const pool = store.sync.pool;
  pool.put('pr', PR, {
    pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
    url: 'https://example.test/acme/app/pull/1',
    head_sha: HEAD,
  });
  pool.put('pr_detail', PR, { threads: [], checks: [], commits: [] });
  pool.put('grouping', PR, {
    rev: HEAD,
    groups: [
      {
        id: 'g1',
        title: 'Everything',
        why: 'all of it',
        kind: 'normal',
        risk: null,
        check: [],
        hunks: rev.files.flatMap((f) => f.hunks.map((h) => h.id)),
        outliers: [],
      },
    ],
  });
  for (let k = 0; k < 50; k++) {
    const f = (k * 7) % FILES;
    putFinding(store, rev, `fd${k}`, f, k % 3);
  }
}

export function putFinding(
  store: RootStore,
  rev: Revision,
  id: string,
  f: number,
  i: number,
) {
  store.sync.pool.put('finding', id, {
    id,
    pr: PR,
    skill: 'review',
    agents: [],
    anchor: {
      rev: HEAD,
      path: rev.files[f]!.path,
      side: 'new',
      line: newLine(rev, f, i),
      start_line: null,
      start_side: null,
    },
    severity: 'warn',
    title: `finding ${id}`,
    body: '',
    state: 'open',
    fix: null,
  });
}

export interface Controls {
  setFocus: (h: HunkId | null) => void;
  setComposer: (c: ComposerState | null) => void;
}

const MODE: ReviewMode = { mode: 'groups', group: 'g1', file: null };
const noop = () => {};

export function Harness({
  rev,
  onReady,
}: {
  rev: Revision;
  onReady: (c: Controls) => void;
}) {
  const [focusHunk, setFocusHunk] = useState<HunkId | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  useEffect(() => onReady({ setFocus: setFocusHunk, setComposer }), [onReady]);
  return (
    <DiffPane
      pr={PR}
      rev={rev}
      mode={MODE}
      setMode={noop}
      since={null}
      sinceOnly={false}
      baselineSha={null}
      tour={null}
      focusHunk={focusHunk}
      setFocusHunk={setFocusHunk}
      composer={composer}
      setComposer={setComposer}
      expandHunk={null}
    />
  );
}

/** Renders the harness into a fresh store seeded with the big PR. */
export async function mountBigPr() {
  const rev = revision();
  const store = new RootStore();
  seed(store, rev);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let controls: Controls = { setFocus: noop, setComposer: noop };
  await act(async () =>
    root.render(
      <RootStoreProvider store={store}>
        <Harness
          rev={rev}
          onReady={(c) => {
            controls = c;
          }}
        />
      </RootStoreProvider>,
    ),
  );
  return {
    rev,
    store,
    host,
    controls: () => controls,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
