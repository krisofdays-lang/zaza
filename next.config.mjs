/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle for Docker (.next/standalone).
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // sharp is a native (libvips) module. It must NOT be bundled by Turbopack —
  // bundling breaks its native binding and crashes any route whose server
  // module graph reaches it (the workflows page pulls it in via the workflow
  // runner → story baking). Keeping it external loads it from node_modules at
  // runtime instead.
  serverExternalPackages: ["sharp"],
  experimental: {
    serverActions: {
      // Media uploads (photos, reels/videos) flow through the uploadMedia
      // Server Action. Next.js caps Server Action request bodies at 1MB by
      // default, which silently rejected anything larger. Raise it so real
      // Instagram media can be uploaded from Storage, Edit Steps and
      // Publications.
      bodySizeLimit: "100mb",
    },
    // Next.js 16 buffers incoming request bodies through an internal proxy
    // layer whose limit defaults to 10MB — SEPARATE from serverActions
    // .bodySizeLimit above. Without this, uploads over 10MB were silently
    // truncated/rejected before reaching the Server Action, even though the
    // Server Action limit was already 100mb. Match the two so real reels
    // (which routinely exceed 10MB) upload end-to-end.
    proxyClientMaxBodySize: "100mb",
  },
}

export default nextConfig
