import { describe, expect, it, vi } from 'vitest';
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
});
