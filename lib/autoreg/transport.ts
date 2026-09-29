import axios, { type AxiosInstance, type AxiosResponse } from "axios"
import { HttpProxyAgent } from "http-proxy-agent"
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

let _warnedMissingTlsProxy = false
function warnMissingTlsProxyOnce() {
  if (_warnedMissingTlsProxy) return
  _warnedMissingTlsProxy = true
  console.warn(
    "[autoreg] WARNING: TLS_PROXY_URL is not set — autoreg traffic is using Node's TLS/JA4 fingerprint, NOT an iPhone's. " +
      "This mismatch against the iOS User-Agent is a primary ban signal. Start the uTLS sidecar and set TLS_PROXY_URL.",
  )
}

export function buildProxyAgent(proxyUrl: string) {
  // Autoreg bypasses uTLS sidecar — Python reference uses plain requests
  // with user proxy directly and gets 10/20 success. The sidecar may be
  // stripping response headers (ig-set-authorization) or breaking the
  // proxy chain. Use user proxy directly, same as Python.
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
  ramBytes: number
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
    ramBytes: device.ramBytes,
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
    // ip-api.com is plain HTTP — buildProxyAgent() returns HTTPS-only agents
    // (CONNECT tunnel) which fail silently for HTTP targets. Use HttpProxyAgent
    // for HTTP proxies, SocksProxyAgent for SOCKS (works for both protocols).
    let httpAgent: HttpProxyAgent<string> | SocksProxyAgent | undefined
    if (proxyUrl) {
      if (proxyUrl.startsWith("socks")) {
        httpAgent = new SocksProxyAgent(proxyUrl)
      } else {
        const url = proxyUrl.startsWith("http") ? proxyUrl : `http://${proxyUrl}`
        httpAgent = new HttpProxyAgent(url)
      }
    }
    const resp = await axios.get("http://ip-api.com/json/?fields=countryCode,timezone", {
      httpAgent,
      proxy: false,
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
  cookies?: Map<string, string>
  rur?: string
  connUuid?: string
}

export function commonHeaders(ctx: HeadersContext): Record<string, string> {
  const connSpeed = 1000 + Math.floor(Math.random() * 4000)

  const headers: Record<string, string> = {
    "accept-language": "en-US;q=1.0",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "ig-intended-user-id": "0",
    "priority": "u=2, i",
    "user-agent": ctx.userAgent,
    "x-bloks-version-id": PINNED_BLOKS_VERSION_ID,
    "x-fb-client-ip": "True",
    "x-fb-connection-type": "wifi",
    "x-fb-server-cluster": "True",
    "x-ig-app-id": PINNED_IG_APP_ID,
    "x-ig-app-locale": "en",
    "x-ig-bandwidth-speed-kbps": "0.000",
    "x-ig-bloks-serialize-payload": "true",
    "x-ig-capabilities": PINNED_IG_CAPABILITIES,
    "x-ig-connection-speed": `${connSpeed}kbps`,
    "x-ig-connection-type": "WiFi",
    "x-ig-device-id": ctx.deviceId,
    "x-ig-device-locale": "en_US",
    "x-ig-mapped-locale": "en_US",
    "x-ig-timezone-offset": "-18000",
    "x-tigon-is-retry": "False",
    "x-ig-transfer-encoding": "chunked",
    "x-fb-http-engine": "Tigon/MNS/TCP",
    "x-fb-rmd": "state=URL_ELIGIBLE",
    "bloks_versioning_id": PINNED_BLOKS_VERSION_ID,
    "bk_client_context": JSON.stringify(BK_CONTEXT),
  }

  if (ctx.mid) headers["x-mid"] = ctx.mid

  if (ctx.cookies && ctx.cookies.size > 0) {
    headers["cookie"] = [...ctx.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }

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
  const resolvedDocId = isAsync ? CLIENT_DOC_ID_ACTION : CLIENT_DOC_ID_APP
  const friendlyName = isAsync
    ? `BKActionRootQuery-${actionId}`
    : `BKAppRootQuery-${actionId}`
  const rootFieldName = isAsync ? "bloks_action" : "bloks_app"

  const inner = {
    server_params: serverParams,
    client_input_params: params,
  }
  const paramsStr = JSON.stringify({ params: JSON.stringify(inner) })

  const variables = JSON.stringify({
    bk_context: BK_CONTEXT,
    params: {
      params: paramsStr,
      bloks_versioning_id: headers["x-bloks-version-id"] || PINNED_BLOKS_VERSION_ID,
      app_id: actionId,
      infra_params: { device_id: headers["x-ig-device-id"] || "" },
    },
  })

  const form: Record<string, string> = {
    method: "post",
    pretty: "false",
    format: "json",
    server_timestamps: "true",
    locale: "en_US",
    purpose: "fetch",
    fb_api_req_friendly_name: friendlyName,
    client_doc_id: resolvedDocId,
    enable_canonical_naming: "true",
    enable_canonical_variable_overrides: "true",
    enable_canonical_naming_ambiguous_type_prefixing: "true",
    variables,
  }

  const body = new URLSearchParams(form).toString()

  return client.post(`${BASE_URL}/graphql_www`, body, {
    headers: {
      ...headers,
      "x-fb-friendly-name": friendlyName,
      "x-root-field-name": rootFieldName,
      "x-graphql-client-library": "pando",
      "x-graphql-request-purpose": "fetch",
    },
    responseType: "text",
    transformResponse: (d: string) => d,
  })
}

// ── Transport: POST async_action ─────────────────────────────────────────
// Used for steps that go through bloks/async_action (step2, step4, step10).

export async function postAsyncAction(
  client: AxiosInstance,
  headers: Record<string, string>,
  actionId: string,
  params: Record<string, unknown>,
  serverParams: Record<string, unknown>,
): Promise<AxiosResponse> {
  const body = signedBody({
    params: JSON.stringify({
      server_params: serverParams,
      client_input_params: params,
    }),
    bloks_versioning_id: headers["x-bloks-version-id"] || PINNED_BLOKS_VERSION_ID,
    bk_client_context: JSON.stringify(BK_CONTEXT),
  })

  return client.post(
    `${BASE_URL}/api/v1/bloks/async_action/${actionId}/`,
    body,
    {
      headers: {
        ...headers,
        "x-fb-friendly-name": "bloks/async_action/",
      },
      responseType: "text",
      transformResponse: (d: string) => d,
    },
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

/** Extract reg_context string from bloks response using multiple strategies. */
export function extractRegContext(resp: AxiosResponse): string | null {
  const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
  if (!raw) return null

  // Strategy 1: flat JSON field with various escape levels
  const jsonPatterns = [
    /\\\\"reg_context\\\\":\\\\"([^"\\]{20,})\\\\"/g,
    /\\"reg_context\\":\\"([^"\\]{20,})\\"/g,
    /"reg_context":"([^"]{20,})"/g,
  ]
  for (const pat of jsonPatterns) {
    const matches = [...raw.matchAll(pat)].map((m) => m[1])
    if (matches.length) return matches.reduce((a, b) => (a.length >= b.length ? a : b))
  }

  // Strategy 2: bloks template — token after "logged_out", ending with |regm
  const bloksMatch = /logged_out[\\"\s]+([A-Za-z0-9_\-][A-Za-z0-9_\-\s]{200,}\|regm)/.exec(raw)
  if (bloksMatch) return bloksMatch[1].replace(/\s+/g, "")

  // Strategy 3: fallback — single token ending with |regm
  const candidates = [...raw.matchAll(/([A-Za-z0-9_\-][A-Za-z0-9_\-\s]{200,}\|regm)/g)]
    .map((m) => m[1].replace(/\s+/g, ""))
  if (candidates.length === 1) return candidates[0]

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
  sessionid?: string
  region?: string
}

export function captureAuthHeaders(resp: AxiosResponse): AuthCapture {
  const h = resp.headers
  const result: AuthCapture = {}

  const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? "")

  // Bloks responses are escaped multiple levels deep.  Build a stack of
  // progressively unescaped copies so every regex gets a chance at each level.
  const layers: string[] = [raw]
  let prev = raw
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\\//g, "/")
    if (next === prev) break
    layers.push(next)
    prev = next
  }

  // Bearer token: header first, then response body (escaped bloks payload)
  const auth = h["ig-set-authorization"]
  if (auth && typeof auth === "string" && auth.trim()) {
    const val = auth.trim()
    result.bearer = val.startsWith("Bearer") ? val : `Bearer ${val}`
  }
  if (!result.bearer) {
    for (const text of layers) {
      const m = /Bearer\s+IGT:2:[A-Za-z0-9+/=_\-]+/.exec(text)
      if (m) { result.bearer = m[0]; break }
    }
  }
  // Bloks action format: SetAuthorizationAction carries the token as a
  // positional argument — e.g. (bk.action…, "Bearer IGT:2:…")
  if (!result.bearer) {
    for (const text of layers) {
      const m = /SetAuthorizationAction[^)]*?"(Bearer\s+IGT:2:[A-Za-z0-9+/=_\-]+)"/.exec(text)
      if (m) { result.bearer = m[1]; break }
    }
  }
  // Bloks tree format: (bk.action.caa.HandleAuthorizationResponse, ...)
  // may contain the base64 bearer inline
  if (!result.bearer) {
    for (const text of layers) {
      const m = /HandleAuthorizationResponse[^)]*?"(Bearer\s+IGT:2:[A-Za-z0-9+/=_\-]+)"/.exec(text)
      if (m) { result.bearer = m[1]; break }
    }
  }
  // Fallback: sessionid in body — synthesize bearer from sessionid + ds_user_id
  // (done after ds_user_id extraction below)

  // Mid from ig-set-x-mid header or cookie
  const mid = h["ig-set-x-mid"]
  if (mid) result.mid = String(mid)
  if (!result.mid) {
    const cookies = h["set-cookie"]
    if (cookies) {
      const cs = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
      const mm = /\bmid=([^;]+)/.exec(cs)
      if (mm) result.mid = mm[1]
    }
  }

  // www-claim: header first, then response body
  const claim = h["x-ig-set-www-claim"]
  if (claim && String(claim) !== "0") {
    result.claim = String(claim)
  }
  if (!result.claim) {
    for (const text of layers) {
      const m = /hmac\.[A-Za-z0-9_\-]{16,}/.exec(text)
      if (m) { result.claim = m[0]; break }
    }
  }

  // ds_user_id: header → cookie → response body
  const dsUser = h["ig-set-ig-u-ds-user-id"]
  if (dsUser) {
    result.dsUserId = String(dsUser)
  }
  if (!result.dsUserId) {
    const dsPatterns = [
      /"(?:pk|user_id|ds_user_id)"\s*:\s*"?(\d{6,})"?/,
      /\(eud\s+(\d{6,})\)/,
      /ds_user_id["\\s:=]+(\d{6,})/,
    ]
    for (const pat of dsPatterns) {
      for (const text of layers) {
        const m = pat.exec(text)
        if (m) { result.dsUserId = m[1]; break }
      }
      if (result.dsUserId) break
    }
  }

  // CSRF, RUR, sessionid from set-cookie
  const cookies = h["set-cookie"]
  if (cookies) {
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
    const csrfMatch = /csrftoken=([^;]+)/.exec(cookieStr)
    if (csrfMatch) result.csrf = csrfMatch[1]
    const rurMatch = /rur=([^;]+)/.exec(cookieStr)
    if (rurMatch) result.rur = rurMatch[1]
    const sessionidMatch = /sessionid=([^;]+)/.exec(cookieStr)
    if (sessionidMatch) result.sessionid = sessionidMatch[1]
    if (!result.dsUserId) {
      const dsMatch = /ds_user_id=(\d+)/.exec(cookieStr)
      if (dsMatch) result.dsUserId = dsMatch[1]
    }
  }

  // sessionid from response body (bloks may set it via cookie actions)
  if (!result.sessionid) {
    for (const text of layers) {
      const m = /sessionid["\\:=\s]+([A-Za-z0-9%]{10,})/.exec(text)
      if (m && m[1] !== "0" && !m[1].startsWith("00000")) { result.sessionid = m[1]; break }
    }
  }

  // Synthesize bearer when we have sessionid + ds_user_id but no bearer
  if (!result.bearer && result.sessionid && result.dsUserId) {
    const payload = JSON.stringify({
      ds_user_id: result.dsUserId,
      sessionid: result.sessionid,
      should_use_header_over_cookies: true,
    })
    result.bearer = `Bearer IGT:2:${Buffer.from(payload).toString("base64")}`
  }

  // RUR from header
  const rur = h["ig-set-ig-u-rur"]
  if (rur && !result.rur) result.rur = String(rur)

  // Region from header
  const region = h["ig-set-ig-u-region"]
  if (region) result.region = String(region)

  return result
}

// ── Create an axios instance with proxy ──────────────────────────────────

export function createClient(proxyUrl?: string): AxiosInstance {
  const agent = buildProxyAgent(proxyUrl || "")
  return axios.create({
    timeout: 60_000,
    maxRedirects: 30,
    validateStatus: () => true, // don't throw on non-2xx
    ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),
  })
}
