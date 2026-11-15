/**
 * The desktop's own rows a host mirrors (docs/fleet.md "One space UI:
 * mirrored rows"): the parts of `ui/src/gen/contract.ts` this app renders,
 * copied by hand (mobile never imports from ui/). Generated from Rust there;
 * keep the field names and shapes the same when they change.
 */

export type SpaceMode = 'ask' | 'edit' | 'run' | 'plan';

export type SpaceStatusRow = 'idle' | 'running' | 'failed' | 'archived';

export type Author = { kind: 'me' } | { kind: 'agent'; agent: string };

/** A file a space turn changed (`ChatMessage::changed_files`). */
export interface TurnFile {
  path: string;
  additions: number;
  deletions: number;
}

/** One thing an agent did in a space turn (`ChatMessage::activity`). */
export type TurnStep =
  | { kind: 'text'; text: string; parent?: string | null }
  | { kind: 'thinking'; text: string; parent?: string | null }
  | {
      kind: 'tool';
      name: string;
      target: string | null;
      ok: boolean | null;
      id?: string | null;
      parent?: string | null;
      detail?: string | null;
      summary?: string | null;
      added?: number | null;
      removed?: number | null;
      background?: boolean;
    };

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  /** `space:rs_…` on a mirrored row. */
  pr: string;
  author: Author;
  text: string;
  at: number;
  failed?: string | null;
  attachments?: Attachment[];
  /** A space message waiting for its turn. */
  queued?: { seq: number } | null;
  from_tasks?: string[];
  activity?: TurnStep[];
  duration_ms?: number | null;
  changed_files?: TurnFile[];
  model?: string | null;
  text_in_steps?: boolean;
  /** The run that wrote this reply (`space:rs_…:<message>`). */
  run?: string | null;
  mode?: SpaceMode | null;
}

export interface SpaceQuestionItem {
  question: string;
  options: string[];
  multi?: boolean;
}

/** Questions the agent asked mid-turn; `id` is the fleet ask's id. */
export interface SpaceQuestion {
  id: string;
  run: string;
  questions: SpaceQuestionItem[];
  asked_at: number;
}

export interface SpaceTurn {
  message: string;
  reply: string;
  undone?: boolean;
  steered?: string[];
  /** A Plan-mode turn's plan: Approve / Revise. */
  plan?: string | null;
  stopped?: boolean;
}

export type SpaceProgressState = 'pending' | 'active' | 'done';

export interface SpaceProgress {
  steps: { label: string; state: SpaceProgressState }[];
  note?: string | null;
  at: number;
}

/** A desktop `Space` row, local-only fields blanked by the host. */
export interface Space {
  id: string;
  name: string;
  goal: string;
  branch: string;
  status: SpaceStatusRow;
  agent: string;
  model?: string | null;
  mode: SpaceMode;
  turns: number;
  /** The turn in flight (`space:rs_…:<message>`). */
  run?: string | null;
  error?: string | null;
  turn_log?: SpaceTurn[];
  title?: string | null;
  progress?: SpaceProgress | null;
  /** What an approved plan is implemented in; none = Edit. */
  build_mode?: SpaceMode | null;
  question?: SpaceQuestion | null;
  blank?: boolean;
  created_at: number;
  updated_at: number;
}
