"""Test fixtures.

Stub out `whisper` and `langfuse` in sys.modules BEFORE importing the app so
tests never require the real Whisper model, ffmpeg, or a Langfuse network
connection.
"""
import sys
import types
import importlib
from contextlib import contextmanager

import pytest


class _StubModel:
    """Records the last path it was asked to transcribe and returns a canned
    result. Tests can override .result / raise via .exc."""

    def __init__(self):
        self.result = {
            "text": "hello world",
            "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "hello world"}],
        }
        self.exc = None
        self.calls = []

    def transcribe(self, path):
        self.calls.append(path)
        if self.exc is not None:
            raise self.exc
        return self.result


STUB_MODEL = _StubModel()


def _install_whisper_stub():
    mod = types.ModuleType("whisper")
    mod.load_model = lambda name: STUB_MODEL
    sys.modules["whisper"] = mod


def _install_langfuse_stub():
    @contextmanager
    def _observation(*args, **kwargs):
        yield _Span()

    class _Span:
        def update(self, *args, **kwargs):
            pass

    class _Langfuse:
        def __init__(self, *args, **kwargs):
            pass

        def start_as_current_observation(self, *args, **kwargs):
            return _observation()

        def update_current_trace(self, *args, **kwargs):
            pass

        def shutdown(self):
            pass

    mod = types.ModuleType("langfuse")
    mod.Langfuse = _Langfuse
    sys.modules["langfuse"] = mod


@pytest.fixture(scope="session")
def app_module():
    _install_whisper_stub()
    _install_langfuse_stub()
    # Ensure a fresh import that picks up the stubs.
    sys.modules.pop("backend.main", None)
    sys.modules.pop("main", None)
    import backend.main as main
    importlib.reload(main)
    return main


@pytest.fixture
def stub_model():
    # Reset between tests.
    STUB_MODEL.exc = None
    STUB_MODEL.calls.clear()
    STUB_MODEL.result = {
        "text": "hello world",
        "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "hello world"}],
    }
    return STUB_MODEL


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient
    return TestClient(app_module.app)
