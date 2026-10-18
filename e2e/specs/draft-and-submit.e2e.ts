import { $, expect } from '@wdio/globals';
import { completeOnboardingIfPresent, openDemoPr } from './helpers';

const COMMENT_TEXT = 'Consider logging which branch this retry takes.';

describe('commenting and submitting a review', () => {
  it('adds a draft on a commentable line, then submits it', async () => {
    await completeOnboardingIfPresent();
    // Default mode is "files" with the first file selected
    // (`src/webhooks/deliver.ts`, per `crates/fixtures/examples/gen.rs`'s
    // file order) — no tab switch needed to see its lines.
    await openDemoPr('webhooks #101');

    // The line `if (res.ok) return;` is unique text within the diff
    // (`ui/src/ui/DiffPane.tsx`'s per-line "+" opens the `Composer`).
    const commentButton = await $(
      '//div[contains(@class,"ln") and contains(.,"res.ok")]//button[@aria-label="comment"]',
    );
    await commentButton.waitForClickable();
    await commentButton.click();

    const composer = await $('//textarea[@aria-label="comment"]');
    await composer.waitForDisplayed();
    await composer.setValue(COMMENT_TEXT);
    await (await $('//button[contains(.,"Add to review")]')).click();

    await expect(
      $('//div[contains(@class,"draft")][contains(.,"pending draft")]'),
    ).toBeDisplayed();

    await (await $('//button[contains(.,"Submit review")]')).click();
    const dialog = await $('[aria-label="Submit review"]');
    await dialog.waitForDisplayed();
    await (await $('button=Submit')).click();
    await dialog.waitForDisplayed({ reverse: true });

    // The outbox round trip through `FixtureHost::submit_review` replaces
    // the pending draft with a real thread (plan §6.7).
    await expect(
      $('//div[contains(@class,"draft")][contains(.,"pending draft")]'),
    ).not.toBeDisplayed();
    await expect($('//div[contains(@class,"thread")]')).toBeDisplayed();
  });
});
