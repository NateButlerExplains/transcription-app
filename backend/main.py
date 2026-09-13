import whisper
import tempfile
import os
import threading
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv(".env")

from langfuse import Langfuse

app = FastAPI()
langfuse = Langfuse(
    public_key=os.getenv("LANGFUSE_PUBLIC_KEY"),
    secret_key=os.getenv("LANGFUSE_SECRET_KEY"),
    host=os.getenv("LANGFUSE_BASE_URL") or os.getenv("LANGFUSE_HOST"),
)
APP_NAME = "transcription-app"
APP_ENV = os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "local"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
CAPTURE_TRANSCRIPT = os.getenv("LANGFUSE_CAPTURE_TRANSCRIPT", "false").lower() == "true"

# Upload guards. MAX_UPLOAD_MB is configurable; default 200 MB.
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "200")) * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024  # stream to disk 1 MB at a time

# Allowlist of audio/video media Whisper (via ffmpeg) can reasonably handle.
ALLOWED_CONTENT_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac",
    "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/flac",
    "audio/x-flac", "audio/opus", "audio/3gpp",
    "video/mp4", "video/mpeg", "video/webm", "video/quicktime",
    "video/x-matroska", "video/x-msvideo",
    "application/octet-stream",  # browsers often send this for media blobs
}
ALLOWED_EXTENSIONS = {
    ".mp3", ".mp4", ".m4a", ".aac", ".wav", ".webm", ".ogg", ".oga",
    ".flac", ".opus", ".mpeg", ".mpga", ".mkv", ".mov", ".avi", ".3gp",
}

# Serialize access to the shared, non-thread-safe Whisper model.
_model_lock = threading.Lock()

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

# Load the Whisper model once at startup.
model = whisper.load_model(WHISPER_MODEL)


def transcript_output(result):
    output = {"segment_count": len(result.get("segments", []))}
    if CAPTURE_TRANSCRIPT:
        output["text"] = result.get("text", "")
    return output


def _validate_upload(file: UploadFile):
    """Reject unsupported media before reading the body. Raises HTTPException(415)."""
    ext = os.path.splitext(file.filename or "")[1].lower()
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type in ALLOWED_CONTENT_TYPES or ext in ALLOWED_EXTENSIONS:
        return
    raise HTTPException(
        status_code=415,
        detail="Unsupported media type. Upload an audio or video file.",
    )


async def _stream_to_tempfile(file: UploadFile, suffix: str):
    """Stream the upload to a temp file in bounded chunks.

    Aborts with HTTP 413 once MAX_UPLOAD_BYTES is exceeded and HTTP 400 for an
    empty upload. Returns (tmp_path, total_bytes). Cleans up its own temp file
    on any failure before raising.
    """
    total = 0
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Upload exceeds maximum size of "
                            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                        ),
                    )
                tmp.write(chunk)
    except Exception:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    if total == 0:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    return tmp_path, total


def _transcribe_sync(tmp_path: str):
    """Run the blocking Whisper call under a lock so the shared model is never
    used by two threads at once."""
    with _model_lock:
        return model.transcribe(tmp_path)


@app.get("/")
def read_root():
    return {"message": "Transcription API is running!"}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    _validate_upload(file)

    file_metadata = {
        "filename": file.filename,
        "content_type": file.content_type,
    }

    with langfuse.start_as_current_observation(
        as_type="span",
        name="transcribe-file",
        input=file_metadata,
        metadata={
            "app": APP_NAME,
            "environment": APP_ENV,
            "feature": "transcription",
        },
    ) as trace:
        langfuse.update_current_trace(
            name="transcribe-file",
            tags=[APP_NAME, APP_ENV, "whisper", "transcription"],
            metadata={
                "app": APP_NAME,
                "environment": APP_ENV,
                "feature": "transcription",
            },
        )
        tmp_path = None
        try:
            # Stream the upload to disk in bounded chunks (size-capped).
            suffix = os.path.splitext(file.filename or "")[1]
            tmp_path, file_size = await _stream_to_tempfile(file, suffix)
            trace.update(input={**file_metadata, "file_size_bytes": file_size})

            with langfuse.start_as_current_observation(
                as_type="generation",
                name="whisper-transcription",
                model=f"whisper-{WHISPER_MODEL}",
                input={**file_metadata, "file_size_bytes": file_size},
                metadata={
                    "app": APP_NAME,
                    "environment": APP_ENV,
                    "feature": "transcription",
                },
            ) as generation:
                # Run the CPU-heavy, blocking Whisper call off the event loop.
                result = await run_in_threadpool(_transcribe_sync, tmp_path)
                generation.update(output=transcript_output(result))

            trace.update(output=transcript_output(result))
        except HTTPException as exc:
            # Bad input (413/415/400) — record on the span and re-raise cleanly.
            trace.update(level="ERROR", status_message=str(exc.detail))
            raise
        except Exception as exc:
            # Corrupt audio, missing ffmpeg, Langfuse/network failures, etc.
            trace.update(level="ERROR", status_message=f"{type(exc).__name__}: {exc}")
            raise HTTPException(
                status_code=500,
                detail="Transcription failed due to an internal error.",
            )
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    return {
        "text": result["text"],
        "segments": result["segments"],
    }


@app.on_event("shutdown")
def shutdown_langfuse():
    langfuse.shutdown()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
