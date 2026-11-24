/** Once a space's PR merged, the header's stage chip becomes `Merged #N`
 *  with a small menu (docs/spaces.md §3, §7): Continue on a new branch,
 *  Open PR, Archive. No banner anywhere any more. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrSummary, Space } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, type Mounted } from '../../test/dom';
import { MergedChip } from './SpacePr';
import { AUTO_ARCHIVE_MERGED_KEY } from './spaces';

// jsdom has no `CSS.escape`; an open react-aria menu calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const PR = 'gh:acme/app#12';

const space = (over: Partial<Space> = {}): Space =>
  ({
    id: 's1',
    project: 'gh:acme/app',
    name: 'rate-limits',
    goal: 'Rate limits',
    branch: 'ada/rate-limits',
    base: 'main',
    base_sha: 'b',
    head_sha: 'h',
    worktree: '/wt/s1',
    status: 'idle',
    agent: 'claude',
    model: null,
    mode: 'edit',
    review_pr: null,
    pr: PR,
    turns: 1,
    run: null,
    error: null,
    created_at: 0,
    updated_at: 0,
    done_at: 100,
    ...over,
  }) as Space;

const summary = (state: PrSummary['state']): PrSummary =>
  ({
    pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 12 },
    title: 'Rate limits',
    state,
    head_sha: 'h',
    updated_at: 5,
    checks: 'pass',
    approvals: 1,
    required_approvals: null,
    review_decision: null,
    conflicts: false,
  }) as unknown as PrSummary;

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  store = new RootStore();
  store.sync.openPr = async () => {};
});

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
});

async function render(s: Space, state: PrSummary['state'] | null = 'merged') {
  if (state) store.sync.pool.put('pr', PR, summary(state));
  m = await mount(
    <RootStoreProvider store={store}>
      <MergedChip space={s} />
    </RootStoreProvider>,
  );
  await settle();
}

const chip = () =>
  m!.host.querySelector<HTMLButtonElement>('.space-merged-chip');
const stage = () => m!.host.querySelector<HTMLElement>('.space-stage');
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) =>
    el.textContent?.trim(),
  );
const item = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.trim().startsWith(text),
  );
const calls = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe('MergedChip', () => {
  it('reads Merged #N, no banner text anywhere', async () => {
    await render(space());
    expect(chip()?.textContent?.trim()).toBe('Merged #12');
    expect(chip()?.getAttribute('aria-label')).toBe('Merged #12: actions');
    expect(m!.host.textContent).not.toContain('Continue here on a new branch');
    expect(m!.host.textContent).not.toContain('archives itself');
    expect(document.body.textContent).not.toContain('archives itself');
  });

  it('says just Merged until the PR summary is loaded', async () => {
    await render(space(), null);
    expect(chip()?.textContent?.trim()).toBe('Merged');
  });

  it('opens a menu with Continue, Open PR and Archive', async () => {
    await render(space());
    await click(chip());
    await settle();
    expect(items()).toEqual([
      'Continue on a new branch',
      'Open PR #12',
      'Archive',
    ]);
  });

  it('Continue calls continue_space and toasts the new branch', async () => {
    transport.onCall('continue_space', () =>
      space({ pr: null, done_at: null, branch: 'ada/rate-limits-2' }),
    );
    await render(space());
    await click(chip());
    await settle();
    await click(item('Continue on a new branch'));
    await settle();
    expect(calls('continue_space')).toEqual([{ space: 's1' }]);
    expect(store.ephemeral.toasts.map((t) => t.text)).toContain(
      'Continuing on ada/rate-limits-2',
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('Archive calls archive_space', async () => {
    transport.onCall('archive_space', () => null);
    await render(space());
    await click(chip());
    await settle();
    await click(item('Archive'));
    await settle();
    expect(calls('archive_space')).toEqual([{ space: 's1' }]);
  });

  it('a remote or archived space only gets Open PR', async () => {
    await render(
      space({
        remote: {
          space: 's1',
          host_device: 'd2',
          host_name: 'Studio Mac',
          project_name: 'app',
          started_here: true,
        },
      }),
    );
    await click(chip());
    await settle();
    expect(items()).toEqual(['Open PR #12']);
  });

  it('renders nothing while the PR is still open', async () => {
    await render(space({ done_at: null }), 'open');
    expect(chip()).toBeNull();
    expect(m!.host.textContent).toBe('');
  });

  it('tells when the space archives itself, unless that is off', async () => {
    await render(space());
    expect(stage()?.getAttribute('title')).toBe(
      'Archives itself 7 days after the merge when idle',
    );
    m!.unmount();
    m = null;
    store.sync.pool.put('setting', `user:${AUTO_ARCHIVE_MERGED_KEY}`, {
      key: AUTO_ARCHIVE_MERGED_KEY,
      scope: 'user',
      value: false,
    });
    await render(space());
    expect(stage()?.getAttribute('title')).toBeNull();
  });
});
