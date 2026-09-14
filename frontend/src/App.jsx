import { useState, useCallback, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { useLiveRecorder } from './useLiveRecorder'
import './App.css'

function App() {
  const [transcript, setTranscript] = useState('')
  const [segments, setSegments] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [copied, setCopied] = useState(false)

  // Live-recording feature state
  const [liveEnabled, setLiveEnabled] = useState(false)
  const [useMic, setUseMic] = useState(true)
  const [useComputer, setUseComputer] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [streamNote, setStreamNote] = useState('')
  const [savedNote, setSavedNote] = useState('')

  // B5: only the most-recent transcription request may write the display.
  const requestIdRef = useRef(0)

  // Auto-save a recording's final transcript to the user's Downloads folder as
  // Markdown (recordings only — the file-drop path keeps its manual export).
  const autoSaveTranscript = useCallback((text, segs) => {
    if (!text || !text.trim()) return
    const content = buildTranscriptMd(text, segs)
    const fname = `transcript-${formatStamp(new Date())}.md`
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fname
    a.click()
    URL.revokeObjectURL(url)
    setSavedNote(`Auto-saved ${fname} to your Downloads folder.`)
  }, [])

  // Shared transcription: send any File/Blob to the backend and render results.
  // Returns { text, segments } on success, or null if stale/failed.
  const transcribeFile = useCallback(async (file, displayName) => {
    if (!file) return null
    const myId = ++requestIdRef.current
    setFileName(displayName)
    setLoading(true)
    setError('')
    setTranscript('')
    setSegments([])
    const formData = new FormData()
    formData.append('file', file, displayName)
    try {
      const response = await axios.post('http://127.0.0.1:8000/transcribe', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      if (requestIdRef.current !== myId) return null // stale response, ignore
      setTranscript(response.data.text)
      setSegments(response.data.segments)
      return { text: response.data.text, segments: response.data.segments }
    } catch {
      if (requestIdRef.current === myId) {
        setError('Transcription failed. Make sure the backend is running.')
      }
      return null
    } finally {
      if (requestIdRef.current === myId) setLoading(false)
    }
  }, [])

  // Fallback path: WebSocket streaming unavailable — transcribe the whole blob
  // once via the one-shot POST, then auto-save.
  const handleRecordedBlob = useCallback(
    async (blob, mimeType) => {
      const type = mimeType || blob.type
      const name = `recording.${extForMime(type)}`
      const file = new File([blob], name, { type })
      const res = await transcribeFile(file, name)
      if (res && res.text) autoSaveTranscript(res.text, res.segments)
    },
    [transcribeFile, autoSaveTranscript]
  )

  // Streaming: incremental partial transcript while recording.
  const handlePartial = useCallback((text) => setLiveText(text), [])

  // Streaming: final full transcript after Stop — render + auto-save.
  const handleFinal = useCallback(
    (text, segs) => {
      requestIdRef.current++ // invalidate any pending one-shot response
      setLiveText('')
      setLoading(false)
      setError('')
      setFileName('Live recording')
      setTranscript(text)
      setSegments(segs)
      autoSaveTranscript(text, segs)
    },
    [autoSaveTranscript]
  )

  const handleStreamNote = useCallback((msg) => setStreamNote(msg), [])

  const { recording, starting, stopping, finalizing, elapsed, recError, setRecError, start, stop, cancel } =
    useLiveRecorder({
      onBlob: handleRecordedBlob,
      onPartial: handlePartial,
      onFinal: handleFinal,
      onStreamNote: handleStreamNote,
      wsUrl: 'ws://127.0.0.1:8000/ws/transcribe'
    })

  const busy = recording || starting || stopping || finalizing

  const handleRecord = () => {
    setLiveText('')
    setStreamNote('')
    setSavedNote('')
    setError('')
    start({ useMic, useComputer })
  }

  const onDrop = useCallback(
    async (acceptedFiles) => {
      const file = acceptedFiles[0]
      if (!file) return
      transcribeFile(file, file.name)
    },
    [transcribeFile]
  )

  const formatElapsed = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = Math.floor(secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const toggleLive = () => {
    // Disabling mid-startup/recording/finalizing must abandon the session.
    if (liveEnabled && busy) cancel()
    setRecError('')
    setLiveText('')
    setLiveEnabled((v) => !v)
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'audio/*': [], 'video/*': [] },
    multiple: false
  })

  const handleCopy = () => {
    navigator.clipboard.writeText(transcript)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
    const s = Math.floor(seconds % 60).toString().padStart(2, '0')
    return `${h}:${m}:${s}`
  }

  const downloadMd = () => {
    const lines = segments.map(seg => `**[${formatTime(seg.start)}]** ${seg.text.trim()}`)
    const content = lines.join('\n\n')
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName}-transcript.md`
    a.click()
  }

  return (
    <div className="app">
      <div className="noise" />
      <header className="header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <span className="logo-text">SCRIBE</span>
        </div>
        <p className="tagline">Local AI Transcription</p>
      </header>

      <main className="main">
        <div className="hero">
          <h1 className="title">
            Turn audio into<br />
            <span className="title-accent">perfect text.</span>
          </h1>
          <p className="description">
            Powered by OpenAI Whisper — runs entirely on your machine.
            No uploads to the cloud. No data leaving your device.
          </p>
        </div>

        <div className="live-panel">
          <div className="live-head">
            <div className="live-title">
              <span className="live-dot" data-on={liveEnabled} />
              Live recording
            </div>
            <button
              type="button"
              className={`switch ${liveEnabled ? 'on' : ''}`}
              onClick={toggleLive}
              aria-pressed={liveEnabled}
              aria-label="Toggle live recording feature"
            >
              <span className="switch-knob" />
            </button>
          </div>

          {liveEnabled && (
            <div className="live-body">
              <div className="source-toggles">
                <label className="source-toggle">
                  <input
                    type="checkbox"
                    checked={useMic}
                    disabled={busy}
                    onChange={(e) => setUseMic(e.target.checked)}
                  />
                  <span>🎙 Microphone</span>
                </label>
                <label className="source-toggle">
                  <input
                    type="checkbox"
                    checked={useComputer}
                    disabled={busy}
                    onChange={(e) => setUseComputer(e.target.checked)}
                  />
                  <span>💻 Computer audio</span>
                </label>
              </div>

              <div className="live-controls">
                {recording || stopping || finalizing ? (
                  <button
                    type="button"
                    className="btn btn-stop"
                    disabled={stopping || finalizing}
                    onClick={stop}
                  >
                    {finalizing ? 'Finalizing…' : stopping ? 'Stopping…' : '■ Stop'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={loading || starting || (!useMic && !useComputer)}
                    onClick={handleRecord}
                  >
                    {starting ? 'Starting…' : '● Record'}
                  </button>
                )}
                {(recording || stopping) && (
                  <span className="rec-indicator">
                    <span className="rec-blink" /> REC {formatElapsed(elapsed)}
                  </span>
                )}
              </div>

              {(recording || finalizing) && (
                <div className="live-transcript">
                  <div className="live-transcript-head">
                    <span className="live-badge">
                      <span className="rec-blink" /> LIVE
                    </span>
                    <span>{finalizing ? 'Finalizing full transcript…' : 'Transcribing as you speak'}</span>
                  </div>
                  <div className="live-transcript-body">
                    {liveText ? (
                      liveText
                    ) : (
                      <span className="live-placeholder">
                        Listening… partial text appears every few seconds.
                      </span>
                    )}
                  </div>
                </div>
              )}

              {streamNote && <div className="live-note">{streamNote}</div>}
              {recError && <div className="error-banner live-error">{recError}</div>}
              <p className="live-hint">
                For computer audio, tick “Share tab audio” / “Share system audio” in the browser picker.
                On Stop, the final transcript auto-saves to your Downloads folder.
              </p>
            </div>
          )}
        </div>

        <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''} ${loading ? 'loading' : ''}`}>
          <input {...getInputProps()} />
          <div className="dropzone-inner">
            {loading ? (
              <>
                <div className="spinner" />
                <p className="dropzone-title">Transcribing...</p>
                <p className="dropzone-sub">{fileName}</p>
              </>
            ) : isDragActive ? (
              <>
                <span className="dropzone-icon">↓</span>
                <p className="dropzone-title">Release to transcribe</p>
              </>
            ) : (
              <>
                <span className="dropzone-icon">◎</span>
                <p className="dropzone-title">Drop your file here</p>
                <p className="dropzone-sub">or click to browse — MP3, WAV, MP4, M4A and more</p>
              </>
            )}
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {savedNote && <div className="saved-note">✓ {savedNote}</div>}

        {transcript && (
          <div className="results">
            <div className="results-header">
              <div className="results-meta">
                <span className="results-label">TRANSCRIPT</span>
                <span className="results-file">{fileName}</span>
              </div>
              <div className="results-actions">
                <button className="btn btn-ghost" onClick={handleCopy}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button className="btn btn-primary" onClick={downloadMd}>
                  Download .md
                </button>
              </div>
            </div>
            <textarea
              className="transcript-area"
              readOnly
              value={transcript}
              rows={12}
            />
          </div>
        )}
      </main>

      <footer className="footer">
        <p>Running locally · Whisper base model · Private by default</p>
      </footer>
    </div>
  )
}

// Build the same timestamped Markdown used by the manual export.
function segTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

function buildTranscriptMd(text, segments) {
  if (segments && segments.length) {
    return segments.map((seg) => `**[${segTime(seg.start)}]** ${seg.text.trim()}`).join('\n\n')
  }
  return text
}

// YYYYMMDD-HHMMSS for auto-save filenames.
function formatStamp(d) {
  const p = (n) => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

// Map the actual recorded MIME type to a container extension the backend/ffmpeg
// accepts, so a filename never mislabels its bytes.
function extForMime(mime) {
  if (!mime) return 'webm'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return 'webm'
}

export default App