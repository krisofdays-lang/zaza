// Reference story dimensions. Used only as a fallback when the source image
// has no readable size — the pill metrics are otherwise derived from the actual
// image width so the photo keeps its original resolution.
export const STORY_W = 1080
export const STORY_H = 1920

export interface BakeLink {
  url: string
  text?: string
  x?: number // normalized centre, 0–1
  y?: number // normalized centre, 0–1
  size?: number // percent (e.g. 50–150)
  rotation?: number // degrees
}

export interface BakeResult {
  buffer: Buffer
  // Normalized sticker box (centre x/y + width/height) that exactly matches the
  // baked pill, so the tappable link area lines up with what the viewer sees.
  box: { x: number; y: number; width: number; height: number; rotation: number }
  // The baked photo's actual pixel dimensions (unchanged from the source).
  width: number
  height: number
}

// The sticker metrics are expressed in units of 1% of the canvas width (cqw),
// mirroring the genuine web link sticker, so the pill scales proportionally to
// whatever resolution the source photo actually is.
function metrics(scale: number, canvasW: number) {
  const cqw = canvasW / 100
  return {
    PAD: 2.5 * cqw * scale,
    ICON: 7.2 * cqw * scale,
    GAP_X: 2 * cqw * scale,
    GAP_EXTRA: 0.06 * cqw * scale,
    TEXT_DY_NUDGE: 0.5 * cqw * scale,
  }
}

// Per-glyph advance widths (in em) for DejaVu Sans Bold — the font sharp uses
// when rendering the sticker SVG. The label is uppercased before measuring, so
// these cover A–Z, digits, space and common punctuation. Anything else falls
// back to a wide default so we never under-reserve.
const GLYPH_EM: Record<string, number> = {
  " ": 0.32,
  A: 0.7, B: 0.71, C: 0.72, D: 0.77, E: 0.68, F: 0.63, G: 0.79, H: 0.79,
  I: 0.36, J: 0.37, K: 0.71, L: 0.61, M: 0.9, N: 0.79, O: 0.79, P: 0.68,
  Q: 0.79, R: 0.74, S: 0.68, T: 0.66, U: 0.77, V: 0.7, W: 0.99, X: 0.7,
  Y: 0.66, Z: 0.68,
  "0": 0.7, "1": 0.7, "2": 0.7, "3": 0.7, "4": 0.7, "5": 0.7, "6": 0.7,
  "7": 0.7, "8": 0.7, "9": 0.7,
  ".": 0.36, ",": 0.36, "!": 0.4, "?": 0.6, "'": 0.31, '"': 0.55, "-": 0.48,
  _: 0.6, "/": 0.4, ":": 0.4, ";": 0.4, "&": 0.85, "@": 1.0, "#": 0.83,
}

function glyphAdvanceEm(ch: string): number {
  return GLYPH_EM[ch] ?? 0.75
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Build the link-sticker SVG (full-canvas) plus its normalized box. Text width is
// estimated from glyph count and then pinned with `textLength`, so the rendered
// text always fills exactly the width we reserved — the baked pill and the tap
// zone stay in sync regardless of the server's font metrics.
function buildStickerSvg(
  link: BakeLink,
  canvasW: number,
  canvasH: number,
): { svg: string; box: BakeResult["box"] } {
  const scale = (link.size ?? 100) / 100
  const m = metrics(scale, canvasW)
  const label = (link.text?.trim() || hostnameOf(link.url) || "LINK").toUpperCase()

  // Estimate the rendered text width per-glyph at the label's font-size. The
  // SVG renderer (sharp → resvg/librsvg) does NOT honor the `textLength` hint,
  // so the text is always drawn at its natural width. A flat average badly
  // under-measured bold uppercase (wide glyphs like M/W/O), so the pill ended up
  // narrower than the text and it spilled out. We now sum the ACTUAL per-glyph
  // advances of DejaVu Sans Bold (the font sharp falls back to) in em units,
  // plus a small safety margin, so the reserved width is never smaller than the
  // rendered text.
  const fontSize = m.ICON
  let advanceEm = 0
  for (const ch of label) advanceEm += glyphAdvanceEm(ch)
  // +4% safety margin to absorb font-fallback differences on the render host.
  const estTextW = Math.max(advanceEm * 1.04 * fontSize, fontSize)
  const wPx = m.PAD + m.ICON + m.GAP_X + m.GAP_EXTRA + estTextW + m.PAD
  // Give the pill enough vertical room for the full cap height plus breathing
  // space above and below (font-size can be taller than the icon box).
  const hPx = m.PAD + Math.max(m.ICON, fontSize) + m.TEXT_DY_NUDGE + m.PAD

  const cx = (link.x ?? 0.5) * canvasW
  const cy = (link.y ?? 0.76) * canvasH
  const left = cx - wPx / 2
  const top = cy - hPx / 2
  const rotation = link.rotation ?? 0

  // Dark "flat" pill with white icon + text, matching the in-app preview.
  const bg = "rgb(23,23,23)"
  const fg = "#ffffff"
  const radius = hPx / 2

  const textX = m.PAD + m.ICON + m.GAP_X + m.GAP_EXTRA
  const iconTop = (hPx - m.ICON) / 2

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">
  <g transform="translate(${left.toFixed(2)} ${top.toFixed(2)}) rotate(${rotation} ${(wPx / 2).toFixed(2)} ${(hPx / 2).toFixed(2)})">
    <rect x="0" y="0" width="${wPx.toFixed(2)}" height="${hPx.toFixed(2)}" rx="${radius.toFixed(2)}" ry="${radius.toFixed(2)}" fill="${bg}"/>
    <g transform="translate(${m.PAD.toFixed(2)} ${iconTop.toFixed(2)})">
      <svg x="0" y="0" width="${m.ICON.toFixed(2)}" height="${m.ICON.toFixed(2)}" viewBox="0 0 24 24" fill="none">
        <path d="M12.7076 18.3639L11.2933 19.7781C9.34072 21.7308 6.1749 21.7308 4.22228 19.7781C2.26966 17.8255 2.26966 14.6597 4.22228 12.7071L5.63649 11.2929M18.3644 12.7071L19.7786 11.2929C21.7312 9.34024 21.7312 6.17441 19.7786 4.22179C17.826 2.26917 14.6602 2.26917 12.7076 4.22179L11.2933 5.636M8.50045 15.4999L15.5005 8.49994" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </g>
    <text x="${textX.toFixed(2)}" y="${(hPx / 2 + fontSize * 0.34).toFixed(2)}" textLength="${estTextW.toFixed(2)}" lengthAdjust="spacingAndGlyphs" fill="${fg}" font-size="${fontSize.toFixed(2)}" font-weight="600" font-family="'DejaVu Sans', Helvetica, Arial, sans-serif" text-anchor="start">${escapeXml(label)}</text>
  </g>
</svg>`

  return {
    svg,
    box: {
      x: link.x ?? 0.5,
      y: link.y ?? 0.76,
      width: wPx / canvasW,
      height: hPx / canvasH,
      rotation,
    },
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

// Bake the link-sticker pill directly into a story photo. The photo keeps its
// ORIGINAL resolution — we only composite the pill SVG on top at the same
// dimensions, so the story is posted at full quality just like before the link
// feature existed. Returns the JPEG bytes and the normalized sticker box so the
// caller can attach a matching tappable link area.
export async function bakeStoryPhotoWithLink(source: Buffer, link: BakeLink): Promise<BakeResult> {
  // Import sharp lazily so its native addon (libvips) only loads when we
  // actually bake an image inside the workflow runner. This keeps it out of the
  // module graph of pages/actions that merely reference the runner (e.g. the
  // workflows page), so a sharp/libvips load issue can never 500 those routes.
  const { default: sharp } = await import("sharp")

  // Use the photo's real dimensions so we neither resize nor letterbox it.
  const meta = await sharp(source).metadata()
  const canvasW = meta.width || STORY_W
  const canvasH = meta.height || STORY_H

  const { svg, box } = buildStickerSvg(link, canvasW, canvasH)

  // Composite the sticker SVG straight over the original photo (no resize).
  const buffer = await sharp(source)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 95 })
    .toBuffer()

  return { buffer, box, width: canvasW, height: canvasH }
}
