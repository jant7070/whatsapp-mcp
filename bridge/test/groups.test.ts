import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { closeDb, initDb, truncateAll } from '../src/db';
import { _resetAllBucketsForTests } from '../src/ratelimit';
import { getChat, setGroupSubject } from '../src/store';
import { refreshGroupSubjects } from '../src/baileys';

// Module-mock baileys so getSock() returns a fake with a deterministic
// groupFetchAllParticipating. getConnectionStatus must report 'connected'
// so the route passes ensureConnected().
vi.mock('../src/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/baileys')>();
  const fakeSock = {
    groupFetchAllParticipating: async () => ({
      '120363999@g.us': { id: '120363999@g.us', subject: 'Refreshed Subject' },
    }),
  };
  return {
    ...actual,
    getSock: () => fakeSock,
    getConnectionStatus: () => 'connected' as const,
  };
});

const KEY = process.env.BRIDGE_API_KEY!;

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

beforeEach(() => {
  initDb({ path: ':memory:' });
  truncateAll();
});
afterEach(() => closeDb());

describe('refreshGroupSubjects', () => {
  it('writes subjects for every group returned by groupFetchAllParticipating', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => ({
        '120363111@g.us': { id: '120363111@g.us', subject: 'El conter' },
        '120363222@g.us': { id: '120363222@g.us', subject: 'Banesco vacantes' },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(2);
    expect(getChat('120363111@g.us')?.name).toBe('El conter');
    expect(getChat('120363222@g.us')?.name).toBe('Banesco vacantes');
  });

  it('skips entries with missing or empty subject', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => ({
        '120363333@g.us': { id: '120363333@g.us', subject: '' },
        '120363444@g.us': { id: '120363444@g.us' /* no subject */ },
        '120363555@g.us': { id: '120363555@g.us', subject: 'Real group' },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(1);
    expect(getChat('120363333@g.us')).toBeUndefined();
    expect(getChat('120363444@g.us')).toBeUndefined();
    expect(getChat('120363555@g.us')?.name).toBe('Real group');
  });

  it('returns refreshed=0 and swallows errors', async () => {
    const fakeSock = {
      groupFetchAllParticipating: async () => {
        throw new Error('socket gone');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await refreshGroupSubjects(fakeSock as any);
    expect(out.refreshed).toBe(0);
  });
});

describe('POST /groups/refresh', () => {
  beforeEach(() => {
    _resetAllBucketsForTests();
  });

  it('writes subjects from groupFetchAllParticipating', async () => {
    const { url, close } = await listen();
    try {
      const resp = await fetch(`${url}/groups/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean; groupsRefreshed: number };
      expect(body.ok).toBe(true);
      expect(body.groupsRefreshed).toBe(1);
      expect(getChat('120363999@g.us')?.name).toBe('Refreshed Subject');
    } finally {
      await close();
    }
  });
});

describe('group subject is visible to read routes', () => {
  beforeEach(() => {
    _resetAllBucketsForTests();
  });

  it('GET /conversations returns the group subject as contactName', async () => {
    setGroupSubject('120363aaa@g.us', 'El conter');
    const { url, close } = await listen();
    try {
      const resp = await fetch(`${url}/conversations?limit=50`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        conversations: Array<{ jid: string; contactName: string; isGroup: boolean }>;
      };
      const hit = body.conversations.find((c) => c.jid === '120363aaa@g.us');
      expect(hit).toBeDefined();
      expect(hit?.contactName).toBe('El conter');
      expect(hit?.isGroup).toBe(true);
    } finally {
      await close();
    }
  });

  it('GET /chats/search finds the group by subject substring', async () => {
    setGroupSubject('120363bbb@g.us', 'Banesco vacantes Caracas');
    const { url, close } = await listen();
    try {
      const resp = await fetch(`${url}/chats/search?q=banesco&limit=20`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        hits: Array<{ jid: string; name: string }>;
      };
      const hit = body.hits.find((h) => h.jid === '120363bbb@g.us');
      expect(hit).toBeDefined();
      expect(hit?.name).toBe('Banesco vacantes Caracas');
    } finally {
      await close();
    }
  });
});
