import type { RequestHandler } from 'express';
import type { AppDeps } from '../types.js';
import { AppError } from '../lib/errors.js';

export interface RateLimitOptions {
  /** pool name: separate limiter pools for student exam routes and integration routes (review §4) */
  pool: string;
  limit: number;
  windowSeconds: number;
  keyOf: (req: Parameters<RequestHandler>[0]) => string;
}

/**
 * Fixed-window counter in Redis. If Redis is unavailable the limiter fails to a
 * conservative in-process counter rather than open, so an outage cannot be
 * used to lift limits.
 */
export function rateLimit(deps: AppDeps, opts: RateLimitOptions): RequestHandler {
  const local = new Map<string, { count: number; resetAt: number }>();
  return async (req, res, next) => {
    const key = `rl:${opts.pool}:${opts.keyOf(req)}`;
    const now = Date.now();
    let count: number;
    try {
      const multi = deps.redis.multi();
      multi.incr(key);
      multi.expire(key, opts.windowSeconds, 'NX');
      const results = await multi.exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch {
      const entry = local.get(key);
      if (!entry || entry.resetAt < now) {
        local.set(key, { count: 1, resetAt: now + opts.windowSeconds * 1000 });
        count = 1;
      } else {
        entry.count += 1;
        count = entry.count;
      }
      if (local.size > 50_000) local.clear();
    }
    res.setHeader('x-ratelimit-limit', String(opts.limit));
    res.setHeader('x-ratelimit-remaining', String(Math.max(0, opts.limit - count)));
    if (count > opts.limit) return next(AppError.tooMany());
    next();
  };
}
