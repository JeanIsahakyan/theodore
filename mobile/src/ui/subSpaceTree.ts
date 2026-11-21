/**
 * A followed space's sub-spaces as a tree (docs/fleet.md "What a hosted
 * space's agent may do"): the rows the host mirrors (`mirror{sub_space}`),
 * flattened for the space screen, counted for the drawer. Pure, so the
 * tests read it.
 *
 * ```text
 * rs_root
 *   ├ child A           depth 0   Running · Edit
 *   │   └ grandchild    depth 1   Merged · Edit
 *   └ child B           depth 0   Waiting for you · Plan
 * orphan (parent gone)  depth 0, after the tree
 *
 * drawer: "3 sub-spaces, 1 running, 1 waiting"
 * ```
 */
import type { MirroredSubSpace } from '../gen/fleet';
import type { Tone } from './logic';

export type SubSpaceState =
  'running' | 'waiting' | 'done' | 'merged' | 'failed';

export const SUB_STATE_LABEL: Record<SubSpaceState, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Done',
  merged: 'Merged',
  failed: 'Failed',
};

export const SUB_STATE_TONE: Record<SubSpaceState, Tone> = {
  running: 'accent',
  waiting: 'warning',
  done: 'neutral',
  merged: 'success',
  failed: 'danger',
};

/**
 * What a sub-space is doing, as its chip says it. `done` (merged into its
 * parent, or shipped) wins; the host's words otherwise (`spaces_list`'s):
 * `running` / `setting_up` run, `question` / `waiting` wait for a person,
 * `failed` failed, the rest (`idle`, `archived`, unknown) are done.
 */
export function subSpaceState(
  s: Pick<MirroredSubSpace, 'status' | 'done'>,
): SubSpaceState {
  if (s.done) return 'merged';
  switch (s.status) {
    case 'running':
    case 'setting_up':
      return 'running';
    case 'question':
    case 'waiting':
      return 'waiting';
    case 'failed':
      return 'failed';
    default:
      return 'done';
  }
}

export interface SubSpaceRow {
  sub: MirroredSubSpace;
  /** 0: a child of the space; 1: a grandchild; and so on. */
  depth: number;
  state: SubSpaceState;
}

/**
 * The sub-spaces of `root`, parents before their children, siblings in the
 * order first seen. A row whose parent isn't in the tree (gone, or not
 * arrived yet) is shown at the top level after it, never hidden; a loop
 * of parents is cut where it closes.
 */
export function subSpaceRows(
  root: string,
  subs: Readonly<Record<string, MirroredSubSpace>>,
): SubSpaceRow[] {
  const list = Object.values(subs);
  const children = new Map<string, MirroredSubSpace[]>();
  for (const s of list) {
    const kids = children.get(s.parent);
    if (kids) kids.push(s);
    else children.set(s.parent, [s]);
  }
  const out: SubSpaceRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const sub of children.get(parent) ?? []) {
      if (seen.has(sub.space)) continue;
      seen.add(sub.space);
      out.push({ sub, depth, state: subSpaceState(sub) });
      walk(sub.space, depth + 1);
    }
  };
  walk(root, 0);
  for (const s of list) {
    if (seen.has(s.space)) continue;
    // The top of what's left: walk up while the parent is still unplaced.
    let top = s;
    const path = new Set<string>([top.space]);
    for (;;) {
      const up = subs[top.parent];
      if (!up || seen.has(up.space) || path.has(up.space)) break;
      path.add(up.space);
      top = up;
    }
    seen.add(top.space);
    out.push({ sub: top, depth: 0, state: subSpaceState(top) });
    walk(top.space, 1);
  }
  return out;
}

export interface SubSpaceCounts {
  total: number;
  running: number;
  waiting: number;
}

export function subSpaceCounts(
  subs: Readonly<Record<string, MirroredSubSpace>> | undefined,
): SubSpaceCounts {
  const c: SubSpaceCounts = { total: 0, running: 0, waiting: 0 };
  for (const s of Object.values(subs ?? {})) {
    c.total += 1;
    const state = subSpaceState(s);
    if (state === 'running') c.running += 1;
    else if (state === 'waiting') c.waiting += 1;
  }
  return c;
}

/** "3 sub-spaces, 1 running, 1 waiting"; `null` with none. */
export function subSpaceSummary(
  subs: Readonly<Record<string, MirroredSubSpace>> | undefined,
): string | null {
  const c = subSpaceCounts(subs);
  if (c.total === 0) return null;
  const parts = [`${c.total} sub-space${c.total === 1 ? '' : 's'}`];
  if (c.running > 0) parts.push(`${c.running} running`);
  if (c.waiting > 0) parts.push(`${c.waiting} waiting`);
  return parts.join(', ');
}
