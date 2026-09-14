"""Minimal tests for the streaming transcription endpoint.

These verify the WebSocket accepts a connection and a chunk and returns a
final message without blocking — they do NOT assert transcription quality
(garbage bytes decode to empty text, which is the intended graceful path).
"""
from fastapi.testclient import TestClient

from main import app


def test_ws_connects_and_finalizes_on_stop():
    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as ws:
        # Send a chunk then request stop; server must reply with a final message
        # (empty transcript is fine for non-decodable bytes) without hanging.
        ws.send_bytes(b"\x00\x01\x02not-real-webm")
        ws.send_text("stop")
        msg = ws.receive_json()
        assert msg["type"] == "final"
        assert "text" in msg
        assert "segments" in msg
        assert isinstance(msg["segments"], list)


def test_ws_finalizes_with_no_audio():
    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as ws:
        # Immediate stop with no audio still returns a well-formed final message.
        ws.send_text("stop")
        msg = ws.receive_json()
        assert msg["type"] == "final"
        assert msg["text"] == ""
        assert msg["segments"] == []
