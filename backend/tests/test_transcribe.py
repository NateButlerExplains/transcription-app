"""Hardening tests for the /transcribe endpoint.

Whisper and Langfuse are stubbed in conftest.py, so these run without the real
model, ffmpeg, or network.
"""
import io

import pytest


def _upload(content: bytes, filename="audio.mp3", content_type="audio/mpeg"):
    return {"file": (filename, io.BytesIO(content), content_type)}


def test_happy_path(client, stub_model):
    resp = client.post("/transcribe", files=_upload(b"\x00" * 2048))
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == "hello world"
    assert body["segments"] == stub_model.result["segments"]
    # Response shape unchanged: exactly text + segments.
    assert set(body.keys()) == {"text", "segments"}
    assert len(stub_model.calls) == 1


def test_oversize_rejected_413(client, app_module, stub_model):
    limit = app_module.MAX_UPLOAD_BYTES
    resp = client.post("/transcribe", files=_upload(b"\x00" * (limit + 1)))
    assert resp.status_code == 413
    assert not stub_model.calls  # never reached the model


def test_unsupported_type_rejected_415(client, stub_model):
    resp = client.post(
        "/transcribe",
        files=_upload(b"hello", filename="notes.txt", content_type="text/plain"),
    )
    assert resp.status_code == 415
    assert not stub_model.calls


def test_empty_upload_rejected_400(client, stub_model):
    resp = client.post("/transcribe", files=_upload(b""))
    assert resp.status_code == 400
    assert not stub_model.calls


def test_internal_error_returns_clean_500(client, stub_model):
    stub_model.exc = RuntimeError("ffmpeg not found: super secret internal detail")
    resp = client.post("/transcribe", files=_upload(b"\x00" * 2048))
    assert resp.status_code == 500
    # No stack trace / internal detail leaked to the client.
    assert "secret" not in resp.text.lower()
    assert resp.json()["detail"] == "Transcription failed due to an internal error."


def test_extension_allowlist_permits_octet_stream_with_good_ext(client, stub_model):
    # Browsers often send application/octet-stream; extension saves it.
    resp = client.post(
        "/transcribe",
        files=_upload(b"\x00" * 2048, filename="clip.wav",
                      content_type="application/octet-stream"),
    )
    assert resp.status_code == 200
