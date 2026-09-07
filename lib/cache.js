export const CACHE_VERSION = 2;
export const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000;

export function cacheTtl(payload) {
  // Never replace good data with a timeout, blocked page or extraction failure.
  if (!payload.complete) return 0;
  return payload.results.some(r => r.status === 'verified') ? MAX_CACHE_AGE_MS / 1000 : 300;
}

export function readCached(value, now = Date.now()) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || data.schemaVersion !== CACHE_VERSION || !Array.isArray(data.results)) return null;
    const ttl = cacheTtl(data);
    const age = now - data.updatedAt;
    if (!ttl || !Number.isFinite(age) || age < 0 || age >= ttl * 1000) return null;
    return data;
  } catch { return null; }
}
