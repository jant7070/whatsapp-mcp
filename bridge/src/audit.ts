// Write-action audit log. Every successful or failed write goes here, with
// PII (phone numbers, names, message bodies, base64 payloads) redacted.
//
// The redacted-params JSON is what's stored — never the raw body. JIDs
// passed in /audit results are stored separately as `target_jid` so callers
// can filter by recipient without parsing the JSON.

import { getDb } from './db';

export interface AuditWrite {
  tool: string;
  targetJid?: string | null;
  paramsRaw: Record<string, unknown> | null;
  ok: boolean;
  errorCode?: string | null;
  resultSummary?: string | null;
  idempotencyKey?: string | null;
}

const REDACTABLE_KEYS = new Set([
  'message',
  'caption',
  'new_text',
  'newText',
  'name',
  'status',
  'address',
  'vcard',
  'avatar_base64',
  'avatarBase64',
  'source_base64',
  'sourceBase64',
  'data',
  'options',
]);

const PHONE_REGEX = /\b\+?\d{7,15}\b/g;
const JID_LOCAL_REGEX = /\b\d{7,15}(?=@(?:s\.whatsapp\.net|g\.us|lid))/g;

// Redact phone numbers + sensitive fields. Keys themselves are kept; only
// values are masked.
export function redact(params: Record<string, unknown> | null): Record<string, unknown> {
  if (!params) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

function redactValue(key: string, value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (REDACTABLE_KEYS.has(key)) {
      // Replace the entire content with a length marker.
      return `<redacted:${value.length}>`;
    }
    // Mask phone numbers / JID locals embedded in non-redactable strings.
    return value.replace(JID_LOCAL_REGEX, '<phone>').replace(PHONE_REGEX, '<phone>');
  }
  if (Array.isArray(value)) {
    if (REDACTABLE_KEYS.has(key)) return `<redacted:array(${value.length})>`;
    return value.map((v) => redactValue(key, v));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [kk, vv] of Object.entries(obj)) {
      out[kk] = redactValue(kk, vv);
    }
    return out;
  }
  return value;
}

export function recordAudit(entry: AuditWrite): void {
  try {
    const db = getDb();
    const redactedParams = redact(entry.paramsRaw);
    const targetJid = entry.targetJid
      ? entry.targetJid.replace(JID_LOCAL_REGEX, '<phone>')
      : null;
    db.prepare(
      `INSERT INTO audit_log
       (timestamp, tool, target_jid, params_redacted_json, ok, error_code, result_summary, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Math.floor(Date.now() / 1000),
      entry.tool,
      targetJid,
      JSON.stringify(redactedParams),
      entry.ok ? 1 : 0,
      entry.errorCode ?? null,
      entry.resultSummary ?? null,
      entry.idempotencyKey ?? null,
    );
  } catch (err) {
    console.error('audit:', err instanceof Error ? err.message : String(err));
  }
}

export interface AuditQuery {
  tool?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export function listAudit(q: AuditQuery): unknown[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.tool) {
    where.push('tool = ?');
    params.push(q.tool);
  }
  if (q.since != null) {
    where.push('timestamp >= ?');
    params.push(q.since);
  }
  if (q.until != null) {
    where.push('timestamp <= ?');
    params.push(q.until);
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const sql = `
    SELECT id, timestamp, tool, target_jid, params_redacted_json,
           ok, error_code, result_summary, idempotency_key
    FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as {
    id: number;
    timestamp: number;
    tool: string;
    target_jid: string | null;
    params_redacted_json: string;
    ok: number;
    error_code: string | null;
    result_summary: string | null;
    idempotency_key: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    tool: r.tool,
    targetJid: r.target_jid,
    params: safeParse(r.params_redacted_json),
    ok: !!r.ok,
    errorCode: r.error_code,
    resultSummary: r.result_summary,
    idempotencyKey: r.idempotency_key,
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
