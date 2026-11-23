/**
 * A space link (docs/mobile.md "Space links"): `https://theodore.cloud/s/<id>`
 * (a Universal Link / App Link), `theodore-mobile://space/<id>`, or the web
 * app's `/space/<id>`. The id in a link is the space's id on the computer
 * that runs it (what its PR footer carries), while the phone lists spaces
 * by their fleet id (`rs_…`). Pure, so the tests read it.
 *
 * ```text
 * /s/<id>  ─▶ a listed space with that fleet id        ─▶ /space/<id>
 *          ─▶ a listed space whose mirrored row is <id> ─▶ /space/<its fleet id>
 *          ─▶ neither, first connection not done yet    ─▶ "Looking for this space…"
 *          ─▶ neither                                   ─▶ "This space isn't on your devices"
 * ```
 */
import type { SpaceMirror } from '../fleet/mirror';
import type { SpaceView } from '../fleet/types';

export type SpaceLink = { kind: 'found'; space: string } | { kind: 'unknown' };

/** The listed space a link's id names, by fleet id or by the space's id on
 *  its host. */
export function resolveSpaceLink(
  id: string,
  spaces: readonly SpaceView[],
  mirrors: Readonly<Record<string, SpaceMirror>>,
): SpaceLink {
  if (!id) return { kind: 'unknown' };
  if (spaces.some((s) => s.space === id)) return { kind: 'found', space: id };
  for (const s of spaces) {
    if (mirrors[s.space]?.space?.id === id)
      return { kind: 'found', space: s.space };
  }
  return { kind: 'unknown' };
}

/** How long a link waits for the first connection before the space is
 *  called missing: the saved sets list at once, the welcome may not. */
export const LOOKING_MS = 8000;

export const LOOKING = 'Looking for this space…';
export const NOT_ON_DEVICES = {
  title: "This space isn't on your devices",
  hint: 'It runs on a computer you don’t follow from here, or it was archived. Open the link on that computer, or ask for it to be shared with this device.',
};

/** What the screen shows for a link: the space to open, a wait, or the
 *  missing state. */
export function spaceLinkState(
  link: SpaceLink,
  welcomed: boolean,
  waitedMs: number,
): 'open' | 'looking' | 'missing' {
  if (link.kind === 'found') return 'open';
  return !welcomed && waitedMs < LOOKING_MS ? 'looking' : 'missing';
}
