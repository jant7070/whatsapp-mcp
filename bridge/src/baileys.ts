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
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';

import { extractBody } from './extract';
import {
  chatBufferLength,
  deleteChat,
  insertMessage,
  recordPushName,
  resetAll,
  setGroupSubject,
  upsertChat,
  upsertContact,
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

export function getSock(): Sock | null {
  return sock;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getLatestQr(): string | null {
  return latestQr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Whether a JID belongs in the user's "Chats" tab (excludes status broadcasts
// and channel newsletters that pollute chat lists).
export function isChatListJid(jid: string | undefined | null): jid is string {
  if (!jid) return false;
  if (isJidStatusBroadcast(jid)) return false;
  if (isJidNewsletter(jid)) return false;
  return true;
}

// Whether a JID should be allowed into our message store at all.
// Broadcasts (incl. user-defined broadcast lists) and newsletters are filtered
// here because they're one-way feeds, not conversational chats — including
// them poisons "show me my recent messages" with status updates.
function isStorableJid(jid: string | undefined | null): jid is string {
  if (!jid) return false;
  if (isJidBroadcast(jid)) return false;
  if (isJidNewsletter(jid)) return false;
  return true;
}

// Baileys timestamps may be number | Long | null | undefined.
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
  const jid = c.id;
  if (!isChatListJid(jid)) return;
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
  const jid = c.id;
  if (!jid) return;
  upsertContact({
    jid,
    name: c.verifiedName || c.name || c.notify || '',
    pushName: '',
  });
}

function ingestMessage(msg: WAMessage): void {
  const remoteJid = msg.key?.remoteJid;
  const id = msg.key?.id;
  if (!id || !remoteJid) return;
  if (!isStorableJid(remoteJid)) return;

  const body = extractBody(msg);
  if (body == null) return; // system/protocol — skip silently

  const isFromMe = !!msg.key.fromMe;
  const isGroup = remoteJid.endsWith('@g.us');
  const ownJid = sock?.user?.id;
  const sender = isFromMe
    ? ownJid || 'me'
    : isGroup
      ? msg.key.participant || remoteJid
      : remoteJid;

  insertMessage({
    id,
    chatJid: remoteJid,
    sender,
    fromName: msg.pushName || '',
    body,
    timestamp: tsToNumber(msg.messageTimestamp),
    isGroup,
    isFromMe,
  });

  // Record the *sender's* pushName against their own JID. Never let an
  // outbound message overwrite the chat's contact name with the user's name.
  if (!isFromMe && msg.pushName) recordPushName(sender, msg.pushName);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export async function startWhatsApp(): Promise<void> {
  warnIfAuthDirInsecure();

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
      latestQr = null;
      console.log('WhatsApp connection established.');
    } else if (connection === 'close') {
      connectionStatus = 'disconnected';
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

// Trigger Baileys' on-demand history fetch for a single chat. Returns once
// either (a) the per-chat buffer length grows OR (b) timeoutMs elapses.
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

  // Poll the buffer; resolve early when growth is detected.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = chatBufferLength(chatJid);
    if (now > before) {
      // Give a brief window for any in-flight batch to fully drain.
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
// Logout — best-effort socket logout + wipe auth dir + reset memory
// ---------------------------------------------------------------------------
export async function logoutAndReset(): Promise<void> {
  if (sock) {
    try {
      await sock.logout();
    } catch {
      // Best-effort; even if WhatsApp rejects the logout we still wipe state.
    }
  }
  sock = null;
  connectionStatus = 'disconnected';
  latestQr = null;
  resetAll();
  // Wipe the contents of AUTH_DIR — not the directory itself. Under Docker
  // the dir is bind-mounted from the host and rmdir on the mountpoint fails
  // with EBUSY.
  try {
    for (const name of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true });
    }
  } catch {
    // Directory may not exist yet — nothing to wipe.
  }
}
