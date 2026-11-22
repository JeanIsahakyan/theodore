/**
 * `POST /v1/telemetry/logs`: the phone and web app's error log, relayed to
 * New Relic so the apps hold no ingest key (docs/telemetry.md "Cloud").
 *
 * ```text
 * {records: [{ts, level: warn|error, msg ≤ 2000, attrs ≤ 30 × (key ≤ 64, string|number|boolean)}] ≤ 100,
 *  resource: {service.name: theodore-mobile|theodore-web, service.version, os.type,
 *             deployment.environment.name, service.instance.id, enduser.id?}}
 *   ─▶ every field checked; unknown or oversized ones dropped; a record with a
 *      bad level, ts or msg dropped (counted); msg and strings redacted again
 *   ─▶ enduser.id kept only when it is the bearer token's user
 *   ─▶ + theodore.relay=true, cloud.region (the colo) on every record
 * ```
 */
import { CloudError } from '../errors';
import type { RelayBatch } from './cloud';
import type { LogRecord } from './log';
import { redactText, type Attrs, type AttrValue } from './redact';

export const RELAY = {
  records: 100,
  msgChars: 2000,
  attrs: 30,
  keyChars: 64,
  valueChars: 2000,
  resourceChars: 256,
  /** A `ts` further in the future than this is clamped to now. */
  futureMs: 5 * 60_000,
  /** A `ts` older than this is clamped (a clock that was never set). */
  pastMs: 30 * 24 * 3_600_000,
} as const;

/** `service.name`s the relay takes. */
export const RELAY_SERVICES: readonly string[] = [
  'theodore-mobile',
  'theodore-web',
];

/** Resource keys kept, as the app sends them (docs/telemetry.md "New Relic"). */
export const RELAY_RESOURCE_KEYS: readonly string[] = [
  'service.name',
  'service.version',
  'os.type',
  'os.version',
  'deployment.environment.name',
  'service.instance.id',
  'enduser.id',
];

const ENDUSER_ID = /^user_[A-Za-z0-9]{1,64}$/;

export interface RelayContext {
  /** The verified bearer's user; absent: anonymous (errors before sign-in). */
  userId?: string;
  nowMs: number;
  /** Cloudflare's colo code, when known. */
  region?: string;
}

export interface ParsedRelay extends RelayBatch {
  /** Records refused (bad level, ts or msg). */
  dropped: number;
  /** The resource's `service.name`. */
  service: string;
}

const bad = (why: string) => new CloudError(400, 'cloud.bad_request', why);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The client's resource, known keys only; `enduser.id` must be the caller. */
export function parseResource(
  raw: unknown,
  userId: string | undefined,
): { resource: Attrs; service: string } {
  if (!isObject(raw)) throw bad('resource is required');
  const service = raw['service.name'];
  if (typeof service !== 'string' || !RELAY_SERVICES.includes(service)) {
    throw bad('resource.service.name is not a Theodore app');
  }
  const resource: Attrs = {};
  for (const key of RELAY_RESOURCE_KEYS) {
    const v = raw[key];
    if (typeof v !== 'string' || v === '' || v.length > RELAY.resourceChars) {
      continue;
    }
    if (key === 'enduser.id') {
      // Never trusted: the token says who this is, or nobody does.
      if (userId === undefined || v !== userId || !ENDUSER_ID.test(v)) continue;
      resource[key] = v;
      continue;
    }
    resource[key] = redactText(v, RELAY.resourceChars);
  }
  return { resource, service };
}

function parseAttrs(raw: unknown): Attrs {
  const out: Attrs = {};
  if (!isObject(raw)) return out;
  let kept = 0;
  for (const [key, v] of Object.entries(raw)) {
    if (kept >= RELAY.attrs) break;
    if (key === '' || key.length > RELAY.keyChars) continue;
    let value: AttrValue;
    if (typeof v === 'string') {
      if (v.length > RELAY.valueChars) continue;
      value = redactText(v, RELAY.valueChars);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      value = v;
    } else if (typeof v === 'boolean') {
      value = v;
    } else {
      continue;
    }
    out[key] = value;
    kept += 1;
  }
  return out;
}

function parseRecord(raw: unknown, ctx: RelayContext): LogRecord | null {
  if (!isObject(raw)) return null;
  const level = raw['level'];
  if (level !== 'warn' && level !== 'error') return null;
  const msg = raw['msg'];
  if (typeof msg !== 'string' || msg === '') return null;
  const given = raw['ts'];
  let ts =
    typeof given === 'number' && Number.isFinite(given) ? given : ctx.nowMs;
  if (ts > ctx.nowMs + RELAY.futureMs || ts < ctx.nowMs - RELAY.pastMs) {
    ts = ctx.nowMs;
  }
  const attrs = parseAttrs(raw['attrs']);
  attrs['theodore.relay'] = true;
  if (ctx.region) attrs['cloud.region'] = ctx.region;
  return {
    ts: Math.floor(ts),
    level,
    msg: redactText(msg, RELAY.msgChars),
    attrs,
  };
}

/** The body of `POST /v1/telemetry/logs`, checked; 400 for what can't be. */
export function parseRelay(
  body: Record<string, unknown>,
  ctx: RelayContext,
): ParsedRelay {
  const records = body['records'];
  if (!Array.isArray(records) || records.length === 0) {
    throw bad('records is required');
  }
  if (records.length > RELAY.records) {
    throw bad(`at most ${RELAY.records} records per request`);
  }
  const { resource, service } = parseResource(body['resource'], ctx.userId);
  const out: LogRecord[] = [];
  let dropped = 0;
  for (const raw of records) {
    const r = parseRecord(raw, ctx);
    if (r) out.push(r);
    else dropped += 1;
  }
  return { resource, records: out, dropped, service };
}
