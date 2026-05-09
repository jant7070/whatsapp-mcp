"""WhatsApp MCP server.

Wraps the Baileys REST bridge as MCP tools. Single-user, personal-use only.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Configuration / startup checks
# ---------------------------------------------------------------------------
DEPLOYMENT_MODE = os.getenv("DEPLOYMENT_MODE", "local")
BRIDGE_API_KEY = os.getenv("BRIDGE_API_KEY")
BRIDGE_URL = os.getenv("BRIDGE_URL", "http://whatsapp-bridge:3001")
BIND_HOST = "0.0.0.0"
MCP_PORT = int(os.getenv("MCP_PORT", "8000"))

if not BRIDGE_API_KEY:
    raise RuntimeError(
        "BRIDGE_API_KEY is not set. Generate one with `openssl rand -hex 32` and put it in .env."
    )

if DEPLOYMENT_MODE == "cloud" and len(BRIDGE_API_KEY) < 32:
    raise RuntimeError(
        "BRIDGE_API_KEY must be at least 32 characters in cloud mode. "
        "Generate one with `openssl rand -hex 32`."
    )

# ---------------------------------------------------------------------------
# Pydantic input models
# ---------------------------------------------------------------------------
class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SendMessageInput(_Base):
    target: str = Field(
        ..., min_length=1, max_length=200,
        description=(
            "Recipient — accepts a contact/chat name, a phone number with country code, "
            "or a full JID (e.g. '5804120001234@s.whatsapp.net' or '<id>@g.us'). "
            "Ambiguous names return candidates instead of sending."
        ),
    )
    message: str = Field(..., min_length=1, max_length=4096, description="Text message to send.")
    idempotency_key: Optional[str] = Field(
        default=None, max_length=128,
        description="Optional 1-128 char printable-ASCII key. Replay returns the cached response.",
    )


class SendMediaInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    kind: str = Field(..., description="image | document | video | audio | voice")
    source_base64: Optional[str] = Field(default=None, description="Base64 payload (alternative to source_url).")
    source_url: Optional[str] = Field(default=None, description="HTTPS URL to fetch (alternative to source_base64).")
    file_name: Optional[str] = Field(default=None, max_length=255)
    mime_type: Optional[str] = Field(default=None, max_length=128)
    caption: Optional[str] = Field(default=None, max_length=1024)
    voice: Optional[bool] = Field(default=False, description="Set true to send as a push-to-talk voice note.")
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class DownloadMediaInput(_Base):
    chat_jid: str = Field(..., min_length=1, max_length=200)
    message_id: str = Field(..., min_length=1, max_length=200)


class SendLocationInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    name: Optional[str] = Field(default=None, max_length=128)
    address: Optional[str] = Field(default=None, max_length=256)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class SendContactInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    name: str = Field(..., min_length=1, max_length=128)
    phone: str = Field(..., min_length=7, max_length=20)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class SendPollInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    name: str = Field(..., min_length=1, max_length=256)
    options: list[str] = Field(..., min_length=2, max_length=12)
    selectable_count: int = Field(default=1, ge=1, le=12)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class ReplyInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=4096)
    quoted_message_id: str = Field(..., min_length=1, max_length=200)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class ReactInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    message_id: str = Field(..., min_length=1, max_length=200)
    emoji: str = Field(..., max_length=32, description="Empty string removes the reaction.")
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class EditMessageInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    message_id: str = Field(..., min_length=1, max_length=200)
    new_text: str = Field(..., min_length=1, max_length=4096)
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class DeleteMessageInput(_Base):
    target: str = Field(..., min_length=1, max_length=200)
    message_id: str = Field(..., min_length=1, max_length=200)
    scope: str = Field(..., description="me | everyone")
    idempotency_key: Optional[str] = Field(default=None, max_length=128)


class MarkReadInput(_Base):
    jid: str = Field(..., min_length=1, max_length=200)


class SearchMessagesInput(_Base):
    query: str = Field(..., min_length=1, max_length=200)
    jid: Optional[str] = Field(default=None, max_length=200)
    kind: Optional[str] = Field(default=None, max_length=32)
    since: Optional[int] = Field(default=None, ge=0)
    until: Optional[int] = Field(default=None, ge=0)
    limit: int = Field(default=50, ge=1, le=200)


class UpdateMyProfileInput(_Base):
    name: Optional[str] = Field(default=None, min_length=1, max_length=25)
    status: Optional[str] = Field(default=None, max_length=139)
    avatar_base64: Optional[str] = Field(default=None)


class GetContactProfileInput(_Base):
    jid: str = Field(..., min_length=1, max_length=200)


class AuditQueryInput(_Base):
    tool: Optional[str] = Field(default=None, max_length=64)
    since: Optional[int] = Field(default=None, ge=0)
    limit: int = Field(default=100, ge=1, le=500)


class GetMessagesInput(_Base):
    jid: str = Field(..., min_length=1, max_length=200)
    limit: int = Field(default=50, ge=1, le=200)
    before_timestamp: Optional[int] = Field(default=None, ge=0)


class FetchOlderInput(_Base):
    jid: str = Field(..., min_length=1, max_length=200)
    count: int = Field(default=50, ge=1, le=200)


class SearchContactsInput(_Base):
    query: str = Field(..., min_length=1, max_length=100)
    limit: int = Field(default=20, ge=1, le=50)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {BRIDGE_API_KEY}"}


async def _bridge_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{BRIDGE_URL}{path}", params=params, headers=_auth_headers())
        resp.raise_for_status()
        return resp.json()


async def _bridge_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{BRIDGE_URL}{path}", json=body, headers=_auth_headers())
        resp.raise_for_status()
        return resp.json()


async def _bridge_patch(path: str, body: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.patch(f"{BRIDGE_URL}{path}", json=body, headers=_auth_headers())
        resp.raise_for_status()
        return resp.json()


def _handle_bridge_error(e: Exception) -> str:
    if isinstance(e, httpx.ConnectError):
        return f"Error: Cannot connect to bridge at {BRIDGE_URL}. Is it running?"
    if isinstance(e, httpx.HTTPStatusError):
        if e.response.status_code == 401:
            return "Error: Unauthorized. Check that BRIDGE_API_KEY matches on both services."
        if e.response.status_code == 426:
            return "Error: HTTPS required. The bridge is in cloud mode — use HTTPS."
        if e.response.status_code == 429:
            retry_after = e.response.headers.get("Retry-After", "?")
            return f"Error: Rate limit exceeded. Retry after {retry_after}s."
        try:
            detail = e.response.json().get("error", e.response.text)
        except Exception:
            detail = e.response.text
        return f"Error ({e.response.status_code}): {detail}"
    if isinstance(e, httpx.TimeoutException):
        return "Error: Bridge request timed out."
    return f"Error: {type(e).__name__}: {str(e)}"


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------
mcp = FastMCP("whatsapp-mcp", host=BIND_HOST, port=MCP_PORT)


# ---- Read-only tools ---------------------------------------------------------
@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_status() -> str:
    """Connection state, message count, media-cache size, error rate, uptime."""
    try:
        data = await _bridge_get("/status")
    except Exception as e:
        return _handle_bridge_error(e)

    status = data.get("status", "unknown")
    has_qr = data.get("hasQr", False)
    cached = data.get("cachedMessages", 0)
    chats = data.get("knownChats", 0)
    contacts = data.get("knownContacts", 0)
    mode = data.get("deploymentMode", "unknown")
    media_bytes = data.get("mediaCacheBytes", 0)
    errors = data.get("errorsLastHour", 0)
    uptime = data.get("connectionUptimeSec", 0)
    last_msg = data.get("lastMessageAt", 0)

    if status == "connected":
        human = (
            f"Connected ({uptime}s uptime). {chats} chats / {contacts} contacts, "
            f"{cached} messages stored. Media cache: {media_bytes} bytes. "
            f"Errors last 1h: {errors}. last_message_at={last_msg}. ({mode} mode)"
        )
    elif has_qr:
        human = f"Not linked yet — QR available. Call whatsapp_get_qr. ({mode} mode)"
    else:
        human = f"Bridge is {status}, no QR available yet. ({mode} mode)"

    return human + f"\n\nraw={data}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_qr() -> str:
    """Fetch the current pairing QR code so the operator can link a phone."""
    try:
        data = await _bridge_get("/qr")
    except Exception as e:
        return _handle_bridge_error(e)
    qr = data.get("qr")
    if not qr:
        return "No QR available — likely already linked. Call whatsapp_get_status to confirm."
    return (
        "1. Open WhatsApp on your phone.\n"
        "2. Tap Settings → Linked Devices → Link a Device.\n"
        "3. Scan the QR data below.\n\n"
        f"QR data:\n{qr}"
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_list_conversations(limit: int = 50) -> str:
    """List recent WhatsApp conversations, newest-first."""
    limit = max(1, min(int(limit), 200))
    try:
        data = await _bridge_get("/conversations", params={"limit": limit})
    except Exception as e:
        return _handle_bridge_error(e)
    conversations = data.get("conversations", [])
    if not conversations:
        return "No conversations known yet."
    lines = [f"{len(conversations)} conversation(s):", ""]
    for c in conversations:
        kind = "group" if c.get("isGroup") else "chat"
        name = c.get("contactName") or "(no name)"
        lines.append(
            f"- jid={c.get('jid')} [{kind}] {name} @ {c.get('lastTimestamp')}: "
            f"{(c.get('lastMessage', '') or '')[:120]}"
        )
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_search_contacts(input: SearchContactsInput) -> str:
    """Search known chats and contacts by name (case-insensitive substring)."""
    try:
        data = await _bridge_get("/chats/search", params={"q": input.query, "limit": input.limit})
    except Exception as e:
        return _handle_bridge_error(e)
    hits = data.get("hits", [])
    if not hits:
        return f"No matches for '{input.query}'."
    lines = [f"{len(hits)} match(es) for '{input.query}':", ""]
    for h in hits:
        kind = "group" if h.get("isGroup") else "chat"
        lines.append(f"- jid={h.get('jid')} [{kind}] {h.get('name')} @ {h.get('lastTimestamp')}")
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_messages(input: GetMessagesInput) -> str:
    """Retrieve recent messages for one chat, newest-first.

    Includes media metadata, reply/edit/delete state, and structured extras
    (location/contact/poll) when present. Use whatsapp_download_media to
    pull media bytes lazily.
    """
    params: dict[str, Any] = {"jid": input.jid, "limit": input.limit}
    if input.before_timestamp is not None:
        params["before_timestamp"] = input.before_timestamp
    try:
        data = await _bridge_get("/messages", params=params)
    except Exception as e:
        return _handle_bridge_error(e)
    messages = data.get("messages", [])
    total = data.get("total", 0)
    has_more = data.get("hasMore", False)
    chat_name = data.get("chatName") or input.jid
    if not messages:
        return f"No messages cached for {chat_name} ({input.jid}). Try whatsapp_fetch_older."
    lines = [
        f"{chat_name} ({input.jid}) — showing {len(messages)} of {total} (hasMore={has_more}):",
        "",
    ]
    for m in messages:
        direction = "→" if m.get("isFromMe") else "←"
        sender = m.get("senderName") or m.get("sender") or "?"
        prefix = f"[{m.get('timestamp')}] {direction} {sender}: "
        body = (m.get("body", "") or "")[:200]
        decor = []
        if m.get("media"):
            mm = m["media"]
            decor.append(f"<media kind={mm.get('kind')} mime={mm.get('mimeType')} cached={mm.get('cached')} id={m.get('id')}>")
        if m.get("extras"):
            decor.append(f"<extras kind={m['extras'].get('kind')}>")
        if m.get("replyToId"):
            decor.append(f"<reply_to={m['replyToId']}>")
        if m.get("editedAt"):
            decor.append("<edited>")
        if m.get("deletedAt"):
            decor.append("<deleted>")
        lines.append(prefix + body + (" " + " ".join(decor) if decor else ""))
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_fetch_older(input: FetchOlderInput) -> str:
    """Backfill older messages of a chat from WhatsApp (best-effort)."""
    params: dict[str, Any] = {"jid": input.jid, "count": input.count}
    try:
        data = await _bridge_get("/messages/fetch_older", params=params)
    except Exception as e:
        return _handle_bridge_error(e)
    requested = data.get("requested", input.count)
    added = data.get("added", 0)
    total = data.get("total", 0)
    if added == 0:
        return f"Requested {requested} older for {input.jid}; WhatsApp returned none. Total cached: {total}."
    return f"Backfilled {added}/{requested} older for {input.jid}. Total cached: {total}."


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_search_messages(input: SearchMessagesInput) -> str:
    """Full-text search across stored messages (FTS5, ranked by bm25)."""
    params: dict[str, Any] = {"q": input.query, "limit": input.limit}
    if input.jid:
        params["jid"] = input.jid
    if input.kind:
        params["kind"] = input.kind
    if input.since is not None:
        params["since"] = input.since
    if input.until is not None:
        params["until"] = input.until
    try:
        data = await _bridge_get("/messages/search", params=params)
    except Exception as e:
        return _handle_bridge_error(e)
    hits = data.get("hits", [])
    if not hits:
        return f"No matches for '{input.query}'."
    lines = [f"{len(hits)} hit(s) for '{input.query}':", ""]
    for h in hits:
        sender = h.get("senderName") or h.get("sender") or "?"
        body = (h.get("body", "") or "")[:200]
        lines.append(
            f"- [{h.get('timestamp')}] chat={h.get('chatJid')} id={h.get('id')} from={sender}: {body}"
        )
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_my_profile() -> str:
    """Own JID, display name, status, and avatar URL."""
    try:
        data = await _bridge_get("/profile/me")
    except Exception as e:
        return _handle_bridge_error(e)
    return (
        f"jid={data.get('jid')}\n"
        f"name={data.get('name')}\n"
        f"status={data.get('status')}\n"
        f"avatarUrl={data.get('avatarUrl')}"
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_contact_profile(input: GetContactProfileInput) -> str:
    """Public profile for a JID (push name, avatar URL, presence)."""
    try:
        data = await _bridge_get(f"/profile/{input.jid}")
    except Exception as e:
        return _handle_bridge_error(e)
    return (
        f"jid={data.get('jid')}\n"
        f"pushName={data.get('pushName')}\n"
        f"avatarUrl={data.get('avatarUrl')}\n"
        f"presence={data.get('presence')}"
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_audit_log(input: AuditQueryInput) -> str:
    """Read the audit log of every write tool's invocation. PII-redacted."""
    params: dict[str, Any] = {"limit": input.limit}
    if input.tool:
        params["tool"] = input.tool
    if input.since is not None:
        params["since"] = input.since
    try:
        data = await _bridge_get("/audit", params=params)
    except Exception as e:
        return _handle_bridge_error(e)
    items = data.get("items", [])
    if not items:
        return "Audit log is empty for this query."
    lines = [f"{len(items)} entrie(s):", ""]
    for it in items:
        lines.append(
            f"- [{it.get('timestamp')}] {it.get('tool')} ok={it.get('ok')} "
            f"target={it.get('targetJid')} err={it.get('errorCode')} "
            f"summary={it.get('resultSummary')}"
        )
    return "\n".join(lines)


# ---- Write tools -------------------------------------------------------------
def _idem(body: dict[str, Any], key: Optional[str]) -> dict[str, Any]:
    if key:
        body["idempotency_key"] = key
    return body


def _format_send_response(data: dict[str, Any], default_label: str = "Sent") -> str:
    if not data.get("ok"):
        return f"{default_label} returned: {data}"
    parts = [f"{default_label}."]
    if data.get("id"):
        parts.append(f"id={data['id']}")
    if data.get("jid"):
        parts.append(f"jid={data['jid']}")
    if data.get("chatName"):
        parts.append(f"chatName={data['chatName']}")
    return " ".join(parts)


def _ambiguity_message(target: str, payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates", [])
    lines = [
        f"Did not send. '{target}' matched {len(candidates)} chats — pick one and call again with its JID:",
        "",
    ]
    for c in candidates:
        kind = "group" if c.get("isGroup") else "chat"
        lines.append(f"- jid={c.get('jid')} [{kind}] {c.get('name')} @ {c.get('lastTimestamp')}")
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_send_message(input: SendMessageInput) -> str:
    """Send a text WhatsApp message."""
    body = _idem({"target": input.target, "message": input.message}, input.idempotency_key)
    try:
        data = await _bridge_post("/send", body)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 409:
            try:
                return _ambiguity_message(input.target, e.response.json())
            except Exception:
                return _handle_bridge_error(e)
        return _handle_bridge_error(e)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_send_media(input: SendMediaInput) -> str:
    """Send media (image, document, video, audio, voice). Provide either source_base64 or source_url."""
    if not input.source_base64 and not input.source_url:
        return "Error: must provide source_base64 or source_url."
    if input.source_base64 and input.source_url:
        return "Error: provide only one of source_base64 or source_url."
    kind = "voice" if input.voice else input.kind
    source: dict[str, Any] = {"type": "base64" if input.source_base64 else "url"}
    if input.source_base64:
        source["data"] = input.source_base64
    if input.source_url:
        source["url"] = input.source_url
    if input.file_name:
        source["fileName"] = input.file_name
    if input.mime_type:
        source["mimeType"] = input.mime_type
    if input.caption:
        source["caption"] = input.caption
    body = _idem({"target": input.target, "kind": kind, "source": source}, input.idempotency_key)
    try:
        data = await _bridge_post("/send/media", body)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 409:
            try:
                return _ambiguity_message(input.target, e.response.json())
            except Exception:
                return _handle_bridge_error(e)
        return _handle_bridge_error(e)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data, default_label=f"Sent {kind}")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_download_media(input: DownloadMediaInput) -> str:
    """Lazily download media bytes for a previously-received message.

    Returns base64 inline for small files; for large files, a short-lived
    signed URL into the bridge.
    """
    try:
        data = await _bridge_get(f"/media/{input.chat_jid}/{input.message_id}")
    except Exception as e:
        return _handle_bridge_error(e)
    if data.get("base64"):
        truncated = data["base64"][:80]
        return (
            f"Downloaded {data.get('kind')} ({data.get('size')} bytes, mime={data.get('mime')}). "
            f"base64 (truncated): {truncated}…\n"
            f"fileName={data.get('fileName')} cached={data.get('cached')}"
        )
    if data.get("url"):
        return (
            f"Downloaded {data.get('kind')} ({data.get('size')} bytes, mime={data.get('mime')}). "
            f"signed_url={data['url']} (5 min expiry)\n"
            f"fileName={data.get('fileName')} cached={data.get('cached')}"
        )
    return f"Unexpected response: {data}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_send_location(input: SendLocationInput) -> str:
    body = _idem(
        {
            "target": input.target,
            "latitude": input.latitude,
            "longitude": input.longitude,
            "name": input.name,
            "address": input.address,
        },
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/send/location", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data, default_label="Sent location")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_send_contact(input: SendContactInput) -> str:
    body = _idem(
        {"target": input.target, "contacts": [{"name": input.name, "phone": input.phone}]},
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/send/contact", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data, default_label="Sent contact")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_send_poll(input: SendPollInput) -> str:
    body = _idem(
        {
            "target": input.target,
            "name": input.name,
            "options": input.options,
            "selectableCount": input.selectable_count,
        },
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/send/poll", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data, default_label="Sent poll")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, idempotentHint=True))
async def whatsapp_reply(input: ReplyInput) -> str:
    body = _idem(
        {
            "target": input.target,
            "message": input.message,
            "quoted_message_id": input.quoted_message_id,
        },
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/reply", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return _format_send_response(data, default_label="Sent reply")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True))
async def whatsapp_react(input: ReactInput) -> str:
    body = _idem(
        {"target": input.target, "message_id": input.message_id, "emoji": input.emoji},
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/react", body)
    except Exception as e:
        return _handle_bridge_error(e)
    if data.get("removed"):
        return f"Reaction removed from {input.message_id} in {data.get('jid')}."
    return f"Reacted {input.emoji!r} to {input.message_id} in {data.get('jid')}."


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True))
async def whatsapp_edit_message(input: EditMessageInput) -> str:
    body = _idem(
        {"target": input.target, "message_id": input.message_id, "new_text": input.new_text},
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/edit", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return f"Edited {data.get('edited')} in {input.target}. new_id={data.get('id')}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True))
async def whatsapp_delete_message(input: DeleteMessageInput) -> str:
    if input.scope not in ("me", "everyone"):
        return "Error: scope must be 'me' or 'everyone'."
    body = _idem(
        {"target": input.target, "message_id": input.message_id, "scope": input.scope},
        input.idempotency_key,
    )
    try:
        data = await _bridge_post("/delete", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return f"Deleted {data.get('deleted')} (scope={data.get('scope')})."


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False))
async def whatsapp_mark_read(input: MarkReadInput) -> str:
    try:
        data = await _bridge_post(f"/chats/{input.jid}/read", {})
    except Exception as e:
        return _handle_bridge_error(e)
    return f"Marked {input.jid} read through {data.get('markedThrough')}."


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True))
async def whatsapp_update_my_profile(input: UpdateMyProfileInput) -> str:
    body: dict[str, Any] = {}
    if input.name is not None:
        body["name"] = input.name
    if input.status is not None:
        body["status"] = input.status
    if input.avatar_base64 is not None:
        body["avatar_base64"] = input.avatar_base64
    if not body:
        return "Nothing to update — pass at least one of name, status, avatar_base64."
    try:
        data = await _bridge_patch("/profile/me", body)
    except Exception as e:
        return _handle_bridge_error(e)
    return f"Updated: {data.get('updated', [])}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True))
async def whatsapp_logout() -> str:
    """Log out of WhatsApp and delete auth_info/. Re-pair after."""
    try:
        data = await _bridge_post("/logout", {})
    except Exception as e:
        return _handle_bridge_error(e)
    return (
        "Logged out. The auth_info/ folder has been deleted. Re-scan QR after the bridge "
        f"produces a new QR.\n\nBridge response: {data}"
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    mcp.run(transport="streamable-http")
