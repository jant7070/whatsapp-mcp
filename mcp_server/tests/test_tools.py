"""Pytest suite for MCP tools — uses respx to stub the bridge."""

from __future__ import annotations

import pytest
import respx
from httpx import Response

import server
from server import (
    BRIDGE_URL,
    DownloadMediaInput,
    SearchMessagesInput,
    SendLocationInput,
    SendMediaInput,
    SendMessageInput,
    SendPollInput,
    whatsapp_download_media,
    whatsapp_get_audit_log,
    whatsapp_get_my_profile,
    whatsapp_get_status,
    whatsapp_search_messages,
    whatsapp_send_location,
    whatsapp_send_media,
    whatsapp_send_message,
    whatsapp_send_poll,
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
async def test_download_media_inline(mock_bridge):
    mock_bridge.get("/media/x@s.whatsapp.net/abc").mock(
        return_value=Response(
            200,
            json={
                "kind": "image",
                "mime": "image/jpeg",
                "fileName": None,
                "size": 123,
                "base64": "aGVsbG8=",
                "cached": False,
            },
        )
    )
    out = await whatsapp_download_media(
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="abc")
    )
    assert "Downloaded image" in out
    assert "base64" in out


@pytest.mark.asyncio
async def test_download_media_url(mock_bridge):
    mock_bridge.get("/media/x@s.whatsapp.net/abc").mock(
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
        DownloadMediaInput(chat_jid="x@s.whatsapp.net", message_id="abc")
    )
    assert "signed_url=http://signed/url" in out


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
