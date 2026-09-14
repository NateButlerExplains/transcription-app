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

  // B5: only the most-recent transcription request may write the display.
  const requestIdRef = useRef(0)

  // Shared transcription: send any File/Blob to the backend and render results.
  const transcribeFile = useCallback(async (file, displayName) => {
    if (!file) return
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
      if (requestIdRef.current !== myId) return // stale response, ignore
      setTranscript(response.data.text)
      setSegments(response.data.segments)
    } catch {
      if (requestIdRef.current !== myId) return
      setError('Transcription failed. Make sure the backend is running.')
    } finally {
      if (requestIdRef.current === myId) setLoading(false)
    }
  }, [])

  const handleRecordedBlob = useCallback(
    (blob, mimeType) => {
      const type = mimeType || blob.type
      const name = `recording.${extForMime(type)}`
      const file = new File([blob], name, { type })
      transcribeFile(file, name)
    },
    [transcribeFile]
  )

  const { recording, starting, stopping, elapsed, recError, setRecError, start, stop, cancel } =
    useLiveRecorder({ onBlob: handleRecordedBlob })

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
    // Disabling mid-startup or mid-recording must abandon the in-flight session.
    if (liveEnabled && (recording || starting || stopping)) cancel()
    setRecError('')
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
                    disabled={recording}
                    onChange={(e) => setUseMic(e.target.checked)}
                  />
                  <span>🎙 Microphone</span>
                </label>
                <label className="source-toggle">
                  <input
                    type="checkbox"
                    checked={useComputer}
                    disabled={recording}
                    onChange={(e) => setUseComputer(e.target.checked)}
                  />
                  <span>💻 Computer audio</span>
                </label>
              </div>

              <div className="live-controls">
                {recording || stopping ? (
                  <button
                    type="button"
                    className="btn btn-stop"
                    disabled={stopping}
                    onClick={stop}
                  >
                    {stopping ? 'Stopping…' : '■ Stop'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={loading || starting || (!useMic && !useComputer)}
                    onClick={() => start({ useMic, useComputer })}
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

              {recError && <div className="error-banner live-error">{recError}</div>}
              <p className="live-hint">
                For computer audio, tick “Share tab audio” / “Share system audio” in the browser picker.
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