// Token-bucket rate limiter.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetAllBucketsForTests, consume } from '../src/ratelimit';

beforeEach(() => _resetAllBucketsForTests());
afterEach(() => _resetAllBucketsForTests());

describe('consume', () => {
  it('grants tokens up to capacity', () => {
    const cap = 5;
    for (let i = 0; i < 5; i++) {
      const r = consume('k', cap);
      expect(r.allowed).toBe(true);
    }
    const sixth = consume('k', cap);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', async () => {
    consume('k', 60); // capacity 60/min => 1/sec
    // Drain to 0
    for (let i = 0; i < 60; i++) consume('k', 60);
    // Wait ~1.5s for ~1 token to refill
    await new Promise((r) => setTimeout(r, 1500));
    const r = consume('k', 60);
    expect(r.allowed).toBe(true);
  });

  it('separate keys do not share buckets', () => {
    for (let i = 0; i < 5; i++) consume('a', 5);
    expect(consume('a', 5).allowed).toBe(false);
    expect(consume('b', 5).allowed).toBe(true);
  });
});
