"""Pytest suite for MCP tools — uses respx to stub the bridge."""

from __future__ import annotations

import pytest
import respx
from httpx import Response
from mcp.server.fastmcp import Image
from mcp.types import TextContent

import server
from server import (
    BRIDGE_URL,
    ClearContactNameInput,
    DownloadMediaInput,
    GetContactProfileInput,
    SearchMessagesInput,
    SendLocationInput,
    SendMediaInput,
    SendMessageInput,
    SendPollInput,
    SetContactNameInput,
    whatsapp_clear_contact_name,
    whatsapp_download_media,
    whatsapp_get_audit_log,
    whatsapp_get_contact_profile,
    whatsapp_get_my_profile,
    whatsapp_get_status,
    whatsapp_search_messages,
    whatsapp_send_location,
    whatsapp_send_media,
    whatsapp_send_message,
    whatsapp_send_poll,
    whatsapp_set_contact_name,
)


@pytest.fixture
def mock_bridge():
    with respx.mock(base_url=BRIDGE_URL) as r:
        yield r


# ---- Status -----------------------------------------------------------------
@pytest.mark.asyncio
async def test_status_connected(mock_bridge):
    mock_bridge.get("/status").mock(
        return_value=Response(
            200,
            json={
                "status": "connected",
                "hasQr": False,
                "knownChats": 5,
                "knownContacts": 12,
                "cachedMessages": 100,
                "deploymentMode": "local",
                "mediaCacheBytes": 0,
                "errorsLastHour": 0,
                "connectionUptimeSec": 60,
                "lastMessageAt": 0,
            },
        )
    )
    out = await whatsapp_get_status()
    assert "Connected" in out
    assert "5 chats" in out


@pytest.mark.asyncio
async def test_status_unauthorized(mock_bridge):
    mock_bridge.get("/status").mock(return_value=Response(401, json={"error": "x"}))
    out = await whatsapp_get_status()
    assert "Unauthorized" in out


# ---- Send message -----------------------------------------------------------
@pytest.mark.asyncio
async def test_send_message_ok(mock_bridge):
    mock_bridge.post("/send").mock(
        return_value=Response(200, json={"ok": True, "id": "abc", "jid": "x@s.whatsapp.net"})
    )
    out = await whatsapp_send_message(
        SendMessageInput(target="5804120001234", message="hi")
    )
    assert "Sent" in out
    assert "id=abc" in out


@pytest.mark.asyncio
async def test_send_message_ambiguous_returns_candidates(mock_bridge):
    mock_bridge.post("/send").mock(
        return_value=Response(
            409,
            json={
                "error": "ambiguous",
                "candidates": [
                    {"jid": "1@s.whatsapp.net", "name": "A", "isGroup": False, "lastTimestamp": 1},
                    {"jid": "2@s.whatsapp.net", "name": "B", "isGroup": False, "lastTimestamp": 2},
                ],
            },
        )
    )
    out = await whatsapp_send_message(SendMessageInput(target="A", message="hi"))
    assert "matched 2 chats" in out
    assert "1@s.whatsapp.net" in out


@pytest.mark.asyncio
async def test_send_message_rate_limit_propagates(mock_bridge):
    mock_bridge.post("/send").mock(
        return_value=Response(429, json={"error": "rate"}, headers={"Retry-After": "5"})
    )
    out = await whatsapp_send_message(SendMessageInput(target="x", message="hi"))
    assert "Rate limit" in out
    assert "5s" in out


@pytest.mark.asyncio
async def test_send_message_idempotency_key_forwarded(mock_bridge):
    mock_bridge.post("/send").mock(
        return_value=Response(200, json={"ok": True, "id": "x", "jid": "j"})
    )
    out = await whatsapp_send_message(
        SendMessageInput(target="x", message="hi", idempotency_key="ABC123")
    )
    assert "Sent" in out
    request = mock_bridge.calls.last.request
    body = request.read().decode()
    assert "ABC123" in body


# ---- Send media -------------------------------------------------------------
@pytest.mark.asyncio
async def test_send_media_requires_one_source():
    out = await whatsapp_send_media(SendMediaInput(target="x", kind="image"))
    assert "must provide" in out


@pytest.mark.asyncio
async def test_send_media_rejects_both_sources():
    out = await whatsapp_send_media(
        SendMediaInput(target="x", kind="image", source_base64="aGk=", source_url="https://e.com/x")
    )
    assert "only one of" in out


@pytest.mark.asyncio
async def test_send_media_base64(mock_bridge):
    mock_bridge.post("/send/media").mock(
        return_value=Response(200, json={"ok": True, "id": "m1", "jid": "j", "kind": "image", "sizeBytes": 5})
    )
    out = await whatsapp_send_media(
        SendMediaInput(target="x", kind="image", source_base64="aGVsbG8=")
    )
    assert "Sent image" in out


@pytest.mark.asyncio
async def test_send_media_voice_flag_overrides_kind(mock_bridge):
    mock_bridge.post("/send/media").mock(
        return_value=Response(200, json={"ok": True, "id": "m1", "jid": "j", "kind": "voice", "sizeBytes": 5})
    )
    out = await whatsapp_send_media(
        SendMediaInput(target="x", kind="audio", source_base64="aGVsbG8=", voice=True)
    )
    request = mock_bridge.calls.last.request
    body = request.read().decode()
    assert '"kind":"voice"' in body
    assert "Sent voice" in out


# ---- Download media ---------------------------------------------------------
@pytest.mark.asyncio
async def test_download_media_image_base64_returns_inline(mock_bridge):
    # Image under inline threshold + base64 payload → [Image, TextContent].
    mock_bridge.get("/media/x@s.whatsapp.net/abc").mock(
        return_value=Response(
            200,
            json={
                "kind": "image",
                "mime": "image/jpeg",
                "fileName": "p.jpg",
                "size": 5,
                "base64": "aGVsbG8=",  # "hello"
                "cached": False,
            },
        )
    )
    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="abc")
    )
    assert isinstance(out, list)
    assert len(out) == 2
    image, text = out
    assert isinstance(image, Image)
    assert image.data == b"hello"
    assert image.to_image_content().mimeType == "image/jpeg"
    assert isinstance(text, TextContent)
    assert text.type == "text"
    assert "Downloaded image" in text.text
    assert "p.jpg" in text.text


@pytest.mark.asyncio
async def test_download_media_image_url_fetched_and_returned_inline(mock_bridge):
    # Image under threshold + signed URL → MCP fetches /media/file/<token>
    # against BRIDGE_URL (not the public base) and returns [Image, TextContent].
    # The `/bridge` Caddy strip-prefix must be removed before the internal call.
    long_url = "https://example.test/bridge/media/file/" + "a" * 200 + "." + "b" * 200
    mock_bridge.get("/media/c@s.whatsapp.net/m1").mock(
        return_value=Response(
            200,
            json={
                "kind": "image",
                "mime": "image/png",
                "fileName": "p.png",
                "size": 158_000,
                "url": long_url,
                "cached": True,
            },
        )
    )
    image_bytes = b"\x89PNG\r\n\x1a\nrest-of-bytes"
    fetch_route = mock_bridge.get(
        f"/media/file/{'a' * 200}.{'b' * 200}"
    ).mock(return_value=Response(200, content=image_bytes))

    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="c@s.whatsapp.net", message_id="m1")
    )

    assert fetch_route.called
    # Confirm the fetch URL targeted the internal BRIDGE_URL with /bridge stripped.
    fetched = fetch_route.calls.last.request.url
    assert str(fetched).startswith(BRIDGE_URL)
    assert "/bridge/" not in fetched.path

    assert isinstance(out, list)
    image, text = out
    assert isinstance(image, Image)
    assert image.data == image_bytes
    assert image.to_image_content().mimeType == "image/png"
    assert isinstance(text, TextContent)
    assert "158000 bytes" in text.text


@pytest.mark.asyncio
async def test_download_media_image_oversize_returns_url_string(mock_bridge, monkeypatch):
    # Oversize image (> MCP_IMAGE_INLINE_MAX_BYTES) → existing URL-string path.
    monkeypatch.setattr(server, "MCP_IMAGE_INLINE_MAX_BYTES", 1024)
    mock_bridge.get("/media/x@s.whatsapp.net/big").mock(
        return_value=Response(
            200,
            json={
                "kind": "image",
                "mime": "image/jpeg",
                "fileName": "big.jpg",
                "size": 5_000_000,
                "url": "http://signed/url-big",
                "cached": False,
            },
        )
    )
    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="big")
    )
    assert isinstance(out, str)
    assert "signed_url=http://signed/url-big" in out


@pytest.mark.asyncio
async def test_download_media_non_image_returns_url_string(mock_bridge):
    # Video / document / audio → no inline rendering, URL string passes through.
    mock_bridge.get("/media/x@s.whatsapp.net/vid").mock(
        return_value=Response(
            200,
            json={
                "kind": "video",
                "mime": "video/mp4",
                "fileName": None,
                "size": 5_000_000,
                "url": "http://signed/url",
                "cached": False,
            },
        )
    )
    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="vid")
    )
    assert isinstance(out, str)
    assert "signed_url=http://signed/url" in out


@pytest.mark.asyncio
async def test_download_media_image_fetch_failure_falls_back_to_url(mock_bridge):
    # If the inline fetch raises, surface the signed URL instead of crashing.
    mock_bridge.get("/media/x@s.whatsapp.net/fail").mock(
        return_value=Response(
            200,
            json={
                "kind": "image",
                "mime": "image/jpeg",
                "fileName": "p.jpg",
                "size": 1234,
                "url": "https://example.test/bridge/media/file/tok123",
                "cached": False,
            },
        )
    )
    # The internal fetch will hit this stubbed 500 → helper returns None → fallback.
    mock_bridge.get("/media/file/tok123").mock(return_value=Response(500))
    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="fail")
    )
    assert isinstance(out, str)
    assert "signed_url=https://example.test/bridge/media/file/tok123" in out


# ---- Send location ----------------------------------------------------------
@pytest.mark.asyncio
async def test_send_location_validates_range():
    with pytest.raises(Exception):
        SendLocationInput(target="x", latitude=200, longitude=0)


@pytest.mark.asyncio
async def test_send_location_ok(mock_bridge):
    mock_bridge.post("/send/location").mock(
        return_value=Response(200, json={"ok": True, "id": "L1", "jid": "j"})
    )
    out = await whatsapp_send_location(
        SendLocationInput(target="x", latitude=10.0, longitude=-66.0)
    )
    assert "Sent location" in out


# ---- Send poll --------------------------------------------------------------
def test_send_poll_validates_options_count():
    with pytest.raises(Exception):
        SendPollInput(target="x", name="p", options=["a"], selectable_count=1)


@pytest.mark.asyncio
async def test_send_poll_ok(mock_bridge):
    mock_bridge.post("/send/poll").mock(
        return_value=Response(200, json={"ok": True, "id": "P1", "jid": "j"})
    )
    out = await whatsapp_send_poll(
        SendPollInput(target="x", name="Best?", options=["A", "B"], selectable_count=1)
    )
    assert "Sent poll" in out


# ---- Search -----------------------------------------------------------------
@pytest.mark.asyncio
async def test_search_messages_no_hits(mock_bridge):
    mock_bridge.get("/messages/search").mock(
        return_value=Response(200, json={"hits": []})
    )
    out = await whatsapp_search_messages(SearchMessagesInput(query="zzz"))
    assert "No matches" in out


@pytest.mark.asyncio
async def test_search_messages_hits(mock_bridge):
    mock_bridge.get("/messages/search").mock(
        return_value=Response(
            200,
            json={
                "hits": [
                    {
                        "id": "1",
                        "chatJid": "j",
                        "sender": "s",
                        "senderName": "Alice",
                        "body": "hello world",
                        "timestamp": 100,
                    }
                ]
            },
        )
    )
    out = await whatsapp_search_messages(SearchMessagesInput(query="hello"))
    assert "1 hit(s)" in out
    assert "Alice" in out


# ---- Profile ----------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_profile(mock_bridge):
    mock_bridge.get("/profile/me").mock(
        return_value=Response(200, json={"jid": "j", "name": "n", "status": "s", "avatarUrl": "u"})
    )
    out = await whatsapp_get_my_profile()
    assert "name=n" in out
    assert "status=s" in out


# ---- Audit ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_audit_log(mock_bridge):
    mock_bridge.get("/audit").mock(
        return_value=Response(
            200,
            json={
                "items": [
                    {
                        "id": 1,
                        "timestamp": 100,
                        "tool": "whatsapp_send_message",
                        "ok": True,
                        "targetJid": "<phone>@s.whatsapp.net",
                        "errorCode": None,
                        "resultSummary": "x",
                    }
                ]
            },
        )
    )
    from server import AuditQueryInput

    out = await whatsapp_get_audit_log(AuditQueryInput(limit=10))
    assert "1 entrie(s)" in out
    assert "whatsapp_send_message" in out


# ---- Connection error -------------------------------------------------------
@pytest.mark.asyncio
async def test_connection_error_friendly(mock_bridge):
    import httpx

    mock_bridge.get("/status").mock(side_effect=httpx.ConnectError("boom"))
    out = await whatsapp_get_status()
    assert "Cannot connect to bridge" in out


# ---- Contact name overrides --------------------------------------------------
@pytest.mark.asyncio
async def test_set_contact_name_round_trip(mock_bridge):
    mock_bridge.put("/contacts/5804120001234@s.whatsapp.net/name").mock(
        return_value=Response(
            200, json={"ok": True, "jid": "5804120001234@s.whatsapp.net", "name": "Papa"}
        )
    )
    out = await whatsapp_set_contact_name(
        SetContactNameInput(jid="5804120001234@s.whatsapp.net", name="Papa")
    )
    assert "Papa" in out
    assert "5804120001234@s.whatsapp.net" in out


@pytest.mark.asyncio
async def test_set_contact_name_validates_length():
    # 26 chars > MAX_NAME_LEN (25) — pydantic rejects before the bridge call.
    with pytest.raises(Exception):
        SetContactNameInput(jid="x@s.whatsapp.net", name="a" * 26)


@pytest.mark.asyncio
async def test_set_contact_name_idempotency_key_forwarded(mock_bridge):
    mock_bridge.put("/contacts/x@s.whatsapp.net/name").mock(
        return_value=Response(200, json={"ok": True, "jid": "x@s.whatsapp.net", "name": "A"})
    )
    await whatsapp_set_contact_name(
        SetContactNameInput(jid="x@s.whatsapp.net", name="A", idempotency_key="K1")
    )
    request = mock_bridge.calls.last.request
    body = request.read().decode()
    assert "K1" in body


@pytest.mark.asyncio
async def test_clear_contact_name_removed(mock_bridge):
    mock_bridge.delete("/contacts/x@s.whatsapp.net/name").mock(
        return_value=Response(200, json={"ok": True, "jid": "x@s.whatsapp.net", "removed": True})
    )
    out = await whatsapp_clear_contact_name(
        ClearContactNameInput(jid="x@s.whatsapp.net")
    )
    assert "Cleared" in out


@pytest.mark.asyncio
async def test_clear_contact_name_no_existing(mock_bridge):
    mock_bridge.delete("/contacts/x@s.whatsapp.net/name").mock(
        return_value=Response(200, json={"ok": True, "jid": "x@s.whatsapp.net", "removed": False})
    )
    out = await whatsapp_clear_contact_name(
        ClearContactNameInput(jid="x@s.whatsapp.net")
    )
    assert "No override" in out


# ---- Contact profile stale flag ----------------------------------------------
@pytest.mark.asyncio
async def test_get_contact_profile_marks_stale(mock_bridge):
    mock_bridge.get("/profile/x@s.whatsapp.net").mock(
        return_value=Response(
            200,
            json={
                "jid": "x@s.whatsapp.net",
                "pushName": "Cached",
                "avatarUrl": "http://cached/a.jpg",
                "presence": None,
                "stale": True,
            },
        )
    )
    out = await whatsapp_get_contact_profile(
        GetContactProfileInput(jid="x@s.whatsapp.net")
    )
    assert "stale" in out.lower()
    assert "Cached" in out


@pytest.mark.asyncio
async def test_get_contact_profile_fresh_no_stale_marker(mock_bridge):
    mock_bridge.get("/profile/x@s.whatsapp.net").mock(
        return_value=Response(
            200,
            json={
                "jid": "x@s.whatsapp.net",
                "pushName": "Live",
                "avatarUrl": "http://live/a.jpg",
                "presence": "available",
            },
        )
    )
    out = await whatsapp_get_contact_profile(
        GetContactProfileInput(jid="x@s.whatsapp.net")
    )
    assert "stale" not in out.lower()
    assert "Live" in out
