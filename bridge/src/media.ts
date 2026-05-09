// Media lazy-download + on-disk cache + LRU/TTL eviction.
//
// Layout: `${MEDIA_DIR}/<chat_jid>/<message_id>.<ext>`. We keep the
// base32-encoded JID-as-folder to avoid path-segment edge cases on Windows
// (the chat jid contains `@` which is fine on POSIX/NTFS).
//
// Outbound URL fetch (used by /send/media via URL) lives in `media.ts` too
// because the SSRF guard is the same shape.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns/promises';
import * as net from 'net';
import { request } from 'undici';
import mimeTypes from 'mime-types';
import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

import { getDb } from './db';
import { getSock } from './baileys';

const MEDIA_DIR = process.env.MEDIA_CACHE_DIR ?? '/data/media';
const MAX_CACHE_BYTES = parseInt(process.env.MEDIA_CACHE_MAX_MB ?? '2048', 10) * 1024 * 1024;
const TTL_MS = parseInt(process.env.MEDIA_CACHE_TTL_DAYS ?? '7', 10) * 86400 * 1000;
const MAX_INBOUND_BYTES = parseInt(process.env.MEDIA_MAX_INBOUND_MB ?? '16', 10) * 1024 * 1024;
const MAX_OUTBOUND_BYTES = parseInt(process.env.MEDIA_MAX_OUTBOUND_MB ?? '100', 10) * 1024 * 1024;
const SIGNED_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes

// HMAC secret for signed media URLs. Keyed off BRIDGE_API_KEY so a key
// rotation invalidates outstanding tokens.
function signingKey(): Buffer {
  return crypto.createHash('sha256').update(process.env.BRIDGE_API_KEY ?? '').digest();
}

function ensureCacheDir(): void {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
}

function safeChatDir(chatJid: string): string {
  // Sanitize: keep only [A-Za-z0-9._@-].
  const safe = chatJid.replace(/[^A-Za-z0-9._@-]/g, '_');
  return path.join(MEDIA_DIR, safe);
}

function safeMessageFile(chatJid: string, messageId: string, mime?: string | null): string {
  const safeId = messageId.replace(/[^A-Za-z0-9._-]/g, '_');
  const ext = mime ? mimeTypes.extension(mime) : null;
  return path.join(safeChatDir(chatJid), `${safeId}${ext ? `.${ext}` : ''}`);
}

export interface MediaRefRow {
  message_id: string;
  chat_jid: string;
  kind: string;
  mime_type: string | null;
  file_name: string | null;
  file_size: number | null;
  caption: string | null;
  baileys_proto_blob: Buffer;
  cached_path: string | null;
  cached_at: number | null;
}

function getMediaRef(chatJid: string, messageId: string): MediaRefRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT message_id, chat_jid, kind, mime_type, file_name, file_size, caption,
                baileys_proto_blob, cached_path, cached_at
         FROM media_refs WHERE chat_jid = ? AND message_id = ?`,
      )
      .get(chatJid, messageId) as MediaRefRow | undefined) ?? null
  );
}

function updateCachedPath(chatJid: string, messageId: string, p: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE media_refs SET cached_path = ?, cached_at = ? WHERE chat_jid = ? AND message_id = ?`,
  ).run(p, p ? Date.now() : null, chatJid, messageId);
}

export interface DownloadResult {
  chatJid: string;
  messageId: string;
  kind: string;
  mime: string;
  fileName: string | null;
  size: number;
  // Either base64 OR a signed URL — never both.
  base64?: string;
  url?: string;
  cached: boolean;
}

const INLINE_MAX_BYTES = parseInt(process.env.MEDIA_INLINE_RESPONSE_MB ?? '4', 10) * 1024 * 1024;

// Re-hydrate the stored proto and ask Baileys to download. Caches to disk on
// success. If the cached file already exists, returns it directly.
//
// Returns the inline-or-URL response shape used by /media/:chatJid/:messageId.
export async function downloadAndServe(
  chatJid: string,
  messageId: string,
  bridgeOrigin: string,
): Promise<DownloadResult> {
  ensureCacheDir();
  const ref = getMediaRef(chatJid, messageId);
  if (!ref) throw new Error('media not found for this chat/message');

  const mime = ref.mime_type ?? 'application/octet-stream';
  // Hit cache first.
  if (ref.cached_path && fs.existsSync(ref.cached_path)) {
    const stats = fs.statSync(ref.cached_path);
    return await assembleResponse(
      chatJid,
      messageId,
      ref.kind,
      mime,
      ref.file_name,
      stats.size,
      ref.cached_path,
      bridgeOrigin,
      true,
    );
  }

  // Decode the stored proto and download.
  let payload: proto.IMessage;
  try {
    payload = proto.Message.decode(ref.baileys_proto_blob);
  } catch (err) {
    throw new Error(
      'stored media proto is corrupt: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const sock = getSock();
  if (!sock) throw new Error('WhatsApp socket not connected');

  // Build the WAMessage skeleton downloadMediaMessage expects.
  const waMessage = {
    key: { id: messageId, remoteJid: chatJid, fromMe: false },
    message: payload,
    messageTimestamp: 0,
  };

  let buffer: Buffer;
  try {
    // Returns a Buffer when type='buffer'.
    buffer = (await downloadMediaMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      waMessage as any,
      'buffer',
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { logger: (sock as any).logger ?? console, reuploadRequest: sock.updateMediaMessage },
    )) as Buffer;
  } catch (err) {
    throw new Error(
      'Baileys download failed: ' + (err instanceof Error ? err.message : String(err)),
    );
  }

  if (buffer.byteLength > MAX_INBOUND_BYTES) {
    throw new Error(
      `inbound media exceeds MEDIA_MAX_INBOUND_MB (${buffer.byteLength} > ${MAX_INBOUND_BYTES})`,
    );
  }

  const filePath = safeMessageFile(chatJid, messageId, mime);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  updateCachedPath(chatJid, messageId, filePath);

  return await assembleResponse(
    chatJid,
    messageId,
    ref.kind,
    mime,
    ref.file_name,
    buffer.byteLength,
    filePath,
    bridgeOrigin,
    false,
  );
}

async function assembleResponse(
  chatJid: string,
  messageId: string,
  kind: string,
  mime: string,
  fileName: string | null,
  size: number,
  filePath: string,
  bridgeOrigin: string,
  cached: boolean,
): Promise<DownloadResult> {
  const base: DownloadResult = {
    chatJid,
    messageId,
    kind,
    mime,
    fileName,
    size,
    cached,
  };
  if (size <= INLINE_MAX_BYTES) {
    base.base64 = fs.readFileSync(filePath).toString('base64');
  } else {
    base.url = `${bridgeOrigin}/media/file/${signFileToken(filePath)}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Signed file tokens. Token format: `${b64url(payload)}.${b64url(hmac)}`
// Payload is `${expiresMs}|${absoluteFilePath}`. HMAC-SHA256 over payload.
// ---------------------------------------------------------------------------
function signFileToken(absPath: string): string {
  const expires = Date.now() + SIGNED_URL_TTL_MS;
  const payload = `${expires}|${absPath}`;
  const sig = crypto.createHmac('sha256', signingKey()).update(payload).digest();
  return `${b64url(Buffer.from(payload))}.${b64url(sig)}`;
}

export interface VerifiedToken {
  filePath: string;
  expires: number;
}
export function verifyFileToken(token: string): VerifiedToken | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = b64urlDecode(parts[0]!);
    sigBuf = b64urlDecode(parts[1]!);
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', signingKey()).update(payloadBuf).digest();
  if (!timingSafeEqual(expected, sigBuf)) return null;
  const [expiresStr, ...rest] = payloadBuf.toString('utf8').split('|');
  const filePath = rest.join('|');
  const expires = parseInt(expiresStr ?? '0', 10);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  return { filePath, expires };
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  let v = s.replace(/-/g, '+').replace(/_/g, '/');
  while (v.length % 4 !== 0) v += '=';
  return Buffer.from(v, 'base64');
}
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// LRU + TTL eviction
// ---------------------------------------------------------------------------
export function totalCacheBytes(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT cached_path FROM media_refs WHERE cached_path IS NOT NULL`,
    )
    .all() as { cached_path: string }[];
  let total = 0;
  for (const r of rows) {
    try {
      total += fs.statSync(r.cached_path).size;
    } catch {
      // file gone — clear pointer
      db.prepare(
        `UPDATE media_refs SET cached_path = NULL, cached_at = NULL WHERE cached_path = ?`,
      ).run(r.cached_path);
    }
  }
  return total;
}

export function evictExpired(): number {
  const db = getDb();
  const cutoff = Date.now() - TTL_MS;
  const rows = db
    .prepare(
      `SELECT chat_jid, message_id, cached_path FROM media_refs
       WHERE cached_at IS NOT NULL AND cached_at < ?`,
    )
    .all(cutoff) as { chat_jid: string; message_id: string; cached_path: string }[];
  let dropped = 0;
  for (const r of rows) {
    try {
      if (fs.existsSync(r.cached_path)) fs.rmSync(r.cached_path, { force: true });
      db.prepare(
        `UPDATE media_refs SET cached_path = NULL, cached_at = NULL WHERE chat_jid = ? AND message_id = ?`,
      ).run(r.chat_jid, r.message_id);
      dropped++;
    } catch {
      // best-effort
    }
  }
  return dropped;
}

export function evictLruUntilUnder(maxBytes: number): number {
  const db = getDb();
  let total = totalCacheBytes();
  if (total <= maxBytes) return 0;

  const rows = db
    .prepare(
      `SELECT chat_jid, message_id, cached_path FROM media_refs
       WHERE cached_path IS NOT NULL ORDER BY cached_at ASC`,
    )
    .all() as { chat_jid: string; message_id: string; cached_path: string }[];

  let dropped = 0;
  for (const r of rows) {
    if (total <= maxBytes) break;
    try {
      const sz = fs.existsSync(r.cached_path) ? fs.statSync(r.cached_path).size : 0;
      if (sz > 0) fs.rmSync(r.cached_path, { force: true });
      db.prepare(
        `UPDATE media_refs SET cached_path = NULL, cached_at = NULL WHERE chat_jid = ? AND message_id = ?`,
      ).run(r.chat_jid, r.message_id);
      total -= sz;
      dropped++;
    } catch {
      // best-effort
    }
  }
  return dropped;
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startMediaSweeper(intervalMs = 3600_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      evictExpired();
      evictLruUntilUnder(MAX_CACHE_BYTES);
    } catch (err) {
      console.error('media sweeper:', err instanceof Error ? err.message : String(err));
    }
  }, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
}
export function stopMediaSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Outbound — base64 / URL → Buffer with SSRF guard.
// ---------------------------------------------------------------------------
export async function loadOutboundFromBase64(b64: string): Promise<Buffer> {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('invalid base64 payload');
  }
  // Round-trip check: re-encoding should match (modulo padding) — protects
  // against junk inputs that base64 silently accepts.
  if (buf.length === 0) throw new Error('empty base64 payload');
  if (buf.length > MAX_OUTBOUND_BYTES) {
    throw new Error(
      `outbound media exceeds MEDIA_MAX_OUTBOUND_MB (${buf.length} > ${MAX_OUTBOUND_BYTES})`,
    );
  }
  return buf;
}

export async function loadOutboundFromUrl(url: string): Promise<{ buffer: Buffer; mime: string | null }> {
  // Parse + validate.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('only http(s) urls are accepted');
  }
  // SSRF guard — resolve and reject private/loopback/link-local addresses.
  await assertPublicHost(parsed.hostname);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const { statusCode, headers, body } = await request(parsed.toString(), {
      method: 'GET',
      maxRedirections: 3,
      signal: ctrl.signal,
      headersTimeout: 10_000,
      bodyTimeout: 30_000,
    });
    if (statusCode >= 400) throw new Error(`upstream returned ${statusCode}`);
    const contentLengthHeader = headers['content-length'];
    const declared = Array.isArray(contentLengthHeader)
      ? parseInt(contentLengthHeader[0]!, 10)
      : parseInt((contentLengthHeader as string | undefined) ?? '0', 10);
    if (Number.isFinite(declared) && declared > MAX_OUTBOUND_BYTES) {
      throw new Error(`upstream content-length exceeds MEDIA_MAX_OUTBOUND_MB`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_OUTBOUND_BYTES) {
        throw new Error('upstream body exceeds MEDIA_MAX_OUTBOUND_MB during stream');
      }
      chunks.push(buf);
    }
    const out = Buffer.concat(chunks, total);
    let mime: string | null = null;
    const ct = headers['content-type'];
    if (typeof ct === 'string') mime = ct.split(';')[0]!.trim();
    else if (Array.isArray(ct) && typeof ct[0] === 'string') mime = ct[0]!.split(';')[0]!.trim();
    return { buffer: out, mime };
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPublicHost(hostname: string): Promise<void> {
  // Resolve all addresses; reject if any one is private.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`refused: private address ${hostname}`);
    return;
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(
      `dns lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`refused: private address ${a.address}`);
  }
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map((p) => parseInt(p, 10));
    if (o.length !== 4) return true;
    const [a, b] = [o[0]!, o[1]!];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    // IPv4-mapped — re-check the embedded v4.
    const m = lower.match(/^::ffff:([0-9.]+)$/);
    if (m && net.isIPv4(m[1]!)) return isPrivateIp(m[1]!);
    return false;
  }
  return true; // unknown family — treat as private
}
