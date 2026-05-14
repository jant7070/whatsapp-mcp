import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';

import {
  fetchOlderForChat,
  getConnectionStatus,
  getConnectionUptimeSec,
  getLastMessageAt,
  getLatestQr,
  getSock,
  isChatListJid,
  logoutAndReset,
  refreshGroupSubjects,
  startWhatsApp,
} from './baileys';
import { canonicalJid } from './lidStore';
import {
  formatPhoneFallback,
  resolveChatName,
  searchChatsByName,
  type ChatSearchHit,
} from './names';
import {
  chatBufferLength,
  counts,
  getMessage,
  getMessages,
  getOldestMessageKeyForChat,
  listChats,
  type CachedMessage,
} from './store';
import { getDb } from './db';
import { searchMessages } from './search';
import { idempotencyMw, recordResultIfKey } from './idempotency';
import { rateLimitMw } from './ratelimit';
import {
  downloadAndServe,
  loadOutboundFromBase64,
  loadOutboundFromUrl,
  totalCacheBytes,
  verifyFileToken,
} from './media';
import {
  getMyProfile,
  updateMyProfile,
  getContactProfile,
} from './profile';
import { listAudit, recordAudit } from './audit';
import {
  cacheBytesGauge,
  connectionStatusGauge,
  errorsInLastHour,
  idempotencyReplays,
  metricsMw,
  rateLimitDrops,
  registry,
  sendMessages,
} from './metrics';

// ---------------------------------------------------------------------------
// Validation utilities
// ---------------------------------------------------------------------------
const MAX_MESSAGE_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 1024;
const JID_REGEX = /^[0-9]{7,15}(@s\.whatsapp\.net|@g\.us)?$/;
const EMOJI_REGEX = /^[\p{Emoji}‍️]{0,16}$/u;

function sanitizeMessage(text: string, max = MAX_MESSAGE_LENGTH): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, max);
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
  if (trimmed.endsWith('@lid')) {
    const canonical = canonicalJid(trimmed);
    if (canonical !== trimmed) return { jid: canonical };
    return { jid: trimmed };
  }
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

function ensureConnected(res: Response): boolean {
  const sock = getSock();
  if (!sock || getConnectionStatus() !== 'connected') {
    res.status(503).json({
      error: 'WhatsApp is not connected. Check /status and scan the QR if needed.',
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------
function shapeMessage(m: CachedMessage) {
  const senderName = m.isFromMe ? 'you' : resolveChatName(m.sender);
  const chatName = resolveChatName(m.chatJid);
  const out: Record<string, unknown> = {
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
    messageKind: m.messageKind ?? 'text',
  };
  if (m.replyToId) out.replyToId = m.replyToId;
  if (m.editedAt) out.editedAt = m.editedAt;
  if (m.deletedAt) out.deletedAt = m.deletedAt;

  // Decorate with media + extras lookups for richer downstream consumption.
  const db = getDb();
  const media = db
    .prepare(
      `SELECT kind, mime_type, file_name, file_size, caption,
              CASE WHEN cached_path IS NOT NULL THEN 1 ELSE 0 END AS has_cache
       FROM media_refs WHERE chat_jid = ? AND message_id = ?`,
    )
    .get(m.chatJid, m.id) as
    | {
        kind: string;
        mime_type: string | null;
        file_name: string | null;
        file_size: number | null;
        caption: string | null;
        has_cache: number;
      }
    | undefined;
  if (media) {
    out.media = {
      kind: media.kind,
      mimeType: media.mime_type,
      fileName: media.file_name,
      fileSize: media.file_size,
      caption: media.caption,
      cached: !!media.has_cache,
    };
  }
  const extras = db
    .prepare(
      `SELECT kind, payload FROM message_extras WHERE chat_jid = ? AND message_id = ?`,
    )
    .get(m.chatJid, m.id) as { kind: string; payload: string } | undefined;
  if (extras) {
    try {
      out.extras = { kind: extras.kind, payload: JSON.parse(extras.payload) };
    } catch {
      // skip malformed
    }
  }
  return out;
}

// Friendly error responder that ALSO records an audit row. Use for write tools.
function writeFail(
  res: Response,
  status: number,
  error: string,
  ctx: {
    tool: string;
    target?: string | null;
    params: Record<string, unknown>;
    errorCode?: string;
  },
): Response {
  recordAudit({
    tool: ctx.tool,
    targetJid: ctx.target ?? null,
    paramsRaw: ctx.params,
    ok: false,
    errorCode: ctx.errorCode ?? `http_${status}`,
    resultSummary: error.slice(0, 200),
  });
  return res.status(status).json({ error });
}

function writeOk(
  res: Response,
  body: Record<string, unknown>,
  ctx: { tool: string; target?: string | null; params: Record<string, unknown>; req: Request },
): Response {
  recordAudit({
    tool: ctx.tool,
    targetJid: ctx.target ?? null,
    paramsRaw: ctx.params,
    ok: true,
    resultSummary: JSON.stringify(body).slice(0, 200),
    idempotencyKey:
      (ctx.req.body && (ctx.req.body as { idempotency_key?: string }).idempotency_key) ?? null,
  });
  recordResultIfKey(ctx.req, body);
  return res.json(body);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function buildRouter(): Router {
  const r = Router();
  r.use(metricsMw());

  // -------------------------------------------------------------------------
  // GET /status — extended
  // -------------------------------------------------------------------------
  r.get(
    '/status',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (_req: Request, res: Response) => {
      const c = counts();
      const conn = getConnectionStatus();
      connectionStatusGauge.set(conn === 'connected' ? 2 : conn === 'connecting' ? 1 : 0);
      let mediaBytes = 0;
      try {
        mediaBytes = totalCacheBytes();
        cacheBytesGauge.set(mediaBytes);
      } catch {
        // best-effort
      }
      res.json({
        status: conn,
        hasQr: getLatestQr() !== null,
        cachedMessages: c.messages,
        knownChats: c.chats,
        knownContacts: c.contacts,
        deploymentMode: process.env.DEPLOYMENT_MODE || 'local',
        lastMessageAt: getLastMessageAt(),
        storeSize: c.messages,
        mediaCacheBytes: mediaBytes,
        errorsLastHour: errorsInLastHour(),
        connectionUptimeSec: getConnectionUptimeSec(),
      });
    },
  );

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
  // GET /metrics
  // -------------------------------------------------------------------------
  r.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  // -------------------------------------------------------------------------
  // GET /audit
  // -------------------------------------------------------------------------
  r.get(
    '/audit',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (req: Request, res: Response) => {
      const tool = typeof req.query.tool === 'string' ? req.query.tool : undefined;
      const since = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
      const limit = clampLimit(req.query.limit, 100, 500);
      const items = listAudit({ tool, since, limit });
      res.json({ items, total: items.length, limit });
    },
  );

  // -------------------------------------------------------------------------
  // GET /conversations
  // -------------------------------------------------------------------------
  r.get(
    '/conversations',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (req: Request, res: Response) => {
      const limit = clampLimit(req.query.limit, 50, 200);
      const conversations = listChats(limit).map((c) => ({
        jid: c.jid,
        isGroup: c.isGroup,
        lastMessage: c.lastMessage,
        lastTimestamp: c.lastTimestamp,
        contactName: resolveChatName(c.jid),
      }));
      res.json({ conversations });
    },
  );

  // -------------------------------------------------------------------------
  // GET /chats/search
  // -------------------------------------------------------------------------
  r.get(
    '/chats/search',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = clampLimit(req.query.limit, 20, 50);
      if (!q.trim()) {
        return res.status(400).json({ error: 'Query parameter `q` is required.' });
      }
      const hits = searchChatsByName(q, limit, isChatListJid);
      res.json({ query: q, hits });
    },
  );

  // -------------------------------------------------------------------------
  // GET /messages
  // -------------------------------------------------------------------------
  r.get(
    '/messages',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (req: Request, res: Response) => {
      const rawJid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
      if (!rawJid) {
        return res
          .status(400)
          .json({ error: '`jid` query parameter is required. Use /chats/search to find one.' });
      }
      const jid = canonicalJid(rawJid);
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
    },
  );

  // -------------------------------------------------------------------------
  // GET /messages/search — FTS5
  // -------------------------------------------------------------------------
  r.get(
    '/messages/search',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      if (!q.trim()) {
        return res.status(400).json({ error: 'Query parameter `q` is required.' });
      }
      const limit = clampLimit(req.query.limit, 50, 200);
      const jid = typeof req.query.jid === 'string' ? canonicalJid(req.query.jid) : undefined;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const since = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
      const until = req.query.until ? parseInt(String(req.query.until), 10) : undefined;

      try {
        const hits = searchMessages({ query: q, jid, kind, since, until, limit });
        res.json({
          query: q,
          total: hits.length,
          hits: hits.map((h) => ({ ...shapeMessage(h), rank: h.rank })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: `search failed: ${msg}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /messages/fetch_older
  // -------------------------------------------------------------------------
  r.get('/messages/fetch_older', async (req: Request, res: Response) => {
    const rawJid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
    if (!rawJid) {
      return res.status(400).json({ error: '`jid` query parameter is required.' });
    }
    const jid = canonicalJid(rawJid);
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
  // POST /send — text
  // -------------------------------------------------------------------------
  r.post(
    '/send',
    rateLimitMw({
      keyFn: (req) => {
        const t = (req.body as { target?: string } | undefined)?.target;
        return ['send:global', `send:target:${t ?? 'unknown'}`];
      },
      capacityPerMinute: (req) =>
        (req.body as { target?: string } | undefined)?.target ? 20 : 60,
    }),
    idempotencyMw('whatsapp_send_message'),
    async (req: Request, res: Response) => {
      const body = req.body || {};
      const target: unknown = body.target ?? body.jid;
      const message: unknown = body.message;
      const params = body as Record<string, unknown>;

      if (typeof target !== 'string' || target.length === 0 || target.length > 200) {
        return writeFail(
          res,
          400,
          'Body must include `target` (1-200 chars): a JID, phone number, or contact/chat name.',
          { tool: 'whatsapp_send_message', params },
        );
      }
      if (typeof message !== 'string') {
        return writeFail(res, 400, 'Body must include `message` (string).', {
          tool: 'whatsapp_send_message',
          params,
        });
      }
      const clean = sanitizeMessage(message);
      if (clean.length === 0) {
        return writeFail(res, 400, 'Message body is empty after sanitization.', {
          tool: 'whatsapp_send_message',
          params,
        });
      }
      if (!ensureConnected(res)) return res;

      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found') {
          return writeFail(
            res,
            404,
            `No contact or chat matches "${target}". Try whatsapp_search_contacts to browse, or pass a JID directly.`,
            { tool: 'whatsapp_send_message', params },
          );
        }
        recordAudit({
          tool: 'whatsapp_send_message',
          targetJid: null,
          paramsRaw: params,
          ok: false,
          errorCode: 'http_409',
          resultSummary: 'ambiguous',
        });
        return res.status(409).json({
          error: `"${target}" is ambiguous — multiple chats match. Pick one and call again with its JID.`,
          candidates: resolved.candidates ?? [],
        });
      }

      try {
        const sent = await getSock()!.sendMessage(resolved.jid, { text: clean });
        sendMessages.inc({ tool: 'whatsapp_send_message', result: 'ok' });
        return writeOk(
          res,
          {
            ok: true,
            id: sent?.key?.id ?? null,
            jid: resolved.jid,
            chatName: resolveChatName(resolved.jid),
          },
          { tool: 'whatsapp_send_message', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_send_message', result: 'error' });
        const msg = err instanceof Error ? err.message : String(err);
        return writeFail(res, 500, `Send failed: ${msg}`, {
          tool: 'whatsapp_send_message',
          target: resolved.jid,
          params,
          errorCode: 'baileys_send',
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /send/media
  // -------------------------------------------------------------------------
  r.post(
    '/send/media',
    rateLimitMw({
      keyFn: (req) => {
        const t = (req.body as { target?: string } | undefined)?.target;
        return ['send:global', `send:target:${t ?? 'unknown'}`];
      },
      capacityPerMinute: (req) =>
        (req.body as { target?: string } | undefined)?.target ? 20 : 60,
    }),
    idempotencyMw('whatsapp_send_media'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        kind?: string;
        source?: {
          type?: 'base64' | 'url';
          data?: string;
          url?: string;
          fileName?: string;
          mimeType?: string;
          caption?: string;
          ptt?: boolean;
        };
      };
      const params = body as unknown as Record<string, unknown>;
      const target = body.target;
      const kind = body.kind;
      const source = body.source ?? {};

      if (!target || typeof target !== 'string') {
        return writeFail(res, 400, 'Body must include `target` (string).', {
          tool: 'whatsapp_send_media',
          params,
        });
      }
      const allowedKinds = new Set(['image', 'document', 'video', 'audio', 'voice']);
      if (!kind || !allowedKinds.has(kind)) {
        return writeFail(
          res,
          400,
          `Body must include \`kind\` (one of ${[...allowedKinds].join(', ')}).`,
          { tool: 'whatsapp_send_media', params, target },
        );
      }
      if (!source.type || (source.type !== 'base64' && source.type !== 'url')) {
        return writeFail(res, 400, '`source.type` must be "base64" or "url".', {
          tool: 'whatsapp_send_media',
          params,
          target,
        });
      }
      if (!ensureConnected(res)) return res;

      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found') {
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_send_media',
            params,
            target,
          });
        }
        recordAudit({
          tool: 'whatsapp_send_media',
          targetJid: null,
          paramsRaw: params,
          ok: false,
          errorCode: 'http_409',
          resultSummary: 'ambiguous',
        });
        return res.status(409).json({
          error: `"${target}" is ambiguous — multiple chats match.`,
          candidates: resolved.candidates ?? [],
        });
      }

      let buffer: Buffer;
      let mime: string | null = source.mimeType ?? null;
      try {
        if (source.type === 'base64') {
          if (!source.data) throw new Error('source.data (base64) required');
          buffer = await loadOutboundFromBase64(source.data);
        } else {
          if (!source.url) throw new Error('source.url required');
          const fetched = await loadOutboundFromUrl(source.url);
          buffer = fetched.buffer;
          if (!mime) mime = fetched.mime;
        }
      } catch (err) {
        return writeFail(
          res,
          400,
          `media load failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_send_media', params, target: resolved.jid, errorCode: 'media_load' },
        );
      }

      const caption =
        typeof source.caption === 'string'
          ? sanitizeMessage(source.caption, MAX_CAPTION_LENGTH)
          : undefined;

      // Build the Baileys content based on kind.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any = {};
      if (kind === 'image') {
        content.image = buffer;
        if (mime) content.mimetype = mime;
        if (caption) content.caption = caption;
      } else if (kind === 'video') {
        content.video = buffer;
        if (mime) content.mimetype = mime;
        if (caption) content.caption = caption;
      } else if (kind === 'audio') {
        content.audio = buffer;
        content.mimetype = mime ?? 'audio/mp4';
        content.ptt = false;
      } else if (kind === 'voice') {
        content.audio = buffer;
        content.mimetype = mime ?? 'audio/ogg; codecs=opus';
        content.ptt = true;
      } else if (kind === 'document') {
        content.document = buffer;
        content.mimetype = mime ?? 'application/octet-stream';
        content.fileName = source.fileName ?? 'file';
        if (caption) content.caption = caption;
      }

      try {
        const sent = await getSock()!.sendMessage(resolved.jid, content);
        sendMessages.inc({ tool: 'whatsapp_send_media', result: 'ok' });
        return writeOk(
          res,
          {
            ok: true,
            id: sent?.key?.id ?? null,
            jid: resolved.jid,
            chatName: resolveChatName(resolved.jid),
            kind,
            sizeBytes: buffer.byteLength,
          },
          { tool: 'whatsapp_send_media', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_send_media', result: 'error' });
        return writeFail(
          res,
          500,
          `send_media failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            tool: 'whatsapp_send_media',
            target: resolved.jid,
            params,
            errorCode: 'baileys_send',
          },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /media/:chatJid/:messageId — lazy download
  // -------------------------------------------------------------------------
  r.get(
    '/media/:chatJid/:messageId',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    async (req: Request, res: Response) => {
      const chatJid = canonicalJid(req.params.chatJid!);
      const messageId = req.params.messageId!;
      if (!ensureConnected(res)) return res;
      const origin = `${req.protocol}://${req.get('host')}`;
      try {
        const result = await downloadAndServe(chatJid, messageId, origin);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = msg.includes('not found') ? 404 : 500;
        res.status(status).json({ error: msg });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /media/file/:token — serve a previously-downloaded file by signed token
  // -------------------------------------------------------------------------
  r.get(
    '/media/file/:token',
    rateLimitMw({
      keyFn: (req) => `media-file:${req.params.token}`,
      capacityPerMinute: 30,
    }),
    (req: Request, res: Response) => {
      const v = verifyFileToken(req.params.token!);
      if (!v) return res.status(403).json({ error: 'invalid or expired token' });
      if (!fs.existsSync(v.filePath)) return res.status(404).json({ error: 'file gone' });
      res.sendFile(v.filePath);
    },
  );

  // -------------------------------------------------------------------------
  // POST /send/location
  // -------------------------------------------------------------------------
  r.post(
    '/send/location',
    rateLimitMw({
      keyFn: (req) => ['send:global', `send:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`],
      capacityPerMinute: (req) => ((req.body as { target?: string } | undefined)?.target ? 20 : 60),
    }),
    idempotencyMw('whatsapp_send_location'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        latitude?: number;
        longitude?: number;
        name?: string;
        address?: string;
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, latitude, longitude, name, address } = body;
      if (!target) {
        return writeFail(res, 400, '`target` is required.', {
          tool: 'whatsapp_send_location',
          params,
        });
      }
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return writeFail(res, 400, '`latitude` and `longitude` must be numbers.', {
          tool: 'whatsapp_send_location',
          params,
          target,
        });
      }
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return writeFail(res, 400, 'lat/lon out of range.', {
          tool: 'whatsapp_send_location',
          params,
          target,
        });
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_send_location',
            params,
            target,
          });
        return res.status(409).json({
          error: `"${target}" is ambiguous.`,
          candidates: resolved.candidates ?? [],
        });
      }
      try {
        const sent = await getSock()!.sendMessage(resolved.jid, {
          location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address },
        });
        sendMessages.inc({ tool: 'whatsapp_send_location', result: 'ok' });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, jid: resolved.jid },
          { tool: 'whatsapp_send_location', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_send_location', result: 'error' });
        return writeFail(
          res,
          500,
          `send_location failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_send_location', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /send/contact
  // -------------------------------------------------------------------------
  r.post(
    '/send/contact',
    rateLimitMw({
      keyFn: (req) => ['send:global', `send:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`],
      capacityPerMinute: (req) => ((req.body as { target?: string } | undefined)?.target ? 20 : 60),
    }),
    idempotencyMw('whatsapp_send_contact'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        vcard?: string;
        contacts?: { name?: string; phone?: string }[];
      };
      const params = body as unknown as Record<string, unknown>;
      const { target } = body;
      if (!target) {
        return writeFail(res, 400, '`target` is required.', {
          tool: 'whatsapp_send_contact',
          params,
        });
      }
      let vcard: string | null = null;
      let displayName: string | null = null;
      if (body.vcard) {
        if (!/^BEGIN:VCARD/m.test(body.vcard) || !/^END:VCARD/m.test(body.vcard)) {
          return writeFail(res, 400, 'malformed vcard', {
            tool: 'whatsapp_send_contact',
            params,
            target,
            errorCode: 'bad_vcard',
          });
        }
        vcard = body.vcard;
      } else if (body.contacts && body.contacts.length > 0) {
        const c = body.contacts[0]!;
        if (!c.name || !c.phone) {
          return writeFail(res, 400, 'contacts[0].name and .phone are required.', {
            tool: 'whatsapp_send_contact',
            params,
            target,
          });
        }
        if (!/^[+]?[0-9 .-]{7,20}$/.test(c.phone)) {
          return writeFail(res, 400, 'malformed phone in contacts[0].', {
            tool: 'whatsapp_send_contact',
            params,
            target,
            errorCode: 'bad_phone',
          });
        }
        displayName = c.name;
        vcard =
          'BEGIN:VCARD\nVERSION:3.0\n' +
          `FN:${c.name}\n` +
          `TEL;type=CELL;waid=${c.phone.replace(/\D/g, '')}:${c.phone}\n` +
          'END:VCARD';
      } else {
        return writeFail(res, 400, 'either `vcard` or `contacts[]` must be provided.', {
          tool: 'whatsapp_send_contact',
          params,
          target,
        });
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_send_contact',
            params,
            target,
          });
        return res.status(409).json({
          error: `"${target}" is ambiguous.`,
          candidates: resolved.candidates ?? [],
        });
      }
      try {
        const sent = await getSock()!.sendMessage(resolved.jid, {
          contacts: { displayName: displayName ?? 'Contact', contacts: [{ vcard }] },
        });
        sendMessages.inc({ tool: 'whatsapp_send_contact', result: 'ok' });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, jid: resolved.jid },
          { tool: 'whatsapp_send_contact', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_send_contact', result: 'error' });
        return writeFail(
          res,
          500,
          `send_contact failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_send_contact', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /send/poll
  // -------------------------------------------------------------------------
  r.post(
    '/send/poll',
    rateLimitMw({
      keyFn: (req) => ['send:global', `send:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`],
      capacityPerMinute: (req) => ((req.body as { target?: string } | undefined)?.target ? 20 : 60),
    }),
    idempotencyMw('whatsapp_send_poll'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        name?: string;
        options?: string[];
        selectableCount?: number;
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, name, options, selectableCount } = body;
      if (!target) {
        return writeFail(res, 400, '`target` is required.', {
          tool: 'whatsapp_send_poll',
          params,
        });
      }
      if (!name || typeof name !== 'string' || name.length === 0 || name.length > 256) {
        return writeFail(res, 400, '`name` must be 1-256 chars.', {
          tool: 'whatsapp_send_poll',
          params,
          target,
        });
      }
      if (!Array.isArray(options) || options.length < 2 || options.length > 12) {
        return writeFail(res, 400, '`options` must have 2-12 entries.', {
          tool: 'whatsapp_send_poll',
          params,
          target,
        });
      }
      const sel = selectableCount ?? 1;
      if (sel < 1 || sel > options.length) {
        return writeFail(res, 400, '`selectableCount` must be 1..options.length.', {
          tool: 'whatsapp_send_poll',
          params,
          target,
        });
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_send_poll',
            params,
            target,
          });
        return res.status(409).json({
          error: `"${target}" is ambiguous.`,
          candidates: resolved.candidates ?? [],
        });
      }
      try {
        const sent = await getSock()!.sendMessage(resolved.jid, {
          poll: { name, values: options, selectableCount: sel },
        });
        sendMessages.inc({ tool: 'whatsapp_send_poll', result: 'ok' });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, jid: resolved.jid },
          { tool: 'whatsapp_send_poll', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_send_poll', result: 'error' });
        return writeFail(
          res,
          500,
          `send_poll failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_send_poll', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /reply
  // -------------------------------------------------------------------------
  r.post(
    '/reply',
    rateLimitMw({
      keyFn: (req) => ['send:global', `send:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`],
      capacityPerMinute: (req) => ((req.body as { target?: string } | undefined)?.target ? 20 : 60),
    }),
    idempotencyMw('whatsapp_reply'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        message?: string;
        quoted_message_id?: string;
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, message, quoted_message_id } = body;
      if (!target || typeof message !== 'string' || !quoted_message_id) {
        return writeFail(
          res,
          400,
          'Body must include `target`, `message`, and `quoted_message_id`.',
          { tool: 'whatsapp_reply', params, target },
        );
      }
      const clean = sanitizeMessage(message);
      if (clean.length === 0)
        return writeFail(res, 400, 'message empty after sanitize.', {
          tool: 'whatsapp_reply',
          params,
          target,
        });
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_reply',
            params,
            target,
          });
        return res.status(409).json({
          error: `"${target}" is ambiguous.`,
          candidates: resolved.candidates ?? [],
        });
      }

      const quoted = getMessage(resolved.jid, quoted_message_id);
      if (!quoted) {
        return writeFail(
          res,
          404,
          'quoted_message_id not found in this chat.',
          { tool: 'whatsapp_reply', params, target: resolved.jid, errorCode: 'quote_not_found' },
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quotedFake: any = {
        key: { id: quoted.id, remoteJid: resolved.jid, fromMe: quoted.isFromMe },
        message: { conversation: quoted.body },
      };
      try {
        const sent = await getSock()!.sendMessage(
          resolved.jid,
          { text: clean },
          { quoted: quotedFake },
        );
        sendMessages.inc({ tool: 'whatsapp_reply', result: 'ok' });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, jid: resolved.jid, replyToId: quoted.id },
          { tool: 'whatsapp_reply', target: resolved.jid, params, req },
        );
      } catch (err) {
        sendMessages.inc({ tool: 'whatsapp_reply', result: 'error' });
        return writeFail(
          res,
          500,
          `reply failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_reply', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /react
  // -------------------------------------------------------------------------
  r.post(
    '/react',
    rateLimitMw({
      keyFn: (req) => `react:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`,
      capacityPerMinute: 30,
    }),
    idempotencyMw('whatsapp_react'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        message_id?: string;
        emoji?: string;
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, message_id, emoji } = body;
      if (!target || !message_id || typeof emoji !== 'string') {
        return writeFail(res, 400, 'Body must include `target`, `message_id`, `emoji`.', {
          tool: 'whatsapp_react',
          params,
          target,
        });
      }
      if (emoji.length > 0 && !EMOJI_REGEX.test(emoji)) {
        return writeFail(res, 400, 'emoji must be 0..16 emoji chars (empty removes reaction).', {
          tool: 'whatsapp_react',
          params,
          target,
          errorCode: 'bad_emoji',
        });
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_react',
            params,
            target,
          });
        return res.status(409).json({ error: `"${target}" is ambiguous.` });
      }
      const target_msg = getMessage(resolved.jid, message_id);
      if (!target_msg) {
        return writeFail(res, 404, 'message_id not found in this chat.', {
          tool: 'whatsapp_react',
          params,
          target: resolved.jid,
        });
      }
      try {
        const sent = await getSock()!.sendMessage(resolved.jid, {
          react: {
            text: emoji,
            key: {
              id: target_msg.id,
              remoteJid: resolved.jid,
              fromMe: target_msg.isFromMe,
            },
          },
        });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, jid: resolved.jid, removed: emoji.length === 0 },
          { tool: 'whatsapp_react', target: resolved.jid, params, req },
        );
      } catch (err) {
        return writeFail(
          res,
          500,
          `react failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_react', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /edit
  // -------------------------------------------------------------------------
  r.post(
    '/edit',
    rateLimitMw({
      keyFn: (req) => `edit:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`,
      capacityPerMinute: 30,
    }),
    idempotencyMw('whatsapp_edit_message'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        message_id?: string;
        new_text?: string;
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, message_id, new_text } = body;
      if (!target || !message_id || typeof new_text !== 'string') {
        return writeFail(res, 400, 'Body must include `target`, `message_id`, `new_text`.', {
          tool: 'whatsapp_edit_message',
          params,
          target,
        });
      }
      const clean = sanitizeMessage(new_text);
      if (clean.length === 0) {
        return writeFail(res, 400, 'new_text empty after sanitize.', {
          tool: 'whatsapp_edit_message',
          params,
          target,
        });
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_edit_message',
            params,
            target,
          });
        return res.status(409).json({ error: `"${target}" is ambiguous.` });
      }
      const original = getMessage(resolved.jid, message_id);
      if (!original) {
        return writeFail(res, 404, 'message_id not found in this chat.', {
          tool: 'whatsapp_edit_message',
          params,
          target: resolved.jid,
        });
      }
      if (!original.isFromMe) {
        return writeFail(res, 403, 'cannot edit messages you did not send.', {
          tool: 'whatsapp_edit_message',
          params,
          target: resolved.jid,
          errorCode: 'not_own_message',
        });
      }
      const ageSec = Math.floor(Date.now() / 1000) - original.timestamp;
      if (ageSec > 15 * 60) {
        return writeFail(
          res,
          409,
          'WhatsApp only allows edits within 15 minutes of sending.',
          {
            tool: 'whatsapp_edit_message',
            params,
            target: resolved.jid,
            errorCode: 'edit_window',
          },
        );
      }
      try {
        const sent = await getSock()!.sendMessage(resolved.jid, {
          text: clean,
          edit: { id: original.id, remoteJid: resolved.jid, fromMe: true },
        });
        return writeOk(
          res,
          { ok: true, id: sent?.key?.id ?? null, edited: original.id },
          { tool: 'whatsapp_edit_message', target: resolved.jid, params, req },
        );
      } catch (err) {
        return writeFail(
          res,
          500,
          `edit failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_edit_message', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /delete
  // -------------------------------------------------------------------------
  r.post(
    '/delete',
    rateLimitMw({
      keyFn: (req) => `delete:target:${(req.body as { target?: string } | undefined)?.target ?? 'unknown'}`,
      capacityPerMinute: 30,
    }),
    idempotencyMw('whatsapp_delete_message'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        target?: string;
        message_id?: string;
        scope?: 'me' | 'everyone';
      };
      const params = body as unknown as Record<string, unknown>;
      const { target, message_id, scope } = body;
      if (!target || !message_id || (scope !== 'me' && scope !== 'everyone')) {
        return writeFail(
          res,
          400,
          'Body must include `target`, `message_id`, scope ("me"|"everyone").',
          { tool: 'whatsapp_delete_message', params, target },
        );
      }
      if (!ensureConnected(res)) return res;
      const resolved = resolveSendTarget(target);
      if ('error' in resolved) {
        if (resolved.error === 'not_found')
          return writeFail(res, 404, `No contact or chat matches "${target}".`, {
            tool: 'whatsapp_delete_message',
            params,
            target,
          });
        return res.status(409).json({ error: `"${target}" is ambiguous.` });
      }
      const original = getMessage(resolved.jid, message_id);
      if (!original) {
        return writeFail(res, 404, 'message_id not found in this chat.', {
          tool: 'whatsapp_delete_message',
          params,
          target: resolved.jid,
        });
      }
      if (scope === 'everyone' && !original.isFromMe) {
        return writeFail(res, 403, 'scope=everyone requires a message you sent.', {
          tool: 'whatsapp_delete_message',
          params,
          target: resolved.jid,
          errorCode: 'not_own_message',
        });
      }
      try {
        if (scope === 'everyone') {
          await getSock()!.sendMessage(resolved.jid, {
            delete: { id: original.id, remoteJid: resolved.jid, fromMe: true },
          });
        } else {
          await getSock()!.chatModify(
            {
              deleteForMe: {
                deleteMedia: false,
                key: { id: original.id, remoteJid: resolved.jid, fromMe: original.isFromMe },
                timestamp: original.timestamp,
              },
            },
            resolved.jid,
          );
        }
        return writeOk(
          res,
          { ok: true, deleted: original.id, scope },
          { tool: 'whatsapp_delete_message', target: resolved.jid, params, req },
        );
      } catch (err) {
        return writeFail(
          res,
          500,
          `delete failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_delete_message', target: resolved.jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /chats/:jid/read
  // -------------------------------------------------------------------------
  r.post(
    '/chats/:jid/read',
    rateLimitMw({ keyFn: () => 'read-mark:global', capacityPerMinute: 60 }),
    async (req: Request, res: Response) => {
      const jid = canonicalJid(req.params.jid!);
      const params: Record<string, unknown> = { jid };
      if (!ensureConnected(res)) return res;
      const newest = getMessages(jid, 1);
      if (newest.length === 0) {
        return writeFail(res, 404, 'no messages cached for this chat — nothing to mark read.', {
          tool: 'whatsapp_mark_read',
          params,
          target: jid,
        });
      }
      try {
        await getSock()!.readMessages([
          { id: newest[0]!.id, remoteJid: jid, fromMe: newest[0]!.isFromMe },
        ]);
        return writeOk(
          res,
          { ok: true, jid, markedThrough: newest[0]!.id },
          { tool: 'whatsapp_mark_read', target: jid, params, req },
        );
      } catch (err) {
        return writeFail(
          res,
          500,
          `mark_read failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_mark_read', target: jid, params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /profile/me
  // -------------------------------------------------------------------------
  r.get(
    '/profile/me',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    async (_req: Request, res: Response) => {
      if (!ensureConnected(res)) return res;
      try {
        res.json(await getMyProfile());
      } catch (err) {
        res.status(500).json({
          error: `profile/me failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /profile/me
  // -------------------------------------------------------------------------
  r.patch(
    '/profile/me',
    rateLimitMw({ keyFn: () => 'profile-write:global', capacityPerMinute: 5 }),
    idempotencyMw('whatsapp_update_my_profile'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        name?: string;
        status?: string;
        avatar_base64?: string;
      };
      const params = body as unknown as Record<string, unknown>;
      if (!ensureConnected(res)) return res;
      try {
        const out = await updateMyProfile({
          name: body.name,
          status: body.status,
          avatarBase64: body.avatar_base64,
        });
        return writeOk(res, { ok: true, ...out }, {
          tool: 'whatsapp_update_my_profile',
          params,
          req,
        });
      } catch (err) {
        return writeFail(
          res,
          400,
          `profile update failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_update_my_profile', params },
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /profile/:jid
  // -------------------------------------------------------------------------
  r.get(
    '/profile/:jid',
    rateLimitMw({ keyFn: () => 'global:read', capacityPerMinute: 120 }),
    async (req: Request, res: Response) => {
      if (!ensureConnected(res)) return res;
      const jid = canonicalJid(req.params.jid!);
      try {
        res.json(await getContactProfile(jid));
      } catch (err) {
        res.status(500).json({
          error: `profile/:jid failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /logout
  // -------------------------------------------------------------------------
  r.post(
    '/logout',
    rateLimitMw({ keyFn: () => 'logout:global', capacityPerMinute: 5 }),
    async (_req: Request, res: Response) => {
      try {
        await logoutAndReset();
        res.json({ ok: true, message: 'Logged out and auth_info/ deleted. Re-scan QR to link again.' });
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('Restart after logout failed:', err instanceof Error ? err.message : String(err));
          });
        }, 1_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Logout failed: ${msg}` });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/refresh — pull group subjects on demand. Same fetch the
  // bridge runs on every reconnect, exposed for already-running sessions.
  // -------------------------------------------------------------------------
  r.post(
    '/groups/refresh',
    rateLimitMw({ keyFn: () => 'profile-write:global', capacityPerMinute: 5 }),
    async (req: Request, res: Response) => {
      const params: Record<string, unknown> = {};
      if (!ensureConnected(res)) return res;
      try {
        const result = await refreshGroupSubjects(getSock()!);
        return writeOk(
          res,
          { ok: true, groupsRefreshed: result.refreshed },
          { tool: 'whatsapp_refresh_groups', params, req },
        );
      } catch (err) {
        return writeFail(
          res,
          500,
          `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          { tool: 'whatsapp_refresh_groups', params },
        );
      }
    },
  );

  // Wire metric counters that depend on response status into a single hook.
  r.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode === 429) rateLimitDrops.inc({ scope: req.path });
      if (res.getHeader('Idempotency-Replayed') === 'true') {
        const tool =
          (req as Request & { _idempotencyTool?: string })._idempotencyTool ?? 'unknown';
        idempotencyReplays.inc({ tool });
      }
    });
    next();
  });

  return r;
}

export { sanitizeMessage, validateJid, normalizeJid, formatPhoneFallback, resolveSendTarget };
