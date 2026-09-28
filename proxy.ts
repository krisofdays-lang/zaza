import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const COOKIE_NAME = "yt_session"

// Public paths that never require a session.
const PUBLIC_PATHS = ["/login"]

// Lightweight navigation gate. This only checks that a session cookie is
// present and well-formed (`id.signature`) — it does NOT verify the HMAC,
// because the Edge runtime has no node:crypto. Real cryptographic verification
// and the actual data scoping happen server-side in getCurrentUser/requireUser,
// which every page and server action relies on. This middleware just gives a
// fast redirect for logged-out users instead of rendering a broken shell.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  const token = request.cookies.get(COOKIE_NAME)?.value
  const looksAuthed = Boolean(token && /^\d+\.[a-f0-9]{64}$/.test(token))

  if (!looksAuthed && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("from", pathname)
    return NextResponse.redirect(url)
  }

  // Already signed in but visiting /login → send to the dashboard.
  if (looksAuthed && isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = "/"
    url.search = ""
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

// Run on everything except Next internals, API routes, and static assets.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map)$).*)"],
}
