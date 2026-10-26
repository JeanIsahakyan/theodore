import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import {
  completeOnboardingIfPresent,
  hasClass,
  openDemoPr,
  showAiPanel,
} from './helpers';

describe('running a skill', () => {
  it('shows the finding the fixture skill script reports', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr();
    await showAiPanel();

    // The AI tab (`ui/src/ui/SidePanel.tsx`) is the side panel's default;
    // `/` opens the skills list and Enter runs the highlighted match
    // (`Chat`'s input). Every fixture agent counts as installed, so the
    // run goes to each of them in turn.
    const ask = await $('//textarea[@aria-label="Ask the agent"]');
    await ask.waitForDisplayed();
    await ask.setValue('/security');
    await $('[role="listbox"][aria-label="Skills"]').waitForDisplayed();
    await browser.keys(Key.Enter);

    // `crates/fixtures/data/demo/agents/*/skill.jsonl` call the real
    // `add_finding` MCP tool (plan §8.3) and end in `Done`: the finding
    // card and the run's summary line ("/security: 1 finding") both
    // appear once they do.
    const finding = await $(
      `//*[${hasClass('finding')}][contains(., "Backoff has no upper bound")]`,
    );
    await finding.waitForDisplayed({ timeout: 15_000 });
    await expect(
      $('//span[starts-with(normalize-space(.), "/security: ")]'),
    ).toBeDisplayed();
  });
});
