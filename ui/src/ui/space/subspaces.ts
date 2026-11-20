/**
 * Sub-spaces (docs/spaces.md "Seeing sub-spaces and agents"): a space another
 * space's agent started sits under that space, not beside it. Pure rules for
 * the sidebar's tree, the space page's Agents panel and the Agents view.
 *
 * ```text
 * listed            parent listed?        shows as
 * ───────────────   ───────────────────   ─────────────────────────────
 * top-level space   —                     a root
 * child             yes                   under it, one step in
 * child             archived / elsewhere  a root, "from <parent>"
 * child             gone                  a root, "from a removed space"
 * ```
 *
 * A child's stage, as every surface words it (`childStage`):
 *
 * ```text
 * starting ─▶ running ─┬─▶ done ─▶ merged      (the parent's space_merge)
 *                      ├─▶ waiting for you      (a question)
 *                      └─▶ failed
 * merged, then more turns ─▶ done again: there's work the parent hasn't taken
 * ```
 */
import type { Space } from '../../gen/contract';
import { spaceTitle } from './spaces';

/** How deep the tree goes at most; a deeper (or circular) chain stops here. */
const MAX_DEPTH = 8;

export interface SpaceNode {
  space: Space;
  children: SpaceNode[];
}

/** The id of the space whose agent started `s`, if any. */
export const parentId = (s: Pick<Space, 'parent'>): string | null =>
  s.parent?.space ?? null;

/** `listed` as a tree, in its own order: a child goes under its parent when
 *  that is listed too, else it stays a root. A loop never nests. */
export function nestSpaces(listed: readonly Space[]): SpaceNode[] {
  const byId = new Map(listed.map((s) => [s.id, s]));
  // A parent chain that comes back to itself is no tree: those stay roots.
  const nests = (s: Space): boolean => {
    let at = parentId(s);
    for (let hops = 0; at && hops < MAX_DEPTH; hops += 1) {
      if (at === s.id) return false;
      const up = byId.get(at);
      if (!up) return true;
      at = parentId(up);
    }
    return at == null || at !== s.id;
  };
  const nodes = new Map(
    listed.map((s): [string, SpaceNode] => [s.id, { space: s, children: [] }]),
  );
  const roots: SpaceNode[] = [];
  for (const s of listed) {
    const node = nodes.get(s.id)!;
    const up = parentId(s);
    const parent = up && up !== s.id ? nodes.get(up) : undefined;
    if (parent && nests(s)) parent.children.push(node);
    else roots.push(node);
  }
  // A merged child is done: it goes after its parent's live ones.
  for (const node of nodes.values()) {
    if (node.children.some((c) => mergedIntoParent(c.space))) {
      node.children = [
        ...node.children.filter((c) => !mergedIntoParent(c.space)),
        ...node.children.filter((c) => mergedIntoParent(c.space)),
      ];
    }
  }
  return roots;
}

/** Every space under `node`, nearest first. */
export function descendants(node: SpaceNode): Space[] {
  const out: Space[] = [];
  const walk = (n: SpaceNode, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const c of n.children) {
      out.push(c.space);
      walk(c, depth + 1);
    }
  };
  walk(node, 0);
  return out;
}

/** Its agent waits on your answer. */
export const asking = (s: Pick<Space, 'status' | 'question'>): boolean =>
  s.status === 'running' && !!s.question;

/** Its parent's agent merged it (`space_merge`), and it has no turn since. */
export const mergedIntoParent = (
  s: Partial<Pick<Space, 'shipped' | 'head_sha'>>,
): boolean =>
  s.shipped?.how === 'merged_into_parent' && s.shipped.head === s.head_sha;

/** Merged into its parent once, whatever came after. */
export const everMerged = (s: Pick<Space, 'shipped'>): boolean =>
  s.shipped?.how === 'merged_into_parent';

export type ChildStage =
  'starting' | 'running' | 'asking' | 'failed' | 'done' | 'merged' | 'archived';

export type StageFields = Pick<
  Space,
  'status' | 'question' | 'shipped' | 'head_sha' | 'turns'
>;

/** Where a sub-space stands. */
export function childStage(s: StageFields): ChildStage {
  if (asking(s)) return 'asking';
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  if (mergedIntoParent(s)) return 'merged';
  if (s.status === 'archived') return 'archived';
  return s.turns > 0 ? 'done' : 'starting';
}

export const CHILD_STAGE_LABEL: Record<ChildStage, string> = {
  starting: 'starting',
  running: 'running',
  asking: 'waiting for you',
  failed: 'failed',
  done: 'done',
  merged: 'merged',
  archived: 'archived',
};

/** What a collapsed parent says about what's under it. */
export interface SubtreeStats {
  total: number;
  running: number;
  /** Agents waiting on your answer. */
  asking: number;
}

export function subtreeStats(node: SpaceNode): SubtreeStats {
  const all = descendants(node);
  return {
    total: all.length,
    running: all.filter((s) => s.status === 'running').length,
    asking: all.filter(asking).length,
  };
}

/** "3 sub-spaces", "1 sub-space, 1 running". */
export function subtreeLabel(st: SubtreeStats): string {
  const n = `${st.total} sub-space${st.total === 1 ? '' : 's'}`;
  const parts = [n];
  if (st.running > 0) parts.push(`${st.running} running`);
  if (st.asking > 0) parts.push(`${st.asking} waiting for you`);
  return parts.join(', ');
}

/** One row of a flattened tree. */
export interface SpaceRow {
  space: Space;
  /** 0 for a root. */
  depth: number;
  /** Set on a row with children. */
  stats: SubtreeStats | null;
  /** Its children are hidden. */
  collapsed: boolean;
  /** A root whose parent isn't listed: "from <parent>". */
  from: string | null;
}

/** The tree as the rows a list shows, children right under their parent;
 *  a collapsed parent's are left out. `all` names a parent that isn't
 *  listed (archived, or another workspace's). */
export function spaceRows(
  roots: readonly SpaceNode[],
  collapsed: ReadonlySet<string>,
  all: readonly Space[] = [],
): SpaceRow[] {
  const rows: SpaceRow[] = [];
  const walk = (n: SpaceNode, depth: number) => {
    const has = n.children.length > 0;
    const shut = has && collapsed.has(n.space.id);
    rows.push({
      space: n.space,
      depth,
      stats: has ? subtreeStats(n) : null,
      collapsed: shut,
      from: depth === 0 ? fromLabel(n.space, all) : null,
    });
    if (shut || depth >= MAX_DEPTH) return;
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

/** "from <parent>" for a sub-space shown on its own; `null` for a space
 *  nobody started. A mirrored space's parent is its host's: not named. */
export function fromLabel(
  s: Pick<Space, 'parent' | 'remote'>,
  all: readonly Space[],
): string | null {
  const up = parentId(s);
  if (!up) return null;
  const parent = all.find((p) => p.id === up);
  if (parent) return `from ${spaceTitle(parent)}`;
  return s.remote ? null : 'from a removed space';
}

/** The spaces `space`'s agent started, archived ones aside, most recently
 *  active first; merged ones last. */
export function subSpacesOf(space: string, all: readonly Space[]): Space[] {
  return all
    .filter((s) => parentId(s) === space && s.status !== 'archived')
    .sort(
      (a, b) =>
        Number(mergedIntoParent(a)) - Number(mergedIntoParent(b)) ||
        b.updated_at - a.updated_at,
    );
}
