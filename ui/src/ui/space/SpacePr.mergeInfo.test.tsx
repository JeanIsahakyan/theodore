/** "Merge: Checking…" doesn't stay until you leave the tab: a failed
 *  `merge_info` (a host answering 502) is asked again on a backoff. And
 *  "Some checks aren't passing" doesn't outlive the checks: a check
 *  finishing (no new head, no new update time) asks again. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeInfo } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { FakeTransport } from '../../test/fakeTransport';
import { mount, type Mounted } from '../../test/dom';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { mergeInfoRetryMs, mergeInfoVersion, useMergeInfo } from '../mergeInfo';
import { SpaceChecks } from './SpacePr';

const PR = 'gh:acme/app#1';

const info: MergeInfo = {
  state: 'clean',
  allowed_methods: ['squash'],
  default_method: 'squash',
  auto_merge_allowed: false,
  auto_merge_enabled: false,
  merge_queue: false,
  in_queue: false,
} as unknown as MergeInfo;

function Probe() {
  const got = useMergeInfo(PR, 'v1');
  return <span>{got ? got.state : 'Checking…'}</span>;
}

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  setTransport(transport);
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

describe('useMergeInfo', () => {
  it('asks again after a failure instead of checking forever', async () => {
    let calls = 0;
    transport.onCall('merge_info', () => {
      calls += 1;
      if (calls === 1) throw { code: 'host.server_error', message: '502' };
      return info;
    });
    m = await mount(<Probe />);
    expect(m.host.textContent).toBe('Checking…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(mergeInfoRetryMs(0));
    });
    expect(calls).toBe(2);
    expect(m.host.textContent).toBe('clean');
  });

  it('backs off, capped', () => {
    expect(mergeInfoRetryMs(0)).toBe(2_000);
    expect(mergeInfoRetryMs(1)).toBe(4_000);
    expect(mergeInfoRetryMs(10)).toBe(30_000);
  });
});

describe('mergeInfoVersion', () => {
  const summary = {
    head_sha: 'abc',
    updated_at: 5,
    checks: 'pending' as const,
  };
  it('moves when a check finishes, head and update time unchanged', () => {
    expect(mergeInfoVersion(summary, [{ id: 'ci', status: 'pass' }])).not.toBe(
      mergeInfoVersion(summary, [{ id: 'ci', status: 'pending' }]),
    );
    expect(
      mergeInfoVersion({ ...summary, checks: 'pass' }, undefined),
    ).not.toBe(mergeInfoVersion(summary, undefined));
  });
  it("doesn't move on the checks' order", () => {
    const a = { id: 'a', status: 'pass' as const };
    const b = { id: 'b', status: 'fail' as const };
    expect(mergeInfoVersion(summary, [a, b])).toBe(
      mergeInfoVersion(summary, [b, a]),
    );
  });
});

describe('the Checks tab merge line', () => {
  it('follows the checks: asked again once a check passes', async () => {
    const store = new RootStore();
    store.sync.pool.put('pr', PR, {
      pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
      title: 'Add notes',
      state: 'open',
      head_sha: 'abc',
      updated_at: 5,
      checks: 'pending',
      approvals: 0,
      required_approvals: null,
      review_decision: null,
      conflicts: false,
    });
    const detail = (status: string) => ({
      threads: [],
      commits: [],
      reviewers: [],
      checks: [{ id: 'ci', name: 'ci', status, url: null, duration_ms: null }],
    });
    store.sync.pool.put('pr_detail', PR, detail('pending'));
    let state = 'unstable';
    let calls = 0;
    transport.onCall('merge_info', () => {
      calls += 1;
      return { ...info, state };
    });
    m = await mount(
      <RootStoreProvider store={store}>
        <SpaceChecks pr={PR} />
      </RootStoreProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);
    expect(m.host.textContent).toContain("Some checks aren't passing");

    // GitHub's verdict moved; here only the check's status says so.
    state = 'clean';
    await act(async () => {
      store.sync.pool.put('pr_detail', PR, detail('pass'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(2);
    expect(m.host.textContent).not.toContain("Some checks aren't passing");
    expect(m.host.textContent).toContain('Ready to merge');
  });
});
