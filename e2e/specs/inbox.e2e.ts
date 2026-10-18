import { $, expect } from '@wdio/globals';
import { completeOnboardingIfPresent, prRowSelector } from './helpers';

describe('inbox', () => {
  it('shows both demo PRs', async () => {
    await completeOnboardingIfPresent();

    const list = await $('[aria-label="Pull requests"]');
    await list.waitForDisplayed();

    await expect($(prRowSelector('webhooks #101'))).toBeDisplayed();
    await expect($(prRowSelector('api #7'))).toBeDisplayed();
  });
});
