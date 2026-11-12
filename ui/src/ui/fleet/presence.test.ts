import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetPresenceRequest } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { FakeTransport } from '../../test/fakeTransport';
import { status } from '../../test/fleet';
import { RootStore } from '../../stores/RootStore';
import { PRESENCE_INTERVAL_MS, startPresence, watchPresence } from './presence';

let sent: FleetPresenceRequest[];
let focused: boolean;
let enabled: boolean;
let stop: (() => void) | null = null;

const start = () => {
  stop = startPresence({
    enabled: () => enabled,
    report: (r) => sent.push(r),
    focused: () => focused,
    now: () => Date.now(),
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  focused = true;
  enabled = true;
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe('startPresence', () => {
  it('reports every 15 s while focused, with the time since the last input', () => {
    start();
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(sent).toEqual([{ focused: true, idle_ms: 15_000 }]);
    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS - 5_000);
    expect(sent[1]).toEqual({ focused: true, idle_ms: 10_000 });
  });

  it('input alone sends nothing', () => {
    start();
    for (let i = 0; i < 50; i += 1) {
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('keydown'));
    }
    expect(sent).toEqual([]);
  });

  it('reports at once when focus changes, and stops the clock while away', () => {
    start();
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(sent).toEqual([{ focused: false, idle_ms: 0 }]);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 4);
    expect(sent).toHaveLength(1);

    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(sent[1]).toEqual({ focused: true, idle_ms: 0 });
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(sent).toHaveLength(3);
  });

  it('sends nothing while the fleet is off', () => {
    enabled = false;
    start();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
  });

  it('undone, it is quiet', () => {
    start();
    stop?.();
    stop = null;
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    window.dispatchEvent(new Event('blur'));
    expect(sent).toEqual([]);
  });
});

describe('watchPresence', () => {
  it('starts when the fleet is enabled and stops when it is turned off', () => {
    const transport = new FakeTransport();
    transport.onCall('fleet_presence', () => null);
    setTransport(transport);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const store = new RootStore();
    const calls = () =>
      transport.calls.filter((c) => c.cmd === 'fleet_presence').length;
    const off = watchPresence(store);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    expect(calls()).toBe(0);

    store.fleet.setStatus(status({ enabled: true }));
    expect(calls()).toBe(1);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(calls()).toBe(2);

    store.fleet.setStatus(status({ enabled: false }));
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 3);
    expect(calls()).toBe(2);
    off();
    vi.restoreAllMocks();
  });
});
