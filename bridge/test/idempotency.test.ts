// Idempotency cache: lookup, store, replay, expiry.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import { lookup, store, purgeExpired } from '../src/idempotency';

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('idempotency', () => {
  it('store + lookup round-trip', () => {
    store('k1', 'tool_a', JSON.stringify({ ok: true }));
    const r = lookup('k1');
    expect(r?.tool).toBe('tool_a');
    expect(r?.resultJson).toBe('{"ok":true}');
  });

  it('lookup of unknown key returns null', () => {
    expect(lookup('nope')).toBeNull();
  });

  it('purgeExpired drops nothing within ttl', () => {
    store('k1', 'tool_a', '{}');
    expect(purgeExpired()).toBe(0);
  });
});
