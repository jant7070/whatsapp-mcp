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
       │       ▲                           │        (Baileys, QR in terminal)
       │       │                           │
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

Caddy is the only public-facing service. It terminates TLS and proxies:

- the MCP traffic to `whatsapp-mcp-cloud:8000` (default route)
- the bridge admin surface (`/qr`, `/status`, `/conversations`, `/messages`,
  `/send`, `/logout`) at `/bridge/*` — auth-gated by Bearer token + rate
  limit + HTTPS-enforce middleware in the bridge

The bridge container is bound to `127.0.0.1` on the host as well — only
Caddy and the MCP container can reach it.

---

## Security model

| Layer | What protects you |
| --- | --- |
| Network (local) | Both services bind to `127.0.0.1` only. |
| Network (cloud) | Only Caddy is public; bridge and MCP are loopback-only on the host. |
| TLS | Caddy auto-issues Let's Encrypt certs; bridge returns **426 Upgrade Required** if `X-Forwarded-Proto` ≠ `https`. |
| Auth | Bearer token (`BRIDGE_API_KEY`) on **every** route. Refuse to start if missing; refuse to start if shorter than 32 chars in cloud mode. |
| Rate limiting | `POST /send`: 10/min. Everything else: 60/min. Returns **429** with `Retry-After`. |
| Input validation | JID regex `^[0-9]{7,15}(@s\.whatsapp\.net|@g\.us)?$`. Messages capped at 4096 chars; control bytes stripped. Pydantic enforces the same rules at the MCP layer. |
| Logging | `{ts, method, path, status, ms, ip}` only. **Never** logs message bodies, JIDs, QR data, or auth tokens. |
| Session file | `bridge/auth_info/` is gitignored; bridge warns at startup if it's group/world-readable on POSIX hosts. |
| Bridge admin surface | Reachable only at `/bridge/*` behind Caddy TLS + Bearer + rate limit. |

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
| `whatsapp_get_status` | yes | Bridge connection state, cache size, and mode. |
| `whatsapp_get_qr` | yes | Returns the pairing QR data (cloud mode). |
| `whatsapp_list_conversations` | yes | Recent chats with last-message preview. |
| `whatsapp_get_messages` | yes | Paginated, optionally filtered by JID/keyword. |
| `whatsapp_send_message` | no | Sends a text. JID + message are validated and sanitized. |
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
