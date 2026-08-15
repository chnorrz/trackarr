// Simple in-memory TTL cache. Good enough for a single-process server -
// no need for anything fancier here.
export class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
