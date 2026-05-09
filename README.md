# whatsapp-mcp

A personal-use WhatsApp MCP server. Lets a single user expose their own
WhatsApp number to AI agents (Claude, n8n, etc.) over the
[MCP protocol](https://modelcontextprotocol.io) via a
[Baileys](https://github.com/WhiskeySockets/Baileys) → REST bridge → MCP
server pipeline.

> **Personal use only.** This is not a multi-tenant service and is not
> intended for bulk messaging, marketing automation, or anything WhatsApp
> would consider abusive. WhatsApp's Terms of Service forbid mass /
> automated messaging that violates their policies; using this in that way
> can get your number banned. **You are responsible for how you use it.**

---

## Architecture

Two services, one shared secret (`BRIDGE_API_KEY`).

### Local mode (default)

```
       ┌───────────────────────────────────┐
       │ Your machine                      │
       │                                   │
       │  127.0.0.1:8000 ─── MCP server ───┼──► 127.0.0.1:3001 ── Bridge ──► WhatsApp
       │       ▲                           │        (Baileys, QR in terminal,
       │       │                           │         SQLite + media cache on disk)
       │   MCP client                      │
       │  (Claude, n8n)                    │
       └───────────────────────────────────┘
```

Everything binds to `127.0.0.1` only. Nothing is reachable from the
network. The QR pairing code is rendered directly in the bridge's terminal.

### Cloud mode

```
              443
   internet ────► Caddy ──► /            ── whatsapp-mcp-cloud:8000  (MCP)
                            /bridge/*    ── whatsapp-bridge:3001     (Bridge admin)
                                                       │
                                                       ▼
                                                   WhatsApp
```

Caddy is the only public-facing service. `/metrics`, `/audit`, and
`/media/file/*` are intentionally not routed publicly — they remain
internal-only.

---

## Storage & media

The bridge persists state to **SQLite** at `${STORE_DB_PATH:-/data/store.db}`
(WAL mode, FTS5 index for full-text search). Volumes mounted on the
container:

- `store_db` → `/data` (the SQLite DB).
- `media_cache` → `/data/media` (lazily-downloaded media files).

Schema (top-level tables): `chats`, `contacts`, `messages` + `messages_fts`,
`media_refs`, `message_extras`, `idempotency_keys`, `audit_log`.

Retention:
- `messages` keeps everything by default (text is cheap).
- `media_refs.cached_path` is evicted by LRU when the cache exceeds
  `MEDIA_CACHE_MAX_MB` (default 2 048) or when older than
  `MEDIA_CACHE_TTL_DAYS` (default 7).
- `idempotency_keys` are pruned after `IDEMPOTENCY_TTL_HOURS` (default 24).

A bridge restart **no longer drops state**.

---

## Security model

| Layer | What protects you |
| --- | --- |
| Network (local) | Both services bind `0.0.0.0` inside their containers; Docker's `127.0.0.1:NNNN:NNNN` port mapping in `docker-compose.yml` restricts host-side access to localhost only. |
| Network (cloud) | Only Caddy is public; bridge and MCP are loopback-only on the host. `/metrics`, `/audit`, `/media/file/*` are never exposed. |
| TLS | Caddy auto-issues Let's Encrypt certs; bridge returns **426 Upgrade Required** if `X-Forwarded-Proto` ≠ `https`. |
| Auth | Bearer token (`BRIDGE_API_KEY`) on **every** route. Refuse to start if missing; refuse to start if shorter than 32 chars in cloud mode. |
| Rate limiting | Per-tool / per-target token-bucket (sends 20/min/JID + 60/min global, reads 120/min, profile-write/logout 5/min). Returns **429** with `Retry-After`. |
| Idempotency | Every write tool accepts `idempotency_key`; replays return cached body with `Idempotency-Replayed: true`. Keys expire after 24 h. |
| Outbound URL fetch | SSRF guard rejects loopback / RFC 1918 / link-local / ULA / EC2 metadata; size capped by `MEDIA_MAX_OUTBOUND_MB`. |
| Audit log | Every write recorded with phone numbers redacted and message bodies / base64 / vCards reduced to length markers. |
| Input validation | JID `^[0-9]{7,15}(@s\.whatsapp\.net|@g\.us)?$`; messages 1-4096 chars; control bytes stripped; emoji 0-16 chars; lat/lon range-checked; poll 2-12 options. |
| Logging | `{ts, method, path, status, ms, ip}` only. **Never** logs message bodies, JIDs, QR data, or auth tokens. |
| Session file | `bridge/auth_info/` is gitignored; bridge warns at startup if it's group/world-readable on POSIX hosts. |

---

## Quick start — local mode

Requires Docker Desktop (Windows/macOS) or Docker Engine + Compose plugin
(Linux).

```bash
cp .env.example .env
# Generate the shared secret:
openssl rand -hex 32   # paste into BRIDGE_API_KEY in .env
```

`.env` minimum:

```
DEPLOYMENT_MODE=local
BRIDGE_API_KEY=<32+ char hex>
```

Start it:

```bash
docker compose --profile local up -d
docker compose logs -f whatsapp-bridge   # the QR will print here on first run
```

Scan the QR in the bridge logs with **WhatsApp → Settings → Linked
Devices → Link a Device**. Then:

```bash
curl -H "Authorization: Bearer <your-key>" http://127.0.0.1:3001/status
```

Connect your MCP client to `http://127.0.0.1:8000/mcp`.

## Quick start — cloud mode

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full VPS walkthrough.

---

## MCP tools

| Tool | Read-only? | Purpose |
| --- | --- | --- |
| `whatsapp_get_status` | yes | Connection state, store size, media cache size, error rate, uptime. |
| `whatsapp_get_qr` | yes | Returns the pairing QR data. |
| `whatsapp_list_conversations` | yes | Recent chats from the bridge's chat directory, newest first. |
| `whatsapp_search_contacts` | yes | Substring search over saved contacts, pushNames, group subjects. |
| `whatsapp_get_messages` | yes | Last N messages of one chat. Surfaces media metadata, reply / edit / delete state, and structured location/contact/poll extras. |
| `whatsapp_search_messages` | yes | FTS5 full-text search ranked by bm25, with optional jid/kind/since/until filters. |
| `whatsapp_fetch_older` | yes | On-demand backfill from WhatsApp's server. Best-effort. |
| `whatsapp_download_media` | yes | Lazy-download media bytes. Returns base64 inline (≤ `MEDIA_INLINE_RESPONSE_MB`) or a 5-min signed URL. |
| `whatsapp_get_my_profile` | yes | Own JID, display name, status, avatar URL. |
| `whatsapp_get_contact_profile` | yes | Public profile for a JID (push name, avatar URL, presence). |
| `whatsapp_get_audit_log` | yes | Read every write tool invocation, PII-redacted. |
| `whatsapp_send_message` | no, idempotent | Send text. Ambiguous names return candidates. |
| `whatsapp_send_media` | no, idempotent | Send image/document/video/audio/voice via base64 or HTTPS URL. |
| `whatsapp_send_location` | no, idempotent | Send a static location pin. |
| `whatsapp_send_contact` | no, idempotent | Send a vCard built from `{name, phone}`. |
| `whatsapp_send_poll` | no, idempotent | Send a poll with 2-12 options. |
| `whatsapp_reply` | no, idempotent | Reply to a previously-received message in-thread. |
| `whatsapp_react` | no, **destructive** | Add or remove a reaction (empty emoji removes). |
| `whatsapp_edit_message` | no, **destructive** | Edit one of your own messages within the 15-min window. |
| `whatsapp_delete_message` | no, **destructive** | Delete `me`-side or `everyone`-side. |
| `whatsapp_mark_read` | no | Mark all messages in a chat read up to the latest. |
| `whatsapp_update_my_profile` | no, **destructive** | Update display name / status / avatar. |
| `whatsapp_logout` | no, **destructive** | Logs out and deletes `auth_info/`; requires re-pairing. |

---

## Environment variables

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `DEPLOYMENT_MODE` | yes | `local` | `local` or `cloud`. |
| `BRIDGE_API_KEY` | yes | — | Shared secret. ≥32 chars in cloud mode. Generate with `openssl rand -hex 32`. |
| `DOMAIN` | cloud only | — | Hostname Caddy serves on (e.g. `mcp.example.com`). |
| `BRIDGE_PORT` | no | `3001` | Bridge listens here. |
| `MCP_PORT` | no | `8000` | MCP server listens here. |
| `BRIDGE_URL` | no | `http://whatsapp-bridge:3001` | MCP → bridge URL inside the compose network. |
| `STORE_DB_PATH` | no | `/data/store.db` | SQLite database path inside the bridge container. |
| `MEDIA_CACHE_DIR` | no | `/data/media` | On-disk media cache. |
| `MEDIA_MAX_INBOUND_MB` | no | `16` | Reject inbound media larger than this on download. |
| `MEDIA_MAX_OUTBOUND_MB` | no | `100` | Cap outbound `/send/media` payloads. |
| `MEDIA_CACHE_MAX_MB` | no | `2048` | Cache eviction trigger. |
| `MEDIA_CACHE_TTL_DAYS` | no | `7` | Files older than this get purged on the next sweep. |
| `MEDIA_INLINE_RESPONSE_MB` | no | `4` | Response shape switch — larger goes via signed URL. |
| `IDEMPOTENCY_TTL_HOURS` | no | `24` | How long an idempotency key is replay-eligible. |

---

## What NOT to do

- **Do not** use this for mass messaging, broadcast outreach, marketing,
  or any behavior that would get a normal human number banned.
- **Do not** expose ports `3001` or `8000` to the public internet. Only
  Caddy on `80`/`443` should ever be reachable.
- **Do not** commit `.env`, `bridge/auth_info/`, `*.key`, or `*.pem` to
  any repository. The included `.gitignore` excludes all of these.
- **Do not** share your `BRIDGE_API_KEY`. Anyone with it can read your
  WhatsApp, send as you, and log you out.
- **Do not** run the bridge without TLS in cloud mode. The HTTPS-enforce
  middleware will refuse plain-HTTP requests, but you should never put
  yourself in that position to begin with.
