// Adaptive decoder for the base64 "cookie" blob pasted when adding an account.
//
// The blob is a snapshot captured from a real logged-in device. Different tools
// export it in DIFFERENT shapes, so this decoder is deliberately tolerant:
//
//   • Input may be base64-encoded JSON OR raw JSON.
//   • Fields may be nested (session/device/ua_profile) OR flat at the top level,
//     and may be wrapped under `account`/`data`.
//   • Key names vary (authorization/bearer/token, ds_user_id/pk/user_id,
//     guid/uuid/_uuid, …) — every field is looked up through an alias list.
//   • The session may be carried as a `cookies` array/string/map instead of an
//     explicit bearer; we read sessionid/ds_user_id/mid/csrf from there.
//   • When only sessionid + ds_user_id are present, we SYNTHESIZE the IGT:2
//     bearer token from them.
//   • A `user_agent` string is parsed to recover model / iOS / locale.
//
// WHATEVER IS PRESENT is kept verbatim. WHATEVER IS MISSING is filled in and
// PERSISTED so it stays stable for every future request: missing device UUIDs
// (guid, phone_id, family_device_id, device_id, pigeon_session, waterfall_id)
// are generated once here, and the UA profile is completed from a preset (or a
// random device when no hardware info is present at all).
//
// The only thing we NEVER take from the blob is the Instagram app version: it is
// always pinned to our latest build (PINNED_IG_APP_VERSION) so app-version-scoped
// values (doc_ids, bloks version, version code) stay consistent with the app.

import { randomUUID } from "node:crypto"
import {
  PINNED_IG_APP_VERSION,
  PINNED_IG_VERSION_CODE,
  normalizeLocale,
  DEFAULT_TIMEZONE,
  randomDevice,
  getPreset,
  parseUserAgent,
} from "./devices"

export interface CookieBlobSession {
  authorization?: string
  ds_user_id?: number | string
  mid?: string
  csrf?: string
  www_claim?: string
}

export interface CookieBlobDevice {
  guid?: string
  family_device_id?: string
  phone_id?: string
  device_id?: string
  pigeon_session?: string
  fb_anon_id?: string
  waterfall_id?: string
  network_bssid?: string
  reg_flow_id?: string
  aac_jid?: string
  machine_id?: string
  cloud_trust?: string
}

export interface CookieBlobUaProfile {
  ua_version?: string
  device_model?: string
  os_version?: string
  os_ver_dotted?: string
  os_build?: string
  locale?: string
  country?: string
  tz_name?: string
  scale?: string
  resolution?: string
  w_logical?: number
  h_logical?: number
  ios_ver?: string
}

export interface CookieBlob {
  saved_at?: number
  username?: string
  password?: string
  totp_seed?: string
  email?: string
  session?: CookieBlobSession
  device?: CookieBlobDevice
  app?: Record<string, unknown>
  ua_profile?: CookieBlobUaProfile
  cookies?: unknown[]
  // Names of the fields that were auto-generated because the blob didn't carry
  // them. Purely informational — persisted inside `identity` for debugging.
  generated?: string[]
}

type Dict = Record<string, unknown>

function isObj(v: unknown): v is Dict {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// First non-empty scalar among `aliases`, searched across `containers` in order
// (so a nested `session`/`device` wins over a flat top-level duplicate). Keys
// are matched case-insensitively; object/array values are skipped.
function pick(containers: Dict[], aliases: string[]): string {
  for (const c of containers) {
    if (!isObj(c)) continue
    for (const alias of aliases) {
      for (const k of Object.keys(c)) {
        if (k.toLowerCase() !== alias) continue
        const val = c[k]
        if (typeof val === "string") {
          if (val.trim()) return val.trim()
        } else if (typeof val === "number" || typeof val === "bigint") {
          return String(val)
        }
      }
    }
  }
  return ""
}

// Parse a `cookies` field in any of the common shapes into a name→value map:
//   "a=1; b=2"  |  ["a=1", "b=2"]  |  [{name,value}|{key,value}]  |  {a:1,b:2}
function parseCookies(input: unknown): Map<string, string> {
  const map = new Map<string, string>()
  const add = (name?: unknown, value?: unknown) => {
    const n = typeof name === "string" ? name.trim().toLowerCase() : ""
    const v = value == null ? "" : String(value)
    if (n && v && !map.has(n)) map.set(n, v)
  }
  const fromString = (s: string) => {
    for (const part of s.split(/;\s*/)) {
      const idx = part.indexOf("=")
      if (idx > 0) add(part.slice(0, idx), part.slice(idx + 1))
    }
  }
  if (typeof input === "string") fromString(input)
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") fromString(item)
      else if (isObj(item)) add(item.name ?? item.key ?? item.Name ?? item.Key, item.value ?? item.Value ?? item.val)
    }
  } else if (isObj(input)) {
    for (const [k, v] of Object.entries(input)) add(k, v)
  }
  return map
}

// Decode the IGT:2:<base64-json> bearer into its ds_user_id / sessionid so we can
// backfill either from the other. Mirrors decodeBearer() in client.ts.
function decodeIgtToken(bearer: string): { dsUserId: string; sessionId: string } {
  try {
    const raw = bearer.replace(/^Bearer\s+/i, "").trim()
    const parts = raw.split(":")
    const json = JSON.parse(Buffer.from(parts[parts.length - 1], "base64").toString("utf8"))
    return { dsUserId: String(json.ds_user_id ?? ""), sessionId: String(json.sessionid ?? "") }
  } catch {
    return { dsUserId: "", sessionId: "" }
  }
}

// Alias lists. "id"/"account_id"/"android_id"/advertising ids are deliberately
// excluded — they're ambiguous and would mismatch across export formats.
const AUTH_KEYS = ["authorization", "bearer", "token", "access_token", "auth"]
const DS_USER_KEYS = ["ds_user_id", "ds_user", "user_id", "userid", "pk"]
const SESSIONID_KEYS = ["sessionid", "session_id"]
const MID_KEYS = ["mid", "x-mid", "x_mid", "ig_mid"]
const CLAIM_KEYS = ["www_claim", "x-ig-www-claim", "ig_www_claim", "www-claim"]
const CSRF_KEYS = ["csrf", "csrftoken", "csrf_token"]
const GUID_KEYS = ["guid", "uuid", "_uuid", "device_uuid"]
const FAMILY_KEYS = ["family_device_id", "familydeviceid", "family_id"]
const PHONE_KEYS = ["phone_id", "phoneid"]
const DEVICE_ID_KEYS = ["device_id", "deviceid", "_device_id"]

function ensureId(current: string, name: string, generated: string[]): string {
  if (current) return current
  generated.push(name)
  return randomUUID()
}

// Decode + adapt + complete the blob. Throws a friendly error only when the
// input isn't parseable at all or carries no usable session (no bearer and no
// sessionid+ds_user_id to build one), so the caller can block the add.
export function decodeCookieBlob(input: string): CookieBlob {
  const raw = (input ?? "").trim()
  if (!raw) throw new Error("Cookie is empty")

  // 1) base64 → JSON (tolerant of url-safe base64 + missing padding).
  let json: unknown
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
    json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  } catch {
    json = undefined
  }
  // 2) Fallback: the blob may have been pasted as raw JSON, not base64.
  if (json === undefined) {
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error("Cookie is not valid base64-encoded JSON")
    }
  }
  if (!isObj(json)) throw new Error("Cookie did not decode to an object")

  const root = json
  const sessionC = isObj(root.session) ? root.session : {}
  const deviceC = isObj(root.device) ? root.device : {}
  const uaC = isObj(root.ua_profile) ? root.ua_profile : isObj(root.device_profile) ? root.device_profile : {}
  const appC = isObj(root.app) ? root.app : {}
  const wrap = isObj(root.account) ? root.account : isObj(root.data) ? root.data : {}
  const containers: Dict[] = [sessionC, deviceC, uaC, appC, root, wrap]

  const cookies = parseCookies(root.cookies ?? sessionC.cookies ?? root.cookie ?? sessionC.cookie)
  const cookieGet = (keys: string[]) => {
    for (const k of keys) {
      const v = cookies.get(k)
      if (v) return v
    }
    return ""
  }

  const generated: string[] = []

  // ── session ───────────────────────────────────────────────────────────────
  let authorization = pick(containers, AUTH_KEYS)
  let dsUserId = pick(containers, DS_USER_KEYS) || cookieGet(["ds_user_id"])
  let sessionid = pick([sessionC, root, wrap], SESSIONID_KEYS) || cookieGet(["sessionid"])

  // Backfill from the bearer if one was provided.
  if (authorization) {
    const d = decodeIgtToken(authorization)
    if (!dsUserId && d.dsUserId) dsUserId = d.dsUserId
    if (!sessionid && d.sessionId) sessionid = d.sessionId
  }
  // Synthesize the IGT:2 bearer when only the raw session pieces are present.
  if (!authorization && sessionid && dsUserId) {
    const payload = JSON.stringify({ ds_user_id: String(dsUserId), sessionid, should_use_header_over_cookies: true })
    authorization = `IGT:2:${Buffer.from(payload).toString("base64")}`
    generated.push("authorization")
  }
  if (!authorization) {
    throw new Error(
      "Cookie has no session: provide either an authorization/bearer token, or sessionid + ds_user_id",
    )
  }

  const session: CookieBlobSession = {
    ...(sessionC as CookieBlobSession),
    authorization,
    ds_user_id: dsUserId || (sessionC as CookieBlobSession).ds_user_id || undefined,
    mid: pick(containers, MID_KEYS) || cookieGet(["mid", "ig-mid"]) || undefined,
    csrf: pick(containers, CSRF_KEYS) || cookieGet(["csrftoken"]) || undefined,
    www_claim: pick(containers, CLAIM_KEYS) || cookieGet(["x-ig-www-claim", "ig-www-claim"]) || undefined,
  }

  // ── device identity (generate + persist anything missing) ──────────────────
  const device: CookieBlobDevice = {
    ...(deviceC as CookieBlobDevice),
    guid: ensureId(pick([deviceC, root, wrap], GUID_KEYS), "guid", generated),
    family_device_id: ensureId(pick([deviceC, root, wrap], FAMILY_KEYS), "family_device_id", generated),
    phone_id: ensureId(pick([deviceC, root, wrap], PHONE_KEYS), "phone_id", generated),
    device_id: ensureId(pick([deviceC, root, wrap], DEVICE_ID_KEYS), "device_id", generated),
    cloud_trust: pick([deviceC, root, wrap], ["cloud_trust", "cloudtrust", "cloud_trust_token"]) || undefined,
  }
  if (!device.pigeon_session) {
    device.pigeon_session = `UFS-${randomUUID()}-0`
    generated.push("pigeon_session")
  }
  if (!device.waterfall_id) {
    device.waterfall_id = randomUUID()
    generated.push("waterfall_id")
  }

  // ── UA profile (real device kept; missing pieces completed) ─────────────────
  let deviceModel = pick([uaC, deviceC, root, wrap], ["device_model", "model", "phone_model"])
  let iosVer = pick([uaC, deviceC, root, wrap], ["ios_ver", "os_version", "ios", "ios_version"])
  let locale = pick([uaC, root, wrap], ["locale", "language", "lang"])
  let scale = pick([uaC, deviceC, root, wrap], ["scale"])
  let resolution = pick([uaC, deviceC, root, wrap], ["resolution", "screen", "dimensions"])
  const tzName = pick([uaC, root, wrap], ["tz_name", "timezone", "tz", "time_zone"])
  const uaString = pick([uaC, root, wrap], ["user_agent", "ua", "useragent"])

  // A bare UA string is enough to recover model / iOS / locale.
  if (uaString) {
    const p = parseUserAgent(uaString)
    if (p) {
      deviceModel = deviceModel || p.iphoneModel
      iosVer = iosVer || p.iosVersion
      locale = locale || p.locale
    }
  }
  // No hardware info at all → assign a realistic random device (and persist it).
  if (!deviceModel) {
    const rd = randomDevice()
    deviceModel = rd.iphoneModel
    iosVer = iosVer || rd.iosVersion
    generated.push("device_model")
  }
  const preset = getPreset(deviceModel)
  const iosUnderscore = (iosVer || "17_0").replace(/\./g, "_")
  const ua_profile: CookieBlobUaProfile = {
    ...(uaC as CookieBlobUaProfile),
    device_model: deviceModel,
    ios_ver: iosUnderscore,
    os_version: iosUnderscore,
    locale: normalizeLocale(locale),
    tz_name: tzName || DEFAULT_TIMEZONE,
    scale: scale || preset.scale,
    resolution: resolution || preset.resolution,
  }

  // ── credentials embedded in the blob (optional) ─────────────────────────────
  const username = pick([root, wrap, sessionC], ["username", "user", "login", "user_name"])
  const password = pick([root, wrap, sessionC], ["password", "pass", "pwd"])
  const totp = pick([root, wrap, sessionC], ["totp_seed", "totp", "twofa", "2fa", "otp_seed", "two_factor"])

  return {
    ...(root as CookieBlob),
    username: username || (root.username as string) || undefined,
    password: password || (root.password as string) || undefined,
    totp_seed: totp || (root.totp_seed as string) || undefined,
    session,
    device,
    ua_profile,
    generated: generated.length ? generated : undefined,
  }
}

// Build the User-Agent for a blob's device: the REAL device model / iOS /
// locale / screen from the (now-completed) profile, but ALWAYS with our pinned
// app version and version code (never the blob's app version).
export function buildUserAgentFromBlob(blob: CookieBlob): string {
  const ua = blob.ua_profile ?? {}
  const model = (ua.device_model || "iPhone11,8").trim()
  const iosUnderscore = (ua.ios_ver || ua.os_version || "17_0").trim().replace(/\./g, "_")
  const locale = normalizeLocale(ua.locale)
  const lang = locale.split("_")[0]
  const scale = (ua.scale || "3.00").trim()
  const resolution = (ua.resolution || "1170x2532").trim()
  return `Instagram ${PINNED_IG_APP_VERSION} (${model}; iOS ${iosUnderscore}; ${locale}; ${lang}; scale=${scale}; ${resolution}; ${PINNED_IG_VERSION_CODE}) AppleWebKit/420+`
}

// The underscore iOS string from the (completed) blob ("16.4.1" → "16_4_1").
export function iosUnderscoreFromBlob(blob: CookieBlob): string {
  const ua = blob.ua_profile ?? {}
  return (ua.ios_ver || ua.os_version || "").trim().replace(/\./g, "_")
}
