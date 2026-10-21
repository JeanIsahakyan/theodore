/** `useAccountSignIn` against a fake transport: the commands it sends, the
 *  browser it opens, and the poll cadence until the sign-in settles. */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from './transport';
import { FakeTransport } from '../test/fakeTransport';
import { useAccountSignIn, type AccountSignIn } from './accountSignIn';
import type { AccountStatus } from '../gen/contract';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const signedIn: AccountStatus = {
  available: true,
  user: { id: 'u', email: 'ada@example.com', name: null, avatar_url: null },
};

let transport: FakeTransport;
let root: Root;
let latest: AccountSignIn;
let done: AccountStatus[];
let opened: string[];

/** Hands each render's hook value out through an effect, not by
 *  assigning a module variable during render. */
function Harness({ onValue }: { onValue: (v: AccountSignIn) => void }) {
  const value = useAccountSignIn((s) => done.push(s));
  useEffect(() => {
    onValue(value);
  });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  setTransport(transport);
  done = [];
  opened = [];
  vi.spyOn(window, 'open').mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  root = createRoot(document.createElement('div'));
  await act(async () =>
    root.render(
      <Harness
        onValue={(v) => {
          latest = v;
        }}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const polls = () =>
  transport.calls.filter((c) => c.cmd === 'account_sign_in_poll').length;

describe('useAccountSignIn', () => {
  it('browser: opens the page, polls every second, focuses on success', async () => {
    transport.queueResult('account_sign_in_start', {
      method: 'browser',
      url: 'https://auth.example/authorize?x=1',
    });
    transport.queueResult(
      'account_sign_in_poll',
      { state: 'pending' },
      { state: 'pending' },
      { state: 'done', status: signedIn },
    );
    transport.onCall('focus_window', () => null);

    act(() => latest.start('browser', ' ada@example.com '));
    await flush();
    expect(transport.calls[0]).toEqual({
      cmd: 'account_sign_in_start',
      args: { req: { method: 'browser', email: 'ada@example.com' } },
    });
    expect(opened).toEqual(['https://auth.example/authorize?x=1']);
    expect(latest.flow.phase).toBe('browser');

    await advance(1000);
    expect(polls()).toBe(1);
    await advance(1000);
    expect(polls()).toBe(2);
    await advance(1000);
    expect(polls()).toBe(3);
    expect(latest.flow.phase).toBe('done');
    expect(done).toEqual([signedIn]);
    expect(transport.calls.some((c) => c.cmd === 'focus_window')).toBe(true);

    // Settled: no more polling.
    await advance(5000);
    expect(polls()).toBe(3);
  });

  it('device: polls at the server interval and honours slow_down', async () => {
    transport.queueResult('account_sign_in_start', {
      method: 'device_code',
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://acme.authkit.app/device',
      verification_uri_complete: null,
      expires_in: 300,
      interval: 5,
    });
    transport.queueResult(
      'account_sign_in_poll',
      { state: 'slow_down', interval: 10 },
      { state: 'done', status: signedIn },
    );

    act(() => latest.start('device_code'));
    await flush();
    expect(opened).toEqual([]);
    expect(latest.flow.device?.userCode).toBe('BCDF-GHJK');

    await advance(4999);
    expect(polls()).toBe(0);
    await advance(1);
    expect(polls()).toBe(1);
    await advance(9999);
    expect(polls()).toBe(1);
    await advance(1);
    expect(polls()).toBe(2);
    expect(done).toEqual([signedIn]);
    expect(transport.calls.some((c) => c.cmd === 'focus_window')).toBe(false);
  });

  it('cancel stops polling and tells the core', async () => {
    transport.queueResult('account_sign_in_start', {
      method: 'browser',
      url: 'u',
    });
    transport.onCall('account_sign_in_poll', () => ({ state: 'pending' }));
    transport.onCall('account_sign_in_cancel', () => null);

    act(() => latest.start('browser'));
    await flush();
    await advance(1000);
    expect(polls()).toBe(1);
    act(() => latest.cancel());
    await flush();
    expect(latest.flow.phase).toBe('idle');
    expect(
      transport.calls.some((c) => c.cmd === 'account_sign_in_cancel'),
    ).toBe(true);
    await advance(5000);
    expect(polls()).toBe(1);
  });

  it('a failed start shows the error', async () => {
    transport.queueResult(
      'account_sign_in_start',
      Object.assign(new Error('x'), {
        code: 'account',
        message: "can't listen on 127.0.0.1:47823",
      }),
    );
    act(() => latest.start('browser'));
    await flush();
    expect(latest.flow.phase).toBe('error');
    expect(latest.flow.error).toContain('47823');
    expect(opened).toEqual([]);
  });
});
