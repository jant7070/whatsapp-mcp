// FTS5 query helper for the messages table.
//
// User queries are NOT trusted as raw FTS5 syntax — that would let `"` or
// `OR` characters inject query operators. We escape every token by quoting
// it (FTS5 phrase syntax) and join with implicit AND.

import { getDb } from './db';
import type { CachedMessage } from './store';

export interface SearchHit extends CachedMessage {
  // FTS5 bm25() rank, lower = better.
  rank: number;
}

export interface SearchOptions {
  query: string;
  jid?: string;
  kind?: string; // text | image | document | video | audio | voice | sticker | location | contact | poll
  since?: number; // Unix seconds inclusive
  until?: number; // Unix seconds inclusive
  limit?: number;
}

const TOKEN_REGEX = /[^\s"]+/g;

// Build an FTS5 MATCH expression from a free-form query. Each token becomes
// a quoted phrase. An empty result means caller should error before query.
function buildMatchExpr(query: string): string | null {
  const tokens: string[] = [];
  for (const m of query.matchAll(TOKEN_REGEX)) {
    const tok = m[0]
      // FTS5 doesn't allow embedded "; double them up to escape (per FTS5 spec).
      .replace(/"/g, '""');
    if (tok.length > 0) tokens.push(`"${tok}"`);
  }
  if (tokens.length === 0) return null;
  return tokens.join(' ');
}

export function searchMessages(opts: SearchOptions): SearchHit[] {
  const db = getDb();
  const matchExpr = buildMatchExpr(opts.query);
  if (!matchExpr) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const where: string[] = ['messages_fts MATCH ?'];
  const params: unknown[] = [matchExpr];

  if (opts.jid) {
    where.push('m.chat_jid = ?');
    params.push(opts.jid);
  }
  if (opts.kind) {
    where.push('m.message_kind = ?');
    params.push(opts.kind);
  }
  if (opts.since != null) {
    where.push('m.timestamp >= ?');
    params.push(opts.since);
  }
  if (opts.until != null) {
    where.push('m.timestamp <= ?');
    params.push(opts.until);
  }

  // bm25() returns lower = more relevant. We expose it as `rank` and order by it.
  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.from_name, m.body, m.timestamp,
           m.is_group, m.is_from_me, m.reply_to_id, m.edited_at, m.deleted_at,
           m.message_kind, bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE ${where.join(' AND ')}
    ORDER BY rank ASC, m.timestamp DESC
    LIMIT ?
  `;
  params.push(limit);

  type Row = {
    id: string;
    chat_jid: string;
    sender: string | null;
    from_name: string | null;
    body: string | null;
    timestamp: number;
    is_group: number;
    is_from_me: number;
    reply_to_id: string | null;
    edited_at: number | null;
    deleted_at: number | null;
    message_kind: string;
    rank: number;
  };

  const rows = db.prepare(sql).all(...params) as Row[];
  return rows.map((r) => ({
    id: r.id,
    chatJid: r.chat_jid,
    sender: r.sender ?? '',
    fromName: r.from_name ?? '',
    body: r.body ?? '',
    timestamp: r.timestamp,
    isGroup: !!r.is_group,
    isFromMe: !!r.is_from_me,
    replyToId: r.reply_to_id,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    messageKind: r.message_kind,
    rank: r.rank,
  }));
}

// Re-exported for tests.
export { buildMatchExpr };
