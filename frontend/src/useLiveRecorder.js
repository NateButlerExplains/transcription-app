import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live audio recorder that mixes microphone and/or computer (system/tab) audio
 * into a single MediaStream via the Web Audio API, records it with MediaRecorder,
 * and hands the resulting Blob back to the caller on stop.
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
 * Lifecycle: startup runs through a 'starting' status that blocks re-entry, and
 * is cancellable via a monotonically increasing start token — if the feature is
 * disabled or the component unmounts before startup commits, the in-flight
 * streams are stopped and nothing is written to the committed refs.
 */
export function useLiveRecorder({ onBlob } = {}) {
  // 'idle' | 'starting' | 'recording'
  const [status, setStatus] = useState('idle')
  const [elapsed, setElapsed] = useState(0)
  const [recError, setRecError] = useState('')

  // Committed session refs (only written once a session is fully started).
  const audioCtxRef = useRef(null)
  const destRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamsRef = useRef([]) // raw input MediaStreams to stop (mic + display)
  const timerRef = useRef(null)
  const mimeRef = useRef('')

  // Re-entry guard (sync) + cancellation token for in-flight startup.
  const busyRef = useRef(false)
  const startTokenRef = useRef(0)

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  // Tear down a COMMITTED session: recorder + destination output + input streams
  // + AudioContext. `deliver=false` detaches handlers so no blob is emitted
  // (used for cancel/unmount); the normal stop() path delivers via onstop.
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
    // Stop the destination's OWN output track (closing the ctx is not enough).
    if (destRef.current?.stream) {
      destRef.current.stream.getTracks().forEach((t) => t.stop())
    }
    // Stop every input track (releases mic + screen-share indicator).
    streamsRef.current.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))
    streamsRef.current = []
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
    destRef.current = null
    recorderRef.current = null
  }, [])

  // Abandon the current session/startup without emitting a blob.
  const cancel = useCallback(() => {
    startTokenRef.current += 1 // invalidate any in-flight startup
    releaseResources(false)
    busyRef.current = false
    setStatus('idle')
    setElapsed(0)
  }, [releaseResources])

  // Release everything if the component unmounts mid-startup/recording.
  useEffect(() => {
    return () => {
      startTokenRef.current += 1
      releaseResources(false)
      busyRef.current = false
    }
  }, [releaseResources])

  const pickMimeType = () => {
    const preferred = 'audio/webm;codecs=opus'
    const has = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)
    if (has(preferred)) return preferred
    if (has('audio/webm')) return 'audio/webm'
    return '' // let the browser choose its default
  }

  const start = useCallback(
    async ({ useMic, useComputer }) => {
      // Block re-entry: never begin a second session while one is starting/active.
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
      const isStale = () => startTokenRef.current !== myToken
      setStatus('starting')

      // Streams held locally until the session is fully committed to refs.
      const captured = [] // every raw stream we opened (for cleanup on failure)
      const sourceStreams = [] // audio-only streams that feed the mixer

      const abort = (userError) => {
        captured.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        if (!isStale()) {
          if (userError) setRecError(userError)
          busyRef.current = false
          setStatus('idle')
        } else {
          // Cancelled mid-startup: streams stopped above, stay idle silently.
          busyRef.current = false
        }
      }

      try {
        // B3: request display capture FIRST, straight off the click gesture, so a
        // slow mic prompt cannot consume the transient user activation it needs.
        if (useComputer) {
          if (!navigator.mediaDevices.getDisplayMedia) {
            return abort('Computer audio capture is not supported in this browser (try Chrome or Edge).')
          }
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
          captured.push(displayStream)
          if (isStale()) return abort()

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
          captured.push(micStream)
          if (isStale()) return abort()
          sourceStreams.push(micStream)
        }
      } catch (err) {
        return abort(describeCaptureError(err))
      }

      // Mix all sources into a single destination stream, then record it.
      let ctx
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        ctx = new AudioCtx()
        const dest = ctx.createMediaStreamDestination()
        sourceStreams.forEach((stream) => ctx.createMediaStreamSource(stream).connect(dest))

        // B4: a context created suspended after the prompts records silence.
        if (ctx.state === 'suspended') await ctx.resume()
        if (isStale()) {
          if (ctx.state !== 'closed') ctx.close().catch(() => {})
          return abort()
        }
        if (ctx.state !== 'running') {
          if (ctx.state !== 'closed') ctx.close().catch(() => {})
          return abort('Could not start the audio engine (context not running).')
        }

        const mimeType = pickMimeType()
        mimeRef.current = mimeType
        const recorder = mimeType
          ? new MediaRecorder(dest.stream, { mimeType })
          : new MediaRecorder(dest.stream)

        chunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.onstop = () => {
          const type = mimeRef.current || (chunksRef.current[0]?.type ?? 'audio/webm')
          const blob = new Blob(chunksRef.current, { type })
          chunksRef.current = []
          releaseResources(true)
          busyRef.current = false
          setStatus('idle')
          setElapsed(0)
          if (blob.size > 0) onBlob?.(blob, type)
        }
        recorder.onerror = () => {
          releaseResources(false)
          busyRef.current = false
          setStatus('idle')
          setElapsed(0)
          setRecError('Recording failed unexpectedly. Please try again.')
        }

        // Suggestion: if a source track ends (user stops screen share mid-record),
        // stop the session instead of timing over silence.
        sourceStreams.forEach((stream) =>
          stream.getTracks().forEach((track) => {
            track.onended = () => {
              if (recorderRef.current === recorder && recorder.state !== 'inactive') {
                recorder.stop()
              }
            }
          })
        )

        // Commit the session to the shared refs.
        audioCtxRef.current = ctx
        destRef.current = dest
        recorderRef.current = recorder
        streamsRef.current = captured

        recorder.start()
        setStatus('recording')
        setElapsed(0)
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
      } catch (err) {
        captured.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
        if (!isStale()) {
          setRecError('Could not start recording: ' + (err?.message || 'unknown error'))
          busyRef.current = false
          setStatus('idle')
        } else {
          busyRef.current = false
        }
      }
    },
    [releaseResources, onBlob]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop() // fires onstop -> builds blob + releaseResources
    } else {
      // Nothing committed yet (still starting): abandon it.
      cancel()
    }
  }, [cancel])

  return {
    status,
    recording: status === 'recording',
    starting: status === 'starting',
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
