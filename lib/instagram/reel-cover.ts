// Reel cover-frame extraction.
//
// The captured gallery-reel publish uploads a SECOND asset right after the video
// bytes: a JPEG cover (rupload_igphoto with cover_photo_type:"nth_frame", the
// SAME upload_id as the video, media_type:2, is_clips_video:1). It is a genuine
// decoded frame of the clip — not a separate image — so to reproduce it exactly
// we must pull a real frame out of the mp4 at publish time.
//
// There is no pure-JS way to decode an H.264/HEVC frame, so this uses the system
// `ffmpeg` binary (present on the long-lived posting server / VPS). Everything is
// BEST-EFFORT: if ffmpeg is missing or errors, callers fall back to
// extract_cover_frame:"1" (already set on the video upload), which makes the IG
// server derive the cover itself — the reel still publishes with a matching
// cover, just without the extra client request.
//
// While we have the frame decoded we also compute the `quality_hints.colors`
// block (sampled RGB averages + standard deviations) the real client sends in
// configure_to_clips, derived from a downscaled RGB copy of the same frame.

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface CoverColors {
  averages: { r: number; g: number; b: number }
  standardDeviations: { r: number; g: number; b: number }
}

export interface CoverFrame {
  jpeg: Buffer
  colors: CoverColors
}

// Neutral fallback used when we can't decode real pixels. Mid-grey with a modest
// spread — plausible values that never contradict a specific frame the way a
// wildly-off constant would.
export const NEUTRAL_COVER_COLORS: CoverColors = {
  averages: { r: 128, g: 128, b: 128 },
  standardDeviations: { r: 32, g: 32, b: 32 },
}

// Make a decoded cover JPEG's bytes unique per publish WITHOUT changing the
// image. ffmpeg decodes identical pixels from the same source frame every time,
// so two reposts of one video yield byte-identical cover JPEGs — and Instagram
// dedupes rupload_igphoto by content hash, so the second publish's cover collides
// with the first and configure_to_clips then fails. We inject a JPEG comment
// (COM, 0xFFFE) segment of random bytes right after the SOI marker: decoders
// ignore it, the image is pixel-for-pixel identical, but the file hash differs.
// The cover upload is single-shot (x-entity-length is recomputed from this
// buffer), so changing the length here is safe — unlike the resumable video
// upload, which is why the video uniquifier rewrites fixed-size timestamp fields
// instead of adding bytes.
function uniquifyJpeg(jpeg: Buffer): Buffer {
  // Must start with SOI (FF D8); if not, it isn't a JPEG we can safely touch.
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg
  const payload = randomBytes(16)
  const com = Buffer.alloc(4 + payload.length)
  com[0] = 0xff
  com[1] = 0xfe
  com.writeUInt16BE(payload.length + 2, 2) // segment length counts the 2 length bytes
  payload.copy(com, 4)
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)])
}

let ffmpegChecked = false
let ffmpegAvailable = false

// Resolve the ffmpeg binary once per process. Honors FFMPEG_PATH so operators can
// point at a bundled static binary; otherwise relies on `ffmpeg` being on PATH.
function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg"
}

function run(bin: string, args: string[], input?: Buffer, timeoutMs = 20000): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("ffmpeg timeout"))
    }, timeoutMs)
    child.stdout.on("data", (d: Buffer) => chunks.push(d))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks) })
    })
    if (input) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

// True when a usable ffmpeg binary is present. Cached after the first probe.
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegAvailable
  ffmpegChecked = true
  try {
    const { code } = await run(ffmpegBin(), ["-version"], undefined, 5000)
    ffmpegAvailable = code === 0
  } catch {
    ffmpegAvailable = false
  }
  return ffmpegAvailable
}

// Compute mean + population standard deviation per channel from a raw rgb24
// buffer (tightly packed R,G,B bytes). Rounded to integers like the capture.
function colorsFromRgb24(raw: Buffer): CoverColors {
  const px = Math.floor(raw.length / 3)
  if (px === 0) return NEUTRAL_COVER_COLORS
  let sr = 0, sg = 0, sb = 0
  for (let i = 0; i < px; i++) {
    sr += raw[i * 3]
    sg += raw[i * 3 + 1]
    sb += raw[i * 3 + 2]
  }
  const ar = sr / px, ag = sg / px, ab = sb / px
  let vr = 0, vg = 0, vb = 0
  for (let i = 0; i < px; i++) {
    vr += (raw[i * 3] - ar) ** 2
    vg += (raw[i * 3 + 1] - ag) ** 2
    vb += (raw[i * 3 + 2] - ab) ** 2
  }
  return {
    averages: { r: Math.round(ar), g: Math.round(ag), b: Math.round(ab) },
    standardDeviations: {
      r: Math.round(Math.sqrt(vr / px)),
      g: Math.round(Math.sqrt(vg / px)),
      b: Math.round(Math.sqrt(vb / px)),
    },
  }
}

// Extract a JPEG cover frame at `timeMs` (default 0) plus the color stats derived
// from that same frame. Returns null if ffmpeg is unavailable or fails, so the
// caller can fall back to server-side extract_cover_frame.
export async function extractCoverFrame(video: Buffer, timeMs = 0): Promise<CoverFrame | null> {
  if (!(await hasFfmpeg())) return null
  const seek = Math.max(0, timeMs / 1000).toFixed(3)
  let dir: string | null = null
  try {
    // ffmpeg needs a seekable input for accurate frame selection, so stage the
    // clip on disk rather than piping it in.
    dir = await mkdtemp(join(tmpdir(), "reelcover-"))
    const inPath = join(dir, "in.mp4")
    await writeFile(inPath, video)

    // 1) The JPEG cover the app uploads (quality ~70, like the capture's uikit
    //    encode). -frames:v 1 grabs a single frame at the seek point.
    const jpegPath = join(dir, "cover.jpg")
    const jpegRun = await run(
      ffmpegBin(),
      ["-y", "-ss", seek, "-i", inPath, "-frames:v", "1", "-q:v", "6", "-f", "mjpeg", jpegPath],
      undefined,
      20000,
    )
    if (jpegRun.code !== 0) return null
    const rawJpeg = await readFile(jpegPath)
    if (rawJpeg.length === 0) return null
    // Uniquify so reposting the same video doesn't collide with the first
    // publish's cover on Instagram's content-hash dedupe.
    const jpeg = uniquifyJpeg(rawJpeg)

    // 2) A tiny rgb24 copy of the same frame for cheap, decode-free color stats.
    let colors = NEUTRAL_COVER_COLORS
    try {
      const rgbRun = await run(
        ffmpegBin(),
        ["-ss", seek, "-i", inPath, "-frames:v", "1", "-vf", "scale=32:32", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
        undefined,
        20000,
      )
      if (rgbRun.code === 0 && rgbRun.stdout.length >= 3) colors = colorsFromRgb24(rgbRun.stdout)
    } catch {
      // keep neutral colors
    }

    return { jpeg, colors }
  } catch {
    return null
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
