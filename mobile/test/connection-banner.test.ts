import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTING_GRACE_MS,
  connectionBanner,
  lateConnecting,
} from '../src/ui/connection';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connection banner', () => {
  it('says nothing for a quick reconnect', () => {
    const seen: boolean[] = [];
    const w = lateConnecting((v) => seen.push(v));
    w.update('connected');
    w.update('connecting');
    vi.advanceTimersByTime(CONNECTING_GRACE_MS - 100);
    w.update('connected');
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]);
  });

  it('a background ─▶ foreground cycle on iOS shows nothing', () => {
    const seen: boolean[] = [];
    const w = lateConnecting((v) => seen.push(v));
    w.update('off');
    w.update('connecting');
    vi.advanceTimersByTime(400);
    w.update('connected');
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]);
  });

  it('shows "Connecting…" after the grace, hides it once connected', () => {
    const seen: boolean[] = [];
    const w = lateConnecting((v) => seen.push(v));
    w.update('connecting');
    // Redials keep it connecting: the clock is not restarted.
    vi.advanceTimersByTime(1000);
    w.update('connecting');
    vi.advanceTimersByTime(CONNECTING_GRACE_MS - 1000);
    expect(seen).toEqual([true]);
    expect(connectionBanner('connecting', null, true)).toMatchObject({
      text: 'Connecting to your devices…',
      busy: true,
    });
    w.update('connected');
    expect(seen).toEqual([true, false]);
    w.dispose();
  });

  it('nothing while connecting under the grace, off, or connected', () => {
    expect(connectionBanner('connecting', null, false)).toBeNull();
    expect(connectionBanner('off', null, true)).toBeNull();
    expect(connectionBanner('connected', null, true)).toBeNull();
  });

  it('an error shows at once, with its reason', () => {
    expect(connectionBanner('error', 'fleet.version', false)).toEqual({
      tone: 'danger',
      text: 'Not connected: fleet.version',
      busy: false,
    });
    expect(connectionBanner('error', null, false)?.text).toBe('Not connected.');
  });
});
