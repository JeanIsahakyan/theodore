/** Fetches the Linear issues linked to a PR (`linear_issues`): the core
 *  already caches the result for ~5 minutes, so this hook just re-asks on
 *  every mount/pr change rather than keeping its own cache on top. Behind
 *  `FEATURES.linear` so Peek and the Review header never call a command
 *  that isn't wired up yet. */
import { useEffect, useState } from 'react';
import type { LinearIssue, PrId } from '../../gen/contract';
import { api } from '../../core/api';
import { FEATURES } from '../../features';

export function useLinearIssues(pr: PrId): LinearIssue[] {
  const [issues, setIssues] = useState<LinearIssue[]>([]);

  useEffect(() => {
    if (!FEATURES.linear) return;
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
  }, [pr]);

  return issues;
}
