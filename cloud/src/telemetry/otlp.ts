/**
 * OTLP/HTTP JSON logs to New Relic (or any OTLP collector), for the cloud's
 * own records and for what the relay forwards (docs/telemetry.md "Cloud").
 *
 * ```text
 * records ─▶ LogBatcher (≤ MAX_BATCH queued, oldest dropped)
 *   ─▶ flush() (ctx.waitUntil, coalesced over `linger` ms)
 *   ─▶ POST <endpoint>/v1/logs  headers from THEODORE_OTLP_HEADERS (k=v,k2=v2)
 *      {resourceLogs: [{resource, scopeLogs: [{scope, logRecords}]}]}
 *      a failure is logged locally once per flush, never retried
 * ```
 */
import { severityNumber, type LogRecord } from './log';
import type { Attrs, AttrValue } from './redact';

/** Where to send, and with what headers. */
export interface OtlpTarget {
  /** Base URL; `/v1/logs` is appended. */
  endpoint: string;
  headers: Record<string, string>;
}

/** Records kept between flushes; over it the oldest go. */
export const MAX_BATCH = 200;

/** The attribute value shape OTLP wants. */
function anyValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

function keyValues(attrs: Attrs): { key: string; value: unknown }[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: anyValue(value),
  }));
}

/** `k=v,k2=v2` (as the app's `THEODORE_OTLP_HEADERS`) as a header map. */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** The request body for one resource's records. */
export function otlpLogsPayload(
  resource: Attrs,
  scope: string,
  records: LogRecord[],
): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: keyValues(resource) },
        scopeLogs: [
          {
            scope: { name: scope },
            logRecords: records.map((r) => ({
              timeUnixNano: `${r.ts}000000`,
              observedTimeUnixNano: `${Date.now()}000000`,
              severityNumber: severityNumber(r.level),
              severityText: r.level.toUpperCase(),
              body: { stringValue: r.msg },
              attributes: keyValues(r.attrs),
            })),
          },
        ],
      },
    ],
  };
}

/** Sends one batch. Never throws; `false` when it didn't land. */
export async function sendLogs(
  fetchFn: typeof fetch,
  target: OtlpTarget,
  resource: Attrs,
  scope: string,
  records: LogRecord[],
): Promise<{ ok: boolean; status?: number; kind?: string }> {
  if (records.length === 0) return { ok: true };
  const url = `${target.endpoint.replace(/\/+$/, '')}/v1/logs`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json' },
      body: JSON.stringify(otlpLogsPayload(resource, scope, records)),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, kind: e instanceof Error ? e.name : typeof e };
  }
}

/**
 * A bounded queue of records with coalesced flushes: `flush()` within
 * `linger` ms of another returns the same promise, so a burst of DO
 * messages or Worker requests is one POST.
 */
export class LogBatcher {
  private queue: LogRecord[] = [];
  private pending: Promise<void> | null = null;
  /** Records dropped since the last flush (over MAX_BATCH). */
  dropped = 0;

  constructor(
    private readonly send: (records: LogRecord[]) => Promise<void>,
    private readonly linger = 500,
    private readonly max = MAX_BATCH,
  ) {}

  get size() {
    return this.queue.length;
  }

  push(record: LogRecord) {
    this.queue.push(record);
    if (this.queue.length > this.max) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  /** Everything queued, sent once; a pending flush is reused. */
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.queue.length === 0) return Promise.resolve();
    const run = async () => {
      if (this.linger > 0) {
        await new Promise((r) => setTimeout(r, this.linger));
      }
      this.pending = null;
      const records = this.queue;
      this.queue = [];
      this.dropped = 0;
      await this.send(records);
    };
    this.pending = run().catch(() => {});
    return this.pending;
  }
}
