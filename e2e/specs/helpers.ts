// Shared steps for every spec: both demo PRs come from
// `crates/fixtures/data/demo` (plan §12.1), loaded through
// `THEODORE_FIXTURES` (see `e2e/README.md` and `crates/fixtures/examples/gen.rs`).

import { $, browser } from '@wdio/globals';

/** First launch only: `ui/src/stores/UiStore.ts` gates the app behind
 *  onboarding until `localStorage['theodore-onboarded']` is set. */
export async function completeOnboardingIfPresent(): Promise<void> {
  const continueBtn = await $('button=Continue');
  if (await continueBtn.isExisting()) {
    await continueBtn.waitForClickable();
    await continueBtn.click();
  }
}

/** The inbox row's visible text is `"{repo} #{number}"` followed by the
 *  PR title (`ui/src/ui/List.tsx`'s `PrRow`). */
export function prRowSelector(repoAndNumber: string): string {
  return `//div[contains(@class,"prrow")][contains(., "${repoAndNumber}")]`;
}

/** Selects PR #101 (`octo/webhooks`, the push-and-regroup demo PR) from the
 *  inbox and opens it in the Review screen. */
export async function openDemoPr(repoAndNumber = 'webhooks #101'): Promise<void> {
  const row = await $(prRowSelector(repoAndNumber));
  await row.waitForDisplayed();
  await row.click();
  // `ui/src/ui/List.tsx`'s `useListKeys` opens the selected PR on Enter.
  await browser.keys(['Enter']);
  await $('.review').waitForDisplayed();
}

/** Switches the groups/files pane to "Grouped" (`ui/src/ui/GroupsPane.tsx`). */
export async function showGroupedView(): Promise<void> {
  const tab = await $('*=Grouped');
  await tab.click();
}
