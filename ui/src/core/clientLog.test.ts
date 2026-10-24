import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientLog } from '../gen/contract';
import { FakeTransport } from '../test/fakeTransport';
import { setTransport } from './transport';
import {
  ClientLogLimiter,
  DEDUPE_MS,
  MAX_TEXT,
  RATE_LIMIT,
  installErrorForwarding,
  reportBoundaryError,
} from './clientLog';

const entry = (message: string) => ({
  level: 'error' as const,
  source: 'onerror',
  message,
});

describe('ClientLogLimiter', () => {
  it('drops the same entry within the dedupe window', () => {
    let t = 0;
    const l = new ClientLogLimiter(() => t);
    expect(l.allow(entry('a'))).toBe(true);
    t = DEDUPE_MS - 1;
    expect(l.allow(entry('a'))).toBe(false);
    expect(l.allow(entry('b'))).toBe(true);
    t = DEDUPE_MS + 1;
    expect(l.allow(entry('a'))).toBe(true);
  });

  it('allows at most RATE_LIMIT entries per rolling minute', () => {
    let t = 0;
    const l = new ClientLogLimiter(() => t);
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(l.allow(entry(`m${i}`))).toBe(true);
      t += 100;
    }
    expect(l.allow(entry('over'))).toBe(false);
    t = 60_000 + 50;
    // The first entry fell out of the window: one slot is free again.
    expect(l.allow(entry('next'))).toBe(true);
    expect(l.allow(entry('next2'))).toBe(false);
  });
});

describe('installErrorForwarding', () => {
  let transport: FakeTransport;
  let now = 0;
  let uninstall: () => void;
  const logged = () =>
    transport.calls
      .filter((c) => c.cmd === 'log_client')
      .map((c) => c.args?.entry as ClientLog);
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    now = 0;
    transport = new FakeTransport();
    transport.onCall('log_client', () => null);
    setTransport(transport);
    uninstall = installErrorForwarding(
      window,
      () => 'review',
      () => now,
    );
  });

  afterEach(() => uninstall());

  const fireError = (err: Error) =>
    window.dispatchEvent(
      new ErrorEvent('error', { error: err, message: err.message }),
    );
  const fireRejection = (reason: unknown) => {
    const e = new Event('unhandledrejection') as Event & { reason: unknown };
    e.reason = reason;
    window.dispatchEvent(e);
  };

  it('forwards an uncaught error with the route name', async () => {
    fireError(new TypeError('x is undefined'));
    await flush();
    const [e] = logged();
    expect(e).toMatchObject({
      level: 'error',
      source: 'onerror',
      message: 'TypeError: x is undefined',
      route: 'review',
    });
    expect(e!.stack).toBeTruthy();
  });

  it('forwards an unhandled rejection, deduped', async () => {
    fireRejection(new Error('boom'));
    fireRejection(new Error('boom'));
    await flush();
    expect(logged()).toHaveLength(1);
    expect(logged()[0]!.source).toBe('unhandledrejection');
    now += DEDUPE_MS + 1;
    fireRejection(new Error('boom'));
    await flush();
    expect(logged()).toHaveLength(2);
  });

  it('stops at the rate limit', async () => {
    for (let i = 0; i < RATE_LIMIT + 5; i++) fireError(new Error(`e${i}`));
    await flush();
    expect(logged()).toHaveLength(RATE_LIMIT);
  });

  it("carries a failed command's op id", async () => {
    fireRejection(Object.assign(new Error('offline'), { opId: 'abc' }));
    await flush();
    expect(logged()[0]!.op_id).toBe('abc');
  });

  it('truncates long messages', async () => {
    fireRejection('x'.repeat(MAX_TEXT * 2));
    await flush();
    expect(logged()[0]!.message.length).toBeLessThanOrEqual(MAX_TEXT + 1);
  });

  it('survives logClient failing, without recursing', async () => {
    transport.onCall('log_client', () => {
      throw new Error('ipc down');
    });
    fireError(new Error('first'));
    await flush();
    fireError(new Error('second'));
    await flush();
    expect(logged()).toHaveLength(2);
  });

  it('forwards boundary errors with the component stack', async () => {
    reportBoundaryError(new Error('render'), '\n    at Review');
    await flush();
    expect(logged()[0]).toMatchObject({
      source: 'boundary',
      component_stack: '\n    at Review',
    });
  });
});
