// ─── Tool Result Cache ────────────────────────────────────────────────────────
// In-memory cache with per-tool TTL. Only read-only / idempotent tools are cached.
// Stateful tools (facebook_publisher, meta_ads, etc.) are intentionally excluded.

interface CacheEntry {
  result:    string;
  expiresAt: number;
}

// TTL in milliseconds per tool name. Only tools whose results are safe to reuse.
const CACHE_TTL: Record<string, number> = {
  web_researcher:   10 * 60 * 1000,  // 10 min — web search results
  google_workspace:  2 * 60 * 1000,  // 2 min  — docs/drive listings (can change)
};

const cache = new Map<string, CacheEntry>();

// ─── Key ─────────────────────────────────────────────────────────────────────

function buildKey(toolName: string, args: Record<string, unknown>): string {
  // Stable JSON serialization: sort keys so arg order doesn't affect the key
  const stableArgs = JSON.stringify(args, Object.keys(args).sort());
  return `${toolName}::${stableArgs}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getCached(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  const ttl = CACHE_TTL[toolName];
  if (!ttl) return null;                    // tool not cacheable

  const key   = buildKey(toolName, args);
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.result;
}

export function setCached(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): void {
  const ttl = CACHE_TTL[toolName];
  if (!ttl) return;                         // tool not cacheable
  if (result.startsWith("❌")) return;      // never cache errors

  const key = buildKey(toolName, args);
  cache.set(key, { result, expiresAt: Date.now() + ttl });
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/** Remove all expired entries. Called periodically from agent startup. */
export function pruneExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}

/** Returns current cache stats for debugging. */
export function getCacheStats(): { size: number; tools: string[] } {
  const tools = [...new Set([...cache.keys()].map(k => k.split("::")[0]))];
  return { size: cache.size, tools };
}
