/**
 * JS errors as records (docs/telemetry.md "UI errors"): uncaught errors,
 * unhandled promise rejections and render crashes, deduped and rate-limited
 * so a loop can't flood the sinks.
 *
 * ```text
 * native  ErrorUtils.setGlobalHandler ─▶ ui.uncaught (fatal: error, else warn) ─▶ the previous handler
 * web     window.onerror ─▶ ui.uncaught      window.onunhandledrejection ─▶ ui.unhandled_rejection
 * both    HermesInternal / globalThis unhandled rejection tracking when present
 * ErrorBoundary (src/telemetry/ErrorBoundary.tsx) ─▶ ui.render_crash
 * ```
 */
import { reportError } from './log';
import type { Fields } from './types';

/** The same message within this window is logged once. */
const DEDUPE_MS = 10_000;
/** Most error records a minute. */
const RATE_LIMIT = 20;

const seen = new Map<string, number>();
let minute = 0;
let inMinute = 0;

const messageOf = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Whether this error should be logged now (dedupe, rate limit). */
export function admit(e: unknown, now = Date.now()): boolean {
  const m = Math.floor(now / 60_000);
  if (m !== minute) {
    minute = m;
    inMinute = 0;
  }
  if (inMinute >= RATE_LIMIT) return false;
  const key = messageOf(e).slice(0, 200);
  const last = seen.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  seen.set(key, now);
  if (seen.size > 200) {
    for (const [k, t] of seen) if (now - t > DEDUPE_MS) seen.delete(k);
  }
  inMinute += 1;
  return true;
}

/** A JS error of `code` (`ui.uncaught`, …), once per burst. */
export function reportJsError(
  code: string,
  e: unknown,
  fields: Fields = {},
  level: 'warn' | 'error' = 'error',
): void {
  if (!admit(e)) return;
  reportError(code, e, fields, level);
}

let installed = false;

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalHandler | undefined;
  setGlobalHandler?: (h: GlobalHandler) => void;
}

/** Hooks the runtime's global handlers; the previous ones still run. */
export function installErrorHandlers(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as {
    ErrorUtils?: ErrorUtilsLike;
    window?: Window & typeof globalThis;
    addEventListener?: typeof addEventListener;
  };
  const utils = g.ErrorUtils;
  if (utils?.setGlobalHandler) {
    const previous = utils.getGlobalHandler?.();
    utils.setGlobalHandler((error, isFatal) => {
      reportJsError(
        'ui.uncaught',
        error,
        { fatal: isFatal === true },
        isFatal ? 'error' : 'warn',
      );
      previous?.(error, isFatal);
    });
  }
  if (typeof g.addEventListener === 'function' && typeof g.window !== 'undefined') {
    g.addEventListener('error', (ev: ErrorEvent) => {
      reportJsError('ui.uncaught', ev.error ?? ev.message, { fatal: false });
    });
    g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      reportJsError('ui.unhandled_rejection', ev.reason, {}, 'warn');
    });
  } else {
    // Hermes: no `unhandledrejection` event; the promise polyfill offers a
    // tracker hook instead.
    const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal as
      | { enablePromiseRejectionTracker?: (o: unknown) => void }
      | undefined;
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id: number, reason: unknown) =>
        reportJsError('ui.unhandled_rejection', reason, {}, 'warn'),
      onHandled: () => {},
    });
  }
}
