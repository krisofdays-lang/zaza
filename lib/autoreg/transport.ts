import axios, { type AxiosInstance, type AxiosResponse } from "axios"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import {
  PINNED_IG_VERSION,
  PINNED_IG_BUILD,
  PINNED_BLOKS_VERSION_ID,
  PINNED_IG_APP_ID,
  PINNED_IG_CAPABILITIES,
  CLIENT_DOC_ID_APP,
  CLIENT_DOC_ID_ACTION,
  BK_CONTEXT,
  BLOKS_PRISM_HEADERS,
  IOS_RELEASES,
  IPHONE_DEVICES,
  COUNTRY_LOCALE,
  type IphoneDevice,
  type IosRelease,
} from "./constants"

const BASE_URL = "https://i.instagram.com"
const TLS_PROXY_URL = process.env.TLS_PROXY_URL || ""

// ── Proxy agent builders ─────────────────────────────────────────────────

class LoopbackTlsProxyAgent extends HttpsProxyAgent<string> {
  async connect(
    req: Parameters<HttpsProxyAgent<string>["connect"]>[0],
    opts: Parameters<HttpsProxyAgent<string>["connect"]>[1],
  ): ReturnType<HttpsProxyAgent<string>["connect"]> {
    return super.connect(req, { ...opts, rejectUnauthorized: false } as typeof opts)
  }
}

export function buildProxyAgent(proxyUrl: string) {
  if (TLS_PROXY_URL) {
    return new LoopbackTlsProxyAgent(TLS_PROXY_URL, {
      rejectUnauthorized: false,
      headers: {
        "x-upstream-proxy": proxyUrl || "",
        "x-app-version": PINNED_IG_VERSION,
      },
    })
  }
  if (!proxyUrl) return undefined
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl)
  const url = proxyUrl.startsWith("http") ? proxyUrl : `http://${proxyUrl}`
  return new HttpsProxyAgent(url)
}

// ── Device profile ───────────────────────────────────────────────────────

export interface DeviceProfile {
  model: string
  name: string
  iosVersion: string
  iosBuild: string
  iosMajor: number
  resolution: string
  scale: string
  wLogical: number
  hLogical: number
}

/** Pick a random compatible device + iOS pairing. */
export function randomDeviceProfile(): DeviceProfile {
  const device = IPHONE_DEVICES[Math.floor(Math.random() * IPHONE_DEVICES.length)]
  return pickIosForDevice(device)
}

function pickIosForDevice(device: IphoneDevice): DeviceProfile {
  const compatible = IOS_RELEASES.filter(
    (r) => r.major >= device.iosMin && r.major <= device.iosMax,
  )
  const release = compatible[Math.floor(Math.random() * compatible.length)]
  return {
    model: device.model,
    name: device.name,
    iosVersion: release.v,
    iosBuild: release.build,
    iosMajor: release.major,
    resolution: device.res,
    scale: device.scale,
    wLogical: device.wLogical,
    hLogical: device.hLogical,
  }
}

// ── Geo resolution ───────────────────────────────────────────────────────

export interface GeoInfo {
  country: string
  timezone: string
  locale: string
  language: string
  acceptLanguage: string
}

/** Resolve geo info from proxy IP via ip-api.com. Falls back to US defaults. */
export async function resolveGeo(proxyUrl?: string): Promise<GeoInfo> {
  const defaults: GeoInfo = {
    country: "US",
    timezone: "America/Chicago",
    locale: "en_US",
    language: "en",
    acceptLanguage: "en-US;q=1.0",
  }
  try {
    const agent = proxyUrl ? buildProxyAgent(proxyUrl) : undefined
    const resp = await axios.get("http://ip-api.com/json/?fields=countryCode,timezone", {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 10_000,
    })
    const cc = resp.data?.countryCode || "US"
    const tz = resp.data?.timezone || defaults.timezone
    const loc = COUNTRY_LOCALE[cc] || COUNTRY_LOCALE.US
    return {
      country: cc,
      timezone: tz,
      locale: loc.locale,
      language: loc.language,
      acceptLanguage: loc.acceptLanguage,
    }
  } catch {
    return defaults
  }
}

// ── User-Agent builder ───────────────────────────────────────────────────

export function buildUserAgent(device: DeviceProfile, locale: string): string {
  const [lang] = locale.split("_")
  return (
    `Instagram ${PINNED_IG_VERSION} ` +
    `(${device.model}; iOS ${device.iosVersion}; ${locale}; ${lang}; ` +
    `scale=${device.scale}; ${device.resolution}; ${PINNED_IG_BUILD}) AppleWebKit/420+`
  )
}

// ── UTC offset for IANA timezone ─────────────────────────────────────────

export function tzOffsetSeconds(timeZone: string, at: Date = new Date()): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
    const map: Record<string, number> = {}
    for (const p of dtf.formatToParts(at)) {
      if (p.type !== "literal") map[p.type] = Number(p.value)
    }
    const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour % 24, map.minute, map.second)
    return Math.round((asUTC - at.getTime()) / 1000)
  } catch {
    return 0
  }
}

// ── Connection profile ───────────────────────────────────────────────────
// Simulates realistic WiFi / cellular connection headers.

export interface ConnectionProfile {
  type: string  // WiFi | LTE | 5G
  speed: string // kbps
  ig_connection_type: string
  ig_bandwidth_speed_kbps: string
  ig_bandwidth_totalbytes_b: string
  ig_bandwidth_totaltime_ms: string
}

export function randomConnectionProfile(): ConnectionProfile {
  const types = [
    { type: "WiFi", speedMin: 15000, speedMax: 120000, igType: "WiFi" },
    { type: "LTE", speedMin: 5000, speedMax: 50000, igType: "4g" },
    { type: "5G", speedMin: 50000, speedMax: 300000, igType: "5g" },
  ]
  const t = types[Math.floor(Math.random() * types.length)]
  const speed = t.speedMin + Math.floor(Math.random() * (t.speedMax - t.speedMin))
  const totalBytes = 500000 + Math.floor(Math.random() * 10000000)
  const totalTime = 100 + Math.floor(Math.random() * 2000)
  return {
    type: t.type,
    speed: String(speed),
    ig_connection_type: t.igType,
    ig_bandwidth_speed_kbps: `${speed}.000`,
    ig_bandwidth_totalbytes_b: String(totalBytes),
    ig_bandwidth_totaltime_ms: String(totalTime),
  }
}

// ── Common headers builder ───────────────────────────────────────────────

export interface HeadersContext {
  userAgent: string
  deviceId: string
  familyDeviceId: string
  phoneId: string
  pigeonSession: string
  machineId: string
  cloudTrustToken: string
  mid: string
  geo: GeoInfo
  connection: ConnectionProfile
  bearer?: string
  dsUserId?: string
  claim?: string
  csrf?: string
}

export function commonHeaders(ctx: HeadersContext): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": ctx.userAgent,
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "accept": "*/*",
    "accept-encoding": "gzip, deflate",
    "accept-language": ctx.geo.acceptLanguage,
    "x-ig-app-locale": ctx.geo.language,
    "x-ig-device-locale": ctx.geo.locale.replace("_", "-"),
    "x-ig-mapped-locale": ctx.geo.locale,
    "x-ig-app-id": PINNED_IG_APP_ID,
    "x-ig-device-id": ctx.deviceId,
    "x-ig-family-device-id": ctx.familyDeviceId,
    "x-ig-timezone-offset": String(tzOffsetSeconds(ctx.geo.timezone)),
    "x-ig-capabilities": PINNED_IG_CAPABILITIES,
    "x-ig-connection-type": ctx.connection.ig_connection_type,
    "x-ig-bandwidth-speed-kbps": ctx.connection.ig_bandwidth_speed_kbps,
    "x-ig-bandwidth-totalbytes-b": ctx.connection.ig_bandwidth_totalbytes_b,
    "x-ig-bandwidth-totaltime-ms": ctx.connection.ig_bandwidth_totaltime_ms,
    "x-pigeon-session-id": ctx.pigeonSession,
    "x-pigeon-rawclienttime": String(Date.now() / 1000),
    "x-fb-http-engine": "Liger",
    "x-fb-client-ip": "True",
    "x-fb-server-cluster": "True",
    "x-bloks-version-id": PINNED_BLOKS_VERSION_ID,
    ...BLOKS_PRISM_HEADERS,
  }

  if (ctx.mid) headers["x-mid"] = ctx.mid
  if (ctx.cloudTrustToken) headers["x-cloud-trust-token"] = ctx.cloudTrustToken
  if (ctx.bearer) headers["authorization"] = ctx.bearer
  if (ctx.dsUserId) {
    headers["ig-u-ds-user-id"] = ctx.dsUserId
    headers["ig-intended-user-id"] = ctx.dsUserId
  }
  if (ctx.claim) headers["x-ig-www-claim"] = ctx.claim
  if (ctx.csrf) headers["x-csrftoken"] = ctx.csrf

  return headers
}

// ── signed_body ──────────────────────────────────────────────────────────
// Instagram expects: signed_body=SIGNATURE.<urlencoded_json>
// The "SIGNATURE" literal is used by the iOS app (it stopped sending real HMACs).

export function signedBody(payload: Record<string, unknown>): string {
  return `signed_body=SIGNATURE.${encodeURIComponent(JSON.stringify(payload))}`
}

// ── Transport: POST graphql_bloks ────────────────────────────────────────
// Two modes:
// - BKAppRootQuery: synchronous bloks requests (no .async suffix in action_id)
// - BKActionRootQuery: async bloks actions (.async suffix in action_id)

export async function postGraphqlBloks(
  client: AxiosInstance,
  headers: Record<string, string>,
  actionId: string,
  params: Record<string, unknown>,
  serverParams: Record<string, unknown>,
): Promise<AxiosResponse> {
  const isAsync = actionId.endsWith(".async")
  const docId = isAsync ? CLIENT_DOC_ID_ACTION : CLIENT_DOC_ID_APP

  const variables = JSON.stringify({
    client_input_params: params,
    server_input_params: serverParams,
    bk_client_context: BK_CONTEXT,
    bloks_action: actionId,
  })

  const body = new URLSearchParams({
    variables,
    doc_id: docId,
  }).toString()

  return client.post(`${BASE_URL}/graphql_www`, body, {
    headers: {
      ...headers,
      "x-fb-friendly-name": isAsync ? "BKActionRootQuery" : "BKAppRootQuery",
    },
  })
}

// ── Transport: POST async_action ─────────────────────────────────────────
// Used for the final step10 (create account) which goes through bloks/async_action.

export async function postAsyncAction(
  client: AxiosInstance,
  headers: Record<string, string>,
  actionId: string,
  params: Record<string, unknown>,
  serverParams: Record<string, unknown>,
): Promise<AxiosResponse> {
  const body = new URLSearchParams({
    params: JSON.stringify({
      client_input_params: params,
      server_input_params: serverParams,
      bk_client_context: BK_CONTEXT,
    }),
  }).toString()

  // action_id without the .async suffix for the URL path
  const cleanId = actionId.replace(/\.async$/, "")

  return client.post(
    `${BASE_URL}/api/v1/bloks/async_action/${PINNED_IG_APP_ID}/${cleanId}/`,
    body,
    { headers },
  )
}

// ── Response parsing ─────────────────────────────────────────────────────

export interface ParsedResponse {
  raw: string
  data: Record<string, unknown> | null
  screenName?: string
  error?: string
}

/** Parse Instagram's graphql_bloks response (HTML-encoded JSON, bloks data). */
export function parseBloksResponse(resp: AxiosResponse): ParsedResponse {
  const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
  const result: ParsedResponse = { raw, data: null }

  try {
    // The response is a JSON envelope with data.data containing the bloks layout
    const json = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data
    result.data = json

    // Extract screen name from various possible locations
    const str = JSON.stringify(json)

    // Look for "screen_name":"<name>" pattern
    const screenMatch = /"screen_name"\s*:\s*"([^"]+)"/.exec(str)
    if (screenMatch) result.screenName = screenMatch[1]

    // Look for error messages
    const errMatch = /"error_message"\s*:\s*"([^"]+)"/.exec(str)
    if (errMatch) result.error = errMatch[1]

    // Also check for "errors" array
    const errorsMatch = /"errors"\s*:\s*\[([^\]]+)\]/.exec(str)
    if (errorsMatch && !result.error) {
      result.error = errorsMatch[1].replace(/"/g, "")
    }
  } catch {
    // Not valid JSON — may be a bloks template string
    result.error = "Failed to parse response"
  }

  return result
}

/** Extract reg_context from bloks response using multiple strategies. */
export function extractRegContext(resp: AxiosResponse): Record<string, unknown> | null {
  const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)

  // Strategy 1: Look for reg_context as flat JSON in response
  try {
    const json = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data
    const str = JSON.stringify(json)

    // Look for "reg_context" key
    const rcMatch = /"reg_context"\s*:\s*"([^"]*)"/.exec(str)
    if (rcMatch) {
      try {
        return JSON.parse(rcMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
      } catch {
        return { raw: rcMatch[1] }
      }
    }
  } catch {}

  // Strategy 2: After "logged_out", look for bloks template JSON
  const loggedOutIdx = raw.indexOf("logged_out")
  if (loggedOutIdx !== -1) {
    const after = raw.slice(loggedOutIdx)
    const braceIdx = after.indexOf("{")
    if (braceIdx !== -1) {
      try {
        // Try to parse the JSON starting from the first brace
        let depth = 0
        let end = braceIdx
        for (let i = braceIdx; i < after.length; i++) {
          if (after[i] === "{") depth++
          else if (after[i] === "}") {
            depth--
            if (depth === 0) { end = i + 1; break }
          }
        }
        const candidate = after.slice(braceIdx, end)
        return JSON.parse(candidate)
      } catch {}
    }
  }

  // Strategy 3: Look for |regm marker
  const regmIdx = raw.indexOf("|regm")
  if (regmIdx !== -1) {
    const before = raw.slice(0, regmIdx)
    const lastBrace = before.lastIndexOf("{")
    if (lastBrace !== -1) {
      try {
        let depth = 0
        let start = lastBrace
        for (let i = lastBrace; i < raw.length; i++) {
          if (raw[i] === "{") depth++
          else if (raw[i] === "}") {
            depth--
            if (depth === 0) {
              return JSON.parse(raw.slice(start, i + 1))
            }
          }
        }
      } catch {}
    }
  }

  return null
}

// ── Capture auth headers from responses ──────────────────────────────────

export interface AuthCapture {
  bearer?: string
  mid?: string
  claim?: string
  dsUserId?: string
  csrf?: string
  rur?: string
}

export function captureAuthHeaders(resp: AxiosResponse): AuthCapture {
  const h = resp.headers
  const result: AuthCapture = {}

  // Bearer token from ig-set-authorization
  const auth = h["ig-set-authorization"]
  if (auth && typeof auth === "string" && auth.startsWith("Bearer")) {
    result.bearer = auth
  }

  // Mid from ig-set-x-mid
  const mid = h["ig-set-x-mid"]
  if (mid) result.mid = String(mid)

  // www-claim
  const claim = h["x-ig-set-www-claim"]
  if (claim) result.claim = String(claim)

  // ds_user_id from response body or headers
  const dsUser = h["ig-set-ig-u-ds-user-id"]
  if (dsUser) result.dsUserId = String(dsUser)

  // CSRF from set-cookie
  const cookies = h["set-cookie"]
  if (cookies) {
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
    const csrfMatch = /csrftoken=([^;]+)/.exec(cookieStr)
    if (csrfMatch) result.csrf = csrfMatch[1]
    const rurMatch = /rur=([^;]+)/.exec(cookieStr)
    if (rurMatch) result.rur = rurMatch[1]
  }

  return result
}

// ── Create an axios instance with proxy ──────────────────────────────────

export function createClient(proxyUrl?: string): AxiosInstance {
  const agent = buildProxyAgent(proxyUrl || "")
  return axios.create({
    timeout: 30_000,
    maxRedirects: 0,
    validateStatus: () => true, // don't throw on non-2xx
    ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
  })
}
