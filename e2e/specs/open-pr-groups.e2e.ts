import { $, expect } from '@wdio/globals';
import { completeOnboardingIfPresent, openDemoPr, showGroupedView } from './helpers';

describe('opening a PR', () => {
  it('shows the groups the fixture grouping script produced', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr('webhooks #101');
    await showGroupedView();

    const groups = await $('[aria-label="Groups"]');
    await groups.waitForDisplayed();

    // `crates/fixtures/data/demo/agents/claude/grouping.jsonl`'s recorded
    // groups, surfaced as a `grouping` sync row (plan §5.1).
    await expect($('*=Retry with backoff')).toBeDisplayed();
    await expect($('*=Tests')).toBeDisplayed();
  });
});
