// HTTP-level integration: auth, validation, rate limit, idempotency replay.
// We exercise routes that don't need a live Baileys socket.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { closeDb, initDb, truncateAll } from '../src/db';
import { _resetAllBucketsForTests } from '../src/ratelimit';
import { buildApp } from '../src/app';
import { insertMessage, upsertChat } from '../src/store';

const KEY = process.env.BRIDGE_API_KEY!;

interface FetchResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function listen(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = buildApp({ apiKey: KEY, deploymentMode: 'local' });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

async function call(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  const resp = await fetch(`${url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let parsed: unknown;
  const text = await resp.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const hh: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    hh[k] = v;
  });
  return { status: resp.status, body: parsed, headers: hh };
}

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
  _resetAllBucketsForTests();
});
afterEach(() => closeDb());

describe('auth', () => {
  it('rejects missing bearer', async () => {
    const { url, close } = await listen();
    try {
      const resp = await fetch(`${url}/status`);
      expect(resp.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('rejects wrong bearer', async () => {
    const { url, close } = await listen();
    try {
      const resp = await fetch(`${url}/status`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(resp.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('accepts valid bearer', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'GET', '/status');
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe('/status (extended)', () => {
  it('exposes new fields', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'GET', '/status');
      expect(r.status).toBe(200);
      const body = r.body as Record<string, unknown>;
      expect(body).toHaveProperty('lastMessageAt');
      expect(body).toHaveProperty('mediaCacheBytes');
      expect(body).toHaveProperty('errorsLastHour');
      expect(body).toHaveProperty('connectionUptimeSec');
    } finally {
      await close();
    }
  });
});

describe('/messages/search', () => {
  it('400 on missing query', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'GET', '/messages/search');
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('returns FTS hits', async () => {
    upsertChat({ jid: 'a@s.whatsapp.net', name: 'A', isGroup: false, lastTimestamp: 0, lastMessage: '' });
    insertMessage({
      id: '1', chatJid: 'a@s.whatsapp.net', sender: 'a', fromName: 'Alice',
      body: 'planet of the apes', timestamp: 100,
      isGroup: false, isFromMe: false, messageKind: 'text',
    });
    const { url, close } = await listen();
    try {
      const r = await call(url, 'GET', '/messages/search?q=planet');
      expect(r.status).toBe(200);
      expect((r.body as { hits: unknown[] }).hits.length).toBe(1);
    } finally {
      await close();
    }
  });
});

describe('/send validation', () => {
  it('rejects missing target', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'POST', '/send', { message: 'hi' });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });
  it('rejects missing message', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'POST', '/send', { target: '5804120001234' });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  });
  it('returns 503 when bridge not connected', async () => {
    const { url, close } = await listen();
    try {
      const r = await call(url, 'POST', '/send', {
        target: '5804120001234',
        message: 'hi',
      });
      expect(r.status).toBe(503);
    } finally {
      await close();
    }
  });
});

describe('/audit', () => {
  it('returns recorded entries', async () => {
    const { url, close } = await listen();
    try {
      // Trigger a failed send (no socket) — generates one audit row.
      await call(url, 'POST', '/send', { target: 'x', message: '' });
      const r = await call(url, 'GET', '/audit?limit=10');
      expect(r.status).toBe(200);
      const body = r.body as { items: unknown[] };
      expect(body.items.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe('/metrics', () => {
  it('serves Prometheus exposition', async () => {
    const { url, close } = await listen();
    try {
      // Make a request to register at least one metric.
      await call(url, 'GET', '/status');
      const r = await call(url, 'GET', '/metrics');
      expect(r.status).toBe(200);
      expect(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).toContain(
        'whatsapp_bridge_http_requests_total',
      );
    } finally {
      await close();
    }
  });
});

describe('idempotency replay', () => {
  it('returns cached response with replay header', async () => {
    const { url, close } = await listen();
    try {
      // Use /send/poll which validates without needing a socket on validation
      // failure — 400s are NOT idempotent-cached. So we need a successful path
      // we can replay. Easier: store an idempotency record manually and replay.
      const idem = await import('../src/idempotency');
      idem.store('replaykey', 'whatsapp_send_message', JSON.stringify({ ok: true, replayed: 1 }));
      const r = await call(url, 'POST', '/send', {
        target: '5804120001234',
        message: 'x',
        idempotency_key: 'replaykey',
      });
      expect(r.status).toBe(200);
      expect(r.headers['idempotency-replayed']).toBe('true');
      expect((r.body as { replayed?: number }).replayed).toBe(1);
    } finally {
      await close();
    }
  });

  it('rejects replay across different tools', async () => {
    const { url, close } = await listen();
    try {
      const idem = await import('../src/idempotency');
      idem.store('xkey', 'whatsapp_send_poll', JSON.stringify({ ok: true }));
      const r = await call(url, 'POST', '/send', {
        target: '5804120001234',
        message: 'x',
        idempotency_key: 'xkey',
      });
      expect(r.status).toBe(409);
    } finally {
      await close();
    }
  });
});
