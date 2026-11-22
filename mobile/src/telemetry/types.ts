/**
 * The one record every sink reads (docs/telemetry.md "Mobile"): the
 * desktop's `tracing` record in TypeScript.
 *
 * ```text
 * log.info / warn / error ─┐
 * track(event, props)     ─┼─▶ Record {ts, level, kind, msg, op_id, fields}
 * reportError(code, err)  ─┘        │
 *                                   ▼ redaction (src/telemetry/redact.ts)
 *                        ring (always, local) · PostHog (product) · relay (warn+)
 * ```
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** `log`: a plain line; `product`: a catalog event; `error`: a JS error,
 *  a crash or a failure with an `error.code`. */
export type Kind = 'log' | 'product' | 'error';

/** A field's value: scalars only, never objects (a nested object is
 *  flattened or stringified before it gets here). */
export type FieldValue = string | number | boolean | null;

export type Fields = Record<string, FieldValue>;

export interface TelemetryRecord {
  /** Unix ms. */
  ts: number;
  level: Level;
  kind: Kind;
  msg: string;
  /** A request flow's correlation id (`req_…`, 16 hex, …), when in one. */
  op_id?: string;
  /** `kind === 'product'`: the catalog event. */
  event?: string;
  fields: Fields;
}

export const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** What every remote record says about the build it came from. */
export interface AppFacts {
  app_version: string;
  /** `store` (an EAS build), `web`, `dev`. */
  channel: string;
  /** `ios`, `android`, `web`. */
  platform: string;
  /** The OS it runs on (a browser: the OS under it). */
  os: string;
  os_version: string;
  /** The commit, when the build knows it; else `unknown`. */
  build: string;
  /** `production`, `staging`, `dev`. */
  build_env: string;
}
