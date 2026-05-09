// In-memory state for the bridge.
// No persistence. Restart drops everything; the post-reconnect history sync
// from Baileys plus on-demand fetchMessageHistory rebuild what callers need.

export interface CachedMessage {
  id: string;
  chatJid: string;
  sender: string;
  fromName: string;
  body: string;
  timestamp: number;
  isGroup: boolean;
  isFromMe: boolean;
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

export const MAX_CHATS = 1000;
export const MAX_CONTACTS = 5000;
export const MAX_PER_CHAT = 200;

const chats = new Map<string, ChatRecord>();
const contacts = new Map<string, ContactRecord>();
const messagesByChat = new Map<string, CachedMessage[]>();
const messageIndex = new Map<string, string>(); // messageId -> chatJid

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------
function evictOldestChatIfNeeded(): void {
  if (chats.size <= MAX_CHATS) return;
  let oldestJid: string | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const c of chats.values()) {
    if (c.lastTimestamp < oldestTs) {
      oldestTs = c.lastTimestamp;
      oldestJid = c.jid;
    }
  }
  if (oldestJid) dropChat(oldestJid);
}

function evictOldestContactIfNeeded(): void {
  if (contacts.size <= MAX_CONTACTS) return;
  const firstKey = contacts.keys().next().value;
  if (firstKey !== undefined) contacts.delete(firstKey);
}

function dropChat(jid: string): void {
  chats.delete(jid);
  const buf = messagesByChat.get(jid);
  if (buf) {
    for (const m of buf) messageIndex.delete(m.id);
    messagesByChat.delete(jid);
  }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------
export function getChat(jid: string): ChatRecord | undefined {
  return chats.get(jid);
}

export function upsertChat(rec: ChatRecord): void {
  const existing = chats.get(rec.jid);
  const merged: ChatRecord = existing
    ? {
        jid: rec.jid,
        name: rec.name || existing.name,
        isGroup: rec.isGroup,
        lastTimestamp: Math.max(existing.lastTimestamp, rec.lastTimestamp),
        lastMessage:
          rec.lastTimestamp >= existing.lastTimestamp
            ? rec.lastMessage || existing.lastMessage
            : existing.lastMessage,
      }
    : rec;
  chats.set(rec.jid, merged);
  if (!existing) evictOldestChatIfNeeded();
}

export function setGroupSubject(jid: string, subject: string): void {
  const existing = chats.get(jid);
  chats.set(jid, {
    jid,
    name: subject,
    isGroup: true,
    lastTimestamp: existing?.lastTimestamp ?? 0,
    lastMessage: existing?.lastMessage ?? '',
  });
  if (!existing) evictOldestChatIfNeeded();
}

export function deleteChat(jid: string): void {
  dropChat(jid);
}

export function listChats(limit: number): ChatRecord[] {
  return Array.from(chats.values())
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export function getContact(jid: string): ContactRecord | undefined {
  return contacts.get(jid);
}

export function upsertContact(rec: ContactRecord): void {
  const existing = contacts.get(rec.jid);
  contacts.set(rec.jid, {
    jid: rec.jid,
    name: rec.name || existing?.name || '',
    pushName: rec.pushName || existing?.pushName || '',
  });
  if (!existing) evictOldestContactIfNeeded();
}

export function recordPushName(jid: string, pushName: string): void {
  if (!jid || !pushName) return;
  const existing = contacts.get(jid);
  if (existing && existing.pushName === pushName) return;
  contacts.set(jid, {
    jid,
    name: existing?.name ?? '',
    pushName,
  });
  if (!existing) evictOldestContactIfNeeded();
}

export function allContacts(): IterableIterator<ContactRecord> {
  return contacts.values();
}

// ---------------------------------------------------------------------------
// Messages — per-chat ring buffer
// ---------------------------------------------------------------------------
function chatBuffer(jid: string): CachedMessage[] {
  let buf = messagesByChat.get(jid);
  if (!buf) {
    buf = [];
    messagesByChat.set(jid, buf);
  }
  return buf;
}

// Insert a message. Returns true if inserted, false if it was a duplicate.
export function insertMessage(msg: CachedMessage): boolean {
  if (messageIndex.has(msg.id)) return false;
  const buf = chatBuffer(msg.chatJid);
  buf.push(msg);
  messageIndex.set(msg.id, msg.chatJid);

  if (buf.length > MAX_PER_CHAT) {
    // Sort ascending by timestamp and drop the oldest single entry.
    buf.sort((a, b) => a.timestamp - b.timestamp);
    const dropped = buf.shift();
    if (dropped) messageIndex.delete(dropped.id);
  }

  // Reflect into the chat record's recency / preview if this is the freshest.
  const existing = chats.get(msg.chatJid);
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

export function getMessages(
  chatJid: string,
  limit: number,
  beforeTimestamp?: number,
): CachedMessage[] {
  const buf = messagesByChat.get(chatJid);
  if (!buf) return [];
  const sorted = [...buf].sort((a, b) => b.timestamp - a.timestamp);
  const filtered =
    beforeTimestamp != null
      ? sorted.filter((m) => m.timestamp < beforeTimestamp)
      : sorted;
  return filtered.slice(0, limit);
}

export function chatBufferLength(chatJid: string): number {
  return messagesByChat.get(chatJid)?.length ?? 0;
}

export interface OldestKey {
  id: string;
  fromMe: boolean;
  timestamp: number;
}

export function getOldestMessageKeyForChat(chatJid: string): OldestKey | null {
  const buf = messagesByChat.get(chatJid);
  if (!buf || buf.length === 0) return null;
  let oldest = buf[0]!;
  for (const m of buf) {
    if (m.timestamp < oldest.timestamp) oldest = m;
  }
  return { id: oldest.id, fromMe: oldest.isFromMe, timestamp: oldest.timestamp };
}

// ---------------------------------------------------------------------------
// Stats / debug
// ---------------------------------------------------------------------------
export function counts(): { chats: number; contacts: number; messages: number } {
  let totalMessages = 0;
  for (const buf of messagesByChat.values()) totalMessages += buf.length;
  return { chats: chats.size, contacts: contacts.size, messages: totalMessages };
}

// Clear every in-memory map. Used by the /logout flow.
export function resetAll(): void {
  chats.clear();
  contacts.clear();
  messagesByChat.clear();
  messageIndex.clear();
}
