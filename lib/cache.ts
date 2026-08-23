interface CacheEntry<T> {
  value: T;
  expires: number;
}

export class TTLCache<T> {
  private readonly ttlMs: number;
  private readonly map = new Map<string, CacheEntry<T>>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
