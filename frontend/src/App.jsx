import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import './App.css'

function App() {
  const [transcript, setTranscript] = useState('')
  const [segments, setSegments] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [copied, setCopied] = useState(false)

  const onDrop = useCallback(async (acceptedFiles) => {
    const file = acceptedFiles[0]
    if (!file) return
    setFileName(file.name)
    setLoading(true)
    setError('')
    setTranscript('')
    setSegments([])
    const formData = new FormData()
    formData.append('file', file)
    try {
      const response = await axios.post('http://127.0.0.1:8000/transcribe', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      setTranscript(response.data.text)
      setSegments(response.data.segments)
    } catch (err) {
      setError('Transcription failed. Make sure the backend is running.')
    } finally {
      setLoading(false)
    }
  }, [])

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

export default App