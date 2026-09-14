import whisper
import tempfile
import os
import threading
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Allow React frontend to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5007",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://localhost:3000",
        "http://127.0.0.1:5007",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
        "http://127.0.0.1:3000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the Whisper model (using "base" for speed, can change later)
model = whisper.load_model("base")

# Whisper is synchronous + CPU-heavy and there is a single shared model, so
# every transcription must (a) run OFF the event loop and (b) be serialized so
# concurrent requests/chunks don't corrupt the model's state or peg all cores.
_model_lock = threading.Lock()


def _blocking_transcribe(path):
    """Runs in a worker thread. The lock serializes access to the one model."""
    with _model_lock:
        return model.transcribe(path)


async def transcribe_bytes(data: bytes, suffix: str = ".webm"):
    """Write audio bytes to a temp file and transcribe them off the event loop.

    Returns (text, segments). On any decode/transcription error returns
    ("", []) so partial/streaming callers can keep going.
    """
    if not data:
        return "", []
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        result = await run_in_threadpool(_blocking_transcribe, tmp_path)
        return result["text"], result["segments"]
    except Exception:
        return "", []
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.get("/")
def read_root():
    return {"message": "Transcription API is running!"}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    # Save uploaded file to a temp location
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        # Run Whisper OFF the event loop, serialized through the model lock, so
        # the one-shot upload never blocks streaming clients (and vice-versa).
        result = await run_in_threadpool(_blocking_transcribe, tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    return {
        "text": result["text"],
        "segments": result["segments"],
    }


# How often (in accumulated chunks) we re-transcribe while streaming. Chunks
# arrive roughly every second (MediaRecorder timeslice), so this is ~every 4s.
_PARTIAL_EVERY_CHUNKS = 4


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    """Streaming transcription.

    Design: a WebSocket endpoint (chosen over interval POSTs because it needs no
    per-request auth/CORS preflight, keeps one ordered byte stream per session,
    and lets the server push partials as soon as they're ready).

    The browser records with a MediaRecorder timeslice and sends each webm chunk
    as it is produced. Only the FIRST chunk carries the webm header, so the
    server ACCUMULATES all bytes from the start and re-transcribes the growing
    buffer (a rolling window would drop the header and fail to decode). Every few
    chunks it emits a {"type":"partial"} update; on stop/disconnect it emits a
    final full-quality {"type":"final"} transcript of the complete audio.
    """
    await websocket.accept()
    buffer = bytearray()
    chunks_since_partial = 0
    partial_inflight = False

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                # Client vanished — nothing to send back; just clean up.
                return

            data = message.get("bytes")
            if data is not None:
                buffer.extend(data)
                chunks_since_partial += 1
                # Emit a partial roughly every N chunks, but never overlap work:
                # if a partial is still running we simply wait for the next tick.
                if chunks_since_partial >= _PARTIAL_EVERY_CHUNKS and not partial_inflight:
                    chunks_since_partial = 0
                    partial_inflight = True
                    text, segments = await transcribe_bytes(bytes(buffer))
                    partial_inflight = False
                    await websocket.send_json(
                        {"type": "partial", "text": text, "segments": segments}
                    )
                continue

            text_msg = message.get("text")
            if text_msg is not None and text_msg == "stop":
                break

        # Final, full-quality pass over the complete audio.
        text, segments = await transcribe_bytes(bytes(buffer))
        await websocket.send_json(
            {"type": "final", "text": text, "segments": segments}
        )
        await websocket.close()
    except WebSocketDisconnect:
        # Client disconnected mid-stream; buffer is discarded, temp files already
        # cleaned by transcribe_bytes.
        return
    except Exception:
        # Never let a streaming error take down the socket ungracefully.
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
