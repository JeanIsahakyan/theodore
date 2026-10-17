/** Typed, per-model accessors over the pool — the ergonomic front door for components. */
import type { ObjectPool } from './ObjectPool';
import type { ModelRows } from './types';

export function modelAccessors(pool: ObjectPool) {
  const of = <K extends keyof ModelRows>(model: K) => ({
    get: (id: string) => pool.get(model, id),
    all: () => pool.all(model),
    where: (pred: (row: ModelRows[K]) => boolean) => pool.where(model, pred),
  });
  return {
    prSummaries: of('pr_summary'),
    inboxStates: of('inbox_state'),
    hunkReads: of('hunk_read'),
    fileViews: of('file_viewed'),
    groups: of('group'),
    threads: of('thread'),
    drafts: of('draft'),
    findings: of('finding'),
    tasks: of('task'),
    skillRuns: of('skill_run'),
    chatMessages: of('chat_message'),
    settings: of('setting'),
  };
}

export type ModelAccessors = ReturnType<typeof modelAccessors>;
