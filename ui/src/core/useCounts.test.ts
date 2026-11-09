import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from './transport';
import { FakeTransport } from '../test/fakeTransport';
import { countUse, flushUseCounts } from './useCounts';

const sent = (t: FakeTransport) =>
  t.calls.filter((c) => c.cmd === 'track_ui').map((c) => c.args);

describe('use counts', () => {
  let transport: FakeTransport;
  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    setTransport(transport);
    transport.onCall('track_ui', () => null);
  });
  afterEach(() => {
    flushUseCounts();
    vi.useRealTimers();
  });

  it('sends one event for many uses, counts only', () => {
    countUse('tool_rows');
    countUse('tool_rows');
    countUse('file_hovers');
    expect(sent(transport)).toEqual([]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(sent(transport)).toEqual([
      { event: { event: 'ui_counts', tool_rows: 2, file_hovers: 1 } },
    ]);
  });

  it('sends nothing when nothing was used', () => {
    flushUseCounts();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sent(transport)).toEqual([]);
  });

  it('starts over after a flush', () => {
    countUse('file_hovers');
    flushUseCounts();
    countUse('file_hovers');
    flushUseCounts();
    expect(sent(transport)).toEqual([
      { event: { event: 'ui_counts', tool_rows: 0, file_hovers: 1 } },
      { event: { event: 'ui_counts', tool_rows: 0, file_hovers: 1 } },
    ]);
  });

  it('flushes when the window hides', () => {
    countUse('tool_rows');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.restoreAllMocks();
    expect(sent(transport)).toHaveLength(1);
  });
});
