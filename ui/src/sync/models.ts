/** Typed, per-model accessors over the pool — the ergonomic front door for components. */
import type { Group, Thread } from '../gen/contract';
import type { ObjectPool } from './ObjectPool';
import type { ModelRows } from './types';

/** Read-only accessor over rows derived from other models. */
function derived<T extends { id: string }>(rows: () => T[]) {
  return {
    get: (id: string) => rows().find((r) => r.id === id),
    all: rows,
    where: (pred: (row: T) => boolean) => rows().filter(pred),
  };
}

export function modelAccessors(pool: ObjectPool) {
  const of = <K extends keyof ModelRows>(model: K) => ({
    get: (id: string) => pool.get(model, id),
    all: () => pool.all(model),
    where: (pred: (row: ModelRows[K]) => boolean) => pool.where(model, pred),
  });
  return {
    prSummaries: of('pr'),
    prDetails: of('pr_detail'),
    groupings: of('grouping'),
    inboxStates: of('inbox_state'),
    hunkReads: of('hunk_read'),
    fileViews: of('file_viewed'),
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
    drafts: of('draft'),
    findings: of('finding'),
    tasks: of('task'),
    skillRuns: of('skill_run'),
    chatMessages: of('chat_message'),
    settings: of('setting'),
  };
}

export type ModelAccessors = ReturnType<typeof modelAccessors>;
