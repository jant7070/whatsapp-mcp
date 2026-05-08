"""WhatsApp MCP server.

Wraps the Baileys REST bridge as MCP tools. Single-user, personal-use only.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Configuration / startup checks
# ---------------------------------------------------------------------------
DEPLOYMENT_MODE = os.getenv("DEPLOYMENT_MODE", "local")
BRIDGE_API_KEY = os.getenv("BRIDGE_API_KEY")
BRIDGE_URL = os.getenv("BRIDGE_URL", "http://whatsapp-bridge:3001")
BIND_HOST = "0.0.0.0" if DEPLOYMENT_MODE == "cloud" else "127.0.0.1"
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

JID_PATTERN = re.compile(r"^[0-9]{7,15}(@s\.whatsapp\.net|@g\.us)?$")


# ---------------------------------------------------------------------------
# Pydantic input models
# ---------------------------------------------------------------------------
class SendMessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    jid: str = Field(
        ...,
        description=(
            "Recipient JID or phone number with country code. "
            "Examples: '5804120001234' or '5804120001234@s.whatsapp.net'. "
            "Get JIDs from whatsapp_list_conversations."
        ),
    )
    message: str = Field(..., min_length=1, max_length=4096, description="Text message to send.")

    @field_validator("jid")
    @classmethod
    def validate_jid(cls, v: str) -> str:
        if not JID_PATTERN.match(v):
            raise ValueError(
                "Invalid JID. Use phone number with country code "
                "(e.g. '5804120001234') or full JID ending in @s.whatsapp.net or @g.us"
            )
        return v


class GetMessagesInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    jid: Optional[str] = Field(
        default=None, description="Filter by chat JID. Leave empty for all chats."
    )
    limit: int = Field(default=20, ge=1, le=100, description="Max messages to return.")
    offset: int = Field(default=0, ge=0, description="Pagination offset.")
    search: Optional[str] = Field(
        default=None, max_length=200, description="Keyword to search in message body."
    )


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
    mode = data.get("deploymentMode", "unknown")

    if status == "connected":
        human = f"Connected. {cached} messages cached. ({mode} mode)"
    elif has_qr:
        human = f"Not linked yet — a QR is available. Call whatsapp_get_qr to scan. ({mode} mode)"
    else:
        human = f"Bridge is {status}, no QR available yet. ({mode} mode)"

    return (
        f"{human}\n\n"
        f"status={status}, hasQr={has_qr}, cachedMessages={cached}, deploymentMode={mode}"
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
async def whatsapp_list_conversations() -> str:
    """List recent WhatsApp conversations cached by the bridge.

    Each entry includes the chat JID (use it with whatsapp_send_message), whether
    it's a group, the last message body, the last message timestamp, and a contact
    name when known.
    """
    try:
        data = await _bridge_get("/conversations")
    except Exception as e:
        return _handle_bridge_error(e)

    conversations = data.get("conversations", [])
    if not conversations:
        return "No conversations cached yet. Receive or send a message first."

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
async def whatsapp_get_messages(input: GetMessagesInput) -> str:
    """Retrieve cached messages, optionally filtered by chat JID and/or keyword.

    Results are paginated (``limit`` 1–100, ``offset`` ≥ 0) and ordered newest-first.
    The bridge holds up to 500 recent messages in memory.
    """
    params: dict[str, Any] = {"limit": input.limit, "offset": input.offset}
    if input.jid is not None:
        params["jid"] = input.jid
    if input.search is not None:
        params["search"] = input.search

    try:
        data = await _bridge_get("/messages", params=params)
    except Exception as e:
        return _handle_bridge_error(e)

    messages = data.get("messages", [])
    total = data.get("total", 0)
    has_more = data.get("hasMore", False)

    if not messages:
        return f"No messages match (total={total})."

    lines = [
        f"Showing {len(messages)} of {total} messages "
        f"(offset={input.offset}, hasMore={has_more}):",
        "",
    ]
    for m in messages:
        direction = "→" if m.get("isFromMe") else "←"
        sender = m.get("fromName") or m.get("from") or "?"
        lines.append(
            f"[{m.get('timestamp')}] {direction} {sender} ({m.get('to')}): "
            f"{m.get('body', '')[:200]}"
        )
    return "\n".join(lines)


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False, destructiveHint=False, openWorldHint=True
    )
)
async def whatsapp_send_message(input: SendMessageInput) -> str:
    """Send a text WhatsApp message.

    Call ``whatsapp_get_status`` first to confirm the bridge is connected. The JID
    must be a phone number with country code (e.g. ``5804120001234``) or a full
    JID ending in ``@s.whatsapp.net`` (direct chat) or ``@g.us`` (group).
    """
    try:
        data = await _bridge_post("/send", {"jid": input.jid, "message": input.message})
    except Exception as e:
        return _handle_bridge_error(e)
    if data.get("ok"):
        return f"Sent. message_id={data.get('id')}"
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
