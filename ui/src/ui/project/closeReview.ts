/** Closing a branch review ("Review branch" with no host PR): the core
 *  drops its rows and worktree, the UI drops its tab. A host PR is never
 *  closable here — the core rejects it too. */
import { api } from '../../core/api';
import type { PrId } from '../../gen/contract';
import type { RootStore } from '../../stores/RootStore';
import type { Route } from '../../stores/UiStore';
import type { ContextMenuItem } from '../ContextMenu';

/** `false` on a rejected close (already toasted by `api.ts`). */
export async function closeBranchReview(
  store: RootStore,
  pr: PrId,
): Promise<boolean> {
  try {
    await api.closeBranchReview(pr);
  } catch {
    return false;
  }
  store.ui.closeTab({ name: 'review', pr });
  return true;
}

/** Right-click menu of a branch-review row (sidebar, project list). */
export function branchReviewMenu(
  store: RootStore,
  pr: PrId,
): ContextMenuItem[] {
  const route: Route = { name: 'review', pr };
  return [
    { id: 'open', label: 'Open', onAction: () => store.ui.go(route) },
    {
      id: 'open-new-tab',
      label: 'Open in new tab',
      onAction: () => store.ui.go(route, { newTab: true }),
    },
    {
      id: 'close-review',
      label: 'Close review',
      danger: true,
      onAction: () => void closeBranchReview(store, pr),
    },
  ];
}
