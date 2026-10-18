import { $, browser, expect } from '@wdio/globals';
import { completeOnboardingIfPresent, openDemoPr } from './helpers';

describe('running a skill', () => {
  it('shows the finding the fixture skill script reports', async () => {
    await completeOnboardingIfPresent();
    await openDemoPr('webhooks #101');

    // The AI tab (`ui/src/ui/SidePanel.tsx`) is the default side tab; `/`
    // followed by a skill name runs it (`SidePanel.tsx`'s `Chat.send`).
    const ask = await $('[aria-label="Ask the agent"]');
    await ask.waitForDisplayed();
    await ask.setValue('/security');
    await browser.keys(['Enter']);

    // `crates/fixtures/data/demo/agents/claude/skill.jsonl` calls the real
    // `add_finding` MCP tool (plan §8.3) and ends in `Done`; the run's
    // status label and the finding card both appear once it does.
    await expect($('*=done')).toBeDisplayed();
    const finding = await $(
      '//div[contains(@class,"finding")][contains(.,"Backoff has no upper bound")]',
    );
    await finding.waitForDisplayed({ timeout: 15_000 });
    await expect(finding).toBeDisplayed();
  });
});
