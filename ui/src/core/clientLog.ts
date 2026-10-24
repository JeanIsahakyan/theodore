/** UI errors → the core's log (`log_client`). The core redacts, rate-limits
 *  and dedupes again; this side keeps a crash loop from flooding IPC.
 *
 *  window error / unhandledrejection / error boundary
 *        └─▶ ClientLog { source, message, stack, route name }
 *              └─▶ ClientLogLimiter (dedupe 10 s, 20 per minute)
 *                    └─▶ api.logClient  (never throws, never toasts)
 */
import type { ClientLog } from '../gen/contract';
import { api } from './api';

/** Same level + source + message within this window is dropped. */
export const DEDUPE_MS = 10_000;
/** At most this many entries per rolling minute. */
export const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Message and stack are cut to this many characters. */
export const MAX_TEXT = 4096;

export class ClientLogLimiter {
  private readonly lastSeen = new Map<string, number>();
  private sent: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether `entry` may go out now; records it if so. */
  allow(entry: Pick<ClientLog, 'level' | 'source' | 'message'>): boolean {
    const t = this.now();
    const key = `${entry.level}\u0000${entry.source}\u0000${entry.message}`;
    const last = this.lastSeen.get(key);
    if (last !== undefined && t - last < DEDUPE_MS) return false;
    this.sent = this.sent.filter((s) => t - s < RATE_WINDOW_MS);
    if (this.sent.length >= RATE_LIMIT) return false;
    this.sent.push(t);
    this.lastSeen.set(key, t);
    // Forget old keys so a long session doesn't grow the map forever.
    if (this.lastSeen.size > 200) {
      for (const [k, v] of this.lastSeen) {
        if (t - v >= DEDUPE_MS) this.lastSeen.delete(k);
      }
    }
    return true;
  }
}

const cut = (s: string): string =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;

function describe(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    return {
      message: cut(`${value.name}: ${value.message}`),
      stack: value.stack ? cut(value.stack) : null,
    };
  }
  let message: string;
  try {
    message =
      typeof value === 'string' ? value : (JSON.stringify(value) ?? 'unknown');
  } catch {
    message = String(value);
  }
  return { message: cut(message), stack: null };
}

let limiter = new ClientLogLimiter();
let routeName: () => string | null = () => null;
/** Set while a forward is in flight: an error raised by forwarding itself
 *  is never forwarded again. */
let forwarding = false;

function forward(entry: ClientLog): void {
  if (forwarding) return;
  forwarding = true;
  try {
    if (!limiter.allow(entry)) return;
    void api.logClient(entry).catch(() => {});
  } catch {
    // Logging must never become the next error.
  } finally {
    forwarding = false;
  }
}

function safeRoute(): string | null {
  try {
    return routeName();
  } catch {
    return null;
  }
}

function build(
  source: ClientLog['source'],
  value: unknown,
  componentStack: string | null = null,
): ClientLog {
  const { message, stack } = describe(value);
  return {
    level: 'error',
    source,
    message,
    stack,
    component_stack: componentStack ? cut(componentStack) : null,
    op_id:
      value && typeof value === 'object' && 'opId' in value
        ? ((value as { opId?: string }).opId ?? null)
        : null,
    route: safeRoute(),
  };
}

/** Forwards uncaught errors and unhandled rejections. `getRoute` returns
 *  the route NAME only (`review`, `inbox`), never ids or titles. Returns
 *  the uninstaller. */
export function installErrorForwarding(
  win: Window,
  getRoute: () => string | null,
  clock: () => number = Date.now,
): () => void {
  routeName = getRoute;
  limiter = new ClientLogLimiter(clock);
  const onError = (e: ErrorEvent) =>
    forward(build('onerror', e.error ?? e.message));
  const onRejection = (e: PromiseRejectionEvent) =>
    forward(build('unhandledrejection', e.reason));
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}

/** For the top-level error boundary. */
export function reportBoundaryError(
  error: unknown,
  componentStack: string | null | undefined,
): void {
  forward(build('boundary', error, componentStack ?? null));
}
