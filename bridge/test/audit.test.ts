// Audit redaction + listAudit query filtering.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import { listAudit, recordAudit, redact } from '../src/audit';

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('redact', () => {
  it('redacts message and caption fields entirely', () => {
    const r = redact({ target: '5804120001234', message: 'hello secret', caption: 'oh' });
    expect(r.message).toMatch(/^<redacted:/);
    expect(r.caption).toMatch(/^<redacted:/);
  });

  it('masks phone numbers embedded in non-redactable strings', () => {
    const r = redact({ note: 'call 5804120001234@s.whatsapp.net' });
    expect(r.note as string).toContain('<phone>');
    expect(r.note as string).not.toContain('5804120001234');
  });

  it('handles nested objects', () => {
    const r = redact({ nested: { message: 'secret', other: 'x' } });
    expect((r.nested as Record<string, unknown>).message).toMatch(/^<redacted:/);
    expect((r.nested as Record<string, unknown>).other).toBe('x');
  });
});

describe('audit log', () => {
  it('records and lists entries', () => {
    recordAudit({
      tool: 'whatsapp_send_message',
      targetJid: '5804120001234@s.whatsapp.net',
      paramsRaw: { target: '5804120001234', message: 'hi' },
      ok: true,
      resultSummary: 'sent',
    });
    const items = listAudit({ tool: 'whatsapp_send_message', limit: 10 }) as Array<{
      tool: string;
      targetJid: string | null;
      params: Record<string, unknown>;
    }>;
    expect(items.length).toBe(1);
    expect(items[0]!.tool).toBe('whatsapp_send_message');
    expect(items[0]!.targetJid).toContain('<phone>');
    expect(items[0]!.params.message).toMatch(/^<redacted:/);
  });

  it('filters by tool', () => {
    recordAudit({ tool: 'a', targetJid: null, paramsRaw: {}, ok: true });
    recordAudit({ tool: 'b', targetJid: null, paramsRaw: {}, ok: true });
    expect((listAudit({ tool: 'a' }) as unknown[]).length).toBe(1);
  });
});
