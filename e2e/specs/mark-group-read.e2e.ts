import { $, expect } from '@wdio/globals';
import {
  button,
  closeGroupsDrawer,
  completeOnboardingIfPresent,
  groupSelector,
  openDemoPr,
  showGroupedView,
} from './helpers';

const GROUP = 'Retry with backoff';

describe('marking a group read', () => {
  it('flips the group to read and its files to viewed', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr();
    await showGroupedView();

    const group = await $(groupSelector(GROUP));
    await group.waitForClickable();
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await closeGroupsDrawer();

    // `ui/src/ui/DiffPane.tsx`'s `GroupCard`: one transaction per hunk in
    // the group (`markGroupRead`), then the button disables and relabels.
    const markRead = await $(button('Mark as read'));
    await markRead.waitForClickable();
    await markRead.click();

    const read = await $(button('Read'));
    await expect(read).toBeDisplayed();
    await expect(read).toBeDisabled();

    // Both of the group's hunks read (the row's "read/total" count), and
    // each file whose every hunk is read goes Viewed (plan §3,
    // `crates/app/src/reading.rs`).
    await showGroupedView();
    await expect(
      $(`${groupSelector(GROUP)}[.//span[normalize-space(.)="2/2"]]`),
    ).toBeDisplayed();
    await expect(
      $(
        '//*[@role="listbox"][@aria-label="Files in group 1"]' +
          '//*[@role="option"][.//*[@title="src/webhooks/deliver.ts"]]' +
          '//input[@aria-label="Viewed — synced with GitHub"]',
      ),
    ).toBeSelected();
  });
});
