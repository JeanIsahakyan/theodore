import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  BROWSER_POLL_MS,
  initialFlow,
  isWaiting,
  looksLikeEmail,
  nextPollDelay,
  reduceFlow,
  signInErrorText,
  type AccountFlow,
  type AccountFlowEvent,
} from './accountFlow';
import type { AccountStatus } from '../gen/contract';

const signedIn: AccountStatus = {
  available: true,
  required: true,
  session_ended: false,
  user: {
    id: 'user_01',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    avatar_url: null,
  },
};

function run(...events: AccountFlowEvent[]): AccountFlow {
  return events.reduce(reduceFlow, initialFlow);
}

describe('reduceFlow — browser', () => {
  it('start → starting → browser with the URL to open', () => {
    const starting = run({ type: 'start', method: 'browser' });
    expect(starting.phase).toBe('starting');
    expect(starting.attempt).toBe(1);
    const waiting = reduceFlow(starting, {
      type: 'started',
      attempt: 1,
      start: { method: 'browser', url: 'https://auth.example/authorize' },
    });
    expect(waiting.phase).toBe('browser');
    expect(waiting.url).toBe('https://auth.example/authorize');
    expect(isWaiting(waiting)).toBe(true);
    expect(nextPollDelay(waiting)).toBe(BROWSER_POLL_MS);
  });

  it('keeps polling on pending, finishes on done', () => {
    const waiting = run(
      { type: 'start', method: 'browser' },
      { type: 'started', attempt: 1, start: { method: 'browser', url: 'u' } },
    );
    const again = reduceFlow(waiting, {
      type: 'poll',
      attempt: 1,
      state: { state: 'pending' },
    });
    // A new object with a bumped counter, so the poll loop re-arms.
    expect(again).not.toBe(waiting);
    expect(again.polls).toBe(waiting.polls + 1);
    expect(again.phase).toBe('browser');

    const done = reduceFlow(again, {
      type: 'poll',
      attempt: 1,
      state: { state: 'done', status: signedIn },
    });
    expect(done.phase).toBe('done');
    expect(done.status).toEqual(signedIn);
    expect(nextPollDelay(done)).toBeNull();
  });

  it('maps denied, expired and failed', () => {
    const waiting = run(
      { type: 'start', method: 'browser' },
      { type: 'started', attempt: 1, start: { method: 'browser', url: 'u' } },
    );
    expect(
      reduceFlow(waiting, {
        type: 'poll',
        attempt: 1,
        state: { state: 'denied' },
      }).phase,
    ).toBe('denied');
    expect(
      reduceFlow(waiting, {
        type: 'poll',
        attempt: 1,
        state: { state: 'expired' },
      }).phase,
    ).toBe('expired');
    const failed = reduceFlow(waiting, {
      type: 'poll',
      attempt: 1,
      state: { state: 'failed', message: 'invalid_grant' },
    });
    expect(failed.phase).toBe('error');
    expect(failed.error).toBe('invalid_grant');
  });

  it('a start that fails goes to error', () => {
    const f = run(
      { type: 'start', method: 'browser' },
      { type: 'failed', attempt: 1, error: "can't listen on 127.0.0.1:47823" },
    );
    expect(f.phase).toBe('error');
    expect(f.error).toContain('47823');
  });
});

describe('reduceFlow — device code', () => {
  const started: AccountFlowEvent = {
    type: 'started',
    attempt: 1,
    start: {
      method: 'device_code',
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://acme.authkit.app/device',
      verification_uri_complete:
        'https://acme.authkit.app/device?user_code=BCDF-GHJK',
      expires_in: 300,
      interval: 5,
    },
  };

  it('shows the code and polls at the server interval', () => {
    const f = run({ type: 'start', method: 'device_code' }, started);
    expect(f.phase).toBe('device');
    expect(f.device?.userCode).toBe('BCDF-GHJK');
    expect(nextPollDelay(f)).toBe(5000);
  });

  it('slow_down raises the interval and never lowers it', () => {
    let f = run({ type: 'start', method: 'device_code' }, started);
    f = reduceFlow(f, {
      type: 'poll',
      attempt: 1,
      state: { state: 'slow_down', interval: 10 },
    });
    expect(nextPollDelay(f)).toBe(10_000);
    f = reduceFlow(f, {
      type: 'poll',
      attempt: 1,
      state: { state: 'slow_down', interval: 3 },
    });
    expect(nextPollDelay(f)).toBe(10_000);
  });
});

describe('reduceFlow — attempts', () => {
  it('cancel goes back to idle and stops polling', () => {
    const f = run(
      { type: 'start', method: 'browser' },
      { type: 'started', attempt: 1, start: { method: 'browser', url: 'u' } },
      { type: 'cancel' },
    );
    expect(f.phase).toBe('idle');
    expect(f.url).toBeNull();
    expect(nextPollDelay(f)).toBeNull();
  });

  it('drops late replies to an abandoned attempt', () => {
    const cancelled = run(
      { type: 'start', method: 'browser' },
      { type: 'cancel' },
    );
    // attempt 1's start resolves after the cancel.
    const late = reduceFlow(cancelled, {
      type: 'started',
      attempt: 1,
      start: { method: 'browser', url: 'u' },
    });
    expect(late).toBe(cancelled);

    const second = run(
      { type: 'start', method: 'browser' },
      { type: 'start', method: 'device_code' },
    );
    expect(second.attempt).toBe(2);
    const stalePoll = reduceFlow(second, {
      type: 'poll',
      attempt: 1,
      state: { state: 'done', status: signedIn },
    });
    expect(stalePoll).toBe(second);
    const staleFail = reduceFlow(second, {
      type: 'failed',
      attempt: 1,
      error: 'x',
    });
    expect(staleFail).toBe(second);
  });

  it('a poll outside a waiting phase is ignored', () => {
    const f = run({ type: 'start', method: 'browser' });
    expect(
      reduceFlow(f, { type: 'poll', attempt: 1, state: { state: 'denied' } }),
    ).toBe(f);
  });
});

describe('helpers', () => {
  it('accountLabel prefers the name', () => {
    expect(accountLabel(signedIn.user!)).toBe('Ada Lovelace');
    expect(accountLabel({ ...signedIn.user!, name: null })).toBe(
      'ada@example.com',
    );
    expect(accountLabel({ ...signedIn.user!, name: '  ' })).toBe(
      'ada@example.com',
    );
  });

  it('looksLikeEmail', () => {
    expect(looksLikeEmail('ada@example.com')).toBe(true);
    expect(looksLikeEmail(' ada@example.com ')).toBe(true);
    expect(looksLikeEmail('ada@')).toBe(false);
    expect(looksLikeEmail('ada example.com')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });

  it('signInErrorText puts core errors in words', () => {
    expect(
      signInErrorText('account: rejected: invalid_client: Unknown client.'),
    ).toMatch(/client id/);
    expect(signInErrorText('account: network: timed out')).toMatch(
      /connection/,
    );
    expect(signInErrorText('account: rejected: access_denied')).toMatch(
      /turned this sign-in down/,
    );
    expect(signInErrorText('something else')).toBe('something else');
  });
});
