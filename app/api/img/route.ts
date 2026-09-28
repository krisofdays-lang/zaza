import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/session"

// Proxies remote Instagram/Facebook CDN images through our server so the
// browser can display them. Instagram's CDN blocks cross-origin hotlinking
// (CORP/ORB) and signs URLs, so a direct <img src> from the client frequently
// fails to load — fetching server-side (no CORS) and re-serving fixes it.
//
// Locked to known IG/FB CDN hosts to avoid an open SSRF proxy.
const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"]

function isAllowed(u: URL): boolean {
  if (u.protocol !== "https:") return false
  return ALLOWED_HOST_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix))
}

export async function GET(req: Request) {
  // Require a logged-in user so this can't be used as a public open proxy.
  const user = await getCurrentUser()
  if (!user) return new NextResponse("Unauthorized", { status: 401 })

  const raw = new URL(req.url).searchParams.get("url")
  if (!raw) return new NextResponse("Missing url", { status: 400 })

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return new NextResponse("Bad url", { status: 400 })
  }
  if (!isAllowed(target)) return new NextResponse("Host not allowed", { status: 403 })

  try {
    const upstream = await fetch(target.toString(), {
      // No referrer; IG CDN serves the asset when the request looks like a plain image fetch.
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      cache: "no-store",
    })
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("Upstream error", { status: 502 })
    }
    const contentType = upstream.headers.get("content-type") || "image/jpeg"
    if (!contentType.startsWith("image/")) {
      return new NextResponse("Not an image", { status: 415 })
    }
    const buffer = Buffer.from(await upstream.arrayBuffer())
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        // Safe to cache hard: IG CDN URLs are content-addressed/signed.
        "Cache-Control": "private, max-age=86400",
      },
    })
  } catch {
    return new NextResponse("Fetch failed", { status: 502 })
  }
}
