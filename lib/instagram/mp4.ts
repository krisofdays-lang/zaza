// Minimal MP4 / MOV box parser to read the real video metadata from an uploaded
// buffer, so the posting flow can send accurate values to Instagram instead of
// hardcoded ones. Reads `mvhd` (duration), the video `tkhd` (display size), the
// video sample entry (`stsd` -> codec), the media header + sample table
// (frame rate), and detects whether a `soun` (audio) track is present.
//
// Why this matters: the real iOS app derives upload_settings from the file it is
// about to upload. If we claim "hvc1" / 30fps / audio-present while the actual
// bytes are H.264 / 24fps / silent, the server sees a mismatch no genuine client
// produces. Returns null if the file isn't parseable ISO-BMFF (callers fall back
// to safe defaults).

export type VideoCodec = "avc1" | "hvc1"

export interface Mp4Probe {
  durationMs: number
  width: number
  height: number
  /** Container codec of the video sample entry, normalized to what the app reports. */
  codec: VideoCodec
  /** Rounded frames-per-second derived from the sample table, or 0 if unknown. */
  frameRate: number
  /** True when the file contains at least one audio (`soun`) track. */
  hasAudio: boolean
  /** Rotation in degrees derived from the track matrix (0/90/180/270). */
  rotationAngle: number
}

interface Box {
  type: string
  dataStart: number
  dataEnd: number
}

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let offset = start
  // Guard against malformed files looping forever.
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset)
    const type = buf.toString("latin1", offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      // 64-bit largesize lives in the 8 bytes after the type.
      if (offset + 16 > end) break
      const high = buf.readUInt32BE(offset + 8)
      const low = buf.readUInt32BE(offset + 12)
      size = high * 2 ** 32 + low
      headerSize = 16
    } else if (size === 0) {
      // Box extends to the end of the container.
      size = end - offset
    }
    if (size < headerSize || offset + size > end) break
    boxes.push({ type, dataStart: offset + headerSize, dataEnd: offset + size })
    offset += size
  }
  return boxes
}

function parseMvhd(buf: Buffer, b: Box): number {
  const version = buf.readUInt8(b.dataStart)
  let p = b.dataStart + 4 // version(1) + flags(3)
  let timescale: number
  let duration: number
  if (version === 1) {
    p += 16 // creation(8) + modification(8)
    timescale = buf.readUInt32BE(p)
    p += 4
    const high = buf.readUInt32BE(p)
    const low = buf.readUInt32BE(p + 4)
    duration = high * 2 ** 32 + low
  } else {
    p += 8 // creation(4) + modification(4)
    timescale = buf.readUInt32BE(p)
    p += 4
    duration = buf.readUInt32BE(p)
  }
  if (!timescale) return 0
  return Math.round((duration / timescale) * 1000)
}

function parseTkhd(buf: Buffer, b: Box): { width: number; height: number; rotation: number } {
  const version = buf.readUInt8(b.dataStart)
  // The 3x3 transform matrix precedes width/height (last 8 bytes). It starts at a
  // fixed offset from the box data: version/flags(4) + times + track_id + reserved
  // + duration + reserved(8) + layer(2) + altgroup(2) + volume(2) + reserved(2).
  const base = b.dataStart + 4
  const timesLen = version === 1 ? 32 : 20 // creation+mod+track_id+reserved+duration
  const matrixStart = base + timesLen + 8 /*reserved*/ + 2 + 2 + 2 + 2
  let rotation = 0
  try {
    // a,b are the first two 16.16 fixed-point matrix entries.
    const a = buf.readInt32BE(matrixStart) / 65536
    const bb = buf.readInt32BE(matrixStart + 4) / 65536
    const deg = Math.round((Math.atan2(bb, a) * 180) / Math.PI)
    rotation = ((deg % 360) + 360) % 360
  } catch {
    rotation = 0
  }
  // width/height are the final 8 bytes of the box, as 16.16 fixed point.
  const wStart = b.dataEnd - 8
  const width = buf.readUInt32BE(wStart) / 65536
  const height = buf.readUInt32BE(wStart + 4) / 65536
  return { width: Math.round(width), height: Math.round(height), rotation }
}

// Handler type of a track ("vide", "soun", ...) read from the mdia > hdlr box.
function trackHandler(buf: Buffer, mdia: Box): string {
  const hdlr = readBoxes(buf, mdia.dataStart, mdia.dataEnd).find((b) => b.type === "hdlr")
  if (!hdlr) return ""
  // version/flags(4) + pre_defined(4), then 4-char handler type.
  return buf.toString("latin1", hdlr.dataStart + 8, hdlr.dataStart + 12)
}

// Codec of the first sample entry inside mdia > minf > stbl > stsd.
function videoCodec(buf: Buffer, mdia: Box): VideoCodec {
  const minf = readBoxes(buf, mdia.dataStart, mdia.dataEnd).find((b) => b.type === "minf")
  if (!minf) return "avc1"
  const stbl = readBoxes(buf, minf.dataStart, minf.dataEnd).find((b) => b.type === "stbl")
  if (!stbl) return "avc1"
  const stsd = readBoxes(buf, stbl.dataStart, stbl.dataEnd).find((b) => b.type === "stsd")
  if (!stsd) return "avc1"
  // stsd: version/flags(4) + entry_count(4), then the sample entry boxes.
  const entries = readBoxes(buf, stsd.dataStart + 8, stsd.dataEnd)
  const type = entries[0]?.type ?? ""
  // HEVC appears as hvc1/hev1; everything else we treat as H.264 (avc1).
  return type === "hvc1" || type === "hev1" ? "hvc1" : "avc1"
}

// Frame rate = sample count / media-duration-seconds, using mdhd + stsz.
function videoFrameRate(buf: Buffer, mdia: Box): number {
  const mdhd = readBoxes(buf, mdia.dataStart, mdia.dataEnd).find((b) => b.type === "mdhd")
  const minf = readBoxes(buf, mdia.dataStart, mdia.dataEnd).find((b) => b.type === "minf")
  if (!mdhd || !minf) return 0
  const version = buf.readUInt8(mdhd.dataStart)
  let p = mdhd.dataStart + 4
  let timescale: number
  let duration: number
  if (version === 1) {
    p += 16
    timescale = buf.readUInt32BE(p)
    p += 4
    duration = buf.readUInt32BE(p) * 2 ** 32 + buf.readUInt32BE(p + 4)
  } else {
    p += 8
    timescale = buf.readUInt32BE(p)
    p += 4
    duration = buf.readUInt32BE(p)
  }
  if (!timescale || !duration) return 0
  const stbl = readBoxes(buf, minf.dataStart, minf.dataEnd).find((b) => b.type === "stbl")
  if (!stbl) return 0
  const stsz = readBoxes(buf, stbl.dataStart, stbl.dataEnd).find((b) => b.type === "stsz")
  if (!stsz) return 0
  // stsz: version/flags(4) + sample_size(4) + sample_count(4).
  const sampleCount = buf.readUInt32BE(stsz.dataStart + 8)
  const seconds = duration / timescale
  if (!sampleCount || seconds <= 0) return 0
  const fps = Math.round(sampleCount / seconds)
  // Clamp to a sane range; parsing noise shouldn't yield absurd values.
  return fps >= 1 && fps <= 240 ? fps : 0
}

// Make a video's bytes unique WITHOUT changing its length or how it plays.
// Instagram dedupes uploads by content hash per account, so posting the same
// source file to two Post Reel nodes makes the server collapse the second upload
// into the first. Appending bytes (an mp4 `free` box) fixed the dedupe but broke
// resumable upload with "Length of the file has changed (failed to resume)"
// because the reported entity length no longer matched the source.
//
// Instead we overwrite the fixed-size creation_time / modification_time fields
// inside `mvhd` and each `tkhd` with random values. These are timestamp fields
// (seconds since 1904) that every real re-encode/transfer changes anyway; players
// and Instagram's transcoder ignore them, so the video is byte-for-byte the same
// length and plays identically, but its hash differs. Mutates a COPY and returns
// it, leaving the caller's original buffer untouched.
export function uniquifyMp4(buffer: Buffer): Buffer {
  try {
    const out = Buffer.from(buffer) // copy so we never mutate the caller's bytes
    const top = readBoxes(out, 0, out.length)
    const moov = top.find((b) => b.type === "moov")
    if (!moov) return out // not parseable ISO-BMFF: return unchanged (same length)

    // Random 32-bit timestamp helper (kept < 2^31 to stay a plausible date and
    // safe for both version-0 (32-bit) and version-1 (64-bit) fields).
    const rand = () => Math.floor(Math.random() * 0x7fffffff)

    // Overwrite creation_time + modification_time of a full-box header at
    // `dataStart`. version(1)+flags(3) precede the two timestamps.
    const touchTimes = (b: Box) => {
      const version = out.readUInt8(b.dataStart)
      const p = b.dataStart + 4
      if (version === 1) {
        // 64-bit: write 0 in the high word, random in the low word (x2).
        out.writeUInt32BE(0, p)
        out.writeUInt32BE(rand(), p + 4)
        out.writeUInt32BE(0, p + 8)
        out.writeUInt32BE(rand(), p + 12)
      } else {
        // 32-bit creation(4) + modification(4).
        out.writeUInt32BE(rand(), p)
        out.writeUInt32BE(rand(), p + 4)
      }
    }

    const moovChildren = readBoxes(out, moov.dataStart, moov.dataEnd)
    const mvhd = moovChildren.find((b) => b.type === "mvhd")
    if (mvhd) touchTimes(mvhd)
    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
      const tkhd = readBoxes(out, trak.dataStart, trak.dataEnd).find((b) => b.type === "tkhd")
      if (tkhd) touchTimes(tkhd)
    }
    return out
  } catch {
    // Any parsing issue: return a same-length copy so upload still works.
    return Buffer.from(buffer)
  }
}

export function probeMp4(buffer: Buffer): Mp4Probe | null {
  try {
    const top = readBoxes(buffer, 0, buffer.length)
    const moov = top.find((b) => b.type === "moov")
    if (!moov) return null

    const moovChildren = readBoxes(buffer, moov.dataStart, moov.dataEnd)
    const mvhd = moovChildren.find((b) => b.type === "mvhd")
    const durationMs = mvhd ? parseMvhd(buffer, mvhd) : 0

    let width = 0
    let height = 0
    let codec: VideoCodec = "avc1"
    let frameRate = 0
    let rotationAngle = 0
    let hasAudio = false

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
      const trakChildren = readBoxes(buffer, trak.dataStart, trak.dataEnd)
      const mdia = trakChildren.find((b) => b.type === "mdia")
      const handler = mdia ? trackHandler(buffer, mdia) : ""

      if (handler === "soun") {
        hasAudio = true
        continue
      }

      // Video track: capture size (from tkhd) + codec/fps (from mdia).
      const tkhd = trakChildren.find((b) => b.type === "tkhd")
      if (tkhd) {
        const dim = parseTkhd(buffer, tkhd)
        if (dim.width > 0 && dim.height > 0 && width === 0) {
          width = dim.width
          height = dim.height
          rotationAngle = dim.rotation
        }
      }
      if (mdia && (handler === "vide" || handler === "")) {
        if (frameRate === 0) frameRate = videoFrameRate(buffer, mdia)
        codec = videoCodec(buffer, mdia)
      }
    }

    if (!durationMs && !width) return null
    return { durationMs, width, height, codec, frameRate, hasAudio, rotationAngle }
  } catch {
    return null
  }
}
