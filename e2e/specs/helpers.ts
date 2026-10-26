// Shared steps for every spec: both demo PRs come from
// `crates/fixtures/data/demo` (plan §12.1), loaded through
// `THEODORE_FIXTURES` (see `e2e/README.md` and `crates/fixtures/examples/gen.rs`).
//
// Selectors lean on roles and ARIA labels the components already carry
// for accessibility. Text matches are explicit XPath with
// `normalize-space(.)`: WebdriverIO's `button=Text` only looks at a
// button's own text nodes, and `*=Text` is a link-text selector (anchors
// only).

import { $, browser } from '@wdio/globals';

/** The demo PR most specs open: `octo/webhooks` #101, the
 *  push-and-regroup PR. Matches the id cell's `title` in the inbox row. */
export const DEMO_PR = 'octo/webhooks #101';

/** An XPath string literal for `s` (no XPath 1.0 escaping needed here:
 *  nothing the specs look for contains a double quote). */
const lit = (s: string) => `"${s}"`;

/** A `<button>` whose whole visible text is `label`. */
export const button = (label: string) =>
  `//button[normalize-space(.)=${lit(label)}]`;

/** An element carrying `cls` as one of its class tokens (not as a
 *  substring: `ln` must not match `lines`). */
export const hasClass = (cls: string) =>
  `contains(concat(" ", normalize-space(@class), " "), " ${cls} ")`;

/** Onboarding's `ProgressBar` (`ui/src/ui/Onboarding.tsx`). */
const SETUP = '[role="progressbar"][aria-label="Setup progress"]';
/** The sidebar (`ui/src/ui/Sidebar.tsx`): there once the app shell is up. */
const NAV = '[role="listbox"][aria-label="Navigation"]';

/** First launch: `ui/src/stores/UiStore.ts` gates the app behind
 *  onboarding until `localStorage['theodore-onboarded']` is set. The
 *  webview's storage outlives the process, so only the first spec of a
 *  run sees it; the rest start in the app.
 *
 *  Fixture mode's steps (no account, no telemetry sink):
 *
 *    Theme ─▶ GitHub ─▶ Agents ─▶ Projects ─▶ Done
 *              │                    └ "Skip" (no projects)
 *              └ no `gh`/keychain token in fixture mode: paste one; the
 *                fixture host accepts any token as its demo viewer
 *
 *  Walked generically (Next / Skip until "Open Inbox"), so a Sharing or
 *  Account step showing up doesn't break it — though an Account step
 *  can't be passed without a real sign-in. */
export async function completeOnboardingIfPresent(): Promise<void> {
  // A blank window until `account_status` answers, then one or the other.
  await browser.waitUntil(
    async () => (await $(SETUP).isExisting()) || (await $(NAV).isExisting()),
    { timeout: 20_000, timeoutMsg: 'neither onboarding nor the app showed up' },
  );
  if (!(await $(SETUP).isExisting())) return;

  // Step 1's welcome only renders once the step list is final (account
  // and sharing status known), so the steps can't shift under a click.
  await $('//*[normalize-space(text())="Welcome to Theodore"]').waitForExist({
    timeout: 10_000,
  });

  for (let i = 0; i < 10 && (await $(SETUP).isExisting()); i++) {
    const finish = await $(button('Open Inbox'));
    if (await finish.isExisting()) {
      await finish.click();
      break;
    }
    if (await $('//*[normalize-space(text())="Connect GitHub"]').isExisting()) {
      await connectGithub();
    }
    const at = await $(SETUP).getAttribute('aria-valuenow');
    const next = await $(
      '//button[normalize-space(.)="Next" or normalize-space(.)="Skip"]',
    );
    await next.waitForEnabled({ timeout: 10_000 });
    await next.click();
    await browser.waitUntil(
      async () =>
        !(await $(SETUP).isExisting()) ||
        (await $(SETUP).getAttribute('aria-valuenow')) !== at,
      { timeoutMsg: `onboarding didn't move past step ${at}` },
    );
  }

  await $(NAV).waitForDisplayed({ timeout: 10_000 });
  // Finishing onboarding plays the welcome (`ui/src/ui/Welcome.tsx`,
  // 1.65 s): a full-window, purely decorative overlay — no role or label
  // to find it by — that takes every click until it's gone.
  await browser.waitUntil(async () => !(await $('.welcome').isExisting()), {
    timeout: 5_000,
    timeoutMsg: 'the welcome animation never finished',
  });
}

/** Onboarding's GitHub step. Next waits for a connected host; fixture
 *  mode has no token source, so paste one (`set_host_token` checks it
 *  against `FixtureHost::viewer`, which always answers). */
async function connectGithub(): Promise<void> {
  const next = await $(button('Next'));
  // The step's own host check is still running, or already connected.
  await browser.waitUntil(
    async () =>
      (await next.isEnabled()) ||
      (await $(button('Paste a token manually')).isExisting()),
    { timeout: 10_000, timeoutMsg: 'the GitHub step never settled' },
  );
  if (await next.isEnabled()) return;
  await (await $(button('Paste a token manually'))).click();
  const token = await $('input[type="password"]');
  await token.waitForDisplayed();
  await token.setValue('fixture-token');
  const verify = await $(button('Verify token'));
  await verify.waitForEnabled();
  await verify.click();
  await next.waitForEnabled({
    timeout: 10_000,
    timeoutMsg: 'the pasted token was not accepted',
  });
}

/** An inbox row: the `Pull requests` list's option whose id cell is
 *  titled `"{owner}/{repo} #{number}"` (`ui/src/ui/List.tsx`'s `PrRow`).
 *  The cell's visible text (`webhooks #101`) has a no-break space and
 *  truncates, so the title is the stable handle. */
export function prRowSelector(ownerRepoNumber: string): string {
  return (
    '//*[@role="listbox"][@aria-label="Pull requests"]' +
    `//*[@role="option"][.//*[@title=${lit(ownerRepoNumber)}]]`
  );
}

/** The sidebar's Inbox. A relaunch restores the last session's tabs, so a
 *  spec can't count on starting there. */
export async function goToInbox(): Promise<void> {
  const inbox = await $(
    `//*[@role="listbox"][@aria-label="Navigation"]//*[@role="option"][.//*[@title="Inbox"]]`,
  );
  await inbox.waitForClickable();
  await inbox.click();
  await $('[role="toolbar"][aria-label="Inbox"]').waitForDisplayed();
}

/** Opens `pr` (PR #101 by default) from the inbox in the Review screen and
 *  waits for its header. */
export async function openDemoPr(pr = DEMO_PR): Promise<void> {
  await goToInbox();
  const row = await $(prRowSelector(pr));
  await row.waitForDisplayed({ timeout: 15_000 });
  // A click on a row opens its PR (`RowList`'s `onPress`).
  await row.click();
  const number = pr.slice(pr.indexOf('#'));
  await $(
    `//*[@role="toolbar"][@aria-label="PR"][.//*[normalize-space(.)=${lit(number)}]]`,
  ).waitForDisplayed({ timeout: 15_000 });
}

/** The groups pane's "Files and groups" toggle — only rendered when the
 *  review is too narrow for the pane as a column (`Review.tsx`'s
 *  `layoutFor`); then the pane is a drawer over the diff. */
const GROUPS_TOGGLE = 'button[aria-label="Files and groups"]';

async function setGroupsDrawer(open: boolean): Promise<void> {
  const toggle = await $(GROUPS_TOGGLE);
  if (!(await toggle.isExisting())) return;
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed !== open) await toggle.click();
}

/** Shows the groups pane in "Grouped" mode (`ui/src/ui/GroupsPane.tsx`).
 *  The tab stays disabled until the fixture grouping has landed. */
export async function showGroupedView(): Promise<void> {
  await setGroupsDrawer(true);
  const grouped = await $(
    '//*[@role="tablist"][@aria-label="How to show changes"]' +
      '//*[@role="tab"][normalize-space(.)="Grouped"]',
  );
  await grouped.waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(
    async () => (await grouped.getAttribute('aria-disabled')) !== 'true',
    { timeout: 15_000, timeoutMsg: 'no groups arrived from the fixture' },
  );
  if ((await grouped.getAttribute('aria-selected')) !== 'true') {
    await grouped.click();
  }
}

/** Gets the groups drawer (if the layout uses one) out of the diff's way. */
export async function closeGroupsDrawer(): Promise<void> {
  await setGroupsDrawer(false);
}

/** A group's row in the groups pane: an accordion trigger (`aria-expanded`)
 *  holding the group's title. */
export function groupSelector(title: string): string {
  return `//button[@aria-expanded][.//*[normalize-space(text())=${lit(title)}]]`;
}

/** Shows the AI panel (`ui/src/ui/SidePanel.tsx`): a column on a wide
 *  review, a drawer (closed by default) on a narrower one. */
export async function showAiPanel(): Promise<void> {
  const toggle = await $('button[aria-label="AI panel"]');
  await toggle.waitForDisplayed();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
}
