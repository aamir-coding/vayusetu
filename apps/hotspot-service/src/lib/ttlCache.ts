/**
 * A small in-process TTL cache for read-through lookups.
 *
 * - Concurrent misses for one key share a single in-flight load, so a burst
 *   of identical requests costs one backend call, not N.
 * - Rejections are never cached: the next caller retries.
 * - Bounded: past `maxEntries` the oldest entry is evicted (Map keeps
 *   insertion order).
 *
 * Per Cloud Run instance, which is fine for data that is identical on every
 * instance and only changes on a known schedule.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    if (hit) this.entries.delete(key);

    const value = load();
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
