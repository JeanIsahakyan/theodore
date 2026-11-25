// PostHog person deletion (src/posthog.ts): off without a key and a
// project; otherwise find the person by distinct id, delete it with its
// events; already gone is fine, anything else throws (account.ts swallows).
import { describe, expect, it } from 'vitest';
import { PosthogError, posthogForgetter } from '../src/posthog';

const ENV = {
  POSTHOG_PERSONAL_API_KEY: 'phx_test',
  POSTHOG_PROJECT_ID: '42',
  POSTHOG_API_HOST: 'https://ph.test/',
};

function fake(answers: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      auth: new Headers(init.headers).get('authorization'),
    });
    const a = answers[`${method} ${url}`];
    return a ? a() : new Response('nope', { status: 500 });
  };
  return { calls, fetchFn };
}

describe('posthogForgetter', () => {
  it('is off without a key or a project', () => {
    expect(posthogForgetter({})).toBeNull();
    expect(posthogForgetter({ POSTHOG_PERSONAL_API_KEY: 'k' })).toBeNull();
    expect(posthogForgetter({ POSTHOG_PROJECT_ID: '1' })).toBeNull();
  });

  it('finds the person by distinct id and deletes it with its events', async () => {
    const base = 'https://ph.test/api/projects/42/persons/';
    const f = fake({
      [`GET ${base}?distinct_id=user_alice`]: () =>
        Response.json({ results: [{ id: 'p-1' }] }),
      [`DELETE ${base}p-1/?delete_events=true`]: () =>
        new Response(null, { status: 204 }),
    });
    await posthogForgetter(ENV, f.fetchFn)!('user_alice');
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${base}?distinct_id=user_alice`,
      `DELETE ${base}p-1/?delete_events=true`,
    ]);
    expect(f.calls.every((c) => c.auth === 'Bearer phx_test')).toBe(true);
  });

  it('no person: nothing to delete', async () => {
    const f = fake({
      'GET https://ph.test/api/projects/42/persons/?distinct_id=u': () =>
        Response.json({ results: [] }),
    });
    await posthogForgetter(ENV, f.fetchFn)!('u');
    expect(f.calls).toHaveLength(1);
  });

  it('throws on a failure (the caller never waits on it)', async () => {
    const f = fake({});
    await expect(posthogForgetter(ENV, f.fetchFn)!('u')).rejects.toBeInstanceOf(
      PosthogError,
    );
  });
});
