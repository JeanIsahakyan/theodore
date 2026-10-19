/** The project's Activity tab: a reverse-chronological feed built from the
 *  PR rows we already have. There's no event log behind this — each PR row
 *  contributes exactly one event, derived from its *current* state, so
 *  "opened" means "currently open or draft" rather than a true open-time
 *  entry. Honest about what it is: a snapshot read as a feed, not history. */
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

export function projectActivity(items: InboxPr[], limit = 50): ActivityEvent[] {
  return items
    .map((p) => ({ id: p.id, pr: p, kind: kindOf(p), at: p.updated_at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
