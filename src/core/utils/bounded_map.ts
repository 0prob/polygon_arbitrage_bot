export interface BoundedMapOptions {
  maxSize: number;
  ttlMs: number;
}

export class BoundedMap<K, V> {
  private map = new Map<K, { value: V; ts: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(options: BoundedMapOptions) {
    if (options.maxSize < 1) throw new RangeError("BoundedMap: maxSize must be >= 1");
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now - entry.ts > this.ttlMs) {
        this.map.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    const now = Date.now();
    let count = 0;
    for (const v of this.map.values()) {
      if (now - v.ts <= this.ttlMs) count++;
    }
    return count;
  }

  keys(): IterableIterator<K> {
    const self = this;
    return (function* () {
      const now = Date.now();
      for (const [k, v] of self.map) {
        if (now - v.ts <= self.ttlMs) yield k;
      }
    })();
  }

  entries(): IterableIterator<[K, V]> {
    const self = this;
    return (function* () {
      const now = Date.now();
      for (const [k, v] of self.map) {
        if (now - v.ts <= self.ttlMs) yield [k, v.value] as [K, V];
      }
    })();
  }

  forEach(fn: (value: V, key: K) => void): void {
    for (const [k, v] of this.map) {
      if (Date.now() - v.ts <= this.ttlMs) {
        fn(v.value, k);
      }
    }
  }

  snapshot(): Map<K, V> {
    const result = new Map<K, V>();
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.ts <= this.ttlMs) result.set(k, v.value);
    }
    return result;
  }
}
