import "server-only"
import { cookies, headers } from "next/headers"
import { createHmac, timingSafeEqual } from "node:crypto"
import { db } from "@/lib/db"
import { users, type User } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

const COOKIE_NAME = "yt_session"
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

// Secret used to sign the session cookie. In production this MUST be set via the
// AUTH_SECRET env var; the dev fallback keeps local work frictionless.
function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret-change-me"
}

// Cookie value is `userId.signature` where signature = HMAC(userId). This makes
// the cookie tamper-proof: a client cannot forge a different user id.
function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex")
}

function makeToken(userId: number): string {
  const payload = String(userId)
  return `${payload}.${sign(payload)}`
}

function verifyToken(token: string | undefined): number | null {
  if (!token) return null
  const idx = token.lastIndexOf(".")
  if (idx <= 0) return null
  const payload = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = sign(payload)
  // Constant-time compare to avoid leaking signature info via timing.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const id = Number(payload)
  return Number.isInteger(id) && id > 0 ? id : null
}

// Detect whether the current request reached us over HTTPS. Reverse proxies
// (nginx/Caddy/Traefik) terminate TLS and forward `x-forwarded-proto: https`.
// On a direct plain-HTTP deploy this is "http", so we won't set a `secure`
// cookie the browser would refuse to store.
async function isHttps(): Promise<boolean> {
  const h = await headers()
  const proto = h.get("x-forwarded-proto") ?? ""
  return proto.split(",")[0].trim().toLowerCase() === "https"
}

// Validate a license key and, if valid, write the session cookie. Returns the
// authenticated user or null when the key is unknown.
export async function loginWithLicenseKey(licenseKey: string): Promise<User | null> {
  const key = licenseKey.trim()
  if (!key) return null
  const [user] = await db.select().from(users).where(eq(users.licenseKey, key))
  if (!user) return null

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, makeToken(user.id), {
    httpOnly: true,
    sameSite: "lax",
    // Only mark the cookie `secure` when the request actually arrived over
    // HTTPS. Tying this to NODE_ENV would silently break plain-HTTP Docker
    // deploys (e.g. http://server-ip:3000): the browser drops a `secure`
    // cookie on HTTP, so the session would never persist and the user would
    // bounce back to /login. Behind an HTTPS reverse proxy this stays secure.
    secure: await isHttps(),
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  })
  return user
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

// Cookie-only session check: verifies the signed token WITHOUT touching the
// database, so it can never throw on a transient DB hiccup. Use this for the
// layout's redirect gate — a signed cookie proves authentication regardless of
// whether the users row can be read right now.
export async function getSessionUserId(): Promise<number | null> {
  const cookieStore = await cookies()
  return verifyToken(cookieStore.get(COOKIE_NAME)?.value)
}

// Never-throwing user lookup. Distinguishes "no valid session" from "the DB
// read failed transiently" so render paths can degrade gracefully instead of
// crashing the whole route tree.
//
// This matters because every Server Action triggers a re-render of the current
// route (layout + page). If that re-render throws — e.g. a transient Neon pool
// error under heavy polling — Next.js surfaces the red "Server Components
// render" overlay. Layout throws are NOT catchable by a same-segment error.tsx,
// so we prevent the throw at the source instead.
export async function getCurrentUserResult(): Promise<{ user: User | null; dbError: boolean }> {
  const cookieStore = await cookies()
  const id = verifyToken(cookieStore.get(COOKIE_NAME)?.value)
  if (!id) return { user: null, dbError: false }
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id))
    return { user: user ?? null, dbError: false }
  } catch (err) {
    console.log("[v0] getCurrentUserResult DB read failed:", (err as Error)?.message)
    return { user: null, dbError: true }
  }
}

// Returns the current user, or null if not authenticated. Never throws — a
// transient DB error resolves to null rather than crashing the caller.
export async function getCurrentUser(): Promise<User | null> {
  const { user } = await getCurrentUserResult()
  return user
}

// Returns the current user or throws. Every scoped server action calls this so
// data access is always bound to a real, signed-in user id.
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
  if (!user) throw new Error("UNAUTHENTICATED")
  return user
}

export async function requireUserId(): Promise<number> {
  return (await requireUser()).id
}

export { COOKIE_NAME }
