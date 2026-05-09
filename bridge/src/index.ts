import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WAMessage,
  Chat,
  Contact,
  ChatUpdate,
  GroupMetadata,
  isJidStatusBroadcast,
  isJidNewsletter,
} from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'local';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3001', 10);
// Bind to all interfaces inside the container; Docker's `127.0.0.1:NNNN:NNNN`
// port mapping is what restricts host-side access to localhost in local mode.
const BIND_HOST = '0.0.0.0';

if (!BRIDGE_API_KEY) {
  console.error('FATAL: BRIDGE_API_KEY is not set. Generate one with `openssl rand -hex 32` and put it in .env.');
  process.exit(1);
}

if (DEPLOYMENT_MODE === 'cloud' && BRIDGE_API_KEY.length < 32) {
  console.error('FATAL: BRIDGE_API_KEY must be at least 32 characters in cloud mode. Generate one with `openssl rand -hex 32`.');
  process.exit(1);
}

const AUTH_DIR = path.resolve(process.cwd(), 'auth_info');

// Permission check (POSIX only — Windows mode bits are not meaningful here).
if (process.platform !== 'win32') {
  try {
    const s = fs.statSync(AUTH_DIR);
    if ((s.mode & 0o077) !== 0) {
      console.warn(`WARNING: ${AUTH_DIR} is group/world-readable. Run \`chmod 700 ${AUTH_DIR}\` to lock it down.`);
    }
  } catch {
    // Directory may not exist yet — Baileys will create it on first run.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_CACHED_MESSAGES = 500;
const MAX_MESSAGE_LENGTH = 4096;
const JID_REGEX = /^[0-9]{7,15}(@s\.whatsapp\.net|@g\.us)?$/;

function sanitizeMessage(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, MAX_MESSAGE_LENGTH);
}

function validateJid(jid: string): boolean {
  return JID_REGEX.test(jid);
}

function normalizeJid(jid: string): string {
  return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
}

interface CachedMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  body: string;
  timestamp: number;
  isGroup: boolean;
  isFromMe: boolean;
}

// LRU-ish: Map preserves insertion order; we evict the oldest entry once full.
const messageCache = new Map<string, CachedMessage>();

// Persistent-ish (process lifetime) directories populated from Baileys events.
// `messageCache` is a rolling window for /messages; these maps are the source
// of truth for chat list and name-resolution.
interface ChatRecord {
  jid: string;
  name: string;          // group subject for groups, contact name for 1:1
  isGroup: boolean;
  lastTimestamp: number; // unix seconds
  lastMessage: string;   // sanitized & truncated preview, may be empty
}

interface ContactRecord {
  jid: string;
  name: string;          // verifiedName || name || notify
  pushName: string;      // most recent pushName seen on a message
}

const chats = new Map<string, ChatRecord>();
const contacts = new Map<string, ContactRecord>();

function cacheMessage(msg: CachedMessage): void {
  if (messageCache.has(msg.id)) {
    messageCache.delete(msg.id);
  }
  messageCache.set(msg.id, msg);
  while (messageCache.size > MAX_CACHED_MESSAGES) {
    const firstKey = messageCache.keys().next().value;
    if (firstKey === undefined) break;
    messageCache.delete(firstKey);
  }
}

function extractBody(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '[non-text message]';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Photo';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video';
  if (m.audioMessage) return m.audioMessage.ptt ? '🎤 Voice message' : '🔊 Audio';
  if (m.stickerMessage) return '💟 Sticker';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName ?? 'Document'}`;
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contact';
  if (m.locationMessage || m.liveLocationMessage) return '📍 Location';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '📊 Poll';
  if (m.reactionMessage) return `Reacted ${m.reactionMessage.text ?? ''}`.trim();
  return '[non-text message]';
}

// Baileys timestamps may be number | Long | null | undefined.
function tsToNumber(t: unknown): number {
  if (t == null) return 0;
  if (typeof t === 'number') return t;
  // Long from the `long` package exposes toNumber().
  const maybeLong = t as { toNumber?: () => number };
  if (typeof maybeLong.toNumber === 'function') return maybeLong.toNumber();
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

function formatPhoneFallback(jid: string): string {
  const local = jid.split('@')[0] || jid;
  // Strip any device suffix like ":12" from a participant JID.
  const digits = local.split(':')[0]!.replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : jid;
}

// Whether a JID belongs in the user's "Chats" tab. Status broadcasts and
// channel newsletters live in WhatsApp's "Updates" tab and would otherwise
// pollute the chat list with non-chat items.
function isChatListJid(jid: string | undefined | null): jid is string {
  if (!jid) return false;
  if (isJidStatusBroadcast(jid)) return false;
  if (isJidNewsletter(jid)) return false;
  return true;
}

function bestContactName(c: ContactRecord | undefined): string {
  if (!c) return '';
  return c.name || c.pushName || '';
}

function resolveChatName(jid: string): string {
  const chat = chats.get(jid);
  if (chat?.isGroup) {
    return chat.name || formatPhoneFallback(jid);
  }
  const fromContacts = bestContactName(contacts.get(jid));
  return chat?.name || fromContacts || formatPhoneFallback(jid);
}

function upsertChatFromBaileys(c: Chat | ChatUpdate): void {
  const jid = c.id;
  if (!isChatListJid(jid)) return;
  const existing = chats.get(jid);
  const isGroup = jid.endsWith('@g.us');
  const ts = tsToNumber(
    (c as Chat).conversationTimestamp ?? (c as Chat).lastMsgTimestamp,
  );
  const next: ChatRecord = {
    jid,
    name: c.name ?? existing?.name ?? '',
    isGroup,
    lastTimestamp: Math.max(existing?.lastTimestamp ?? 0, ts),
    lastMessage: existing?.lastMessage ?? '',
  };
  chats.set(jid, next);
}

function upsertContactFromBaileys(c: Contact | Partial<Contact>): void {
  const jid = c.id;
  if (!jid) return;
  const existing = contacts.get(jid);
  // Prefer a name the user has saved; fall back to the contact's own notify.
  const resolvedName =
    c.verifiedName || c.name || c.notify || existing?.name || '';
  contacts.set(jid, {
    jid,
    name: resolvedName,
    pushName: existing?.pushName ?? '',
  });
}

function recordPushName(jid: string, pushName: string | undefined | null): void {
  if (!jid || !pushName) return;
  const existing = contacts.get(jid);
  if (existing && existing.pushName === pushName) return;
  contacts.set(jid, {
    jid,
    name: existing?.name ?? '',
    pushName,
  });
}

function recordGroupSubject(jid: string, subject: string | undefined): void {
  if (!jid || !subject) return;
  const existing = chats.get(jid);
  chats.set(jid, {
    jid,
    name: subject,
    isGroup: true,
    lastTimestamp: existing?.lastTimestamp ?? 0,
    lastMessage: existing?.lastMessage ?? '',
  });
}

interface ChatSearchHit {
  jid: string;
  name: string;
  isGroup: boolean;
  lastTimestamp: number;
}

function searchChatsByName(query: string, limit = 20): ChatSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Map<string, ChatSearchHit>();
  const consider = (jid: string, name: string) => {
    if (!jid || !name) return;
    if (!isChatListJid(jid)) return;
    if (!name.toLowerCase().includes(q)) return;
    if (seen.has(jid)) return;
    const chat = chats.get(jid);
    seen.set(jid, {
      jid,
      name: resolveChatName(jid),
      isGroup: jid.endsWith('@g.us'),
      lastTimestamp: chat?.lastTimestamp ?? 0,
    });
  };
  for (const c of chats.values()) consider(c.jid, c.name);
  for (const c of contacts.values()) {
    consider(c.jid, c.name);
    consider(c.jid, c.pushName);
  }
  return Array.from(seen.values())
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', DEPLOYMENT_MODE === 'cloud' ? 1 : false);
app.use(express.json({ limit: '256kb' }));

// HTTPS enforcement (cloud only). Caddy sets X-Forwarded-Proto automatically.
if (DEPLOYMENT_MODE === 'cloud') {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.status(426).json({
        error: 'HTTPS is required in cloud mode. Do not expose this service without TLS.',
      });
    }
    next();
  });
}

// Safe request logger.
// Intentionally excluded: message body, JID/phone numbers, QR data, auth tokens.
// Path-only — query strings are skipped because they may contain JIDs or search terms.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        ip: req.ip,
      }),
    );
  });
  next();
});

// Bearer-token auth on every route.
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.use(requireApiKey);

// Rate limiting.
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const sendLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// ---------------------------------------------------------------------------
// WhatsApp connection (Baileys)
// ---------------------------------------------------------------------------
type Sock = ReturnType<typeof makeWASocket>;

let sock: Sock | null = null;
let latestQr: string | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    // Baileys defaults to printing the QR; we handle it explicitly below.
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      if (DEPLOYMENT_MODE === 'local') {
        // Local mode: render the QR in the terminal so the operator can scan directly.
        qrcodeTerminal.generate(qr, { small: true });
        console.log('Scan the QR code above with WhatsApp → Linked Devices.');
      } else {
        // Cloud mode: do not render QR in logs; expose only via GET /qr.
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
        // Auto-reconnect with a small delay.
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('Reconnect failed:', err instanceof Error ? err.message : String(err));
          });
        }, 2_000);
      }
    }
  });

  // Shared message ingestion: feeds the rolling messageCache and updates the
  // chat directory's recency / preview. Used by both the live `messages.upsert`
  // event and the bulk `messages` array delivered with `messaging-history.set`.
  const ingestMessage = (msg: WAMessage): void => {
    if (!msg.key?.id || !msg.key?.remoteJid) return;
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const isFromMe = !!msg.key.fromMe;
    const ownJid = sock?.user?.id;
    const sender = isFromMe
      ? (ownJid || 'me')
      : (isGroup ? (msg.key.participant || remoteJid) : remoteJid);

    const body = extractBody(msg);
    const timestamp = tsToNumber(msg.messageTimestamp);

    cacheMessage({
      id: msg.key.id,
      from: sender,
      fromName: msg.pushName || '',
      to: remoteJid,
      body,
      timestamp,
      isGroup,
      isFromMe,
    });

    // Record the *sender's* pushName against their own JID. Never let an
    // outbound message overwrite the chat's contact name with the user's name.
    if (!isFromMe && msg.pushName) {
      recordPushName(sender, msg.pushName);
    }

    // Update the chat directory's recency / preview, but only for JIDs that
    // belong in the user's chat list (skip status@broadcast, newsletters, etc.).
    if (!isChatListJid(remoteJid)) return;
    const existingChat = chats.get(remoteJid);
    const newTs = Math.max(existingChat?.lastTimestamp ?? 0, timestamp);
    chats.set(remoteJid, {
      jid: remoteJid,
      name: existingChat?.name ?? '',
      isGroup,
      lastTimestamp: newTs,
      // Only overwrite preview if this message is the freshest we've seen.
      lastMessage: newTs === timestamp ? body : (existingChat?.lastMessage ?? ''),
    });
  };

  // ---- Directory events (chat list & contacts) -----------------------------
  // Baileys fires `messaging-history.set` with the initial sync after pairing
  // and again after most reconnects when there's existing sync data on disk.
  sock.ev.on('messaging-history.set', ({ chats: bChats, contacts: bContacts, messages: bMessages }) => {
    for (const c of bChats) upsertChatFromBaileys(c);
    for (const c of bContacts) upsertContactFromBaileys(c);
    for (const m of bMessages) ingestMessage(m);
    console.log(
      `History sync applied: chats=${chats.size}, contacts=${contacts.size}, messages=${messageCache.size}`,
    );
  });

  sock.ev.on('chats.upsert', (bChats) => {
    for (const c of bChats) upsertChatFromBaileys(c);
  });
  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) upsertChatFromBaileys(u);
  });
  sock.ev.on('chats.delete', (jids) => {
    for (const jid of jids) chats.delete(jid);
  });
  sock.ev.on('contacts.upsert', (bContacts) => {
    for (const c of bContacts) upsertContactFromBaileys(c);
  });
  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) upsertContactFromBaileys(u);
  });
  sock.ev.on('groups.upsert', (groupMetas: GroupMetadata[]) => {
    for (const g of groupMetas) recordGroupSubject(g.id, g.subject);
  });
  sock.ev.on('groups.update', (updates: Partial<GroupMetadata>[]) => {
    for (const u of updates) {
      if (u.id) recordGroupSubject(u.id, u.subject);
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) ingestMessage(msg);
  });
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------
app.get('/status', (_req, res) => {
  res.json({
    status: connectionStatus,
    hasQr: latestQr !== null,
    cachedMessages: messageCache.size,
    knownChats: chats.size,
    knownContacts: contacts.size,
    deploymentMode: DEPLOYMENT_MODE,
  });
});

app.get('/qr', (_req, res) => {
  if (!latestQr) {
    return res.status(404).json({ error: 'No QR available — already linked or not yet generated.' });
  }
  res.json({ qr: latestQr });
});

app.get('/conversations', (req, res) => {
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
    200,
  );
  const conversations = Array.from(chats.values())
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, limit)
    .map((c) => ({
      jid: c.jid,
      isGroup: c.isGroup,
      lastMessage: c.lastMessage,
      lastTimestamp: c.lastTimestamp,
      contactName: resolveChatName(c.jid),
    }));
  res.json({ conversations });
});

app.get('/chats/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1),
    50,
  );
  if (!q.trim()) {
    return res.status(400).json({ error: 'Query parameter `q` is required.' });
  }
  const hits = searchChatsByName(q, limit);
  res.json({ query: q, hits });
});

app.get('/messages', (req, res) => {
  const jid = typeof req.query.jid === 'string' ? req.query.jid : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

  let all = Array.from(messageCache.values());
  if (jid) {
    all = all.filter((m) => m.to === jid || m.from === jid);
  }
  if (search) {
    all = all.filter((m) => m.body.toLowerCase().includes(search));
  }
  all.sort((a, b) => b.timestamp - a.timestamp);

  const total = all.length;
  const slice = all.slice(offset, offset + limit).map((m) => ({
    ...m,
    senderName: m.isFromMe ? 'you' : resolveChatName(m.from),
  }));
  res.json({
    messages: slice,
    total,
    limit,
    offset,
    hasMore: offset + slice.length < total,
  });
});

interface ResolvedTarget {
  jid: string;
  // For ambiguous matches we return all candidates so the caller can disambiguate.
  candidates?: ChatSearchHit[];
}

function resolveSendTarget(target: string): ResolvedTarget | { error: 'not_found' | 'ambiguous'; candidates?: ChatSearchHit[] } {
  const trimmed = target.trim();
  // Full JID — accept as-is.
  if (/@(s\.whatsapp\.net|g\.us)$/.test(trimmed) && validateJid(trimmed)) {
    return { jid: trimmed };
  }
  // Bare phone number — normalize.
  if (/^[0-9]{7,15}$/.test(trimmed)) {
    return { jid: normalizeJid(trimmed) };
  }
  // Otherwise: name lookup.
  const hits = searchChatsByName(trimmed, 10);
  if (hits.length === 0) return { error: 'not_found' };
  if (hits.length > 1) return { error: 'ambiguous', candidates: hits };
  return { jid: hits[0]!.jid };
}

app.post('/send', sendLimiter, async (req, res) => {
  const body = req.body || {};
  const target: unknown = body.target ?? body.jid;
  const message: unknown = body.message;

  if (typeof target !== 'string' || target.length === 0 || target.length > 200) {
    return res.status(400).json({
      error: 'Body must include `target` (1-200 chars): a JID, phone number, or contact/chat name.',
    });
  }
  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'Body must include `message` (string).' });
  }

  const clean = sanitizeMessage(message);
  if (clean.length === 0) {
    return res.status(400).json({ error: 'Message body is empty after sanitization.' });
  }
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp is not connected. Check /status and scan the QR if needed.' });
  }

  const resolved = resolveSendTarget(target);
  if ('error' in resolved) {
    if (resolved.error === 'not_found') {
      return res.status(404).json({
        error: `No contact or chat matches "${target}". Try whatsapp_search_contacts to browse, or pass a JID directly.`,
      });
    }
    return res.status(409).json({
      error: `"${target}" is ambiguous — multiple chats match. Pick one and call again with its JID.`,
      candidates: resolved.candidates ?? [],
    });
  }

  try {
    const sent = await sock.sendMessage(resolved.jid, { text: clean });
    return res.json({ ok: true, id: sent?.key?.id ?? null, jid: resolved.jid });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Send failed: ${msg}` });
  }
});

app.post('/logout', async (_req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch {
        // Best-effort: even if the logout request to WhatsApp fails, wipe local state.
      }
    }
    sock = null;
    connectionStatus = 'disconnected';
    latestQr = null;
    messageCache.clear();
    chats.clear();
    contacts.clear();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ ok: true, message: 'Logged out and auth_info/ deleted. Re-scan QR to link again.' });
    // Restart the connection so a fresh QR is produced.
    setTimeout(() => {
      startWhatsApp().catch((err) => {
        console.error('Restart after logout failed:', err instanceof Error ? err.message : String(err));
      });
    }, 1_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Logout failed: ${msg}` });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
app.listen(BRIDGE_PORT, BIND_HOST, () => {
  console.log(`Bridge running on ${BIND_HOST}:${BRIDGE_PORT} [${DEPLOYMENT_MODE} mode]`);
});

startWhatsApp().catch((err) => {
  console.error('Initial WhatsApp start failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
