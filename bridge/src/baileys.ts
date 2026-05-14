import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WAMessage,
  Chat,
  Contact,
  ChatUpdate,
  GroupMetadata,
  WAMessageKey,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidBroadcast,
  proto,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';

import { extractMeta, type ExtractResult } from './extract';
import { canonicalJid, initLidStore } from './lidStore';
import { getDb } from './db';
import {
  chatBufferLength,
  deleteChat,
  insertMessage,
  markMessageDeleted,
  recordPushName,
  resetAll,
  setGroupSubject,
  upsertChat,
  upsertContact,
  updateMessageBody,
} from './store';

type Sock = ReturnType<typeof makeWASocket>;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
const AUTH_DIR = path.resolve(process.cwd(), 'auth_info');
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'local';

let sock: Sock | null = null;
let latestQr: string | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let connectionEstablishedAt = 0;
let lastMessageAt = 0;

export function getSock(): Sock | null {
  return sock;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getLatestQr(): string | null {
  return latestQr;
}

export function getConnectionUptimeSec(): number {
  if (connectionStatus !== 'connected' || connectionEstablishedAt === 0) return 0;
  return Math.floor((Date.now() - connectionEstablishedAt) / 1000);
}

export function getLastMessageAt(): number {
  return lastMessageAt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function isChatListJid(jid: string | undefined | null): jid is string {
  if (!jid) return false;
  if (isJidStatusBroadcast(jid)) return false;
  if (isJidNewsletter(jid)) return false;
  return true;
}

function isStorableJid(jid: string | undefined | null): jid is string {
  if (!jid) return false;
  if (isJidBroadcast(jid)) return false;
  if (isJidNewsletter(jid)) return false;
  return true;
}

function tsToNumber(t: unknown): number {
  if (t == null) return 0;
  if (typeof t === 'number') return t;
  const maybeLong = t as { toNumber?: () => number };
  if (typeof maybeLong.toNumber === 'function') return maybeLong.toNumber();
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Permission check (POSIX)
// ---------------------------------------------------------------------------
function warnIfAuthDirInsecure(): void {
  if (process.platform === 'win32') return;
  try {
    const s = fs.statSync(AUTH_DIR);
    if ((s.mode & 0o077) !== 0) {
      console.warn(
        `WARNING: ${AUTH_DIR} is group/world-readable. Run \`chmod 700 ${AUTH_DIR}\` to lock it down.`,
      );
    }
  } catch {
    // Not present yet — Baileys will create it on first run.
  }
}

// ---------------------------------------------------------------------------
// Ingestion — single funnel for both live messages and history-sync batches
// ---------------------------------------------------------------------------
function ingestChat(c: Chat | ChatUpdate): void {
  const rawJid = c.id;
  if (!isChatListJid(rawJid)) return;
  const jid = canonicalJid(rawJid);
  const ts = tsToNumber(
    (c as Chat).conversationTimestamp ?? (c as Chat).lastMsgTimestamp,
  );
  upsertChat({
    jid,
    name: c.name ?? '',
    isGroup: jid.endsWith('@g.us'),
    lastTimestamp: ts,
    lastMessage: '',
  });
}

function ingestContact(c: Contact | Partial<Contact>): void {
  const rawJid = c.id;
  if (!rawJid) return;
  const jid = canonicalJid(rawJid);
  upsertContact({
    jid,
    name: c.verifiedName || c.name || c.notify || '',
    pushName: '',
  });
}

// Persist a media_refs row referencing the original Baileys IMessage proto.
// We store the proto as a serialized blob so a later GET /media call can
// re-hydrate it and pass to downloadMediaMessage().
function persistMediaRef(
  chatJid: string,
  messageId: string,
  meta: ExtractResult,
): void {
  if (!meta.media || !meta.mediaSource) return;
  try {
    const blob = proto.Message.encode(meta.mediaSource as proto.IMessage).finish();
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO media_refs
       (message_id, chat_jid, kind, mime_type, file_name, file_size, caption, baileys_proto_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      chatJid,
      meta.media.kind,
      meta.media.mimeType ?? null,
      meta.media.fileName ?? null,
      meta.media.fileSize ?? null,
      meta.media.caption ?? null,
      Buffer.from(blob),
    );
  } catch (err) {
    console.error('persistMediaRef:', err instanceof Error ? err.message : String(err));
  }
}

function persistExtra(
  chatJid: string,
  messageId: string,
  meta: ExtractResult,
): void {
  if (meta.location) {
    persistExtraRow(chatJid, messageId, 'location', meta.location);
  } else if (meta.contact) {
    persistExtraRow(chatJid, messageId, 'contact', meta.contact);
  } else if (meta.poll) {
    persistExtraRow(chatJid, messageId, 'poll', meta.poll);
  }
}

function persistExtraRow(chatJid: string, messageId: string, kind: string, payload: unknown): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO message_extras (message_id, chat_jid, kind, payload)
       VALUES (?, ?, ?, ?)`,
    ).run(messageId, chatJid, kind, JSON.stringify(payload));
  } catch (err) {
    console.error('persistExtra:', err instanceof Error ? err.message : String(err));
  }
}

function ingestMessage(msg: WAMessage): void {
  const rawRemote = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!id || !rawRemote) return;
  if (!isStorableJid(rawRemote)) return;

  const meta = extractMeta(msg);
  if (!meta) return; // system/protocol — skip silently.

  const remoteJid = canonicalJid(rawRemote);
  const isFromMe = !!msg.key.fromMe;
  const isGroup = remoteJid.endsWith('@g.us');
  const ownJid = sock?.user?.id;
  const rawSender = isFromMe
    ? ownJid || 'me'
    : isGroup
      ? msg.key.participant || rawRemote
      : rawRemote;
  const sender = canonicalJid(rawSender);
  const timestamp = tsToNumber(msg.messageTimestamp);

  // Edits: do not insert a fresh message row — rewrite the original.
  if (meta.kind === 'edit' && meta.edit?.targetMessageId) {
    updateMessageBody(remoteJid, meta.edit.targetMessageId, meta.edit.newText, timestamp);
    if (timestamp > lastMessageAt) lastMessageAt = timestamp;
    return;
  }
  if (meta.kind === 'delete' && meta.edit?.targetMessageId) {
    markMessageDeleted(remoteJid, meta.edit.targetMessageId, timestamp);
    if (timestamp > lastMessageAt) lastMessageAt = timestamp;
    return;
  }
  // Reactions are not stored as messages (no body) — drop silently.
  if (meta.kind === 'reaction') return;

  // Reply linkage from extendedTextMessage.contextInfo.stanzaId.
  let replyToId: string | null = null;
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.stanzaId) replyToId = ctx.stanzaId;

  const inserted = insertMessage({
    id,
    chatJid: remoteJid,
    sender,
    fromName: msg.pushName || '',
    body: meta.text,
    timestamp,
    isGroup,
    isFromMe,
    replyToId,
    messageKind: meta.kind,
  });

  if (inserted) {
    if (meta.media) persistMediaRef(remoteJid, id, meta);
    if (meta.location || meta.contact || meta.poll) persistExtra(remoteJid, id, meta);
  }

  if (timestamp > lastMessageAt) lastMessageAt = timestamp;
  if (!isFromMe && msg.pushName) recordPushName(sender, msg.pushName);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export async function startWhatsApp(): Promise<void> {
  warnIfAuthDirInsecure();
  initLidStore(AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      if (DEPLOYMENT_MODE === 'local') {
        qrcodeTerminal.generate(qr, { small: true });
        console.log('Scan the QR code above with WhatsApp → Linked Devices.');
      } else {
        console.log('QR generated — fetch it via GET /qr (Bearer-authed).');
      }
    }

    if (connection === 'connecting') {
      connectionStatus = 'connecting';
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      connectionEstablishedAt = Date.now();
      latestQr = null;
      console.log('WhatsApp connection established.');
    } else if (connection === 'close') {
      connectionStatus = 'disconnected';
      connectionEstablishedAt = 0;
      const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      const reason = err?.output?.statusCode;
      const loggedOut = reason === DisconnectReason.loggedOut;
      console.log(`WhatsApp disconnected (reason=${reason}). loggedOut=${loggedOut}`);
      if (!loggedOut) {
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('Reconnect failed:', err instanceof Error ? err.message : String(err));
          });
        }, 2_000);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    for (const c of chats) ingestChat(c);
    for (const c of contacts) ingestContact(c);
    for (const m of messages) ingestMessage(m);
    console.log(
      `History sync applied: chats=${chats.length}, contacts=${contacts.length}, messages=${messages.length}`,
    );
  });

  sock.ev.on('chats.upsert', (bChats) => {
    for (const c of bChats) ingestChat(c);
  });
  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) ingestChat(u);
  });
  sock.ev.on('chats.delete', (jids) => {
    for (const jid of jids) deleteChat(jid);
  });
  sock.ev.on('contacts.upsert', (bContacts) => {
    for (const c of bContacts) ingestContact(c);
  });
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) ingestContact(u);
  });
  sock.ev.on('groups.upsert', (groupMetas: GroupMetadata[]) => {
    for (const g of groupMetas) setGroupSubject(g.id, g.subject);
  });
  sock.ev.on('groups.update', (updates: Partial<GroupMetadata>[]) => {
    for (const u of updates) {
      if (u.id && u.subject) setGroupSubject(u.id, u.subject);
    }
  });
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) ingestMessage(m);
  });
}

// ---------------------------------------------------------------------------
// Older-history fetch
// ---------------------------------------------------------------------------
export interface FetchOlderResult {
  requested: number;
  added: number;
  total: number;
}

export async function fetchOlderForChat(
  chatJid: string,
  count: number,
  oldestMsgKey: WAMessageKey,
  oldestMsgTimestamp: number,
  timeoutMs = 5000,
): Promise<FetchOlderResult> {
  const s = sock;
  if (!s) {
    return { requested: count, added: 0, total: chatBufferLength(chatJid) };
  }

  const before = chatBufferLength(chatJid);
  await s.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = chatBufferLength(chatJid);
    if (now > before) {
      await sleep(250);
      const after = chatBufferLength(chatJid);
      return { requested: count, added: after - before, total: after };
    }
    await sleep(250);
  }
  return { requested: count, added: 0, total: chatBufferLength(chatJid) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Group metadata refresh
// ---------------------------------------------------------------------------
// Baileys only emits `groups.upsert` / `groups.update` for groups that change
// during the session. Existing groups need an explicit fetch — call this on
// connect and from POST /groups/refresh.
export async function refreshGroupSubjects(
  s: Sock,
): Promise<{ refreshed: number }> {
  try {
    const all = await s.groupFetchAllParticipating();
    let n = 0;
    for (const meta of Object.values(all)) {
      const id = (meta as { id?: string }).id;
      const subject = (meta as { subject?: string }).subject;
      if (!id || !subject) continue;
      setGroupSubject(id, subject);
      n += 1;
    }
    return { refreshed: n };
  } catch (err) {
    console.error(
      'refreshGroupSubjects:',
      err instanceof Error ? err.message : String(err),
    );
    return { refreshed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
export async function logoutAndReset(): Promise<void> {
  if (sock) {
    try {
      await sock.logout();
    } catch {
      // Best-effort.
    }
  }
  sock = null;
  connectionStatus = 'disconnected';
  connectionEstablishedAt = 0;
  latestQr = null;
  resetAll();
  try {
    for (const name of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true });
    }
  } catch {
    // not present yet — nothing to wipe.
  }
}
