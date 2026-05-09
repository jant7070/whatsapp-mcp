import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';

import {
  fetchOlderForChat,
  getConnectionStatus,
  getLatestQr,
  getSock,
  isChatListJid,
  logoutAndReset,
  startWhatsApp,
} from './baileys';
import {
  formatPhoneFallback,
  resolveChatName,
  searchChatsByName,
  type ChatSearchHit,
} from './names';
import {
  chatBufferLength,
  counts,
  getMessages,
  getOldestMessageKeyForChat,
  listChats,
  type CachedMessage,
} from './store';

// ---------------------------------------------------------------------------
// Local utilities (validation + sanitization)
// ---------------------------------------------------------------------------
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

interface ResolvedTarget {
  jid: string;
}

interface ResolveError {
  error: 'not_found' | 'ambiguous';
  candidates?: ChatSearchHit[];
}

function resolveSendTarget(target: string): ResolvedTarget | ResolveError {
  const trimmed = target.trim();
  if (/@(s\.whatsapp\.net|g\.us)$/.test(trimmed) && validateJid(trimmed)) {
    return { jid: trimmed };
  }
  if (/^[0-9]{7,15}$/.test(trimmed)) {
    return { jid: normalizeJid(trimmed) };
  }
  const hits = searchChatsByName(trimmed, 10, isChatListJid);
  if (hits.length === 0) return { error: 'not_found' };
  if (hits.length > 1) return { error: 'ambiguous', candidates: hits };
  return { jid: hits[0]!.jid };
}

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------
function shapeMessage(m: CachedMessage) {
  const senderName = m.isFromMe ? 'you' : resolveChatName(m.sender);
  const chatName = resolveChatName(m.chatJid);
  return {
    id: m.id,
    chatJid: m.chatJid,
    chatName,
    sender: m.sender,
    senderName,
    fromName: m.fromName,
    body: m.body,
    timestamp: m.timestamp,
    isGroup: m.isGroup,
    isFromMe: m.isFromMe,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function buildRouter(): Router {
  const r = Router();

  const sendLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // -------------------------------------------------------------------------
  // GET /status
  // -------------------------------------------------------------------------
  r.get('/status', (_req: Request, res: Response) => {
    const c = counts();
    res.json({
      status: getConnectionStatus(),
      hasQr: getLatestQr() !== null,
      cachedMessages: c.messages,
      knownChats: c.chats,
      knownContacts: c.contacts,
      deploymentMode: process.env.DEPLOYMENT_MODE || 'local',
    });
  });

  // -------------------------------------------------------------------------
  // GET /qr
  // -------------------------------------------------------------------------
  r.get('/qr', (_req: Request, res: Response) => {
    const qr = getLatestQr();
    if (!qr) {
      return res
        .status(404)
        .json({ error: 'No QR available — already linked or not yet generated.' });
    }
    res.json({ qr });
  });

  // -------------------------------------------------------------------------
  // GET /conversations
  // -------------------------------------------------------------------------
  r.get('/conversations', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit, 50, 200);
    const conversations = listChats(limit).map((c) => ({
      jid: c.jid,
      isGroup: c.isGroup,
      lastMessage: c.lastMessage,
      lastTimestamp: c.lastTimestamp,
      contactName: resolveChatName(c.jid),
    }));
    res.json({ conversations });
  });

  // -------------------------------------------------------------------------
  // GET /chats/search
  // -------------------------------------------------------------------------
  r.get('/chats/search', (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = clampLimit(req.query.limit, 20, 50);
    if (!q.trim()) {
      return res.status(400).json({ error: 'Query parameter `q` is required.' });
    }
    const hits = searchChatsByName(q, limit, isChatListJid);
    res.json({ query: q, hits });
  });

  // -------------------------------------------------------------------------
  // GET /messages — jid required
  // -------------------------------------------------------------------------
  r.get('/messages', (req: Request, res: Response) => {
    const jid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
    if (!jid) {
      return res
        .status(400)
        .json({ error: '`jid` query parameter is required. Use /chats/search to find one.' });
    }
    const limit = clampLimit(req.query.limit, 50, 200);
    const beforeTs =
      typeof req.query.before_timestamp === 'string'
        ? parseInt(req.query.before_timestamp, 10)
        : undefined;
    const before = Number.isFinite(beforeTs) ? (beforeTs as number) : undefined;

    const all = getMessages(jid, limit, before);
    res.json({
      messages: all.map(shapeMessage),
      jid,
      chatName: resolveChatName(jid),
      total: chatBufferLength(jid),
      limit,
      hasMore: all.length === limit,
    });
  });

  // -------------------------------------------------------------------------
  // GET /messages/fetch_older — on-demand backfill via Baileys
  // -------------------------------------------------------------------------
  r.get('/messages/fetch_older', async (req: Request, res: Response) => {
    const jid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
    if (!jid) {
      return res.status(400).json({ error: '`jid` query parameter is required.' });
    }
    if (getConnectionStatus() !== 'connected' || !getSock()) {
      return res
        .status(503)
        .json({ error: 'WhatsApp is not connected. Check /status and re-pair if needed.' });
    }
    const count = clampLimit(req.query.count, 50, 200);
    const oldest = getOldestMessageKeyForChat(jid);
    if (!oldest) {
      return res.status(409).json({
        error:
          'No anchor message available for this chat yet. Send or receive at least one message in this chat before backfilling history.',
      });
    }

    try {
      const result = await fetchOlderForChat(
        jid,
        count,
        { id: oldest.id, remoteJid: jid, fromMe: oldest.fromMe },
        oldest.timestamp,
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `fetch_older failed: ${msg}` });
    }
  });

  // -------------------------------------------------------------------------
  // POST /send
  // -------------------------------------------------------------------------
  r.post('/send', sendLimiter, async (req: Request, res: Response) => {
    const body = req.body || {};
    const target: unknown = body.target ?? body.jid;
    const message: unknown = body.message;

    if (typeof target !== 'string' || target.length === 0 || target.length > 200) {
      return res.status(400).json({
        error:
          'Body must include `target` (1-200 chars): a JID, phone number, or contact/chat name.',
      });
    }
    if (typeof message !== 'string') {
      return res.status(400).json({ error: 'Body must include `message` (string).' });
    }

    const clean = sanitizeMessage(message);
    if (clean.length === 0) {
      return res.status(400).json({ error: 'Message body is empty after sanitization.' });
    }
    const sock = getSock();
    if (!sock || getConnectionStatus() !== 'connected') {
      return res
        .status(503)
        .json({ error: 'WhatsApp is not connected. Check /status and scan the QR if needed.' });
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
      return res.json({
        ok: true,
        id: sent?.key?.id ?? null,
        jid: resolved.jid,
        chatName: resolveChatName(resolved.jid),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Send failed: ${msg}` });
    }
  });

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  r.post('/logout', async (_req: Request, res: Response) => {
    try {
      await logoutAndReset();
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

  return r;
}

// Re-exported for tests / debugging.
export { sanitizeMessage, validateJid, normalizeJid, formatPhoneFallback };
