/**
 * Spaces (docs/spaces.md): pure rules for the hidden build mode — whether
 * it's on, which spaces a workspace lists, what each one's sidebar glyph
 * says, and which "branch reviews" are really a space's live diff.
 */
import type { PrId, PrSummary, Setting, Space } from '../../gen/contract';
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

/** "3 files +42 −7" for the changes pane header. */
export function diffStat(
  files: { additions: number; deletions: number }[],
): string {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const n = files.length;
  return `${n} file${n === 1 ? '' : 's'}  +${add} −${del}`;
}
