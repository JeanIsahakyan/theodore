/**
 * The cloud's telemetry, wired from the Worker's bindings: the logger every
 * module writes to, the OTLP sink behind it, and the relay's own send.
 *
 * ```text
 * THEODORE_OTLP_ENDPOINT (var) + THEODORE_OTLP_HEADERS (secret) ─▶ a target
 *   both ─▶ warn/error + REMOTE_INFO events ─▶ New Relic, service.name theodore-cloud
 *           relay batches ─▶ New Relic, the client's resource
 *   either missing ─▶ Workers Logs only; the relay answers 202 and drops
 * ```
 *
 * One instance per isolate (the bindings don't change under it): the
 * Worker and the `OrgHub` each `flush()` on `ctx.waitUntil` after their work.
 */
import {
  consoleSink,
  Logger,
  noopSink,
  type LogRecord,
  type LogSink,
} from './log';
import {
  LogBatcher,
  parseOtlpHeaders,
  sendLogs,
  type OtlpTarget,
} from './otlp';
import type { Attrs } from './redact';

export interface TelemetryEnv {
  /** OTLP/HTTP base URL (`/v1/logs` appended), e.g. https://otlp.nr-data.net. */
  THEODORE_OTLP_ENDPOINT?: string;
  /** `k=v,k2=v2`, e.g. `api-key=<license key>`; a secret. */
  THEODORE_OTLP_HEADERS?: string;
  /** `staging`, `production`, `local`: `deployment.environment.name`. */
  THEODORE_ENV?: string;
}

/** What the relay forwards: the client's resource and its records, checked. */
export interface RelayBatch {
  resource: Attrs;
  records: LogRecord[];
}

export interface Telemetry {
  log: Logger;
  /** Whether records leave the Worker at all. */
  readonly remote: boolean;
  /** A relay batch to New Relic (never throws); resolves when sent or dropped. */
  relay(batch: RelayBatch): Promise<void>;
  /** The cloud's own queued records out, coalesced; for `ctx.waitUntil`. */
  flush(): Promise<void>;
}

export const CLOUD_SERVICE = 'theodore-cloud';
export const RELAY_SCOPE = 'theodore-relay';

/** The cloud's own OTLP resource. */
export function cloudResource(env: TelemetryEnv): Attrs {
  return {
    'service.name': CLOUD_SERVICE,
    'deployment.environment.name': env.THEODORE_ENV ?? 'local',
    'cloud.provider': 'cloudflare',
    'cloud.platform': 'cloudflare_workers',
  };
}

export function otlpTarget(env: TelemetryEnv): OtlpTarget | null {
  const endpoint = env.THEODORE_OTLP_ENDPOINT?.trim();
  const headers = parseOtlpHeaders(env.THEODORE_OTLP_HEADERS);
  if (!endpoint || Object.keys(headers).length === 0) return null;
  return { endpoint, headers };
}

export interface TelemetryOptions {
  fetch?: typeof fetch;
  /** Flush coalescing window (ms); 0 in tests. */
  linger?: number;
  /** Where records also go locally; `consoleSink` in the Worker. */
  local?: LogSink;
  now?: () => number;
}

export function createTelemetry(
  env: TelemetryEnv,
  o: TelemetryOptions = {},
): Telemetry {
  const fetchFn = o.fetch ?? ((input, init) => fetch(input, init));
  const local = o.local ?? consoleSink;
  const target = otlpTarget(env);
  const resource = cloudResource(env);
  const batcher = target
    ? new LogBatcher(async (records) => {
        const out = await sendLogs(
          fetchFn,
          target,
          resource,
          CLOUD_SERVICE,
          records,
        );
        if (!out.ok) {
          local.local({
            ts: o.now?.() ?? Date.now(),
            level: 'warn',
            msg: 'telemetry export failed',
            attrs: {
              records: records.length,
              status: out.status ?? 0,
              kind: out.kind ?? '',
            },
          });
        }
      }, o.linger ?? 500)
    : null;
  const sink: LogSink = {
    local: (r) => local.local(r),
    remote: (r) => batcher?.push(r),
  };
  const log = new Logger(
    batcher ? sink : { ...noopSink, local: sink.local },
    {},
    o.now,
  );
  return {
    log,
    remote: target !== null,
    async relay(batch) {
      if (!target) return;
      const out = await sendLogs(
        fetchFn,
        target,
        batch.resource,
        RELAY_SCOPE,
        batch.records,
      );
      if (!out.ok) {
        log.warn('telemetry relay failed', {
          records: batch.records.length,
          status: out.status ?? 0,
          kind: out.kind ?? '',
        });
      }
    },
    flush: () => batcher?.flush() ?? Promise.resolve(),
  };
}

let current: { key: string; telemetry: Telemetry } | undefined;

/** The isolate's telemetry for these bindings (made once). */
export function telemetryFor(env: TelemetryEnv): Telemetry {
  const key = [
    env.THEODORE_OTLP_ENDPOINT ?? '',
    env.THEODORE_OTLP_HEADERS ?? '',
    env.THEODORE_ENV ?? '',
  ].join('\n');
  if (!current || current.key !== key) {
    current = { key, telemetry: createTelemetry(env) };
  }
  return current.telemetry;
}
