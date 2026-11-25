/**
 * The cloud's structured logger (docs/telemetry.md "Cloud"): one record,
 * redacted once, to Workers Logs always and to New Relic for what matters.
 *
 * ```text
 * log.info / warn / error / exception ─▶ base + attrs ─▶ redact ─▶ record
 *   ─▶ console.<level>(JSON)                       always (Workers Logs)
 *   ─▶ sink.remote(record, ids hashed)             warn, error, and the info
 *                                                  events in REMOTE_INFO
 * ```
 *
 * Nothing here is awaited: a sink that sends (src/telemetry/otlp.ts)
 * queues and flushes on `ctx.waitUntil`.
 */
import {
  hashIdentities,
  MAX_STACK,
  redactAttrs,
  redactText,
  type Attrs,
  type AttrValue,
} from './redact';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  /** Unix ms. */
  ts: number;
  level: Level;
  msg: string;
  attrs: Attrs;
}

/** Where redacted records go. `remote` gets identity fields hashed. */
export interface LogSink {
  local(record: LogRecord): void;
  remote(record: LogRecord): void;
}

/**
 * Info events worth the trip to New Relic: the operational picture
 * (traffic, fleet, pushes, limits). Everything else at info stays in
 * Workers Logs; warn and error always go.
 */
export const REMOTE_INFO: ReadonlySet<string> = new Set([
  'http request',
  'auth failed',
  'rate limited',
  'quota hit',
  'fleet connected',
  'fleet disconnected',
  'fleet device adopted',
  'fleet request',
  'push sent',
  'telemetry relayed',
]);

const SEVERITY: Record<Level, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

/** OTLP's `severityNumber` for a level. */
export const severityNumber = (level: Level) => SEVERITY[level];

/** Workers Logs: one JSON object per line, the console method as its level. */
export const consoleSink: LogSink = {
  local(record) {
    const line = JSON.stringify({
      ts: new Date(record.ts).toISOString(),
      level: record.level,
      msg: record.msg,
      ...record.attrs,
    });
    if (record.level === 'error') console.error(line);
    else if (record.level === 'warn') console.warn(line);
    else console.log(line);
  },
  remote() {},
};

export const noopSink: LogSink = { local() {}, remote() {} };

export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly base: Attrs = {},
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** The same sinks with more fixed attributes (a request's, a hub's). */
  child(attrs: Record<string, unknown>): Logger {
    return new Logger(
      this.sink,
      { ...this.base, ...redactAttrs(attrs) },
      this.clock,
    );
  }

  debug(msg: string, attrs?: Record<string, unknown>) {
    this.log('debug', msg, attrs);
  }
  info(msg: string, attrs?: Record<string, unknown>) {
    this.log('info', msg, attrs);
  }
  warn(msg: string, attrs?: Record<string, unknown>) {
    this.log('warn', msg, attrs);
  }
  error(msg: string, attrs?: Record<string, unknown>) {
    this.log('error', msg, attrs);
  }

  /** An exception: its kind, redacted message and stack, at error level. */
  exception(msg: string, e: unknown, attrs?: Record<string, unknown>) {
    this.log('error', msg, { ...attrs, ...errorAttrs(e) });
  }

  log(level: Level, msg: string, attrs?: Record<string, unknown>) {
    const record: LogRecord = {
      ts: this.clock(),
      level,
      msg: redactText(msg, 512),
      attrs: { ...this.base, ...(attrs ? redactAttrs(attrs) : {}) },
    };
    this.sink.local(record);
    if (level === 'warn' || level === 'error' || REMOTE_INFO.has(msg)) {
      this.sink.remote({ ...record, attrs: hashIdentities(record.attrs) });
    }
  }
}

/** `error.kind`, `error.message`, `error.stack` for any thrown value. */
export function errorAttrs(e: unknown): Record<string, AttrValue> {
  if (e instanceof Error) {
    const out: Record<string, AttrValue> = {
      'error.kind': e.name,
      'error.message': redactText(e.message, 1024),
    };
    if (e.stack) out['error.stack'] = redactText(e.stack, MAX_STACK);
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') out['error.code'] = code;
    return out;
  }
  return { 'error.kind': typeof e };
}

export const noopLogger = new Logger(noopSink);
