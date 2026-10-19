/** Typed, per-model accessors over the pool — the ergonomic front door for components. */
import type { Group, Side, Thread } from '../gen/contract';
import type { ObjectPool } from './ObjectPool';
import { groupKey, groupedIndex, type GroupLookup } from './grouped';
import type { ModelRows } from './types';

/** Read-only accessor over rows derived from other models. */
function derived<T extends { id: string }>(rows: () => T[]) {
  return {
    get: (id: string) => rows().find((r) => r.id === id),
    all: rows,
    where: (pred: (row: T) => boolean) => rows().filter(pred),
  };
}

/** Builds the index on first use, so models nobody indexes cost nothing. */
function lazy<T>(make: () => GroupLookup<T>): GroupLookup<T> {
  let idx: GroupLookup<T> | undefined;
  return (key) => (idx ??= make())(key);
}

type PrScoped = {
  [K in keyof ModelRows]: ModelRows[K] extends { pr: string } ? K : never;
}[keyof ModelRows];

export function modelAccessors(pool: ObjectPool) {
  const of = <K extends keyof ModelRows>(model: K) => ({
    get: (id: string) => pool.get(model, id),
    all: () => pool.all(model),
    where: (pred: (row: ModelRows[K]) => boolean) => pool.where(model, pred),
  });
  /** `of` plus `byPr`: live rows of one PR, in pool order (same as
   *  `where((r) => r.pr === pr)`), re-rendering only on that PR's changes. */
  const scoped = <K extends PrScoped>(model: K) => {
    const byPr = lazy(() =>
      groupedIndex<ModelRows[K]>((add) => {
        for (const r of pool.all(model)) add((r as { pr: string }).pr, r);
      }),
    );
    return { ...of(model), byPr: (pr: string) => byPr(pr) };
  };
  /** Rows keyed by an anchor line: `pr`, path, side and line number. */
  const byLine = <K extends 'draft' | 'finding'>(
    model: K,
    keep: (r: ModelRows[K]) => boolean = () => true,
  ) =>
    lazy(() =>
      groupedIndex<ModelRows[K]>((add) => {
        for (const r of pool.all(model)) {
          if (!keep(r)) continue;
          const a = r.anchor;
          add(groupKey(r.pr, a.path, a.side, a.line), r);
        }
      }),
    );

  const hunkReadIdx = lazy(() =>
    groupedIndex<true>((add) => {
      for (const r of pool.all('hunk_read')) add(groupKey(r.pr, r.hunk), true);
    }),
  );
  const fileViewIdx = lazy(() =>
    groupedIndex<ModelRows['file_viewed']>((add) => {
      for (const r of pool.all('file_viewed')) add(groupKey(r.pr, r.path), r);
    }),
  );
  const draftsAt = byLine('draft');
  const findingsAt = byLine('finding', (f) => f.state !== 'ignored');
  // Thread ids, not objects: a `pr_detail` row is replaced wholesale on any
  // change (checks, labels), and only the thread ids feed the diff lines.
  const threadIdsAt = lazy(() =>
    groupedIndex<string>((add) => {
      for (const d of pool.all('pr_detail')) {
        for (const t of d.threads) {
          const a = t.anchor;
          if (a) add(groupKey(d.id, a.path, a.side, a.line), t.id);
        }
      }
    }),
  );

  return {
    prSummaries: of('pr'),
    prDetails: of('pr_detail'),
    groupings: of('grouping'),
    inboxStates: of('inbox_state'),
    hunkReads: {
      ...scoped('hunk_read'),
      isRead: (pr: string, hunk: string) =>
        hunkReadIdx(groupKey(pr, hunk)).length > 0,
    },
    fileViews: {
      ...scoped('file_viewed'),
      /** The row for one file, last one wins — same as `where(...).at(-1)`. */
      of: (pr: string, path: string) => fileViewIdx(groupKey(pr, path)).at(-1),
    },
    /** Groups of one PR's grouping, in reading order. Group ids are only
     *  unique within a PR — always look groups up through this. */
    groupsOf: (pr: string) => pool.get('grouping', pr)?.groups ?? [],
    /** Groups of every loaded grouping, in reading order. */
    groups: derived<Group & { id: string }>(() =>
      pool.all('grouping').flatMap((g) => g.groups),
    ),
    /** Review threads of every loaded PR (they live inside `pr_detail`). */
    threads: derived<Thread & { id: string }>(() =>
      pool.all('pr_detail').flatMap((d) => d.threads),
    ),
    /** Ids of the threads anchored on one line of one PR. */
    threadIdsAt: (pr: string, path: string, side: Side, line: number) =>
      threadIdsAt(groupKey(pr, path, side, line)),
    drafts: {
      ...scoped('draft'),
      at: (pr: string, path: string, side: Side, line: number) =>
        draftsAt(groupKey(pr, path, side, line)),
    },
    findings: {
      ...scoped('finding'),
      /** Findings on one line, minus ignored ones. */
      shownAt: (pr: string, path: string, side: Side, line: number) =>
        findingsAt(groupKey(pr, path, side, line)),
    },
    tasks: scoped('task'),
    skillRuns: scoped('skill_run'),
    chatMessages: scoped('chat_message'),
    settings: of('setting'),
    projects: of('project'),
  };
}

export type ModelAccessors = ReturnType<typeof modelAccessors>;
