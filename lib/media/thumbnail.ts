import "server-only"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import sharp from "sharp"
import ffmpegStatic from "ffmpeg-static"
import { MEDIA_ROOT, absPathFor } from "@/lib/media/storage"

const execFileP = promisify(execFile)

// ---------------------------------------------------------------------------
// Lightweight image thumbnails for the storage library + media pickers.
//
// The grid used to load full-resolution originals (multi-MB each) into dozens
// of <img> cells at once. Even after streaming/Range fixes, the browser still
// had to download and decode every full image, which froze the tab. Here we
// generate a small webp thumbnail once, cache it on disk, and serve that to the
// grid instead. Originals are still served (unresized) for the full preview.
//
// Cache lives under <MEDIA_ROOT>/.thumbs/<relPath>.webp — a sibling to the user
// dirs, so it never mixes with real uploads and can be safely wiped.
// ---------------------------------------------------------------------------

const THUMB_ROOT = path.join(MEDIA_ROOT, ".thumbs")
const THUMB_WIDTH = 480 // enough for a crisp grid cell on hi-dpi, tiny in bytes

function thumbAbsPath(relPath: string): string {
  // Keep the per-user partitioning and append .webp so multiple sizes/formats
  // could coexist later. relPath is already validated by absPathFor callers.
  const safeRel = relPath.replace(/\.\.(?:[\\/]|$)/g, "_")
  return path.join(THUMB_ROOT, `${safeRel}.webp`)
}

// Returns the absolute path to a cached webp thumbnail for the given image,
// generating (and caching) it on first request. Returns null if the source is
// missing or cannot be decoded as an image.
export async function getOrCreateImageThumb(relPath: string): Promise<string | null> {
  const src = absPathFor(relPath)
  const out = thumbAbsPath(relPath)

  // Serve the cached thumb if it's newer than (or same age as) the source.
  try {
    const [srcStat, thumbStat] = await Promise.all([fs.stat(src), fs.stat(out)])
    if (thumbStat.isFile() && thumbStat.mtimeMs >= srcStat.mtimeMs) return out
  } catch {
    // thumb missing (or source missing) — fall through to (re)generate
  }

  try {
    await fs.mkdir(path.dirname(out), { recursive: true })
    await sharp(src, { failOn: "none" })
      .rotate() // honor EXIF orientation
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 62 })
      .toFile(out)
    return out
  } catch {
    return null
  }
}

// Returns the absolute path to a cached webp poster (first frame) for the given
// video, generating it on first request with a bundled static ffmpeg binary.
// This is what keeps a video-heavy library light: the grid renders these small
// <img> posters instead of dozens of real <video> elements (each of which the
// browser initializes a decoder for, which is the real cause of the freeze).
// Returns null if ffmpeg is unavailable or the frame can't be extracted.
export async function getOrCreateVideoPoster(relPath: string): Promise<string | null> {
  const src = absPathFor(relPath)
  const out = thumbAbsPath(relPath)

  try {
    const [srcStat, thumbStat] = await Promise.all([fs.stat(src), fs.stat(out)])
    if (thumbStat.isFile() && thumbStat.mtimeMs >= srcStat.mtimeMs) return out
  } catch {
    // poster missing (or source missing) — fall through to (re)generate
  }

  if (!ffmpegStatic) return null

  try {
    await fs.mkdir(path.dirname(out), { recursive: true })
    // Grab a single frame ~0.5s in (skips black/incomplete first frames),
    // scale to the thumb width preserving aspect, and pipe raw PNG to sharp so
    // the on-disk cache format matches image thumbs (webp). `-y` overwrites.
    const { stdout } = await execFileP(
      ffmpegStatic,
      [
        "-loglevel", "error",
        "-ss", "0.5",
        "-i", src,
        "-frames:v", "1",
        "-vf", `scale=${THUMB_WIDTH}:-2:flags=fast_bilinear`,
        "-f", "image2pipe",
        "-vcodec", "png",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
    )
    if (!stdout || stdout.length === 0) return null
    await sharp(stdout, { failOn: "none" }).webp({ quality: 62 }).toFile(out)
    return out
  } catch {
    return null
  }
}

// Unified entry point used by the media route: pick the right generator for
// the media kind. Returns the cached webp path or null.
export async function getOrCreateThumb(relPath: string, kind: string): Promise<string | null> {
  return kind === "video" ? getOrCreateVideoPoster(relPath) : getOrCreateImageThumb(relPath)
}
