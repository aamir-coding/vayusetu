import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/lib/ttlCache.js';

describe('TtlCache', () => {
  it('serves hits until the TTL, then reloads', async () => {
    let t = 0;
    const c = new TtlCache<number>(1000, 10, () => t);
    const load = vi.fn(async () => 42);
    expect(await c.get('k', load)).toBe(42);
    t = 999;
    expect(await c.get('k', load)).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000;
    await c.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent misses', async () => {
    const c = new TtlCache<number>(1000, 10);
    let release!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((ok) => (release = ok)));
    const both = Promise.all([c.get('k', load), c.get('k', load)]);
    release(7);
    expect(await both).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never caches a rejection', async () => {
    const c = new TtlCache<number>(1000, 10);
    await expect(c.get('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await c.get('k', async () => 1)).toBe(1);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const c = new TtlCache<number>(1000, 2);
    await c.get('a', async () => 1);
    await c.get('b', async () => 2);
    await c.get('c', async () => 3);
    expect(c.size).toBe(2);
    const reload = vi.fn(async () => 9);
    expect(await c.get('a', reload)).toBe(9); // 'a' was evicted
  });
});
