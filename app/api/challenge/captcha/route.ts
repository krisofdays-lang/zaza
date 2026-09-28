import type { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { igAccounts } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { requireUserId } from "@/lib/auth/session"
import { InstagramClient } from "@/lib/instagram/client"
import type { UfacState } from "@/lib/instagram/ufac"

// Streams the current challenge captcha image for an account.
//
// The IG challenge captcha (facebook.com/captcha/tfbimage/...) is IP-BOUND: it
// is served for the IP the challenge was issued on. So we fetch it SERVER-SIDE
// through the account's OWN mobile proxy (client.fetchImage), egressing from
// that same IP with the account's iPhone User-Agent. A direct browser load, or
// a fetch from the app server's IP, returns a broken / mismatched image — which
// is why the picture wasn't rendering. Only if the proxy path fails entirely do
// we fall back to a plain direct fetch.
//
// The URL is never accepted from the client: we read the captcha URL that the
// UFAC flow already stored on the account row, scoped to the signed-in user.
export async function GET(req: NextRequest) {
  let userId: Awaited<ReturnType<typeof requireUserId>>
  try {
    userId = await requireUserId()
  } catch {
    return new Response("unauthorized", { status: 401 })
  }

  const accountId = Number(req.nextUrl.searchParams.get("accountId"))
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return new Response("bad request", { status: 400 })
  }

  const rows = await db
    .select()
    .from(igAccounts)
    .where(and(eq(igAccounts.id, accountId), eq(igAccounts.userId, userId)))
    .limit(1)
  const acc = rows[0]
  const url = (acc?.challengeState as UfacState | null)?.captchaUrl
  if (!acc || !url) return new Response("no captcha", { status: 404 })

  const noStore = "no-store, no-cache, must-revalidate"

  // Preferred: through the account's mobile proxy, so we hit facebook from the
  // same IP the captcha was issued on.
  try {
    const client = new InstagramClient(acc)
    const img = await client.fetchImage(url)
    if (img.ok && img.data && img.data.length > 0) {
      return new Response(img.data, {
        headers: { "content-type": img.contentType, "cache-control": noStore },
      })
    }
    console.log("[v0] captcha proxy fetch non-ok:", img.status, "len:", img.data?.length ?? 0)
  } catch (e) {
    console.log("[v0] captcha proxy fetch threw:", (e as Error)?.message)
  }

  // Fallback: plain direct fetch (may be wrong IP, but better than nothing).
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent":
          "Instagram 448.0.0.39.66 (iPhone17,1; iOS 18_5; en_US; en; scale=3.00; 1206x2622; 1072661960) AppleWebKit/420+",
        accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      },
      cache: "no-store",
      redirect: "follow",
    })
    if (r.ok) {
      const ab = await r.arrayBuffer()
      return new Response(Buffer.from(ab), {
        headers: {
          "content-type": r.headers.get("content-type") || "image/jpeg",
          "cache-control": noStore,
        },
      })
    }
    console.log("[v0] captcha direct fetch non-ok:", r.status)
  } catch (e) {
    console.log("[v0] captcha direct fetch threw:", (e as Error)?.message)
  }

  return new Response("captcha fetch failed", { status: 502 })
}
