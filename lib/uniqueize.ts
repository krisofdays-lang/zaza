// Client-side media uniqueization + compression.
//
// Images are re-rendered through a canvas with strong-but-natural RANDOM
// transforms (optional horizontal mirror, micro rotation + zoom, color grading,
// a faint gradient wash, a soft vignette/shadow and pixel noise) then re-encoded
// so the resulting file has a brand new hash and a visibly different "look".
//
// Videos are processed with ffmpeg.wasm (single-thread core, so it works
// without cross-origin isolation / SharedArrayBuffer): random hflip, a small
// rotation angle, eq color grading, a vignette, a crop/scale jiggle, a re-encode
// and stripped + randomized metadata. `compressVideo` is a separate, transform
// free pass that just shrinks the file at near-visually-lossless quality.

import { withFfmpeg } from "@/lib/ffmpeg-client"

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min
}

function chance(p: number) {
  return Math.random() < p
}

function withSuffix(name: string, suffix: string, ext?: string) {
  const dot = name.lastIndexOf(".")
  const base = dot > 0 ? name.slice(0, dot) : name
  const oldExt = dot > 0 ? name.slice(dot + 1) : ""
  return `${base}-${suffix}.${ext || oldExt || "bin"}`
}

export async function uniqueizeImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas not supported")

  // --- Random colour grade (wider than before but still natural) ----------
  const brightness = rand(0.93, 1.07)
  const contrast = rand(0.92, 1.09)
  const saturate = rand(0.9, 1.12)
  const hue = rand(-8, 8)
  ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturate}) hue-rotate(${hue}deg)`

  // --- Geometry: optional mirror + tiny rotation + slight zoom -------------
  const mirror = chance(0.5)
  const angle = rand(-1.6, 1.6) * (Math.PI / 180) // small tilt in radians
  const zoom = rand(1.03, 1.07) // covers the corners exposed by the rotation/crop
  ctx.save()
  ctx.translate(width / 2, height / 2)
  if (mirror) ctx.scale(-1, 1)
  ctx.rotate(angle)
  ctx.scale(zoom, zoom)
  // Micro-crop: nudge the source rect a couple px so framing differs too.
  const cx = Math.floor(rand(0, 4))
  const cy = Math.floor(rand(0, 4))
  const cw = width - cx - Math.floor(rand(0, 4))
  const ch = height - cy - Math.floor(rand(0, 4))
  ctx.drawImage(bitmap, cx, cy, cw, ch, -width / 2, -height / 2, width, height)
  ctx.restore()
  ctx.filter = "none"

  // --- Faint diagonal gradient wash (random warm/cool, very low alpha) -----
  const warm = chance(0.5)
  const gx = chance(0.5) ? width : 0
  const grad = ctx.createLinearGradient(0, 0, gx, height)
  if (warm) {
    grad.addColorStop(0, `rgba(255, 180, 120, ${rand(0.04, 0.09).toFixed(3)})`)
    grad.addColorStop(1, `rgba(120, 90, 200, ${rand(0.03, 0.07).toFixed(3)})`)
  } else {
    grad.addColorStop(0, `rgba(120, 170, 255, ${rand(0.04, 0.09).toFixed(3)})`)
    grad.addColorStop(1, `rgba(255, 160, 140, ${rand(0.03, 0.07).toFixed(3)})`)
  }
  ctx.globalCompositeOperation = "soft-light"
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)

  // --- Soft vignette / shadow around the edges -----------------------------
  const inner = Math.min(width, height) * rand(0.55, 0.7)
  const outer = Math.hypot(width, height) / 2
  const vignette = ctx.createRadialGradient(width / 2, height / 2, inner, width / 2, height / 2, outer)
  vignette.addColorStop(0, "rgba(0,0,0,0)")
  vignette.addColorStop(1, `rgba(0,0,0,${rand(0.1, 0.22).toFixed(3)})`)
  ctx.globalCompositeOperation = "multiply"
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = "source-over"

  // --- Faint random pixel noise so the data differs everywhere -------------
  const imgData = ctx.getImageData(0, 0, width, height)
  const data = imgData.data
  for (let i = 0; i < data.length; i += 4) {
    if (Math.random() < 0.6) {
      const d = Math.floor(rand(-3, 3))
      data[i] = Math.min(255, Math.max(0, data[i] + d))
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + d))
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + d))
    }
  }
  ctx.putImageData(imgData, 0, 0)

  const isPng = file.type.includes("png")
  const type = isPng ? "image/png" : "image/jpeg"
  const quality = isPng ? undefined : rand(0.86, 0.96)
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality),
  )
  bitmap.close()
  return new File([blob], withSuffix(file.name, "uniq", isPng ? "png" : "jpg"), { type })
}

export async function uniqueizeVideo(file: File, onProgress?: (ratio: number) => void): Promise<File> {
  const { fetchFile } = await import("@ffmpeg/util")
  const data = await fetchFile(file)

  return withFfmpeg(onProgress, async (ff, id) => {
    // Unique temp names so overlapping jobs can never clobber each other.
    const inName = `uniq-in-${id}.mp4`
    const outName = `uniq-out-${id}.mp4`
    await ff.writeFile(inName, data)

    // Random colour grade.
    const brightness = rand(-0.06, 0.06).toFixed(3)
    const contrast = rand(0.95, 1.06).toFixed(3)
    const saturation = rand(0.94, 1.08).toFixed(3)
    const gamma = rand(0.95, 1.05).toFixed(3)
    // Small random rotation; zoom in a touch so the rotated frame still fills.
    const angleDeg = rand(-2, 2)
    const angleRad = (angleDeg * Math.PI) / 180
    const mirror = chance(0.5)
    const crf = String(Math.floor(rand(22, 26)))
    const tag = Math.random().toString(36).slice(2, 10)

    // Filter chain: (optional hflip) -> colour eq -> rotate (zoomed) -> vignette
    // -> 2px crop/scale jiggle. scale=iw*1.06 first hides the rotation corners.
    const parts: string[] = []
    if (mirror) parts.push("hflip")
    parts.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:gamma=${gamma}`)
    parts.push("scale=iw*1.06:ih*1.06")
    parts.push(`rotate=${angleRad.toFixed(5)}:fillcolor=none`)
    parts.push("crop=iw/1.06:ih/1.06")
    parts.push(`vignette=PI/${Math.floor(rand(5, 8))}`)
    parts.push("crop=iw-2:ih-2:1:1")

    await ff.exec([
      "-i",
      inName,
      "-vf",
      parts.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      crf,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-map_metadata",
      "-1",
      "-metadata",
      `comment=${tag}`,
      "-movflags",
      "+faststart",
      outName,
    ])

    const out = await ff.readFile(outName)
    await ff.deleteFile(inName)
    await ff.deleteFile(outName)
    const blob = new Blob([out as Uint8Array], { type: "video/mp4" })
    return new File([blob], withSuffix(file.name, "uniq", "mp4"), { type: "video/mp4" })
  })
}

// Shrink a video at near-visually-lossless quality. No look-changing transforms:
// just an efficient H.264 re-encode (CRF ~24, slower preset for better
// compression), capping very large frames to 1080px on the long edge and
// down-mixing audio to a sane bitrate. Good for trimming file size before
// uploading/posting.
export async function compressVideo(file: File, onProgress?: (ratio: number) => void): Promise<File> {
  const { fetchFile } = await import("@ffmpeg/util")
  const data = await fetchFile(file)

  return withFfmpeg(onProgress, async (ff, id) => {
    const inName = `min-in-${id}.mp4`
    const outName = `min-out-${id}.mp4`
    await ff.writeFile(inName, data)

    await ff.exec([
      "-i",
      inName,
      // Only downscale if larger than 1080 on the long edge; never upscale.
      "-vf",
      "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outName,
    ])

    const out = await ff.readFile(outName)
    await ff.deleteFile(inName)
    await ff.deleteFile(outName)
    const blob = new Blob([out as Uint8Array], { type: "video/mp4" })
    return new File([blob], withSuffix(file.name, "min", "mp4"), { type: "video/mp4" })
  })
}

export async function uniqueizeFile(
  file: File,
  kind: "image" | "video",
  onProgress?: (ratio: number) => void,
): Promise<File> {
  return kind === "video" ? uniqueizeVideo(file, onProgress) : uniqueizeImage(file)
}
