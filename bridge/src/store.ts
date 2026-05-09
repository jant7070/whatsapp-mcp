// SQLite-backed store. Public API is preserved 1:1 with the previous
// in-memory implementation — see types and exported function names below.
//
// All writes are synchronous (better-sqlite3 is synchronous by design).
// Hot paths (insertMessage, upsertChat, upsertContact, listChats, getMessages)
// use prepared statements cached at module load.

import { getDb } from './db';

export interface CachedMessage {
  id: string;
  chatJid: string;
  sender: string;
  fromName: string;
  body: string;
  timestamp: number;
  isGroup: boolean;
  isFromMe: boolean;
  // New fields (optional for back-compat). Surfaced in /messages and to MCP.
  replyToId?: string | null;
  editedAt?: number | null;
  deletedAt?: number | null;
  messageKind?: string;
}

export interface ChatRecord {
  jid: string;
  name: string;
  isGroup: boolean;
  lastTimestamp: number;
  lastMessage: string;
}

export interface ContactRecord {
  jid: string;
  name: string;
  pushName: string;
}

export interface OldestKey {
  id: string;
  fromMe: boolean;
  timestamp: number;
}

// Caps preserved for callers that read them. SQLite holds everything; the
// MAX_PER_CHAT cap is no longer enforced as a ring-buffer size — it's now
// only the "default per-chat trim threshold" used by maintenance jobs.
export const MAX_CHATS = 1000;
export const MAX_CONTACTS = 5000;
export const MAX_PER_CHAT = 200;

// ---------------------------------------------------------------------------
// Lazy prepared-statement cache. Statements are bound to a specific Db
// instance, so we re-prepare if the underlying db handle changes (e.g. tests
// reset between runs).
//
// `LooseStmt` lets us call run/get/all with variadic positional args OR a
// single named-binding object — the actual binding semantics are enforced by
// SQLite at execute time.
// ---------------------------------------------------------------------------
interface LooseStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

type Stmts = {
  getChat: LooseStmt;
  upsertChat: LooseStmt;
  setGroupSubject: LooseStmt;
  deleteChat: LooseStmt;
  listChats: LooseStmt;
  countChats: LooseStmt;
  getContact: LooseStmt;
  upsertContact: LooseStmt;
  recordPushName: LooseStmt;
  allContacts: LooseStmt;
  countContacts: LooseStmt;
  insertMessage: LooseStmt;
  hasMessage: LooseStmt;
  getMessage: LooseStmt;
  getMessagesAll: LooseStmt;
  getMessagesBefore: LooseStmt;
  chatBufferLength: LooseStmt;
  getOldestMessageKey: LooseStmt;
  countMessages: LooseStmt;
  updateEditedBody: LooseStmt;
  markDeleted: LooseStmt;
};

let stmts: Stmts | null = null;
let stmtsForDbId: object | null = null;

function s(): Stmts {
  const db = getDb();
  if (stmts && stmtsForDbId === db) return stmts;
  // The Database.prepare() return type defaults to a single-argument bind
  // signature; cast through `unknown` to LooseStmt so call sites can use
  // either positional vararg or named-binding object styles.
  const prep = (sql: string): LooseStmt => db.prepare(sql) as unknown as LooseStmt;
  stmts = {
    getChat: prep('SELECT * FROM chats WHERE jid = ?'),
    upsertChat: prep(`
      INSERT INTO chats (jid, name, is_group, last_timestamp, last_message)
      VALUES (@jid, @name, @is_group, @last_timestamp, @last_message)
      ON CONFLICT(jid) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
        is_group = excluded.is_group,
        last_timestamp = MAX(chats.last_timestamp, excluded.last_timestamp),
        last_message = CASE
          WHEN excluded.last_timestamp >= chats.last_timestamp AND excluded.last_message != ''
            THEN excluded.last_message
          ELSE chats.last_message
        END
    `),
    setGroupSubject: prep(`
      INSERT INTO chats (jid, name, is_group, last_timestamp, last_message)
      VALUES (@jid, @name, 1, @last_timestamp, '')
      ON CONFLICT(jid) DO UPDATE SET name = excluded.name, is_group = 1
    `),
    deleteChat: prep(`
      DELETE FROM chats WHERE jid = ?;
    `),
    listChats: prep(`
      SELECT jid, name, is_group, last_timestamp, last_message
      FROM chats ORDER BY last_timestamp DESC LIMIT ?
    `),
    countChats: prep('SELECT COUNT(*) AS n FROM chats'),
    getContact: prep('SELECT * FROM contacts WHERE jid = ?'),
    upsertContact: prep(`
      INSERT INTO contacts (jid, name, push_name, updated_at)
      VALUES (@jid, @name, @push_name, @updated_at)
      ON CONFLICT(jid) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
        push_name = CASE WHEN excluded.push_name != '' THEN excluded.push_name ELSE contacts.push_name END,
        updated_at = excluded.updated_at
    `),
    recordPushName: prep(`
      INSERT INTO contacts (jid, name, push_name, updated_at)
      VALUES (@jid, '', @push_name, @updated_at)
      ON CONFLICT(jid) DO UPDATE SET
        push_name = excluded.push_name,
        updated_at = excluded.updated_at
      WHERE excluded.push_name != ''
        AND excluded.push_name != contacts.push_name
    `),
    allContacts: prep('SELECT jid, name, push_name FROM contacts'),
    countContacts: prep('SELECT COUNT(*) AS n FROM contacts'),
    insertMessage: prep(`
      INSERT INTO messages (
        id, chat_jid, sender, from_name, body, timestamp,
        is_group, is_from_me, reply_to_id, edited_at, deleted_at, message_kind
      ) VALUES (
        @id, @chat_jid, @sender, @from_name, @body, @timestamp,
        @is_group, @is_from_me, @reply_to_id, @edited_at, @deleted_at, @message_kind
      )
      ON CONFLICT(chat_jid, id) DO NOTHING
    `),
    hasMessage: prep(
      'SELECT 1 FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1',
    ),
    getMessage: prep(
      'SELECT * FROM messages WHERE chat_jid = ? AND id = ?',
    ),
    getMessagesAll: prep(`
      SELECT id, chat_jid, sender, from_name, body, timestamp,
             is_group, is_from_me, reply_to_id, edited_at, deleted_at, message_kind
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `),
    getMessagesBefore: prep(`
      SELECT id, chat_jid, sender, from_name, body, timestamp,
             is_group, is_from_me, reply_to_id, edited_at, deleted_at, message_kind
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `),
    chatBufferLength: prep(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?',
    ),
    getOldestMessageKey: prep(`
      SELECT id, is_from_me, timestamp
      FROM messages WHERE chat_jid = ?
      ORDER BY timestamp ASC LIMIT 1
    `),
    countMessages: prep('SELECT COUNT(*) AS n FROM messages'),
    updateEditedBody: prep(`
      UPDATE messages SET body = ?, edited_at = ?
      WHERE chat_jid = ? AND id = ?
    `),
    markDeleted: prep(`
      UPDATE messages SET deleted_at = ?, body = '[message deleted]'
      WHERE chat_jid = ? AND id = ?
    `),
  };
  stmtsForDbId = db;
  return stmts;
}

// ---------------------------------------------------------------------------
// Row → typed record mappers
// ---------------------------------------------------------------------------
type ChatRow = {
  jid: string;
  name: string | null;
  is_group: number;
  last_timestamp: number;
  last_message: string | null;
};
function rowToChat(r: ChatRow): ChatRecord {
  return {
    jid: r.jid,
    name: r.name ?? '',
    isGroup: !!r.is_group,
    lastTimestamp: r.last_timestamp,
    lastMessage: r.last_message ?? '',
  };
}

type ContactRow = {
  jid: string;
  name: string | null;
  push_name: string | null;
};
function rowToContact(r: ContactRow): ContactRecord {
  return {
    jid: r.jid,
    name: r.name ?? '',
    pushName: r.push_name ?? '',
  };
}

type MessageRow = {
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
};
function rowToMessage(r: MessageRow): CachedMessage {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------
export function getChat(jid: string): ChatRecord | undefined {
  const row = s().getChat.get(jid) as ChatRow | undefined;
  return row ? rowToChat(row) : undefined;
}

export function upsertChat(rec: ChatRecord): void {
  s().upsertChat.run({
    jid: rec.jid,
    name: rec.name ?? '',
    is_group: rec.isGroup ? 1 : 0,
    last_timestamp: rec.lastTimestamp ?? 0,
    last_message: rec.lastMessage ?? '',
  });
}

export function setGroupSubject(jid: string, subject: string): void {
  const existing = getChat(jid);
  s().setGroupSubject.run({
    jid,
    name: subject,
    last_timestamp: existing?.lastTimestamp ?? 0,
  });
}

export function deleteChat(jid: string): void {
  const db = getDb();
  // FK-less schema; manually clear messages + media for this chat.
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM media_refs WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM message_extras WHERE chat_jid = ?').run(jid);
    s().deleteChat.run(jid);
  })();
}

export function listChats(limit: number): ChatRecord[] {
  return (s().listChats.all(limit) as ChatRow[]).map(rowToChat);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export function getContact(jid: string): ContactRecord | undefined {
  const row = s().getContact.get(jid) as ContactRow | undefined;
  return row ? rowToContact(row) : undefined;
}

export function upsertContact(rec: ContactRecord): void {
  s().upsertContact.run({
    jid: rec.jid,
    name: rec.name ?? '',
    push_name: rec.pushName ?? '',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export function recordPushName(jid: string, pushName: string): void {
  if (!jid || !pushName) return;
  s().recordPushName.run({
    jid,
    push_name: pushName,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export function allContacts(): IterableIterator<ContactRecord> {
  const rows = s().allContacts.all() as ContactRow[];
  return rows.map(rowToContact)[Symbol.iterator]();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
// Insert a message. Returns true if inserted, false if it was a duplicate.
export function insertMessage(msg: CachedMessage): boolean {
  const has = s().hasMessage.get(msg.chatJid, msg.id);
  if (has) return false;

  const row = s().insertMessage.run({
    id: msg.id,
    chat_jid: msg.chatJid,
    sender: msg.sender,
    from_name: msg.fromName,
    body: msg.body,
    timestamp: msg.timestamp,
    is_group: msg.isGroup ? 1 : 0,
    is_from_me: msg.isFromMe ? 1 : 0,
    reply_to_id: msg.replyToId ?? null,
    edited_at: msg.editedAt ?? null,
    deleted_at: msg.deletedAt ?? null,
    message_kind: msg.messageKind ?? 'text',
  });
  if (row.changes === 0) return false;

  // Mirror the chat record for recency / preview.
  const existing = getChat(msg.chatJid);
  const newTs = Math.max(existing?.lastTimestamp ?? 0, msg.timestamp);
  upsertChat({
    jid: msg.chatJid,
    name: existing?.name ?? '',
    isGroup: msg.isGroup,
    lastTimestamp: newTs,
    lastMessage: newTs === msg.timestamp ? msg.body : existing?.lastMessage ?? '',
  });

  return true;
}

export function getMessage(chatJid: string, id: string): CachedMessage | undefined {
  const row = s().getMessage.get(chatJid, id) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function getMessages(
  chatJid: string,
  limit: number,
  beforeTimestamp?: number,
): CachedMessage[] {
  if (beforeTimestamp != null) {
    const rows = s().getMessagesBefore.all(chatJid, beforeTimestamp, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }
  const rows = s().getMessagesAll.all(chatJid, limit) as MessageRow[];
  return rows.map(rowToMessage);
}

export function chatBufferLength(chatJid: string): number {
  const row = s().chatBufferLength.get(chatJid) as { n: number };
  return row?.n ?? 0;
}

export function getOldestMessageKeyForChat(chatJid: string): OldestKey | null {
  const row = s().getOldestMessageKey.get(chatJid) as
    | { id: string; is_from_me: number; timestamp: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, fromMe: !!row.is_from_me, timestamp: row.timestamp };
}

// Reflect an edit: update body + edited_at. Idempotent.
export function updateMessageBody(
  chatJid: string,
  id: string,
  newBody: string,
  editedAt: number,
): void {
  s().updateEditedBody.run(newBody, editedAt, chatJid, id);
}

// Reflect a delete: set deleted_at + body marker. Idempotent.
export function markMessageDeleted(chatJid: string, id: string, deletedAt: number): void {
  s().markDeleted.run(deletedAt, chatJid, id);
}

// ---------------------------------------------------------------------------
// Stats / debug
// ---------------------------------------------------------------------------
export function counts(): { chats: number; contacts: number; messages: number } {
  return {
    chats: (s().countChats.get() as { n: number }).n,
    contacts: (s().countContacts.get() as { n: number }).n,
    messages: (s().countMessages.get() as { n: number }).n,
  };
}

export function resetAll(): void {
  // Rebuild the prepared statements after a truncate so they bind to the
  // fresh schema state if anything was re-created.
  const db = getDb();
  db.exec(`
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
