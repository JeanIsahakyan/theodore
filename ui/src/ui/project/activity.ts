/** The project's Activity tab: a reverse-chronological feed built from the
 *  PR rows we already have. There's no event log behind this — each PR row
 *  contributes exactly one event, derived from its *current* state, so
 *  "opened" means "currently open or draft" rather than a true open-time
 *  entry. An "opened" event's `at` uses the real `created_at` where the
 *  host filled it (falling back to `updated_at`); merged/closed still use
 *  `updated_at` — `created_at` wouldn't make those any more accurate.
 *  Honest about what it is: a snapshot read as a feed, not history. */
import type { InboxPr } from '../List';

export type ActivityKind = 'opened' | 'merged' | 'closed';

export interface ActivityEvent {
  id: string;
  pr: InboxPr;
  kind: ActivityKind;
  at: number;
}

function kindOf(p: InboxPr): ActivityKind {
  if (p.state === 'merged') return 'merged';
  if (p.state === 'closed') return 'closed';
  return 'opened';
}

function atOf(p: InboxPr, kind: ActivityKind): number {
  return kind === 'opened' ? p.created_at ?? p.updated_at : p.updated_at;
}

export function projectActivity(items: InboxPr[], limit = 50): ActivityEvent[] {
  return items
    .map((p) => {
      const kind = kindOf(p);
      return { id: p.id, pr: p, kind, at: atOf(p, kind) };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
