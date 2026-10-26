/** Fetches the Linear issues linked to a PR (`linear_issues`): the core
 *  already caches the result for ~5 minutes, so this hook just re-asks on
 *  every mount/pr change rather than keeping its own cache on top. Asks
 *  nothing while `on` is false (`isLinearOn`: the build flag and Settings →
 *  Labs), so a hidden Linear never calls the command. */
import { useEffect, useState } from 'react';
import type { LinearIssue, PrId } from '../../gen/contract';
import { api } from '../../core/api';

export function useLinearIssues(pr: PrId, on: boolean): LinearIssue[] {
  const [issues, setIssues] = useState<LinearIssue[]>([]);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    void api
      .linearIssues({ pr })
      .then((r) => {
        if (!cancelled) setIssues(r);
      })
      .catch(() => {
        if (!cancelled) setIssues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pr, on]);

  return issues;
}
