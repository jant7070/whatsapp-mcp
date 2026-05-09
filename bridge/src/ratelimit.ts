// Per-key token-bucket rate limiter.
//
// Lightweight in-process implementation. One bucket per key (e.g. tool name,
// per-target JID, per-token). No external dependency — keeps Vitest tests
// fast and deterministic.

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number; // tokens per ms
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface ConsumeResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

// Consume one token from `key`'s bucket. Limits expressed as tokens-per-minute.
export function consume(key: string, capacityPerMinute: number): ConsumeResult {
  const now = Date.now();
  const refillPerMs = capacityPerMinute / 60_000;

  let b = buckets.get(key);
  if (!b) {
    b = {
      tokens: capacityPerMinute,
      capacity: capacityPerMinute,
      refillPerMs,
      updatedAt: now,
    };
    buckets.set(key, b);
  } else {
    if (b.capacity !== capacityPerMinute) {
      // Capacity changed (e.g. test reset) — re-anchor.
      b.capacity = capacityPerMinute;
      b.refillPerMs = refillPerMs;
      b.tokens = Math.min(b.tokens, capacityPerMinute);
    }
    const elapsed = now - b.updatedAt;
    if (elapsed > 0) {
      b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
      b.updatedAt = now;
    }
  }

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
  }

  // Time until enough tokens: (1 - tokens) / refillPerMs ms.
  const retryAfterMs = Math.ceil((1 - b.tokens) / b.refillPerMs);
  return { allowed: false, retryAfterMs, remaining: 0 };
}

// Test helper: forget every bucket. Production code should never call this.
export function _resetAllBucketsForTests(): void {
  buckets.clear();
}

// Express middleware factory. Each call evaluates `getKey(req)` and
// `getCapacityPerMinute(req)` so callers can build keys from `:jid` route
// params, request body, etc.
import type { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  keyFn: (req: Request) => string | string[]; // multiple keys = each must allow
  capacityPerMinute: number | ((req: Request) => number);
}

export function rateLimitMw(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const keys = opts.keyFn(req);
    const arr = Array.isArray(keys) ? keys : [keys];
    const capacity =
      typeof opts.capacityPerMinute === 'function'
        ? opts.capacityPerMinute(req)
        : opts.capacityPerMinute;
    let worst: ConsumeResult = { allowed: true, retryAfterMs: 0, remaining: capacity };
    for (const k of arr) {
      const r = consume(k, capacity);
      if (!r.allowed && r.retryAfterMs > worst.retryAfterMs) worst = r;
      if (!r.allowed && worst.allowed) worst = r;
    }
    if (!worst.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(worst.retryAfterMs / 1000)));
      return res.status(429).json({
        error: `Rate limit exceeded. Retry after ${Math.ceil(worst.retryAfterMs / 1000)}s.`,
      });
    }
    next();
  };
}
