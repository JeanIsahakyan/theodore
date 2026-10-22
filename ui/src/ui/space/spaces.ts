/**
 * Spaces (docs/spaces.md): pure rules for the hidden build mode — whether
 * it's on, which spaces a workspace lists, what each one's sidebar glyph
 * says, and which "branch reviews" are really a space's live diff.
 */
import type {
  PrId,
  PrSummary,
  Setting,
  Space,
  SpaceMode,
} from '../../gen/contract';
import { ALL, type WorkspaceId } from '../../core/workspaces';

/** The per-machine switch (Settings → Labs). */
export const BUILD_MODE_KEY = 'labs.build_mode';

/** `settings` rows are `{ key, scope, value }`; only the user scope counts. */
function userSetting(
  settings: Pick<Setting, 'key' | 'scope' | 'value'>[],
  key: string,
): Pick<Setting, 'value'> | undefined {
  return settings.find((s) => s.key === key && s.scope === 'user');
}

/** Build mode is on when the build flag says so, or the user turned it on. */
export function buildModeOn(
  flag: boolean,
  settings: Pick<Setting, 'key' | 'scope' | 'value'>[],
): boolean {
  return flag || userSetting(settings, BUILD_MODE_KEY)?.value === true;
}

/** Settings → Labs is listed once the `labs.build_mode` row exists at all
 *  (on or off) — creating it is the deliberate first step. */
export function labsVisible(
  flag: boolean,
  settings: Pick<Setting, 'key' | 'scope' | 'value'>[],
): boolean {
  return flag || userSetting(settings, BUILD_MODE_KEY) !== undefined;
}

/** The `chat_message.pr` key of a space's transcript. */
export const spaceChatKey = (space: string): PrId => `space:${space}`;

/** A space review's `PrRef::host_id` is its checkpoint ref. */
export const SPACE_REF_PREFIX = 'refs/theodore/spaces/';

/** A branch review that is a space's live diff — listed with the space,
 *  not under Local branches. */
export function isSpaceReview(p: Pick<PrSummary, 'pr'>): boolean {
  return p.pr.host_id?.startsWith(SPACE_REF_PREFIX) ?? false;
}

/** Spaces the workspace lists: its project's (All: every one), archived
 *  ones left out, most recently active first. */
export function spacesIn(ws: WorkspaceId, spaces: Space[]): Space[] {
  return spaces
    .filter((s) => s.status !== 'archived')
    .filter((s) => ws === ALL || s.project === ws)
    .sort((a, b) => b.updated_at - a.updated_at);
}

export type SpaceGlyph = 'running' | 'unseen' | 'idle' | 'failed';

/** What the sidebar shows next to a space (docs/spaces.md §3): a finished
 *  turn you haven't looked at reads as waiting for you. `seenAt` is when
 *  the space page was last open, kept locally. */
export function spaceGlyph(
  s: Pick<Space, 'status' | 'updated_at' | 'turns'>,
  seenAt: number | undefined,
): SpaceGlyph {
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  if (s.turns > 0 && (seenAt ?? 0) < s.updated_at) return 'unseen';
  return 'idle';
}

/** A turn just ended (running → anything else): what to tell you if you're
 *  not looking at the space. `null` when nothing finished. */
export function turnEnded(
  prev: Pick<Space, 'status'> | undefined,
  next: Pick<Space, 'status' | 'name' | 'error'>,
): { level: 'info' | 'error'; text: string } | null {
  if (prev?.status !== 'running' || next.status === 'running') return null;
  if (next.status === 'failed') {
    return {
      level: 'error',
      text: `${next.name}: turn failed${next.error ? ` — ${next.error}` : ''}`,
    };
  }
  return { level: 'info', text: `${next.name}: turn done` };
}

/** Per-space spend limit (docs/spaces.md §12), its own key — not the PR
 *  review budget. */
export const SPACE_BUDGET_KEY = 'budget.per_space_usd';
/** Days after a space is done before it archives itself; 0 = never. */
export const AUTO_ARCHIVE_KEY = 'spaces.auto_archive_days';
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7;

/** `budget.per_space_usd` for a repo: its `repo:<slug>` row (from the
 *  repo's `.review/config.yaml`) wins over the user's. `null` = no limit. */
export function spaceBudget(
  settings: Pick<Setting, 'key' | 'scope' | 'value'>[],
  repoSlug: string,
): number | null {
  const rows = settings.filter((s) => s.key === SPACE_BUDGET_KEY);
  const row =
    rows.find((s) => s.scope === `repo:${repoSlug}`) ??
    rows.find((s) => s.scope === 'user');
  return typeof row?.value === 'number' && row.value > 0 ? row.value : null;
}

/** `spaces.auto_archive_days`, user scope; unset or invalid = 7. */
export function autoArchiveDays(
  settings: Pick<Setting, 'key' | 'scope' | 'value'>[],
): number {
  const v = userSetting(settings, AUTO_ARCHIVE_KEY)?.value;
  return typeof v === 'number' && v >= 0 && Number.isFinite(v)
    ? Math.floor(v)
    : DEFAULT_AUTO_ARCHIVE_DAYS;
}

/** "$0.42 / $5.00", or just "$0.42" without a budget. */
export function fmtSpend(usd: number, budget: number | null): string {
  const spent = `$${usd.toFixed(2)}`;
  return budget == null ? spent : `${spent} / $${budget.toFixed(2)}`;
}

/** Where a space is in its lifecycle (docs/spaces.md §1). `opening`: the
 *  branch is pushed and the PR is being opened (or the attempt failed —
 *  Open PR again is safe, it never opens a second one). */
export type SpaceStage =
  'drafting' | 'opening' | 'in_review' | 'merged_locally' | 'branch' | 'done';

export function spaceStage(
  s: Pick<Space, 'pr' | 'shipped' | 'done_at'>,
  prState?: PrSummary['state'],
): SpaceStage {
  if (s.shipped?.how === 'merged_locally') return 'merged_locally';
  if (s.shipped?.how === 'branch') return 'branch';
  if (s.pr) return prState === 'merged' || s.done_at ? 'done' : 'in_review';
  if (s.shipped?.how === 'pr') return 'opening';
  return 'drafting';
}

export const STAGE_LABEL: Record<SpaceStage, string> = {
  drafting: 'Drafting',
  opening: 'Opening PR',
  in_review: 'In review',
  merged_locally: 'Merged locally',
  branch: 'Kept as branch',
  done: 'Merged',
};

/** Turns since the last ship that a Push would send. */
export function unshipped(s: Pick<Space, 'shipped' | 'head_sha'>): boolean {
  return s.shipped != null && s.shipped.head !== s.head_sha;
}

/** The title Open PR / Merge locally proposes: the goal's first line,
 *  else the space's name. */
export function defaultTitle(s: Pick<Space, 'goal' | 'name'>): string {
  const line = s.goal
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? s.name;
}

/** "3 files +42 −7" for the changes pane header. */
export function diffStat(
  files: { additions: number; deletions: number }[],
): string {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const n = files.length;
  return `${n} file${n === 1 ? '' : 's'}  +${add} −${del}`;
}

/** What a key does on a space page (outside the composer). */
export type SpaceKeyAction =
  'focus' | 'mode' | 'review' | 'ship' | 'ship-alt' | 'open-pr' | 'archive';

/** `key` is the layout-independent letter (`latinKey`). Archive needs ⇧ —
 *  it removes the worktree, so a stray `e` must not do it. */
export function spaceKeyAction(
  key: string,
  shift: boolean,
): SpaceKeyAction | null {
  switch (key) {
    case 'c':
    case '/':
      return shift ? null : 'focus';
    case 'm':
      return shift ? null : 'mode';
    case 'r':
      return shift ? null : 'review';
    case 'p':
      return shift ? 'ship-alt' : 'ship';
    case 'o':
      return shift ? null : 'open-pr';
    case 'e':
      return shift ? 'archive' : null;
    default:
      return null;
  }
}

const MODE_ORDER: SpaceMode[] = ['ask', 'edit', 'run'];

/** `M` cycles Ask → Edit → Run → Ask. */
export function nextMode(m: SpaceMode): SpaceMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]!;
}
