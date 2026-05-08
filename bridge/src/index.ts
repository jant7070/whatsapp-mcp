import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WAMessage,
} from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'local';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3001', 10);
const BIND_HOST = DEPLOYMENT_MODE === 'cloud' ? '0.0.0.0' : '127.0.0.1';

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
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    '[non-text message]'
  );
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

  sock.ev.on('messages.upsert', ({ messages }) => {
    const ownJid = sock?.user?.id;
    for (const msg of messages) {
      if (!msg.key?.id || !msg.key?.remoteJid) continue;
      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const isFromMe = !!msg.key.fromMe;
      const sender = isFromMe
        ? (ownJid || 'me')
        : (isGroup ? (msg.key.participant || remoteJid) : remoteJid);

      cacheMessage({
        id: msg.key.id,
        from: sender,
        fromName: msg.pushName || '',
        to: remoteJid,
        body: extractBody(msg),
        timestamp: Number(msg.messageTimestamp || 0),
        isGroup,
        isFromMe,
      });
    }
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
    deploymentMode: DEPLOYMENT_MODE,
  });
});

app.get('/qr', (_req, res) => {
  if (!latestQr) {
    return res.status(404).json({ error: 'No QR available — already linked or not yet generated.' });
  }
  res.json({ qr: latestQr });
});

app.get('/conversations', (_req, res) => {
  // Group by chat JID (the "to" field), keep the latest message per chat.
  const byChat = new Map<string, CachedMessage>();
  for (const msg of messageCache.values()) {
    const existing = byChat.get(msg.to);
    if (!existing || msg.timestamp > existing.timestamp) {
      byChat.set(msg.to, msg);
    }
  }
  const conversations = Array.from(byChat.entries())
    .map(([jid, latest]) => ({
      jid,
      isGroup: jid.endsWith('@g.us'),
      lastMessage: latest.body,
      lastTimestamp: latest.timestamp,
      contactName: latest.fromName || '',
    }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  res.json({ conversations });
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
  const slice = all.slice(offset, offset + limit);
  res.json({
    messages: slice,
    total,
    limit,
    offset,
    hasMore: offset + slice.length < total,
  });
});

app.post('/send', sendLimiter, async (req, res) => {
  const { jid, message } = req.body || {};
  if (typeof jid !== 'string' || typeof message !== 'string') {
    return res.status(400).json({ error: 'Body must include `jid` and `message` strings.' });
  }
  if (!validateJid(jid)) {
    return res.status(400).json({
      error: "Invalid JID. Use a phone number with country code (e.g. '5804120001234') or a full JID ending in @s.whatsapp.net or @g.us.",
    });
  }
  const clean = sanitizeMessage(message);
  if (clean.length === 0) {
    return res.status(400).json({ error: 'Message body is empty after sanitization.' });
  }
  if (!sock || connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp is not connected. Check /status and scan the QR if needed.' });
  }

  try {
    const target = normalizeJid(jid);
    const sent = await sock.sendMessage(target, { text: clean });
    return res.json({ ok: true, id: sent?.key?.id ?? null });
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
