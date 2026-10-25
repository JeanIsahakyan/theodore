import { $, expect } from '@wdio/globals';
import {
  button,
  completeOnboardingIfPresent,
  hasClass,
  openDemoPr,
} from './helpers';

const COMMENT_TEXT = 'Consider logging which branch this retry takes.';

/** The diff line of `src/webhooks/deliver.ts` that reads `if (res.ok)
 *  return;` (`ui/src/ui/DiffPane.tsx`'s `Line`, class `ln`). Unique in the
 *  diff — the removed `if (!res.ok) throw …` line also contains `res.ok`. */
const LINE = `//div[${hasClass('ln')}][contains(., "if (res.ok) return;")]`;
const DRAFT = `//*[${hasClass('draft')}][contains(., "${COMMENT_TEXT}")]`;
const THREAD = `//*[${hasClass('thread')}][contains(., "${COMMENT_TEXT}")]`;

describe('commenting and submitting a review', () => {
  it('adds a draft on a commentable line, then submits it', async () => {
    await completeOnboardingIfPresent();
    // Opens grouped, on the first group ("Retry with backoff"), whose
    // hunks include all of `deliver.ts`.
    await openDemoPr();

    const line = await $(LINE);
    await line.waitForDisplayed({ timeout: 15_000 });
    await line.scrollIntoView();
    // The line's "+" (comment) only shows while the line is hovered
    // (`.ln:hover .ln-act` in `ui/src/styles.css`).
    await line.moveTo();
    const comment = await line.$('.//button[@aria-label="comment"]');
    await comment.waitForClickable();
    await comment.click();

    const composer = await $('//textarea[@aria-label="comment"]');
    await composer.waitForDisplayed();
    await composer.setValue(COMMENT_TEXT);
    const add = await $(
      '//button[contains(normalize-space(.), "Add to review")]',
    );
    await add.waitForEnabled();
    await add.click();

    await expect($(DRAFT)).toBeDisplayed();

    // "Submit" alone on a narrow review header (`Review.tsx`).
    await (
      await $(
        '//*[@role="toolbar"][@aria-label="PR"]' +
          '//button[normalize-space(.)="Submit review" or normalize-space(.)="Submit"]',
      )
    ).click();
    // `Modals.tsx`'s `SubmitReviewModal`, titled "Review · <pr>".
    const dialog = await $('[role="dialog"][aria-label^="Review"]');
    await dialog.waitForDisplayed();
    await (await dialog.$(`.${button('Submit')}`)).click();
    await dialog.waitForDisplayed({ reverse: true });

    // Submitting goes back to where the PR was opened from (the inbox);
    // reopen it to see the result. The outbox round trip through
    // `FixtureHost::submit_review` replaces the pending draft with a real
    // thread on the same line (plan §6.7).
    await openDemoPr();
    await $(THREAD).waitForDisplayed({ timeout: 15_000 });
    await expect($(DRAFT)).not.toBeExisting();
  });
});
