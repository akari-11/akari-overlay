/**
 * A small LRU cache with per-entry expiry, serialisable to JSON so it can be
 * persisted to disk between sessions.
 *
 * `Map` keeps insertion order, so "least recently used" is simply the first
 * key: every read re-inserts the entry at the end.
 */

export interface CacheEntry<V> {
  value: V;
  /** Absolute epoch-ms timestamp after which the entry is stale. */
  expiresAt: number;
}

export interface CacheJson<V> {
  ttlMs: number;
  entries: Array<[string, CacheEntry<V>]>;
}

export class TtlLruCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();

  constructor(
    public readonly ttlMs: number,
    public readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (ttlMs <= 0) throw new RangeError('ttlMs must be > 0');
    if (maxEntries <= 0) throw new RangeError('maxEntries must be > 0');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Returns the cached value, or undefined if absent or expired. Refreshes LRU position. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Stores a value. `ttlMs` overrides the cache default for this entry only. */
  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Drops every expired entry. Returns how many were removed. */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, e] of this.map) {
      if (e.expiresAt <= t) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  toJSON(): CacheJson<V> {
    this.prune();
    return { ttlMs: this.ttlMs, entries: [...this.map.entries()] };
  }

  /** Loads entries produced by `toJSON`, skipping anything already expired. */
  load(json: CacheJson<V> | null | undefined): number {
    if (!json || !Array.isArray(json.entries)) return 0;
    const t = this.now();
    let loaded = 0;
    for (const item of json.entries) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, entry] = item;
      if (typeof key !== 'string' || !entry || typeof entry.expiresAt !== 'number') continue;
      if (entry.expiresAt <= t) continue;
      this.map.delete(key);
      this.map.set(key, { value: entry.value, expiresAt: entry.expiresAt });
      loaded++;
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return loaded;
  }
}
