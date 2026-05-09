// SQLite persistence layer.
//
// One process owns the DB. WAL mode for concurrent reads. Synchronous
// `better-sqlite3` is used because every call site is already in a worker
// thread inside a single Node process — async would not help and would add
// boilerplate.
//
// Schema migrations are append-only; `user_version` PRAGMA tracks the
// installed version. Initial migration creates everything in one shot.

import Database, { type Database as Db } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Db | null = null;
let activePath: string | null = null;

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL,
  last_timestamp INTEGER NOT NULL,
  last_message TEXT,
  is_archived INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_muted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  push_name TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender TEXT,
  from_name TEXT,
  body TEXT,
  timestamp INTEGER NOT NULL,
  is_group INTEGER NOT NULL,
  is_from_me INTEGER NOT NULL,
  reply_to_id TEXT,
  edited_at INTEGER,
  deleted_at INTEGER,
  message_kind TEXT NOT NULL,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp
  ON messages(chat_jid, timestamp DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, from_name,
  content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Sync triggers. content='messages' makes FTS5 reference the base table by
-- rowid; we still drive the index manually because (chat_jid, id) is the
-- primary key (no implicit rowid alias) and the messages table has no
-- single integer rowid column we control.
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, from_name) VALUES (new.rowid, new.body, new.from_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, from_name) VALUES('delete', old.rowid, old.body, old.from_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, from_name) VALUES('delete', old.rowid, old.body, old.from_name);
  INSERT INTO messages_fts(rowid, body, from_name) VALUES (new.rowid, new.body, new.from_name);
END;

CREATE TABLE IF NOT EXISTS media_refs (
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT,
  file_name TEXT,
  file_size INTEGER,
  caption TEXT,
  baileys_proto_blob BLOB NOT NULL,
  cached_path TEXT,
  cached_at INTEGER,
  PRIMARY KEY (chat_jid, message_id)
);
CREATE INDEX IF NOT EXISTS idx_media_cached_at
  ON media_refs(cached_at) WHERE cached_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_extras (
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (chat_jid, message_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_created_at ON idempotency_keys(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  tool TEXT NOT NULL,
  target_jid TEXT,
  params_redacted_json TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_code TEXT,
  result_summary TEXT,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
`;

export interface InitOptions {
  // Absolute path or ":memory:". When omitted, falls back to STORE_DB_PATH env
  // or "/data/store.db".
  path?: string;
}

export function initDb(opts: InitOptions = {}): Db {
  if (db) return db;
  const dbPath =
    opts.path ?? process.env.STORE_DB_PATH ?? '/data/store.db';
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('temp_store = MEMORY');

  const currentVersion = (handle.pragma('user_version', { simple: true }) as number) || 0;
  if (currentVersion < SCHEMA_VERSION) {
    handle.exec(SCHEMA_SQL);
    handle.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  db = handle;
  activePath = dbPath;
  return handle;
}

export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
    activePath = null;
  }
}

// Test helper: drop all rows but keep the schema.
export function truncateAll(): void {
  const h = getDb();
  h.exec(`
    DELETE FROM messages_fts;
    DELETE FROM messages;
    DELETE FROM media_refs;
    DELETE FROM message_extras;
    DELETE FROM idempotency_keys;
    DELETE FROM audit_log;
    DELETE FROM chats;
    DELETE FROM contacts;
  `);
}

export function dbPath(): string | null {
  return activePath;
}
