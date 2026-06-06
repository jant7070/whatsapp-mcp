# Group-name fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `chats.name` for every WhatsApp group on connect so `/conversations` and `/chats/search` return real subjects instead of empty values, plus add a manual `POST /groups/refresh` endpoint.

**Architecture:** All changes live in `bridge/`. Extract a `refreshGroupSubjects(sock)` helper that calls `sock.groupFetchAllParticipating()` and feeds each `{id, subject}` into the existing `setGroupSubject` store function. Call the helper fire-and-forget from the `connection === 'open'` branch, and synchronously from a new admin route.

**Tech Stack:** TypeScript, Baileys (`@whiskeysockets/baileys`), Express, Vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-05-13-group-name-fix-design.md`

---

## File Structure

- **Modify:** `bridge/src/baileys.ts` — add `refreshGroupSubjects` export; call it from the `connection.update` 'open' branch.
- **Modify:** `bridge/src/routes.ts` — add `POST /groups/refresh` route.
- **Create:** `bridge/test/groups.test.ts` — unit test for `refreshGroupSubjects`, integration test for `POST /groups/refresh`, regression test for `/conversations` and `/chats/search` with a seeded group.

No DB schema changes. No changes to `mcp_server/`.

---

### Task 1: Unit-test and extract `refreshGroupSubjects`

The helper takes a Baileys socket, fetches all participating groups, calls `setGroupSubject` for each, and returns `{ refreshed: number }`. Pure function behavior — easy to unit test with a fake sock.

**Files:**
- Create: `bridge/test/groups.test.ts`
- Modify: `bridge/src/baileys.ts`

- [ ] **Step 1: Write the failing unit test**

Create `bridge/test/groups.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb, truncateAll } from '../src/db';
import { getChat } from '../src/store';
import { refreshGroupSubjects } from '../src/baileys';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bridge && npm test -- groups.test.ts`
Expected: FAIL — `refreshGroupSubjects` is not exported from `bridge/src/baileys.ts`.

- [ ] **Step 3: Implement `refreshGroupSubjects` in `bridge/src/baileys.ts`**

Add this export to `bridge/src/baileys.ts`, placed after the `fetchOlderForChat` block (so all socket-facing helpers cluster together):

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bridge && npm test -- groups.test.ts`
Expected: PASS — all three cases green.

- [ ] **Step 5: Run typecheck to confirm no type errors**

Run: `cd bridge && npm run typecheck`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/baileys.ts bridge/test/groups.test.ts
git commit -m "feat(bridge): add refreshGroupSubjects helper

Pulls the subject for every participating group via Baileys and writes
it to the chats table. Baileys does not replay group metadata for
already-existing groups on reconnect, so an explicit fetch is required."
```

---

### Task 2: Call `refreshGroupSubjects` on connect

Wire the helper into `startWhatsApp`'s `connection.update` handler so every connection refresh populates group subjects. No unit test for this glue — it requires a real Baileys socket. Manual verification will cover it.

**Files:**
- Modify: `bridge/src/baileys.ts` (the `connection.update` handler inside `startWhatsApp`)

- [ ] **Step 1: Modify the `connection === 'open'` branch**

In `bridge/src/baileys.ts`, find the `connection.update` listener's `connection === 'open'` branch (currently:

```typescript
} else if (connection === 'open') {
  connectionStatus = 'connected';
  connectionEstablishedAt = Date.now();
  latestQr = null;
  console.log('WhatsApp connection established.');
}
```

).

Replace it with:

```typescript
} else if (connection === 'open') {
  connectionStatus = 'connected';
  connectionEstablishedAt = Date.now();
  latestQr = null;
  console.log('WhatsApp connection established.');
  // Fire-and-forget: pull group subjects for every group we're in. Baileys
  // does not replay group metadata for existing groups, so without this
  // chats.name stays empty and /conversations returns blank names.
  const s = sock;
  if (s) {
    refreshGroupSubjects(s)
      .then((r) => {
        if (r.refreshed > 0) {
          console.log(`Group subjects refreshed: ${r.refreshed}`);
        }
      })
      .catch(() => {
        // refreshGroupSubjects already logs internally.
      });
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd bridge && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Run the full test suite to make sure nothing else broke**

Run: `cd bridge && npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add bridge/src/baileys.ts
git commit -m "feat(bridge): refresh group subjects on connect

Calls refreshGroupSubjects fire-and-forget from the connection.update
'open' branch so chats.name is populated for existing groups every
time the bridge reconnects."
```

---

### Task 3: TDD `POST /groups/refresh`

Admin route that reuses the helper synchronously and returns `{ ok, groupsRefreshed }`. Uses `vi.mock` to stub `getSock` so the test does not need a live socket.

**Files:**
- Modify: `bridge/test/groups.test.ts`
- Modify: `bridge/src/routes.ts`

- [ ] **Step 1: Write the failing route test**

Append this `describe` block to `bridge/test/groups.test.ts`:

```typescript
import http from 'http';
import { AddressInfo } from 'net';
import { vi } from 'vitest';
import { buildApp } from '../src/app';
import { _resetAllBucketsForTests } from '../src/ratelimit';
import { getChat } from '../src/store';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bridge && npm test -- groups.test.ts`
Expected: FAIL — route returns 404 (no such endpoint).

- [ ] **Step 3: Extend the existing `baileys` import in `bridge/src/routes.ts`**

Locate the current import (top of file) and add `refreshGroupSubjects` to the named-imports list, in alphabetical position:

```typescript
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
```

- [ ] **Step 4: Add the route inside `buildRouter()`**

Insert this block immediately after the `POST /logout` block (so admin operations cluster together):

```typescript
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd bridge && npm test -- groups.test.ts`
Expected: PASS — `POST /groups/refresh` test green plus the three helper tests still green.

- [ ] **Step 6: Run typecheck**

Run: `cd bridge && npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add bridge/src/routes.ts bridge/test/groups.test.ts
git commit -m "feat(bridge): POST /groups/refresh admin endpoint

Lets a long-running session re-pull group subjects without a
reconnect. Rate-limited under profile-write:global (5/min) and
audited via writeOk."
```

---

### Task 4: Regression test for `/conversations` and `/chats/search`

Guard test that seeds a group via `setGroupSubject` and confirms both routes return the subject. Already works today (the routes use `resolveChatName`); this prevents future regressions.

**Files:**
- Modify: `bridge/test/groups.test.ts`

- [ ] **Step 1: Add the regression test**

Append this `describe` block to `bridge/test/groups.test.ts` (note: the `vi.mock` from Task 3 already covers `getConnectionStatus`, so the routes will accept requests):

```typescript
import { setGroupSubject } from '../src/store';

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
```

- [ ] **Step 2: Run only the new tests**

Run: `cd bridge && npm test -- groups.test.ts`
Expected: PASS — all describe blocks in `groups.test.ts` green.

- [ ] **Step 3: Run the full test suite**

Run: `cd bridge && npm test`
Expected: every existing test still passes; no regressions.

- [ ] **Step 4: Commit**

```bash
git add bridge/test/groups.test.ts
git commit -m "test(bridge): regression coverage for group-name reads

Seeds a group via setGroupSubject and asserts /conversations exposes
contactName and /chats/search finds it by subject substring. Guards
the existing read path that the on-connect refresh feeds."
```

---

### Task 5: Manual verification on a live connection

Code is green, but the on-connect glue (Task 2) is not unit-tested. Run the bridge against the real account and confirm the gap from the screenshots is closed.

- [ ] **Step 1: Start the bridge**

Run: `cd bridge && npm run dev`
Wait for `WhatsApp connection established.` and then (within ~5s) a log line like `Group subjects refreshed: N` where N is the user's group count.

- [ ] **Step 2: Hit `/conversations`**

Run: `curl -s -H "Authorization: Bearer $BRIDGE_API_KEY" http://127.0.0.1:8080/conversations?limit=20 | jq '.conversations[] | select(.isGroup) | {jid, contactName}'`
Expected: every group JID has a non-empty `contactName` (e.g., `"El conter"`, not blank or a numeric fallback).

- [ ] **Step 3: Hit `/chats/search` for a known group name**

Run: `curl -s -H "Authorization: Bearer $BRIDGE_API_KEY" "http://127.0.0.1:8080/chats/search?q=conter" | jq '.hits'`
Expected: at least one hit whose `name` matches the group subject.

- [ ] **Step 4: Hit `/groups/refresh` and confirm response shape**

Run: `curl -s -X POST -H "Authorization: Bearer $BRIDGE_API_KEY" http://127.0.0.1:8080/groups/refresh | jq`
Expected: `{ "ok": true, "groupsRefreshed": N }` where N matches the connect-time count.

- [ ] **Step 5: If all four checks pass, the work is complete**

No further commit needed; manual verification is for confidence, not artifacts.

---

## Self-Review Notes

- Spec coverage: §Fix.1 (on-connect fetch) → Task 1+2; §Fix.2 (admin route) → Task 3; §Fix.3 (tests) → Tasks 1, 3, 4; §Acceptance → Task 5.
- No placeholders, no "TODO".
- Type consistency: `refreshGroupSubjects(s: Sock): Promise<{ refreshed: number }>` used identically in helper, callers, and tests. Route response uses `groupsRefreshed` (the externally-facing name) which is mapped from the helper's `refreshed` field — distinct names by design (helper is internal, route is API contract).
