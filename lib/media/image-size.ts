// Probe an image buffer for its real pixel dimensions.
//
// Carousels (configure_sidecar) declare each child's source_width/source_height.
// If we send the wrong size (e.g. a hardcoded 1080x1080) for a photo whose real
// aspect ratio differs, Instagram re-crops/re-scales that slide — which showed
// up as the "second photo changes resolution" bug. Reading the true dimensions
// keeps every slide at its actual size.
//
// sharp is imported lazily (its libvips native addon) so it only loads when a
// post actually needs it, mirroring lib/instagram/story-bake.ts.
export async function probeImageSize(buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const { default: sharp } = await import("sharp")
    const meta = await sharp(buffer).metadata()
    if (meta.width && meta.height) return { width: meta.width, height: meta.height }
  } catch {
    // best-effort — fall back to the caller's default
  }
  return null
}
