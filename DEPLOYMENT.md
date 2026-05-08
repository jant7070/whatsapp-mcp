# Cloud Deployment Guide

This guide walks through deploying `whatsapp-mcp` to a VPS with automatic
HTTPS via Caddy. It assumes a fresh Ubuntu 22.04+ host.

> **Personal use only.** WhatsApp's Terms of Service forbid bulk messaging
> and unauthorized automation. Linking this bridge to your number is at
> your own risk; keep usage to the same volume and patterns as your normal
> human use of WhatsApp.

---

## 1. Provision a VPS

Any provider works (DigitalOcean, Hetzner, Linode, Scaleway, OVH, …). The
service is light — 1 vCPU / 1 GB RAM / 10 GB disk is plenty.

- OS: Ubuntu 22.04 LTS or newer.
- Open firewall ports **22**, **80**, and **443**. Nothing else.
- Use SSH keys, not passwords.

## 2. Point a domain at the VPS

Create a DNS **A record** for the subdomain you want (`mcp.yourdomain.com`)
pointing to the VPS public IP. Wait for DNS to propagate (`dig` or
`nslookup` should return the new IP from a fresh resolver).

Caddy will use this hostname to obtain a Let's Encrypt certificate
automatically — DNS must resolve **before** you start the cloud profile.

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker version
docker compose version
```

## 4. Copy the project files to the VPS

Either clone the repository or copy via `scp`/`rsync`:

```bash
git clone <your-repo-url> whatsapp-mcp
cd whatsapp-mcp
```

## 5. Configure `.env`

```bash
cp .env.example .env
nano .env
```

Set the following:

```
DEPLOYMENT_MODE=cloud
DOMAIN=mcp.yourdomain.com
BRIDGE_API_KEY=<paste output of: openssl rand -hex 32>
BRIDGE_PORT=3001
MCP_PORT=8000
```

> The bridge **refuses to start** if `BRIDGE_API_KEY` is missing or
> shorter than 32 characters in cloud mode.

Lock down the file:

```bash
chmod 600 .env
```

## 6. Start the cloud profile

```bash
docker compose --profile cloud up -d
docker compose ps
```

Caddy will request a Let's Encrypt certificate the first time the domain
resolves. Watch logs until the bridge is healthy:

```bash
docker compose logs -f
```

## 7. Fetch the pairing QR

The bridge admin surface is exposed at `/bridge/*` behind Caddy TLS and
the Bearer token.

```bash
curl -H "Authorization: Bearer <your-key>" https://mcp.yourdomain.com/bridge/qr
```

The response is `{"qr": "<long-string>"}`. The `qr` value is the data the
WhatsApp app needs to scan.

## 8. Render the QR locally to scan it

The QR string is too long to paste into the terminal. Render it on **your
laptop** (not the VPS) so your phone can scan it from your screen:

```bash
pip install "qrcode[pil]"
python3 -c "import qrcode,sys; qrcode.make(sys.argv[1]).show()" "<qr_data>"
```

## 9. Link the device

On your phone, in WhatsApp:

1. Go to **Settings → Linked Devices → Link a Device**.
2. Point your phone at the rendered QR.

## 10. Verify the connection

```bash
curl -H "Authorization: Bearer <your-key>" https://mcp.yourdomain.com/bridge/status
```

Expect `{"status":"connected", "hasQr":false, "cachedMessages":N, "deploymentMode":"cloud"}`.

## 11. Connect Claude / n8n / your MCP client

The MCP endpoint is the **default route** at the domain (no `/bridge`
prefix). Most MCP clients use the streamable-HTTP transport at `/mcp`:

- MCP server URL: `https://mcp.yourdomain.com/mcp`
- Bearer header: `Authorization: Bearer <your-key>`

The MCP server forwards the same `BRIDGE_API_KEY` to the bridge — the
client only sees one secret.

---

## Security Checklist

Tick **every** box before considering the deployment "live":

- [ ] `BRIDGE_API_KEY` is at least 32 characters and was generated with `openssl rand -hex 32`.
- [ ] `.env` permissions are `600` (`stat -c %a .env` returns `600`).
- [ ] `bridge/auth_info/` permissions are `700` after the first run (`chmod -R 700 bridge/auth_info`).
- [ ] `docker compose ps` shows **no port mapping** for `whatsapp-mcp-cloud` (Caddy proxies it).
- [ ] `docker compose ps` shows the bridge bound to `127.0.0.1:3001` only — never `0.0.0.0:3001`.
- [ ] VPS firewall blocks every port except 22, 80, 443.
- [ ] HTTPS works: `curl https://mcp.yourdomain.com/bridge/status` (with Bearer) returns 200.
- [ ] Without the Bearer token, every endpoint returns 401.
- [ ] `.env`, `auth_info/`, `*.key`, and `*.pem` are all listed in `.gitignore` (verify with `git check-ignore`).
- [ ] Project repo is private if you store it on a remote.

---

## Operations

### Rotating the API key

1. Generate a new key: `openssl rand -hex 32`.
2. Edit `.env`, replace `BRIDGE_API_KEY`.
3. Restart: `docker compose --profile cloud restart`.
4. Update every MCP client and any saved `curl` commands.

### Viewing logs

```bash
docker compose logs -f whatsapp-bridge
docker compose logs -f whatsapp-mcp-cloud
docker compose logs -f caddy
```

The bridge logs `{ts, method, path, status, ms, ip}` only — it never logs
message bodies, JIDs, QR payloads, or Bearer tokens.

### Backing up the linked-device session

The Baileys session lives in `bridge/auth_info/`. Without it the bridge
must re-pair via QR. Back it up like any other secret:

```bash
sudo tar -C bridge -czf auth_info-backup.tar.gz auth_info
chmod 600 auth_info-backup.tar.gz
# Move off the VPS to encrypted storage.
```

### Stopping / removing

```bash
docker compose --profile cloud down            # stop containers, keep data
docker compose --profile cloud down --volumes  # also wipe Caddy certs
```
