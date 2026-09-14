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
 * Lifecycle guarantees:
 *  - Startup runs through a 'starting' status behind a sync busy guard, so a
 *    second session can never begin while one is starting/active/stopping.
 *  - Every acquired resource (input stream, AudioContext, destination) is
 *    registered for cancellation the moment it exists — a cancel()/unmount mid
 *    startup stops it immediately (no stuck mic light / screen-share banner).
 *  - A monotonic start token owns the guard/status/committed refs: only the
 *    CURRENT token may release the busy guard or mutate shared state, so a
 *    stale startup completion stops only the streams it locally acquired and
 *    touches nothing shared.
 *  - stop() is idempotent: a committed recorder is allowed to finish delivering
 *    its blob; a second Stop is a no-op, never a discard.
 */
export function useLiveRecorder({ onBlob } = {}) {
  // 'idle' | 'starting' | 'recording' | 'stopping'
  const [status, setStatus] = useState('idle')
  const [elapsed, setElapsed] = useState(0)
  const [recError, setRecError] = useState('')

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

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  // Stop a bundle of resources: destination output tracks, input tracks, ctx.
  // Stopping the destination stream's OWN tracks is required — closing the
  // AudioContext is not a substitute.
  const stopBundle = (streams, ctx, dest) => {
    if (dest?.stream) dest.stream.getTracks().forEach((t) => t.stop())
    streams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }

  // Tear down BOTH the committed session and any in-flight startup resources.
  // `deliver=false` detaches recorder handlers so no blob is emitted
  // (cancel/unmount); the normal stop() path passes true so onstop delivers.
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
      // Block re-entry: never begin a second session while one is
      // starting / active / stopping.
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

      // Own in-flight resources from the moment they exist so cancel()/unmount
      // can release them even mid-await.
      const inflight = { streams: [], ctx: null, dest: null }
      inflightRef.current = inflight
      const sourceStreams = [] // audio-only streams feeding the mixer

      // Stop only what THIS startup locally acquired; touch shared state only
      // when still the current token.
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
        // B3: request display capture FIRST, straight off the click gesture, so a
        // slow mic prompt cannot consume the transient user activation it needs.
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

      // Mix all sources into a single destination stream, then record it.
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const ctx = new AudioCtx()
        inflight.ctx = ctx // owned for cancellation before we await resume()
        const dest = ctx.createMediaStreamDestination()
        inflight.dest = dest
        sourceStreams.forEach((stream) => ctx.createMediaStreamSource(stream).connect(dest))

        // B4: a context created suspended after the prompts records silence.
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

        chunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.onstop = () => {
          if (!isCurrent()) return
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
          if (!isCurrent()) return
          releaseResources(false)
          busyRef.current = false
          setStatus('idle')
          setElapsed(0)
          setRecError('Recording failed unexpectedly. Please try again.')
        }

        // If a source track ends (user stops screen share mid-record), stop the
        // session instead of timing over silence.
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

        // Commit the session: ownership moves from inflight to the committed refs.
        audioCtxRef.current = ctx
        destRef.current = dest
        recorderRef.current = recorder
        streamsRef.current = inflight.streams
        inflightRef.current = null

        recorder.start()
        setStatus('recording')
        setElapsed(0)
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
      } catch (err) {
        if (isCurrent()) {
          // May have already committed to the shared refs (e.g. recorder.start()
          // threw). Fully tear down committed refs + detach handlers so no stale
          // recorder survives to break the next session's stop().
          releaseResources(false)
          setRecError('Could not start recording: ' + (err?.message || 'unknown error'))
          busyRef.current = false
          setStatus('idle')
        } else {
          // Stale token: touch nothing shared — clean up only what we acquired.
          stopBundle(inflight.streams, inflight.ctx, inflight.dest)
          if (inflightRef.current === inflight) inflightRef.current = null
        }
      }
    },
    [releaseResources, onBlob]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder) {
      // Committed session. Let it finish delivering; a second Stop is a no-op.
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        setStatus('stopping')
        recorder.stop() // onstop builds the blob + releaseResources
      }
      return
    }
    // No committed recorder: only a 'starting' session (nothing to deliver) or
    // nothing at all. Abandon a starting session.
    if (busyRef.current) cancel()
  }, [cancel])

  return {
    status,
    recording: status === 'recording',
    starting: status === 'starting',
    stopping: status === 'stopping',
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
