/**
 * Warnings, errors and JS crashes to New Relic through the Theodore cloud
 * (`POST <cloud>/v1/telemetry/logs`, docs/telemetry.md "Mobile"), so no
 * New Relic key is ever in the app. Only while "Send error reports" is on.
 *
 * ```text
 * warn / error record ─▶ {ts, level, msg ≤ 2000, attrs ≤ 30 keys of string|number|boolean}
 * batch ─▶ {records, resource: {service.name: theodore-mobile, service.version,
 *           os.type, deployment.environment.name, service.instance.id: <install id>,
 *           enduser.id?: user_… (consent 2 only)}}   ≤ 64 KB a request
 * Authorization: Bearer <session JWT> when signed in; errors before sign-in go without
 * ```
 */
import { createQueue, outcomeOf, type BatchQueue } from './queue';
import type { AppFacts, TelemetryRecord } from './types';

export const RELAY_PATH = '/v1/telemetry/logs';
export const RELAY_MSG_MAX = 2000;
export const RELAY_ATTRS_MAX = 30;
export const RELAY_REQUEST_BYTES = 64 * 1024;
export const RELAY_BATCH = 25;
export const RELAY_FLUSH_MS = 10_000;
export const RELAY_ATTEMPTS = 4;

export interface RelayRecord {
  ts: number;
  level: 'warn' | 'error';
  msg: string;
  attrs: Record<string, string | number | boolean>;
}

export interface RelayResource {
  'service.name': 'theodore-mobile';
  'service.version': string;
  'os.type': string;
  'deployment.environment.name': string;
  'service.instance.id': string;
  'enduser.id'?: string;
}

export interface RelayBody {
  records: RelayRecord[];
  resource: RelayResource;
}

/** A redacted record as the relay takes it; `null` below warn. */
export function toRelayRecord(r: TelemetryRecord): RelayRecord | null {
  if (r.level !== 'warn' && r.level !== 'error') return null;
  const attrs: Record<string, string | number | boolean> = {
    kind: r.kind,
  };
  if (r.op_id) attrs.op_id = r.op_id;
  if (r.event) attrs.event = r.event;
  for (const [k, v] of Object.entries(r.fields)) {
    if (Object.keys(attrs).length >= RELAY_ATTRS_MAX) break;
    if (v === null || v === undefined) continue;
    attrs[k] = typeof v === 'string' ? v.slice(0, RELAY_MSG_MAX) : v;
  }
  return { ts: r.ts, level: r.level, msg: r.msg.slice(0, RELAY_MSG_MAX), attrs };
}

export interface RelayOptions {
  cloudUrl: string;
  facts: AppFacts;
  installId: () => string;
  /** The account id, only with error-report consent 2; else `null`. */
  enduser: () => string | null;
  /** The session JWT when signed in. */
  token: () => Promise<string | null>;
  fetch: typeof fetch;
  flushMs?: number;
  batchSize?: number;
  backoffMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface RelaySink {
  push(r: TelemetryRecord): void;
  flush(): Promise<void>;
  clear(): void;
  queued(): number;
  sent(): number;
}

export const relayUrl = (cloud: string): string =>
  `${cloud.replace(/\/+$/, '')}${RELAY_PATH}`;

export function relayBody(
  records: RelayRecord[],
  facts: AppFacts,
  installId: string,
  enduser: string | null,
): RelayBody {
  const resource: RelayResource = {
    'service.name': 'theodore-mobile',
    'service.version': facts.app_version,
    'os.type': facts.os,
    'deployment.environment.name': facts.build_env,
    'service.instance.id': installId,
  };
  if (enduser) resource['enduser.id'] = enduser;
  return { records, resource };
}

export function createRelay(o: RelayOptions): RelaySink {
  const queue: BatchQueue<RelayRecord> = createQueue<RelayRecord>({
    batchSize: o.batchSize ?? RELAY_BATCH,
    flushMs: o.flushMs ?? RELAY_FLUSH_MS,
    attempts: RELAY_ATTEMPTS,
    backoffMs: o.backoffMs ?? 2_000,
    backoffMaxMs: 60_000,
    maxQueued: 300,
    maxAgeMs: 30 * 60_000,
    // Room for the resource and the envelope under the request cap.
    maxBatchBytes: RELAY_REQUEST_BYTES - 2048,
    bytesOf: (r) => JSON.stringify(r).length,
    now: o.now,
    random: o.random,
    async send(batch) {
      const body = relayBody(batch, o.facts, o.installId(), o.enduser());
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const token = await o.token().catch(() => null);
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await o.fetch(relayUrl(o.cloudUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return outcomeOf(res.status);
    },
  });
  return {
    push(r) {
      const rec = toRelayRecord(r);
      if (!rec) return;
      // One record over the cap can't be sent at all.
      if (JSON.stringify(rec).length > RELAY_REQUEST_BYTES - 4096) {
        rec.attrs = { kind: rec.attrs.kind ?? 'log', truncated: true };
      }
      queue.push(rec);
    },
    flush: () => queue.flush(),
    clear: () => queue.clear(),
    queued: () => queue.size(),
    sent: () => queue.sent(),
  };
}
