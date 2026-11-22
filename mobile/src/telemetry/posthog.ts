/**
 * Usage data to PostHog over plain HTTPS (`POST <host>/batch/`), no SDK:
 * product events only, only while "Share usage data" is on
 * (docs/telemetry.md "PostHog").
 *
 * ```text
 * product record ─▶ {event, distinct_id, timestamp, properties}
 *   properties: the catalog props + app_version, channel, platform, os,
 *               os_version, build, build_env, $geoip_disable: true,
 *               anonymous: $process_person_profile: false
 * batches of 50 or every 30 s ─▶ retried with backoff on 5xx / 429 /
 *   network errors, dropped on another 4xx or after 4 attempts
 * sign-in / app start / sharing turned on, signed in ─▶ $identify
 *   {distinct_id: user_…, $anon_distinct_id, $set: the build facts}
 * ```
 */
import { createQueue, outcomeOf, type BatchQueue } from './queue';
import type { AppFacts, Fields } from './types';

export const POSTHOG_BATCH = 50;
export const POSTHOG_FLUSH_MS = 30_000;
export const POSTHOG_ATTEMPTS = 4;

export interface PostHogEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface PostHogOptions {
  host: string;
  key: string;
  facts: AppFacts;
  fetch: typeof fetch;
  flushMs?: number;
  batchSize?: number;
  backoffMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface PostHogSink {
  /** A product event; `anonymous`: no person profile for this id. */
  capture(
    event: string,
    distinctId: string,
    anonymous: boolean,
    ts: number,
    props: Fields,
  ): void;
  identify(userId: string, anonId: string, ts: number): void;
  flush(): Promise<void>;
  /** Drops what waits (the switch turned off). */
  clear(): void;
  queued(): number;
  sent(): number;
}

/** `host` without a trailing slash, `/batch/` appended. */
export const batchUrl = (host: string): string =>
  `${host.replace(/\/+$/, '')}/batch/`;

export function createPostHog(o: PostHogOptions): PostHogSink {
  const common = (): Record<string, string | number | boolean> => ({
    app_version: o.facts.app_version,
    channel: o.facts.channel,
    platform: o.facts.platform,
    os: o.facts.os,
    os_version: o.facts.os_version,
    build: o.facts.build,
    build_env: o.facts.build_env,
    $geoip_disable: true,
  });
  const queue: BatchQueue<PostHogEvent> = createQueue<PostHogEvent>({
    batchSize: o.batchSize ?? POSTHOG_BATCH,
    flushMs: o.flushMs ?? POSTHOG_FLUSH_MS,
    attempts: POSTHOG_ATTEMPTS,
    backoffMs: o.backoffMs ?? 2_000,
    backoffMaxMs: 60_000,
    maxQueued: 500,
    maxAgeMs: 30 * 60_000,
    now: o.now,
    random: o.random,
    async send(batch) {
      const res = await o.fetch(batchUrl(o.host), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: o.key, batch }),
      });
      return outcomeOf(res.status);
    },
  });
  return {
    capture(event, distinctId, anonymous, ts, props) {
      queue.push({
        event,
        distinct_id: distinctId,
        timestamp: new Date(ts).toISOString(),
        properties: {
          ...props,
          ...common(),
          ...(anonymous ? { $process_person_profile: false } : {}),
        },
      });
    },
    identify(userId, anonId, ts) {
      queue.push({
        event: '$identify',
        distinct_id: userId,
        timestamp: new Date(ts).toISOString(),
        properties: {
          ...common(),
          $anon_distinct_id: anonId,
          $set: JSON.stringify(common()),
        },
      });
    },
    flush: () => queue.flush(),
    clear: () => queue.clear(),
    queued: () => queue.size(),
    sent: () => queue.sent(),
  };
}
