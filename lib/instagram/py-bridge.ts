// Bridge from the Node app to the FastAPI Instagram request service (backend/).
//
// When IG_SERVICE_URL is set (the Docker entrypoint launches uvicorn on loopback
// and exports it), reel publishing is delegated to the Python service, which
// egresses through the SAME uTLS sidecar as Node so the JA4 fingerprint is
// identical. When it is unset — or USE_PYTHON_IG=0 — callers fall back to the
// in-process TypeScript flow, so nothing breaks during the migration.
//
// The service is stateless about the DB: we send the full account fingerprint
// and the video bytes (base64), and it returns the publish result plus any
// server-rotated claim/rur the caller should persist.

import type { igAccounts } from "@/lib/db/schema"

type Account = typeof igAccounts.$inferSelect

// True when reel publishing should be routed through the Python service.
export function pythonIgEnabled(): boolean {
  if (process.env.USE_PYTHON_IG === "0") return false
  return Boolean(process.env.IG_SERVICE_URL)
}

function serviceUrl(path: string): string {
  const base = (process.env.IG_SERVICE_URL || "").replace(/\/+$/, "")
  return `${base}${path}`
}

// Map a Drizzle igAccounts row to the account fingerprint the service expects.
// Field names use the camelCase aliases the Python Account model accepts.
function accountPayload(a: Account) {
  return {
    id: a.id,
    igUserId: a.igUserId,
    bearerToken: a.bearerToken,
    mid: a.mid,
    claim: a.claim,
    deviceId: a.deviceId,
    familyDeviceId: a.familyDeviceId,
    phoneId: a.phoneId,
    cloudTrustToken: a.cloudTrustToken,
    proxyType: a.proxyType,
    proxyUrl: a.proxyUrl,
    rotationUrl: a.rotationUrl,
    iphoneModel: a.iphoneModel,
    iosVersion: a.iosVersion,
    appVersion: a.appVersion,
    locale: a.locale,
    timezone: a.timezone,
  }
}

export interface PyReelResult {
  ok: boolean
  status: number
  detail?: string
  uploadId?: string
  claim?: string
  rur?: string
  // Mirror publishReelFlow: which request failed + its endpoint, so the runner
  // can log the exact failing call regardless of which backend published.
  stage?: string
  endpoint?: string
}

// ── Autoreg ──────────────────────────────────────────────────────────────

export interface PyAutoregConfig {
  method: "email" | "sms"
  proxy: string
  igPassword?: string
  anymessageApiKey?: string
  anymessageDomain?: string
  anymessageSite?: string
  textverifiedApiKey?: string
  textverifiedUsername?: string
  stepDelayMin?: number
  stepDelayMax?: number
  codeWaitTimeout?: number
  codePollInterval?: number
}

export interface PyAutoregResult {
  success: boolean
  error: string
  nuxApproved: boolean
  username: string
  password: string
  email: string
  phone: string
  bearer: string
  mid: string
  claim: string
  dsUserId: string
  csrf: string
  rur: string
  deviceId: string
  familyDeviceId: string
  phoneId: string
  pigeonSession: string
  fbAnonId: string
  waterfallId: string
  machineId: string
  cloudTrustToken: string
  aacJid: string
  aacCs: string
  iphoneModel: string
  iosVersion: string
  appVersion: string
  locale: string
  timezone: string
  userAgent: string
  sessionBlob: Record<string, unknown>
  steps: { step: string; detail: string; ts: number }[]
}

export async function registerViaPython(config: PyAutoregConfig): Promise<PyAutoregResult> {
  const res = await fetch(serviceUrl("/autoreg/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  })

  if (!res.ok && res.status >= 500) {
    const text = await res.text().catch(() => "")
    return {
      success: false,
      error: `ig_service_${res.status}: ${text.slice(0, 200)}`,
      nuxApproved: false,
      username: "", password: "", email: "", phone: "",
      bearer: "", mid: "", claim: "", dsUserId: "", csrf: "", rur: "",
      deviceId: "", familyDeviceId: "", phoneId: "", pigeonSession: "",
      fbAnonId: "", waterfallId: "", machineId: "", cloudTrustToken: "",
      aacJid: "", aacCs: "",
      iphoneModel: "", iosVersion: "", appVersion: "",
      locale: "", timezone: "", userAgent: "",
      sessionBlob: {},
      steps: [],
    }
  }
  return (await res.json()) as PyAutoregResult
}

// ── Reel publishing ─────────────────────────────────────────────────────

// Publish one reel via the Python service. Mirrors publishReelFlow()'s contract
// so the runner can swap between the two with no behavioral change.
export async function publishReelViaPython(
  account: Account,
  buffer: Buffer,
  opts: { caption?: string; fallbackWidth?: number; fallbackHeight?: number } = {},
): Promise<PyReelResult> {
  const res = await fetch(serviceUrl("/reel/publish"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: accountPayload(account),
      videoBase64: buffer.toString("base64"),
      caption: opts.caption ?? "",
      fallbackWidth: opts.fallbackWidth ?? 720,
      fallbackHeight: opts.fallbackHeight ?? 1280,
    }),
  })

  if (!res.ok && res.status >= 500) {
    // A 5xx from the service itself (not from Instagram) is an infra failure.
    const text = await res.text().catch(() => "")
    return { ok: false, status: res.status, detail: `ig_service_${res.status}: ${text.slice(0, 200)}` }
  }
  return (await res.json()) as PyReelResult
}
