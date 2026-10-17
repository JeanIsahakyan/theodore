/**
 * `WireRow.model` / `MutationOp.model` are plain strings on the wire (see
 * `crates/contract`); this is the UI's side of that contract — the set of
 * model names it knows how to pool, and the row shape each one carries.
 *
 * NOTE for the store/app crates: these strings must match what `app`/`store`
 * write into the sync log. There is no shared enum today (see final report,
 * "contract changes needed") — keep this list and the Rust side in sync by
 * hand until there is one.
 */
import type {
  ChatMessage,
  Draft,
  FileViewedRow,
  Finding,
  Group,
  HunkRead,
  InboxState,
  PrSummary,
  Setting,
  SkillRun,
  Task,
  Thread,
} from '../gen/contract';

export const MODEL_NAMES = [
  'pr_summary',
  'inbox_state',
  'hunk_read',
  'file_viewed',
  'group',
  'thread',
  'draft',
  'finding',
  'task',
  'skill_run',
  'chat_message',
  'setting',
] as const;

export type ModelName = (typeof MODEL_NAMES)[number];

/** A row as the pool stores it: the typed payload, plus the pool's own key
 *  always stamped on as `id` — `PrSummary` and `Setting` carry no id field
 *  of their own, so this is the only place it survives. */
type WithId<T> = T & { id: string };

/** Row shape stored in the pool for each model name. */
export interface ModelRows {
  pr_summary: WithId<PrSummary>;
  inbox_state: WithId<InboxState>;
  hunk_read: WithId<HunkRead>;
  file_viewed: WithId<FileViewedRow>;
  group: WithId<Group>;
  thread: WithId<Thread>;
  draft: WithId<Draft>;
  finding: WithId<Finding>;
  task: WithId<Task>;
  skill_run: WithId<SkillRun>;
  chat_message: WithId<ChatMessage>;
  setting: WithId<Setting>;
}

/**
 * The pool is keyed by whatever string core assigns: `WireRow.id` on
 * bootstrap/sync, `MutationOp.id` on a local write. Models without a natural
 * single-field id (`inbox_state`, `hunk_read`, `file_viewed`, `setting`) are
 * expected to use a composite string (e.g. `"<pr>:<hunk>"`) — core and the
 * UI must agree on that string since it is never recomputed locally.
 */
