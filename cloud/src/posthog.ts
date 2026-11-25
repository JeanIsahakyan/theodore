/**
 * PostHog person deletion on account deletion (docs/telemetry.md "Account
 * deletion"). The apps send usage events under `distinct_id` = the WorkOS
 * user id once a user signs in with usage consent; deleting the account
 * deletes that person and its events too.
 *
 * ```text
 * POSTHOG_PERSONAL_API_KEY (secret) + POSTHOG_PROJECT_ID (var)? no ─▶ nothing
 *   ─▶ GET  <host>/api/projects/<project>/persons/?distinct_id=<user>
 *   ─▶ each person: DELETE …/persons/<uuid>/?delete_events=true
 * ```
 *
 * Best effort: the caller never waits on a failure (account.ts logs it and
 * goes on). A personal API key needs only the `person:write` scope.
 */

export interface PosthogEnv {
  /** A PostHog personal API key with `person:write` (secret). */
  POSTHOG_PERSONAL_API_KEY?: string;
  /** The project the apps send to (numeric id). */
  POSTHOG_PROJECT_ID?: string;
  /** PostHog's API host (not the ingest host); default the US cloud. */
  POSTHOG_API_HOST?: string;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** One call's budget: deletion never hangs on PostHog. */
const TIMEOUT_MS = 5_000;

export class PosthogError extends Error {
  constructor(readonly status: number) {
    super(`posthog answered ${status}`);
    this.name = 'PosthogError';
  }
}

/** Deletes the person(s) with `distinctId`, and their events. */
export type ForgetPerson = (distinctId: string) => Promise<void>;

/** `null` without a key and a project: nothing to delete. */
export function posthogForgetter(
  env: PosthogEnv,
  fetchFn: Fetch = (input, init) => fetch(input, init),
): ForgetPerson | null {
  const key = env.POSTHOG_PERSONAL_API_KEY?.trim();
  const project = env.POSTHOG_PROJECT_ID?.trim();
  if (!key || !project) return null;
  const host = (
    env.POSTHOG_API_HOST?.trim() || 'https://us.posthog.com'
  ).replace(/\/+$/, '');
  const base = `${host}/api/projects/${encodeURIComponent(project)}/persons/`;
  const call = async (url: string, method: string) => {
    const res = await fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Already gone counts as done.
    if (!res.ok && res.status !== 404) throw new PosthogError(res.status);
    return res;
  };
  return async (distinctId) => {
    const q = new URLSearchParams({ distinct_id: distinctId });
    const found = await call(`${base}?${q}`, 'GET');
    if (found.status === 404) return;
    const page = (await found.json()) as { results?: Array<{ id?: string }> };
    for (const p of page.results ?? []) {
      if (!p.id) continue;
      await call(
        `${base}${encodeURIComponent(p.id)}/?delete_events=true`,
        'DELETE',
      );
    }
  };
}
