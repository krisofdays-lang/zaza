import { type NextRequest, NextResponse } from "next/server"
import { submitSelfie } from "@/app/actions/challenge"

// Route handlers have no Server Action body-size limit and don't go through the
// v0-preview proxy the way action calls do, so large selfie videos come through
// intact on any host. The browser POSTs both files as multipart FormData here.
export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const accountId = Number(form.get("accountId"))
    const photo = form.get("photo")
    const video = form.get("video")

    if (!Number.isFinite(accountId) || !(photo instanceof File) || !(video instanceof File)) {
      return NextResponse.json({ error: "Bad request" }, { status: 400 })
    }

    let overrides: Parameters<typeof submitSelfie>[3]
    const overridesRaw = form.get("overrides")
    if (typeof overridesRaw === "string" && overridesRaw) {
      try {
        overrides = JSON.parse(overridesRaw)
      } catch {
        overrides = undefined
      }
    }

    const photoBuf = Buffer.from(await photo.arrayBuffer())
    const videoBuf = Buffer.from(await video.arrayBuffer())

    // Auth is enforced inside submitSelfie -> loadAccount (requireUserId); the
    // session cookie rides along with this same-origin fetch.
    const result = await submitSelfie(accountId, photoBuf, videoBuf, overrides)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Selfie submit failed" },
      { status: 500 },
    )
  }
}
