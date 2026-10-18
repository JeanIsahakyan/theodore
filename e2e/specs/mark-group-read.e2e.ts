import { $, expect } from '@wdio/globals';
import { completeOnboardingIfPresent, openDemoPr, showGroupedView } from './helpers';

describe('marking a group read', () => {
  it('flips the group to read and the file to viewed', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr('webhooks #101');
    await showGroupedView();

    const group = await $('*=Retry with backoff');
    await group.click();

    // `ui/src/ui/DiffPane.tsx`'s `GroupCard`: one transaction per hunk in
    // the group (`markGroupRead`), then the button disables and relabels.
    const markRead = await $('button*=Mark as read');
    await markRead.waitForClickable();
    await markRead.click();

    await expect($('button=Read')).toBeDisplayed();
    await expect(
      $('//*[contains(@class,"grp")][contains(., "2/2 read")]'),
    ).toBeDisplayed();
  });
});
