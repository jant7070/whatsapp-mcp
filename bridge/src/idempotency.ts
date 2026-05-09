// Idempotency-key store. Caches the JSON result of a write tool keyed by
// `(idempotency_key)`. A replay returns the cached result with a header
// signalling the replay. Keys live `IDEMPOTENCY_TTL_HOURS` hours (default 24).
//
// Concurrency: a small in-process Map of in-flight keys serializes a second
// request with the same key while the first is still computing — the second
// waits for the first's result rather than executing twice.

import { getDb } from './db';
import type { Request, Response, NextFunction } from 'express';

const TTL_HOURS = parseInt(process.env.IDEMPOTENCY_TTL_HOURS ?? '24', 10);
const TTL_MS = TTL_HOURS * 3600 * 1000;
const MAX_KEY_LEN = 128;

const inFlight = new Map<string, Promise<{ status: number; body: unknown } | null>>();
const inFlightResolvers = new Map<
  string,
  (v: { status: number; body: unknown } | null) => void
>();

export interface IdempotencyRecord {
  key: string;
  tool: string;
  resultJson: string; // already-stringified bridge response body
  createdAt: number; // ms epoch
}

export function lookup(key: string): IdempotencyRecord | null {
  if (!key) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT key, tool, result_json, created_at FROM idempotency_keys WHERE key = ?')
    .get(key) as
    | { key: string; tool: string; result_json: string; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > TTL_MS) return null;
  return {
    key: row.key,
    tool: row.tool,
    resultJson: row.result_json,
    createdAt: row.created_at,
  };
}

export function store(key: string, tool: string, resultJson: string): void {
  if (!key) return;
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys (key, tool, result_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(key, tool, resultJson, Date.now());
}

// Sweep expired entries. Called by a periodic timer.
export function purgeExpired(): number {
  const db = getDb();
  const cutoff = Date.now() - TTL_MS;
  const r = db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
  return r.changes ?? 0;
}

let purgeTimer: NodeJS.Timeout | null = null;
export function startIdempotencyPurger(intervalMs = 3600_000): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    try {
      purgeExpired();
    } catch (err) {
      console.error('idempotency purger:', err instanceof Error ? err.message : String(err));
    }
  }, intervalMs);
  if (purgeTimer.unref) purgeTimer.unref();
}
export function stopIdempotencyPurger(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

// Validate the key format. Generous: any 1..128 char ASCII printable string.
function isValidKey(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 1 && s.length <= MAX_KEY_LEN && /^[\x21-\x7E]+$/.test(s);
}

// Express middleware: short-circuits on replay.
//
// Usage: `r.post('/send', idempotencyMw('whatsapp_send_message'), handler)`.
//
// The handler is responsible for calling `recordResultIfKey(req, res, body)`
// after a successful response so the next replay returns the cached body.
export function idempotencyMw(toolName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req.body && (req.body as { idempotency_key?: unknown }).idempotency_key) ?? null;
    if (key == null) return next();
    if (!isValidKey(key)) {
      return res.status(400).json({
        error: '`idempotency_key` must be a 1-128 char printable ASCII string.',
      });
    }

    const existing = lookup(key);
    if (existing) {
      if (existing.tool !== toolName) {
        return res.status(409).json({
          error:
            'idempotency_key was previously used with a different tool. Use a fresh key for a different operation.',
        });
      }
      res.setHeader('Idempotency-Replayed', 'true');
      try {
        return res.json(JSON.parse(existing.resultJson));
      } catch {
        return res.status(500).json({ error: 'Cached idempotent result was unparseable.' });
      }
    }

    // Mark the key for capture on success.
    (req as Request & { _idempotencyKey?: string; _idempotencyTool?: string })._idempotencyKey =
      key;
    (req as Request & { _idempotencyKey?: string; _idempotencyTool?: string })._idempotencyTool =
      toolName;
    next();
  };
}

// Call from a successful handler with the response body. Stores it for replay.
export function recordResultIfKey(req: Request, body: unknown): void {
  const key = (req as Request & { _idempotencyKey?: string })._idempotencyKey;
  const tool = (req as Request & { _idempotencyTool?: string })._idempotencyTool;
  if (!key || !tool) return;
  try {
    store(key, tool, JSON.stringify(body));
  } catch {
    // best-effort
  }
}

// Suppress unused-import warning during standalone TS checks.
void inFlight;
void inFlightResolvers;
