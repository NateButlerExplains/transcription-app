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
 */
export function useLiveRecorder({ onBlob } = {}) {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [recError, setRecError] = useState('')

  const audioCtxRef = useRef(null)
  const destRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const streamsRef = useRef([]) // all raw MediaStreams to stop (mic + display)
  const timerRef = useRef(null)
  const mimeRef = useRef('')

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    // Stop every track from every captured stream (releases mic + screen-share).
    streamsRef.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop())
    })
    streamsRef.current = []
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
    destRef.current = null
    recorderRef.current = null
  }, [])

  // Release everything if the component unmounts mid-recording.
  useEffect(() => cleanup, [cleanup])

  const pickMimeType = () => {
    const preferred = 'audio/webm;codecs=opus'
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(preferred)) {
      return preferred
    }
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.('audio/webm')) {
      return 'audio/webm'
    }
    return '' // let the browser choose its default
  }

  const start = useCallback(
    async ({ useMic, useComputer }) => {
      setRecError('')

      if (!useMic && !useComputer) {
        setRecError('Select at least one audio source (Microphone or Computer).')
        return
      }
      if (!navigator.mediaDevices) {
        setRecError('Audio capture is not supported in this browser.')
        return
      }

      const captured = []
      const sourceStreams = []

      try {
        if (useMic) {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
          captured.push(micStream)
          sourceStreams.push(micStream)
        }

        if (useComputer) {
          if (!navigator.mediaDevices.getDisplayMedia) {
            throw makeError('unsupported-display', 'Computer audio capture is not supported in this browser (try Chrome or Edge).')
          }
          // Video must be requested for the browser to expose tab/system audio.
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
          captured.push(displayStream)

          const audioTracks = displayStream.getAudioTracks()
          if (audioTracks.length === 0) {
            // User forgot to tick "Share audio" in the picker.
            displayStream.getTracks().forEach((t) => t.stop())
            captured.pop()
            throw makeError(
              'no-computer-audio',
              'No computer audio track was shared. Re-try and enable "Share tab audio" / "Share system audio" in the picker.'
            )
          }

          // Keep only the audio; drop the video track we were forced to request.
          const audioOnly = new MediaStream(audioTracks)
          displayStream.getVideoTracks().forEach((t) => t.stop())
          sourceStreams.push(audioOnly)
        }
      } catch (err) {
        // Stop anything we already opened before failing.
        captured.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        setRecError(describeCaptureError(err))
        return
      }

      // Mix all sources into a single destination stream.
      let ctx
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        ctx = new AudioCtx()
        const dest = ctx.createMediaStreamDestination()
        sourceStreams.forEach((stream) => {
          ctx.createMediaStreamSource(stream).connect(dest)
        })

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
          cleanup()
          setRecording(false)
          setElapsed(0)
          if (blob.size > 0) onBlob?.(blob, type)
        }

        audioCtxRef.current = ctx
        destRef.current = dest
        recorderRef.current = recorder
        streamsRef.current = captured

        recorder.start()
        setRecording(true)
        setElapsed(0)
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
      } catch (err) {
        captured.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
        setRecError('Could not start recording: ' + (err?.message || 'unknown error'))
      }
    },
    [cleanup, onBlob]
  )

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop() // fires onstop -> builds blob + cleanup
    } else {
      cleanup()
      setRecording(false)
      setElapsed(0)
    }
  }, [cleanup])

  return { recording, elapsed, recError, setRecError, start, stop }
}

function makeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function describeCaptureError(err) {
  if (err?.code === 'unsupported-display' || err?.code === 'no-computer-audio') {
    return err.message
  }
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return 'Permission denied. Allow microphone / screen-audio access to record.'
  }
  if (err?.name === 'NotFoundError') {
    return 'No matching audio device was found.'
  }
  return 'Could not access audio: ' + (err?.message || 'unknown error')
}
