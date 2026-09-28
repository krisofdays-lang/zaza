// Shared ffmpeg.wasm singleton for all client-side video work (uniqueize,
// compress, metadata tagging). Loading the core is expensive (~30 MB), so we
// keep one instance for the whole tab. Uses the single-thread UMD core, which
// works without cross-origin isolation / SharedArrayBuffer.
//
// IMPORTANT: ffmpeg.wasm is a SINGLE instance with ONE virtual filesystem and
// ONE worker — it is not reentrant. If the user fires several operations at
// once (compress + uniqueize on many clips), running them concurrently would
// corrupt each other's files or throw "called twice". So every ffmpeg job goes
// through `withFfmpeg`, which:
//   1. serializes all jobs into a global FIFO queue (one runs at a time),
//   2. hands the task a unique id for collision-free temp filenames,
//   3. attaches/detaches the progress listener per job so progress never
//      leaks across operations.

import type { FFmpeg } from "@ffmpeg/ffmpeg"

let ffmpegInstance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null

export async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg")
    const { toBlobURL } = await import("@ffmpeg/util")
    const ff = new FFmpeg()
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd"
    await ff.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    })
    ffmpegInstance = ff
    return ff
  })()
  return loadPromise
}

// Global FIFO queue. Each job waits for the previous one to finish (success or
// failure) before touching the shared ffmpeg instance.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Run an exclusive ffmpeg job. Jobs are serialized tab-wide, so any number of
 * concurrent user clicks are processed safely one after another.
 *
 * @param onProgress optional 0..1 progress callback, scoped to this job only.
 * @param task receives the ffmpeg instance and a unique id for temp filenames.
 */
export function withFfmpeg<T>(
  onProgress: ((ratio: number) => void) | undefined,
  task: (ff: FFmpeg, id: string) => Promise<T>,
): Promise<T> {
  const result = queue.then(async () => {
    const ff = await getFfmpeg()
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const handler = onProgress
      ? ({ progress }: { progress: number }) => onProgress(Math.min(1, Math.max(0, progress)))
      : null
    if (handler) ff.on("progress", handler)
    try {
      return await task(ff, id)
    } finally {
      if (handler) ff.off("progress", handler)
    }
  })
  // Keep the chain alive even if this job rejects, so the queue never wedges.
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
