export const CACHE_VERSION = 2;
export const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000;
export const CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function cacheTtl(payload) {
  // Never replace good data with a timeout, blocked page or extraction failure.
  if (!payload.complete) return 0;
  return CACHE_RETENTION_MS / 1000;
}

export function readCached(value, now = Date.now(), { allowStale = false } = {}) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || data.schemaVersion !== CACHE_VERSION || !Array.isArray(data.results)) return null;
    const ttl = cacheTtl(data);
    const age = now - data.updatedAt;
    const maxAge = allowStale ? ttl * 1000 : MAX_CACHE_AGE_MS;
    if (!ttl || !Number.isFinite(age) || age < 0 || age >= maxAge) return null;
    return data;
  } catch { return null; }
}
