import { Result, Ok, Err } from '../shared/result.js';

// ─── Configuración de límites por acción ──────────────────────────────────────

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  agent_run:      { maxRequests: 10, windowMs: 60_000 },       // 10 / min
  tool_execution: { maxRequests: 30, windowMs: 60_000 },       // 30 / min
  image_generator:{ maxRequests: 5,  windowMs: 60_000 },       // 5  / min
  self_repair:    { maxRequests: 3,  windowMs: 3_600_000 },    // 3  / hora
  web_researcher: { maxRequests: 20, windowMs: 60_000 },       // 20 / min
  facebook_post:  { maxRequests: 10, windowMs: 3_600_000 },    // 10 / hora
  system_control: { maxRequests: 20, windowMs: 60_000 },       // 20 / min
};

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  lastRequest: number;
}

export interface LimitStatus {
  limit: number;
  remaining: number;
  windowMs: number;
  resetTime: number;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly action: string,
    public readonly userId: string,
    public readonly retryAfterSeconds: number = 0
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface StoredEntry {
  data: RateLimitEntry;
  expiresAt: number;
}

export class MemoryRateLimitStore {
  private readonly store = new Map<string, StoredEntry>();

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    // Lazy expiry — checked on read (works with vitest fake timers)
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  // Note: synchronous Map.set inside async function runs before any await,
  // so callers that omit `await` still see the update immediately.
  async set(key: string, data: RateLimitEntry, ttlMs: number): Promise<void> {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── RateLimiter ─────────────────────────────────────────────────────────────

export class RateLimiter {
  constructor(private readonly store: MemoryRateLimitStore = new MemoryRateLimitStore()) {}

  async checkLimit(
    userId: string,
    action: string
  ): Promise<Result<LimitStatus, RateLimitError>> {
    const config = RATE_LIMITS[action];
    if (!config) {
      return Err(new RateLimitError(
        `Acción desconocida: "${action}"`,
        action,
        userId
      ));
    }

    const key = `${userId || 'anonymous'}:${action}`;
    const now = Date.now();
    const entry = await this.store.get(key);

    // New window or the window has expired
    if (!entry || now - entry.windowStart >= config.windowMs) {
      const fresh: RateLimitEntry = { count: 1, windowStart: now, lastRequest: now };
      await this.store.set(key, fresh, config.windowMs);
      return Ok({
        limit: config.maxRequests,
        remaining: config.maxRequests - 1,
        windowMs: config.windowMs,
        resetTime: now + config.windowMs,
      });
    }

    // Limit exceeded — do NOT increment, just report
    if (entry.count >= config.maxRequests) {
      const resetTime = entry.windowStart + config.windowMs;
      const retryAfter = Math.max(0, Math.ceil((resetTime - now) / 1000));
      return Err(new RateLimitError(
        `Rate limit superado para "${action}". Reintenta en ${retryAfter}s.`,
        action,
        userId,
        retryAfter
      ));
    }

    // Within limit — increment
    const updated: RateLimitEntry = {
      count: entry.count + 1,
      windowStart: entry.windowStart,
      lastRequest: now,
    };
    const remainingTtl = Math.max(1, config.windowMs - (now - entry.windowStart));
    await this.store.set(key, updated, remainingTtl);

    return Ok({
      limit: config.maxRequests,
      remaining: config.maxRequests - updated.count,
      windowMs: config.windowMs,
      resetTime: entry.windowStart + config.windowMs,
    });
  }

  async getLimitStatus(userId: string, action: string): Promise<LimitStatus> {
    const config = RATE_LIMITS[action];
    if (!config) return { limit: 0, remaining: 0, windowMs: 0, resetTime: Date.now() };

    const key = `${userId || 'anonymous'}:${action}`;
    const entry = await this.store.get(key);

    if (!entry) {
      return {
        limit: config.maxRequests,
        remaining: config.maxRequests,
        windowMs: config.windowMs,
        resetTime: Date.now() + config.windowMs,
      };
    }

    return {
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - entry.count),
      windowMs: config.windowMs,
      resetTime: entry.windowStart + config.windowMs,
    };
  }

  async resetLimit(userId: string, action: string): Promise<void> {
    const key = `${userId || 'anonymous'}:${action}`;
    await this.store.delete(key);
  }

  /**
   * Express middleware — aplica rate limit a una ruta.
   * Siempre setea X-RateLimit-* headers; devuelve 429 si se supera el límite.
   */
  middleware(action: string) {
    return async (req: any, res: any, next: any): Promise<void> => {
      const userId: string = req.user?.id ?? req.ip ?? 'anonymous';
      const result = await this.checkLimit(userId, action);
      const status = await this.getLimitStatus(userId, action);

      res.setHeader('X-RateLimit-Limit', status.limit);
      res.setHeader('X-RateLimit-Remaining', status.remaining);

      if (result.isErr()) {
        const resetTime = status.resetTime;
        const retryAfter = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter,
        });
        return;
      }

      next();
    };
  }
}
