import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceCache } from './resource';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('resourceCache', () => {
  it('starts loading and resolves to ready', async () => {
    const cache = resourceCache<string>();
    const res = cache.get('k1', () => Promise.resolve('hello'));
    expect(res.status).toBe('loading');
    await flush();
    expect(res.status).toBe('ready');
    expect(res.data).toBe('hello');
  });

  it('dedupes in-flight loads for the same key', async () => {
    const cache = resourceCache<string>();
    const load = vi.fn(() => Promise.resolve('v'));
    const a = cache.get('k1', load);
    const b = cache.get('k1', load);
    expect(a).toBe(b);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never reloads once a key has resolved — immutable data needs no invalidation', async () => {
    const cache = resourceCache<string>();
    const load = vi.fn(() => Promise.resolve('v'));
    cache.get('k1', load);
    await flush();
    cache.get('k1', load);
    cache.get('k1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected load as an error status', async () => {
    const cache = resourceCache<string>();
    const res = cache.get('k1', () => Promise.reject(new Error('boom')));
    await flush();
    expect(res.status).toBe('error');
    expect(res.error).toBe('boom');
  });

  it('evicts the least recently touched key once over the limit', async () => {
    const cache = resourceCache<string>({ limit: 2 });
    cache.get('a', () => Promise.resolve('a'));
    cache.get('b', () => Promise.resolve('b'));
    await flush();
    cache.get('a', () => Promise.resolve('a')); // touch a, so b becomes the oldest
    cache.get('c', () => Promise.resolve('c')); // pushes b out
    await flush();

    expect(cache.peek('a')).toBe('a');
    expect(cache.peek('c')).toBe('c');
    expect(cache.peek('b')).toBeUndefined();
  });

  it('invalidate() forces the next get() to reload', async () => {
    const cache = resourceCache<string>();
    const load = vi.fn(() => Promise.resolve('v'));
    cache.get('k1', load);
    await flush();
    cache.invalidate('k1');
    cache.get('k1', load);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  describe('a failed load', () => {
    afterEach(() => vi.useRealTimers());

    it('is served as is right after the failure — no retry loop on re-render', async () => {
      const cache = resourceCache<string>({ retryAfterMs: 5000 });
      const load = vi.fn(() => Promise.reject(new Error('boom')));
      const a = cache.get('k1', load);
      await flush();
      expect(a.status).toBe('error');
      expect(cache.get('k1', load)).toBe(a);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('is retried by the next get() once it is old enough', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const cache = resourceCache<string>({ retryAfterMs: 5000 });
      const load = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('git: bad object'))
        .mockResolvedValueOnce('rev');
      cache.get('k1', load);
      await flush();
      vi.setSystemTime(Date.now() + 5000);
      const b = cache.get('k1', load);
      expect(b.status).toBe('loading');
      await flush();
      expect(b.status).toBe('ready');
      expect(b.data).toBe('rev');
      expect(load).toHaveBeenCalledTimes(2);
      // A success is cached for good again.
      vi.setSystemTime(Date.now() + 60_000);
      expect(cache.get('k1', load)).toBe(b);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('is retried at once after invalidate() — the Retry button', async () => {
      const cache = resourceCache<string>();
      const load = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('rev');
      cache.get('k1', load);
      await flush();
      cache.invalidate('k1');
      const b = cache.get('k1', load);
      await flush();
      expect(b.status).toBe('ready');
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
