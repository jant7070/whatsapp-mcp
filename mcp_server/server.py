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
# Bind to all interfaces inside the container; Docker's `127.0.0.1:NNNN:NNNN`
# port mapping is what restricts host-side access to localhost in local mode.
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
class SendMessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    target: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description=(
            "Recipient — accepts any of: a contact or chat name (e.g. 'Jireh Capote'), "
            "a phone number with country code (e.g. '5804120001234'), or a full JID "
            "(e.g. '5804120001234@s.whatsapp.net' for a chat or '<id>@g.us' for a group). "
            "If a name matches multiple chats, the tool returns the candidates "
            "instead of sending so you can disambiguate."
        ),
    )
    message: str = Field(..., min_length=1, max_length=4096, description="Text message to send.")


class GetMessagesInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    jid: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description=(
            "Chat JID to fetch messages from. Get one from whatsapp_list_conversations "
            "or whatsapp_search_contacts."
        ),
    )
    limit: int = Field(default=50, ge=1, le=200, description="Max messages to return (newest first).")
    before_timestamp: Optional[int] = Field(
        default=None,
        ge=0,
        description=(
            "Unix-seconds cursor for pagination. Returns only messages with timestamp < "
            "this value. Use the smallest timestamp from a previous page to walk older."
        ),
    )


class FetchOlderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    jid: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="Chat JID whose history should be backfilled.",
    )
    count: int = Field(
        default=50,
        ge=1,
        le=200,
        description="How many older messages to ask WhatsApp for (best-effort).",
    )


class SearchContactsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Substring to match (case-insensitive) against contact and chat names.",
    )
    limit: int = Field(default=20, ge=1, le=50, description="Max hits to return.")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {BRIDGE_API_KEY}"}


async def _bridge_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{BRIDGE_URL}{path}", params=params, headers=_auth_headers())
        resp.raise_for_status()
        return resp.json()


async def _bridge_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(f"{BRIDGE_URL}{path}", json=body, headers=_auth_headers())
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
            return "Error: Rate limit exceeded. Wait before sending more messages."
        if e.response.status_code == 404:
            try:
                detail = e.response.json().get("error", "Not found")
            except Exception:
                detail = "Not found"
            return f"Error (404): {detail}"
        return f"Error ({e.response.status_code}): {e.response.text}"
    if isinstance(e, httpx.TimeoutException):
        return "Error: Bridge request timed out."
    return f"Error: {type(e).__name__}: {str(e)}"


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------
mcp = FastMCP("whatsapp-mcp", host=BIND_HOST, port=MCP_PORT)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_status() -> str:
    """Check whether the WhatsApp bridge is connected and how many messages are cached.

    Call this first to confirm the bridge is reachable and authenticated. If ``hasQr``
    is true, no device is linked yet — call ``whatsapp_get_qr`` next.
    """
    try:
        data = await _bridge_get("/status")
    except Exception as e:
        return _handle_bridge_error(e)

    status = data.get("status", "unknown")
    has_qr = data.get("hasQr", False)
    cached = data.get("cachedMessages", 0)
    known_chats = data.get("knownChats", 0)
    known_contacts = data.get("knownContacts", 0)
    mode = data.get("deploymentMode", "unknown")

    if status == "connected":
        human = (
            f"Connected. {known_chats} chats / {known_contacts} contacts known, "
            f"{cached} recent messages buffered. ({mode} mode)"
        )
    elif has_qr:
        human = f"Not linked yet — a QR is available. Call whatsapp_get_qr to scan. ({mode} mode)"
    else:
        human = f"Bridge is {status}, no QR available yet. ({mode} mode)"

    return (
        f"{human}\n\n"
        f"status={status}, hasQr={has_qr}, knownChats={known_chats}, "
        f"knownContacts={known_contacts}, cachedMessages={cached}, deploymentMode={mode}"
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_qr() -> str:
    """Fetch the current pairing QR code so the operator can link a phone.

    Returns the raw QR payload string. Open WhatsApp on your phone, go to
    Settings → Linked Devices → Link a Device, then scan the rendered QR.
    """
    try:
        data = await _bridge_get("/qr")
    except Exception as e:
        return _handle_bridge_error(e)

    qr = data.get("qr")
    if not qr:
        return "No QR available — likely already linked. Call whatsapp_get_status to confirm."

    instructions = (
        "1. Open WhatsApp on your phone.\n"
        "2. Tap Settings → Linked Devices → Link a Device.\n"
        "3. Point your phone at the rendered QR code below.\n"
    )
    if DEPLOYMENT_MODE == "cloud":
        instructions += (
            "\nRender the QR locally with:\n"
            '  python3 -c "import qrcode,sys; qrcode.make(sys.argv[1]).show()" "<qr_data>"\n'
            "(install with: pip install \"qrcode[pil]\")\n"
        )

    return f"{instructions}\nQR data:\n{qr}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_list_conversations(limit: int = 50) -> str:
    """List recent WhatsApp conversations from the bridge's chat directory.

    Status broadcasts, broadcast lists, and channel newsletters are excluded.

    Each entry includes the chat JID (use it with whatsapp_send_message or
    whatsapp_get_messages), whether it's a group, the last message preview, the
    last-message timestamp, and the resolved contact/group name. Names come from
    the user's saved contacts when available, then the contact's pushName, then
    a phone-number fallback (e.g. ``+5804120017``).

    Args:
        limit: Max conversations to return (1-200, default 50).
    """
    limit = max(1, min(int(limit), 200))
    try:
        data = await _bridge_get("/conversations", params={"limit": limit})
    except Exception as e:
        return _handle_bridge_error(e)

    conversations = data.get("conversations", [])
    if not conversations:
        return (
            "No conversations known yet. If you just linked a fresh QR, the bridge "
            "may still be receiving the initial history sync — try again in a few seconds."
        )

    lines = [f"{len(conversations)} conversation(s):", ""]
    for c in conversations:
        kind = "group" if c.get("isGroup") else "chat"
        name = c.get("contactName") or "(no name)"
        lines.append(
            f"- jid={c.get('jid')} [{kind}] {name} "
            f"@ {c.get('lastTimestamp')}: {c.get('lastMessage', '')[:120]}"
        )
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_search_contacts(input: SearchContactsInput) -> str:
    """Search known chats and contacts by name (case-insensitive substring).

    Use this to look up a JID before calling whatsapp_send_message, or to
    confirm a contact exists. Matches are returned newest-first by last
    activity. Results draw from both saved contact names and pushNames the
    bridge has seen, plus group subjects. Status broadcasts, broadcast lists,
    and channel newsletters are excluded.
    """
    try:
        data = await _bridge_get(
            "/chats/search", params={"q": input.query, "limit": input.limit}
        )
    except Exception as e:
        return _handle_bridge_error(e)

    hits = data.get("hits", [])
    if not hits:
        return f"No matches for '{input.query}'."

    lines = [f"{len(hits)} match(es) for '{input.query}':", ""]
    for h in hits:
        kind = "group" if h.get("isGroup") else "chat"
        lines.append(
            f"- jid={h.get('jid')} [{kind}] {h.get('name')} "
            f"@ {h.get('lastTimestamp')}"
        )
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_get_messages(input: GetMessagesInput) -> str:
    """Retrieve recent messages for one chat, newest-first.

    Status broadcasts and channel newsletters are excluded. The bridge keeps
    the last 200 messages per chat in memory; if you need more history than
    that for a given chat, call ``whatsapp_fetch_older`` to ask WhatsApp for
    older chunks, then call this tool again.

    For pagination, pass ``before_timestamp`` set to the smallest timestamp
    you saw in the previous page.
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
        return (
            f"No messages cached for {chat_name} ({input.jid}). "
            "Try whatsapp_fetch_older to pull history from WhatsApp."
        )

    lines = [
        f"{chat_name} ({input.jid}) — showing {len(messages)} of {total} cached "
        f"(hasMore={has_more}):",
        "",
    ]
    for m in messages:
        direction = "→" if m.get("isFromMe") else "←"
        # senderName is resolved by the bridge using saved contacts → pushName →
        # phone-number fallback. It is "you" for outbound messages.
        sender = m.get("senderName") or m.get("sender") or "?"
        lines.append(
            f"[{m.get('timestamp')}] {direction} {sender}: {m.get('body', '')[:200]}"
        )
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def whatsapp_fetch_older(input: FetchOlderInput) -> str:
    """Ask WhatsApp for older messages of a chat (best-effort, on-demand backfill).

    The bridge anchors the request on the oldest message it currently has for
    this chat and asks WhatsApp's server to deliver up to ``count`` older
    messages. The actual number returned can be lower (or zero) — WhatsApp
    rate-limits this and may have nothing more to send. Re-call to walk
    further back.

    Requires the chat to already have at least one cached message as an anchor;
    if none exists, send or receive a message in that chat first.
    """
    params: dict[str, Any] = {"jid": input.jid, "count": input.count}
    try:
        data = await _bridge_get("/messages/fetch_older", params=params)
    except Exception as e:
        return _handle_bridge_error(e)

    requested = data.get("requested", input.count)
    added = data.get("added", 0)
    total = data.get("total", 0)

    if added == 0:
        return (
            f"Requested {requested} older messages for {input.jid}; WhatsApp returned none. "
            f"The chat now has {total} cached. Try again or accept that there's no more history."
        )
    return (
        f"Backfilled {added} older messages for {input.jid} (requested {requested}). "
        f"The chat now has {total} cached — call whatsapp_get_messages to read them."
    )


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False, destructiveHint=False, openWorldHint=True
    )
)
async def whatsapp_send_message(input: SendMessageInput) -> str:
    """Send a text WhatsApp message.

    Call ``whatsapp_get_status`` first to confirm the bridge is connected. The
    ``target`` accepts a contact/chat name, a phone number with country code,
    or a full JID. Names are matched case-insensitively against saved contacts,
    pushNames, and group subjects.

    If the name matches multiple chats this tool returns the candidate list
    instead of sending — pick one and call again with its JID.
    """
    try:
        data = await _bridge_post(
            "/send", {"target": input.target, "message": input.message}
        )
    except httpx.HTTPStatusError as e:
        # 409 Ambiguous → return the candidates so the caller can disambiguate.
        if e.response.status_code == 409:
            try:
                payload = e.response.json()
            except Exception:
                return _handle_bridge_error(e)
            candidates = payload.get("candidates", [])
            lines = [
                f"Did not send. '{input.target}' matched {len(candidates)} chats — "
                "pick one and call whatsapp_send_message again with its JID:",
                "",
            ]
            for c in candidates:
                kind = "group" if c.get("isGroup") else "chat"
                lines.append(
                    f"- jid={c.get('jid')} [{kind}] {c.get('name')} "
                    f"@ {c.get('lastTimestamp')}"
                )
            return "\n".join(lines)
        if e.response.status_code == 404:
            try:
                detail = e.response.json().get("error", "Not found")
            except Exception:
                detail = "Not found"
            return f"Did not send. {detail}"
        return _handle_bridge_error(e)
    except Exception as e:
        return _handle_bridge_error(e)
    if data.get("ok"):
        jid = data.get("jid", "")
        return f"Sent to {jid}. message_id={data.get('id')}"
    return f"Send returned: {data}"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True))
async def whatsapp_logout() -> str:
    """Log the bridge out of WhatsApp and delete the local auth_info session.

    WARNING: This invalidates the linked-device session. You will need to re-scan
    the QR code with your phone to use any other tool again.
    """
    try:
        data = await _bridge_post("/logout", {})
    except Exception as e:
        return _handle_bridge_error(e)
    return (
        "Logged out. The auth_info/ folder has been deleted. "
        "Re-authentication will be required: call whatsapp_get_qr after the bridge "
        "produces a new QR.\n\n"
        f"Bridge response: {data}"
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    mcp.run(transport="streamable-http")
