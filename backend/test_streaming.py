"""Minimal tests for the streaming transcription endpoint.

These verify the WebSocket accepts a connection and a chunk and returns a
final message without blocking — they do NOT assert transcription quality
(garbage bytes decode to empty text, which is the intended graceful path).
"""
import os
import shutil
import subprocess
import tempfile

import pytest
from fastapi.testclient import TestClient

from main import app


def _make_webm():
    """Generate ~1s of silent webm/opus so a partial/final can actually decode.
    Returns bytes, or None if ffmpeg/libopus is unavailable."""
    if not shutil.which("ffmpeg"):
        return None
    path = tempfile.mktemp(suffix=".webm")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi",
                "-i", "anullsrc=r=16000:cl=mono", "-t", "1",
                "-c:a", "libopus", "-f", "webm", path,
            ],
            capture_output=True,
            check=True,
        )
        with open(path, "rb") as f:
            return f.read()
    except Exception:
        return None
    finally:
        if os.path.exists(path):
            os.remove(path)


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


def test_ws_streams_decodable_audio_to_final():
    data = _make_webm()
    if not data:
        pytest.skip("ffmpeg/libopus unavailable")
    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as ws:
        # Send in several chunks (exercises the partial path), then stop.
        step = max(1, len(data) // 5)
        for i in range(0, len(data), step):
            ws.send_bytes(data[i:i + step])
        ws.send_text("stop")
        final = None
        for _ in range(20):  # drain any partials until the final arrives
            msg = ws.receive_json()
            if msg["type"] == "final":
                final = msg
                break
        assert final is not None
        assert "text" in final
        assert isinstance(final["segments"], list)


def test_ws_client_disconnect_midstream_is_graceful():
    data = _make_webm() or b"\x00\x01\x02not-real"
    client = TestClient(app)
    with client.websocket_connect("/ws/transcribe") as ws:
        ws.send_bytes(data[: max(1, len(data) // 2)])
        # Leave the context -> socket closes with no 'stop'. The server must
        # handle WebSocketDisconnect without raising.
    assert True
