import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live audio recorder that mixes microphone and/or computer (system/tab) audio
 * into a single MediaStream via the Web Audio API, records it with MediaRecorder,
 * streams the growing recording to the backend over a WebSocket for near-live
 * transcription, and hands the final transcript (or a fallback Blob) to the
 * caller on stop.
 *
 * Sources:
 *  - Microphone: navigator.mediaDevices.getUserMedia({ audio: true })
 *  - Computer:   navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
 *                (a video track must be requested for tab/system audio; we keep
 *                 only the audio track and stop the video track immediately)
 *
 * Mixing: AudioContext + one MediaStreamAudioSourceNode per source, all wired
 * into a single MediaStreamAudioDestinationNode whose stream is recorded.
 *
 * Streaming: MediaRecorder runs with a 1s timeslice; each webm chunk is sent
 * over the WebSocket as produced. The server emits {type:'partial'} updates
 * (onPartial) while recording and a {type:'final'} full transcript (onFinal)
 * after 'stop'. If the socket never opens or errors, we fall back to the
 * one-shot POST path via onBlob and report it through onStreamNote.
 *
 * Lifecycle guarantees (preserved across review rounds):
 *  - 'starting' status behind a sync busy guard; no overlapping sessions.
 *  - Every acquired resource is owned for cancellation the moment it exists.
 *  - A monotonic start token owns the guard/status/committed refs; a stale
 *    startup completion touches nothing shared.
 *  - stop() is idempotent; a committed recorder finishes delivering.
 *  - cancel()/unmount stops all tracks, closes the AudioContext, and closes the
 *    WebSocket without delivering a blob.
 */
const FALLBACK_UNAVAILABLE =
  'Live transcription unavailable — the full transcript will appear after you stop.'

export function useLiveRecorder({ onBlob, onPartial, onFinal, onStreamNote, onAbort, wsUrl } = {}) {
  // 'idle' | 'starting' | 'recording' | 'stopping' | 'finalizing'
  const [status, setStatus] = useState('idle')
  const [elapsed, setElapsed] = useState(0)
  const [recError, setRecError] = useState('')

  // Latest callbacks kept in a ref so handler identities never churn deps.
  const cbRef = useRef({ onBlob, onPartial, onFinal, onStreamNote, onAbort })
  useEffect(() => {
    cbRef.current = { onBlob, onPartial, onFinal, onStreamNote, onAbort }
  }, [onBlob, onPartial, onFinal, onStreamNote, onAbort])

  // Committed session refs (written only once a session is fully started).
  const audioCtxRef = useRef(null)
  const destRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamsRef = useRef([]) // raw input MediaStreams (mic + display)
  const timerRef = useRef(null)
  const mimeRef = useRef('')

  // In-flight (starting, not yet committed) resources — owned for cancellation.
  const inflightRef = useRef(null) // { streams:[], ctx, dest }

  // Re-entry guard (sync) + cancellation token for in-flight startup.
  const busyRef = useRef(false)
  const startTokenRef = useRef(0)

  // Streaming state.
  const wsRef = useRef(null)
  const sendQueueRef = useRef([]) // chunks awaiting an OPEN socket
  const streamOkRef = useRef(false) // socket reached OPEN and hasn't errored
  const finalizedRef = useRef(false) // final delivered (or fallback done)
  const finalizingRef = useRef(false) // stop sent, awaiting final
  const pendingBlobRef = useRef(null) // { blob, type } for fallback delivery
  const streamNotedRef = useRef(false) // a fallback note already shown this session

  // Show exactly one fallback note per session (never zero, never conflicting).
  const noteFallback = useCallback((msg) => {
    if (streamNotedRef.current) return
    streamNotedRef.current = true
    cbRef.current.onStreamNote?.(msg)
  }, [])

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const closeWs = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
      } catch {
        // ignore
      }
    }
    wsRef.current = null
    sendQueueRef.current = []
  }, [])

  const flushQueue = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const q = sendQueueRef.current
    while (q.length) {
      try {
        ws.send(q.shift())
      } catch {
        break
      }
    }
  }, [])

  // Stop a bundle of resources: destination output tracks, input tracks, ctx.
  const stopBundle = (streams, ctx, dest) => {
    if (dest?.stream) dest.stream.getTracks().forEach((t) => t.stop())
    streams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }

  // Tear down BOTH the committed session and any in-flight startup resources.
  const releaseResources = useCallback((deliver) => {
    clearTimer()
    const recorder = recorderRef.current
    if (recorder) {
      if (!deliver) {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
      }
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // ignore
        }
      }
    }
    stopBundle(streamsRef.current, audioCtxRef.current, destRef.current)
    streamsRef.current = []
    audioCtxRef.current = null
    destRef.current = null
    recorderRef.current = null

    const inf = inflightRef.current
    if (inf) {
      stopBundle(inf.streams, inf.ctx, inf.dest)
      inflightRef.current = null
    }
  }, [])

  // Fallback: stream ended before a final arrived — transcribe the local blob.
  const finalizeFallback = useCallback(() => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    finalizingRef.current = false
    const pb = pendingBlobRef.current
    pendingBlobRef.current = null
    closeWs()
    busyRef.current = false
    setStatus('idle')
    noteFallback('Live stream ended early — transcribing the full recording.')
    if (pb && pb.blob.size > 0) cbRef.current.onBlob?.(pb.blob, pb.type)
  }, [closeWs, noteFallback])

  const handleWsMessage = useCallback(
    (ev) => {
      if (finalizedRef.current) return
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'partial') {
        cbRef.current.onPartial?.(msg.text || '', msg.segments || [])
      } else if (msg.type === 'final') {
        finalizedRef.current = true
        finalizingRef.current = false
        pendingBlobRef.current = null // release the buffered fallback blob
        closeWs()
        busyRef.current = false
        setStatus('idle')
        setElapsed(0)
        cbRef.current.onFinal?.(msg.text || '', msg.segments || [])
      }
    },
    [closeWs]
  )

  // Abandon the current session/startup without emitting a blob or a final.
  const cancel = useCallback(() => {
    startTokenRef.current += 1 // invalidate any in-flight startup
    finalizedRef.current = true // ignore any late ws final
    finalizingRef.current = false
    pendingBlobRef.current = null
    chunksRef.current = [] // release retained audio buffers
    closeWs()
    releaseResources(false)
    busyRef.current = false
    setStatus('idle')
    setElapsed(0)
    // Let App invalidate any in-flight one-shot fallback POST + auto-save.
    cbRef.current.onAbort?.()
  }, [closeWs, releaseResources])

  // Release everything if the component unmounts mid-startup/recording.
  useEffect(() => {
    return () => {
      startTokenRef.current += 1
      finalizedRef.current = true
      pendingBlobRef.current = null
      chunksRef.current = []
      closeWs()
      releaseResources(false)
      busyRef.current = false
      cbRef.current.onAbort?.()
    }
  }, [closeWs, releaseResources])

  const pickMimeType = () => {
    const preferred = 'audio/webm;codecs=opus'
    const has = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)
    if (has(preferred)) return preferred
    if (has('audio/webm')) return 'audio/webm'
    return '' // let the browser choose its default
  }

  const start = useCallback(
    async ({ useMic, useComputer }) => {
      if (busyRef.current) return
      setRecError('')

      if (!useMic && !useComputer) {
        setRecError('Select at least one audio source (Microphone or Computer).')
        return
      }
      if (!navigator.mediaDevices) {
        setRecError('Audio capture is not supported in this browser.')
        return
      }

      busyRef.current = true
      const myToken = ++startTokenRef.current
      const isCurrent = () => startTokenRef.current === myToken
      setStatus('starting')

      const inflight = { streams: [], ctx: null, dest: null }
      inflightRef.current = inflight
      const sourceStreams = []

      const abort = (userError) => {
        stopBundle(inflight.streams, inflight.ctx, inflight.dest)
        if (inflightRef.current === inflight) inflightRef.current = null
        if (isCurrent()) {
          if (userError) setRecError(userError)
          busyRef.current = false
          setStatus('idle')
        }
      }

      try {
        // B3: request display capture FIRST, off the click gesture.
        if (useComputer) {
          if (!navigator.mediaDevices.getDisplayMedia) {
            return abort('Computer audio capture is not supported in this browser (try Chrome or Edge).')
          }
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
          inflight.streams.push(displayStream)
          if (!isCurrent()) return abort()

          const audioTracks = displayStream.getAudioTracks()
          if (audioTracks.length === 0) {
            return abort(
              'No computer audio track was shared. Re-try and enable "Share tab audio" / "Share system audio" in the picker.'
            )
          }
          const audioOnly = new MediaStream(audioTracks)
          displayStream.getVideoTracks().forEach((t) => t.stop())
          sourceStreams.push(audioOnly)
        }

        if (useMic) {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          inflight.streams.push(micStream)
          if (!isCurrent()) return abort()
          sourceStreams.push(micStream)
        }
      } catch (err) {
        return abort(describeCaptureError(err))
      }

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const ctx = new AudioCtx()
        inflight.ctx = ctx
        const dest = ctx.createMediaStreamDestination()
        inflight.dest = dest
        sourceStreams.forEach((stream) => ctx.createMediaStreamSource(stream).connect(dest))

        // B4: resume a context that came up suspended (else it records silence).
        if (ctx.state === 'suspended') await ctx.resume()
        if (!isCurrent()) return abort()
        if (ctx.state !== 'running') {
          return abort('Could not start the audio engine (context not running).')
        }

        const mimeType = pickMimeType()
        mimeRef.current = mimeType
        const recorder = mimeType
          ? new MediaRecorder(dest.stream, { mimeType })
          : new MediaRecorder(dest.stream)

        // Reset streaming state for this session.
        finalizedRef.current = false
        finalizingRef.current = false
        streamOkRef.current = false
        streamNotedRef.current = false
        sendQueueRef.current = []
        pendingBlobRef.current = null
        chunksRef.current = []

        // Open the streaming socket (best effort — one-shot fallback otherwise).
        if (wsUrl && typeof WebSocket !== 'undefined') {
          try {
            const ws = new WebSocket(wsUrl)
            wsRef.current = ws
            ws.onopen = () => {
              streamOkRef.current = true
              flushQueue()
            }
            ws.onmessage = handleWsMessage
            ws.onerror = () => {
              // Note only when it never worked; a mid/late failure is announced
              // by the eventual fallback (onstop else / finalizeFallback).
              if (!streamOkRef.current) noteFallback(FALLBACK_UNAVAILABLE)
              streamOkRef.current = false
            }
            ws.onclose = () => {
              streamOkRef.current = false
              // If we've asked for the final and never got it, fall back.
              if (finalizingRef.current) finalizeFallback()
            }
          } catch {
            wsRef.current = null
            noteFallback(FALLBACK_UNAVAILABLE)
          }
        }

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunksRef.current.push(e.data)
            if (wsRef.current) {
              sendQueueRef.current.push(e.data)
              flushQueue()
            }
          }
        }
        recorder.onstop = () => {
          if (!isCurrent()) return
          const type = mimeRef.current || (chunksRef.current[0]?.type ?? 'audio/webm')
          const blob = new Blob(chunksRef.current, { type })
          chunksRef.current = []
          releaseResources(true) // stops tracks/ctx; does NOT touch the socket
          setElapsed(0)

          const ws = wsRef.current
          if (ws && streamOkRef.current && ws.readyState === WebSocket.OPEN) {
            // Stream the tail, ask for the final, keep the socket open for it.
            pendingBlobRef.current = { blob, type }
            finalizingRef.current = true
            setStatus('finalizing')
            flushQueue()
            try {
              ws.send('stop')
            } catch {
              finalizeFallback()
            }
          } else {
            // No healthy stream (never opened, still connecting, or closed) —
            // one-shot fallback. Ensure the user is told live text was skipped.
            finalizedRef.current = true
            busyRef.current = false
            setStatus('idle')
            closeWs()
            noteFallback(FALLBACK_UNAVAILABLE)
            if (blob.size > 0) cbRef.current.onBlob?.(blob, type)
          }
        }
        recorder.onerror = () => {
          if (!isCurrent()) return
          finalizedRef.current = true
          closeWs()
          releaseResources(false)
          busyRef.current = false
          setStatus('idle')
          setElapsed(0)
          setRecError('Recording failed unexpectedly. Please try again.')
        }

        // Auto-stop if a source track ends (user stops screen share mid-record).
        sourceStreams.forEach((stream) =>
          stream.getTracks().forEach((track) => {
            track.onended = () => {
              if (recorderRef.current === recorder && recorder.state === 'recording') {
                setStatus('stopping')
                recorder.stop()
              }
            }
          })
        )

        // Commit the session: ownership moves to the committed refs.
        audioCtxRef.current = ctx
        destRef.current = dest
        recorderRef.current = recorder
        streamsRef.current = inflight.streams
        inflightRef.current = null

        recorder.start(1000) // 1s timeslice -> periodic chunks for streaming
        setStatus('recording')
        setElapsed(0)
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
      } catch (err) {
        if (isCurrent()) {
          finalizedRef.current = true
          closeWs()
          releaseResources(false)
          setRecError('Could not start recording: ' + (err?.message || 'unknown error'))
          busyRef.current = false
          setStatus('idle')
        } else {
          stopBundle(inflight.streams, inflight.ctx, inflight.dest)
          if (inflightRef.current === inflight) inflightRef.current = null
        }
      }
    },
    [releaseResources, closeWs, flushQueue, handleWsMessage, finalizeFallback, noteFallback, wsUrl]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder) {
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        setStatus('stopping')
        recorder.stop() // onstop finalizes; a second Stop is a no-op
      }
      return
    }
    if (busyRef.current) cancel()
  }, [cancel])

  return {
    status,
    recording: status === 'recording',
    starting: status === 'starting',
    stopping: status === 'stopping',
    finalizing: status === 'finalizing',
    elapsed,
    recError,
    setRecError,
    start,
    stop,
    cancel
  }
}

function describeCaptureError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return 'Permission denied. Allow microphone / screen-audio access to record.'
  }
  if (err?.name === 'NotFoundError') {
    return 'No matching audio device was found.'
  }
  if (err?.name === 'NotSupportedError') {
    return 'Computer audio capture is not supported in this browser (try Chrome or Edge).'
  }
  return 'Could not access audio: ' + (err?.message || 'unknown error')
}
