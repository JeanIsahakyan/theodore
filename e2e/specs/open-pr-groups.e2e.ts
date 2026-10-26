import { $, expect } from '@wdio/globals';
import {
  completeOnboardingIfPresent,
  groupSelector,
  openDemoPr,
  showGroupedView,
} from './helpers';

describe('opening a PR', () => {
  it('shows the groups the fixture grouping script produced', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr();
    await showGroupedView();

    // `crates/fixtures/data/demo/agents/claude/grouping.jsonl`'s recorded
    // groups, surfaced as a `grouping` sync row (plan §5.1).
    await expect($(groupSelector('Retry with backoff'))).toBeDisplayed();
    await expect($(groupSelector('Tests'))).toBeDisplayed();
    // Read progress over those groups (`GroupsPane.tsx`).
    await expect(
      $('[role="progressbar"][aria-label="Groups read"]'),
    ).toBeDisplayed();
  });
});
