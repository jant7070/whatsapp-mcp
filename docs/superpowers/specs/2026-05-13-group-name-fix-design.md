# Group-name fix for the WhatsApp bridge

**Date:** 2026-05-13
**Status:** Approved for planning
**Scope:** `bridge/` only

## Problem

A consuming MCP session shows group chats with no name in `GET /conversations`
and cannot find them via `GET /chats/search`. Example: the user has a group
titled "El conter" in WhatsApp, but the bridge returns an empty `contactName`
for its JID and search for `"counter"` finds nothing.

## Root cause

The bridge already has the right ingestion points:

- `setGroupSubject(jid, subject)` upserts the `chats.name` column.
- Listeners on `groups.upsert` and `groups.update` (`bridge/src/baileys.ts`)
  call `setGroupSubject` when Baileys emits them.

Baileys only emits those events for groups that are *created* or have a
*subject change* during the active session. For groups that already existed
when the linked device was paired, no event ever fires, so `chats.name`
stays empty.

Downstream effects:

- `resolveChatName` falls back to `formatPhoneFallback(jid)`, which renders
  the group-JID's long numeric prefix as `+<digits>` — useless as a label,
  and consumers like the upstream Claude session render it as `None`.
- `searchChatsByName` filters out empty-name chats, so the group is
  invisible to search.

## Fix

Pull group metadata explicitly on connect, and provide a manual refresh
endpoint for already-running sessions.

### 1. Eager fetch on connect

In `bridge/src/baileys.ts`, inside the `connection === 'open'` branch of
the `connection.update` handler, fire-and-forget a call to
`sock.groupFetchAllParticipating()`. For each `{ id, subject }` in the
returned map, call the existing `setGroupSubject(id, subject)`.

- Run async, do not block connection completion.
- Wrap in `try/catch`; on failure, log and move on. `groups.update` will
  still catch subsequent subject changes.
- No retry loop — reconnects will re-trigger this path naturally.

### 2. Admin refresh route

Add `POST /groups/refresh` to `bridge/src/routes.ts`:

- Requires connection (`ensureConnected`).
- Rate-limited under the existing `profile-write:global` bucket (5/min).
- Calls the same fetch + setGroupSubject loop synchronously.
- Returns `{ ok: true, groupsRefreshed: <count> }`.
- Audited via `recordAudit` like other write-style admin ops.

This covers the case where a session is already running and a subject
needs re-pulling without a reconnect (e.g., a newly-joined group that
slipped past `groups.upsert` because of timing).

### 3. Tests

Add `bridge/test/groups.refresh.test.ts`:

- Seed a group via `setGroupSubject('120363xxx@g.us', 'El conter')`.
- Hit `GET /conversations` and assert `contactName === 'El conter'` for
  that JID.
- Hit `GET /chats/search?q=conter` and assert at least one hit whose
  `name === 'El conter'`.
- Mock the Baileys socket so `POST /groups/refresh` writes a different
  subject and assert it's reflected in a subsequent `GET /conversations`.

The first two assertions guard the wiring that already exists but is
currently broken because nothing populates the `chats.name` column. The
third asserts the new refresh route.

## Out of scope

- Changing `formatPhoneFallback` for group JIDs. Once subjects are
  populated, this fallback rarely runs; if it does, the JID-derived
  string is a fine debug indicator.
- Caching group participants, descriptions, or avatars — only `subject`
  is needed to fix the reported gap.
- Touching the MCP server (`mcp_server/`) — the bridge change is
  sufficient; the upstream tool already returns whatever
  `contactName` the bridge gives it.

## Acceptance

- `GET /conversations` returns the real group subject for every group
  the user is in within ~5s of a fresh connection.
- `GET /chats/search?q=<substring>` finds groups by their subject.
- `POST /groups/refresh` re-pulls subjects without reconnecting.
- New tests pass; existing tests untouched and still pass.
