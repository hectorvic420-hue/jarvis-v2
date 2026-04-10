import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RateLimiter,
  MemoryRateLimitStore,
  RateLimitError,
  RATE_LIMITS
} from '../../src/security/rateLimiter';

describe('RateLimiter', () => {
  let store: MemoryRateLimitStore;
  let limiter: RateLimiter;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
    limiter = new RateLimiter(store);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Configuración básica', () => {
    it('debe permitir requests dentro del límite', async () => {
      const result = await limiter.checkLimit('user1', 'agent_run');
      expect(result.isOk()).toBe(true);
    });

    it('debe bloquear después de exceder límite', async () => {
      const config = RATE_LIMITS.agent_run;

      // Hacer requests hasta el límite
      for (let i = 0; i < config.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      // El siguiente debe fallar
      const result = await limiter.checkLimit('user1', 'agent_run');
      expect(result.isErr()).toBe(true);
      expect((result as any).error).toBeInstanceOf(RateLimitError);
    });

    it('debe permitir requests después de reset de ventana', async () => {
      const config = RATE_LIMITS.agent_run;

      // Exceder límite
      for (let i = 0; i < config.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      const blocked = await limiter.checkLimit('user1', 'agent_run');
      expect(blocked.isErr()).toBe(true);

      // Avanzar tiempo más allá de la ventana
      vi.advanceTimersByTime(config.windowMs + 1000);

      // Debe permitir de nuevo
      const allowed = await limiter.checkLimit('user1', 'agent_run');
      expect(allowed.isOk()).toBe(true);
    });
  });

  describe('Límites por tipo de acción', () => {
    it('debe tener límites diferentes para cada acción', async () => {
      const agentConfig = RATE_LIMITS.agent_run;
      const imageConfig = RATE_LIMITS.image_generator;

      expect(agentConfig.maxRequests).not.toBe(imageConfig.maxRequests);
    });

    it('debe trackear acciones independientemente', async () => {
      // Agotar límite de agent_run
      for (let i = 0; i < RATE_LIMITS.agent_run.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      const agentBlocked = await limiter.checkLimit('user1', 'agent_run');
      expect(agentBlocked.isErr()).toBe(true);

      // Pero tool_execution debe seguir funcionando
      const toolAllowed = await limiter.checkLimit('user1', 'tool_execution');
      expect(toolAllowed.isOk()).toBe(true);
    });

    it('debe respetar límite estricto de self_repair (3/hora)', async () => {
      const config = RATE_LIMITS.self_repair;
      expect(config.maxRequests).toBe(3);
      expect(config.windowMs).toBe(3_600_000); // 1 hora

      // 3 requests permitidos
      for (let i = 0; i < 3; i++) {
        const result = await limiter.checkLimit('user1', 'self_repair');
        expect(result.isOk()).toBe(true);
      }

      // 4to bloqueado
      const blocked = await limiter.checkLimit('user1', 'self_repair');
      expect(blocked.isErr()).toBe(true);
    });
  });

  describe('Aislamiento por usuario', () => {
    it('debe trackear usuarios independientemente', async () => {
      const config = RATE_LIMITS.agent_run;

      // Agotar límite de user1
      for (let i = 0; i < config.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      // user1 bloqueado
      const user1Blocked = await limiter.checkLimit('user1', 'agent_run');
      expect(user1Blocked.isErr()).toBe(true);

      // user2 debe poder continuar
      const user2Allowed = await limiter.checkLimit('user2', 'agent_run');
      expect(user2Allowed.isOk()).toBe(true);
    });
  });

  describe('getLimitStatus', () => {
    it('debe retornar estado inicial correcto', async () => {
      const status = await limiter.getLimitStatus('user1', 'agent_run');

      expect(status.limit).toBe(RATE_LIMITS.agent_run.maxRequests);
      expect(status.remaining).toBe(RATE_LIMITS.agent_run.maxRequests);
      expect(status.windowMs).toBe(RATE_LIMITS.agent_run.windowMs);
    });

    it('debe decrementar remaining después de requests', async () => {
      await limiter.checkLimit('user1', 'agent_run');

      const status = await limiter.getLimitStatus('user1', 'agent_run');
      expect(status.remaining).toBe(RATE_LIMITS.agent_run.maxRequests - 1);
    });

    it('debe calcular resetTime correctamente', async () => {
      const before = Date.now();
      await limiter.checkLimit('user1', 'agent_run');

      const status = await limiter.getLimitStatus('user1', 'agent_run');

      expect(status.resetTime).toBeGreaterThan(before);
      expect(status.resetTime).toBeLessThanOrEqual(before + RATE_LIMITS.agent_run.windowMs + 1000);
    });
  });

  describe('resetLimit', () => {
    it('debe resetear límite específico', async () => {
      // Agotar límite
      for (let i = 0; i < RATE_LIMITS.agent_run.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      const blocked = await limiter.checkLimit('user1', 'agent_run');
      expect(blocked.isErr()).toBe(true);

      // Reset
      await limiter.resetLimit('user1', 'agent_run');

      // Debe permitir de nuevo
      const allowed = await limiter.checkLimit('user1', 'agent_run');
      expect(allowed.isOk()).toBe(true);
    });
  });

  describe('Middleware', () => {
    it('debe crear middleware funcional', () => {
      const middleware = limiter.middleware('agent_run');
      expect(typeof middleware).toBe('function');
    });

    it('debe setear headers de rate limit', async () => {
      const middleware = limiter.middleware('agent_run');
      const req = { user: { id: 'user1' } };
      const res = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };
      const next = vi.fn();

      await middleware(req, res, next);

      // Debe llamar next si está dentro del límite
      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
    });

    it('debe retornar 429 cuando excede límite', async () => {
      const middleware = limiter.middleware('agent_run');
      const config = RATE_LIMITS.agent_run;

      // Agotar límite primero
      for (let i = 0; i < config.maxRequests; i++) {
        await limiter.checkLimit('user1', 'agent_run');
      }

      const req = { user: { id: 'user1' } };
      const res = {
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };
      const next = vi.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('MemoryRateLimitStore', () => {
    it('debe auto-limpiar entradas expiradas', async () => {
      const store = new MemoryRateLimitStore();
      const key = 'test:key';

      await store.set(key, {
        count: 1,
        windowStart: Date.now(),
        lastRequest: Date.now()
      }, 100); // 100ms TTL

      expect(await store.get(key)).not.toBeNull();

      // Avanzar tiempo
      vi.advanceTimersByTime(150);

      // Debe estar limpio
      expect(await store.get(key)).toBeNull();
    });

    it('debe permitir clear para testing', () => {
      const store = new MemoryRateLimitStore();

      store.set('key1', { count: 1, windowStart: 0, lastRequest: 0 }, 10000);
      store.set('key2', { count: 1, windowStart: 0, lastRequest: 0 }, 10000);

      expect(store.size()).toBe(2);

      store.clear();

      expect(store.size()).toBe(0);
    });
  });

  describe('Acciones desconocidas', () => {
    it('debe rechazar acción no definida', async () => {
      const result = await limiter.checkLimit('user1', 'unknown_action' as any);
      expect(result.isErr()).toBe(true);
      expect((result as any).error.message).toContain('Acción desconocida');
    });
  });

  describe('Edge cases', () => {
    it('debe manejar userId vacío', async () => {
      const result = await limiter.checkLimit('', 'agent_run');
      expect(result.isOk()).toBe(true); // Trackea como usuario anónimo
    });

    it('debe manejar múltiples requests concurrentes', async () => {
      const promises = Array(5).fill(null).map(() =>
        limiter.checkLimit('user1', 'agent_run')
      );

      const results = await Promise.all(promises);

      // Algunos pueden fallar si exceden límite, pero no debe crashear
      const successCount = results.filter(r => r.isOk()).length;
      expect(successCount).toBeLessThanOrEqual(RATE_LIMITS.agent_run.maxRequests);
    });
  });
});
