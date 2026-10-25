import { $, expect } from '@wdio/globals';
import {
  completeOnboardingIfPresent,
  goToInbox,
  prRowSelector,
} from './helpers';

describe('inbox', () => {
  it('shows both demo PRs', async () => {
    await completeOnboardingIfPresent();
    await goToInbox();

    // `List.tsx`'s `RowList`: one listbox, a section per inbox reason
    // (#101 needs your review, #7 is assigned to you).
    const list = await $('[role="listbox"][aria-label="Pull requests"]');
    await list.waitForDisplayed({ timeout: 15_000 });

    await expect($(prRowSelector('octo/webhooks #101'))).toBeDisplayed();
    await expect($(prRowSelector('octo/api #7'))).toBeDisplayed();
  });
});
