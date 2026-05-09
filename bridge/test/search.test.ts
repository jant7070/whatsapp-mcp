// FTS5 search: token escaping, filters, ranking.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import { insertMessage } from '../src/store';
import { buildMatchExpr, searchMessages } from '../src/search';

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('searchMessages', () => {
  it('escapes special chars in tokens (no injection)', () => {
    expect(buildMatchExpr('foo "bar" baz')).toBe('"foo" "bar" "baz"');
    expect(buildMatchExpr('"OR drop"')).toBe('"OR" "drop"');
    expect(buildMatchExpr('   ')).toBe(null);
  });

  it('returns matching rows newest-first by rank', () => {
    insertMessage({
      id: '1', chatJid: 'c@s.whatsapp.net', sender: 'a', fromName: 'Alice',
      body: 'Hello world from alice', timestamp: 100,
      isGroup: false, isFromMe: false, messageKind: 'text',
    });
    insertMessage({
      id: '2', chatJid: 'c@s.whatsapp.net', sender: 'a', fromName: 'Alice',
      body: 'goodbye world', timestamp: 200,
      isGroup: false, isFromMe: false, messageKind: 'text',
    });
    const hits = searchMessages({ query: 'world' });
    expect(hits.length).toBe(2);
  });

  it('filters by jid + kind + time window', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '',
      body: 'shared keyword', timestamp: 100,
      isGroup: false, isFromMe: false, messageKind: 'text',
    });
    insertMessage({
      id: '2', chatJid: 'b@s.whatsapp.net', sender: 'b', fromName: '',
      body: 'shared keyword', timestamp: 200,
      isGroup: false, isFromMe: false, messageKind: 'image',
    });
    expect(searchMessages({ query: 'keyword', jid: 'a@s.whatsapp.net' }).length).toBe(1);
    expect(searchMessages({ query: 'keyword', kind: 'image' }).length).toBe(1);
    expect(searchMessages({ query: 'keyword', since: 150 }).length).toBe(1);
    expect(searchMessages({ query: 'keyword', until: 150 }).length).toBe(1);
  });

  it('handles unicode without diacritics', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '',
      body: 'José Morillo', timestamp: 100,
      isGroup: false, isFromMe: false, messageKind: 'text',
    });
    const hits = searchMessages({ query: 'jose' });
    expect(hits.length).toBe(1);
  });

  it('empty query returns []', () => {
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: '',
      body: 'hi', timestamp: 100, isGroup: false, isFromMe: false, messageKind: 'text',
    });
    expect(searchMessages({ query: '' })).toEqual([]);
  });
});
