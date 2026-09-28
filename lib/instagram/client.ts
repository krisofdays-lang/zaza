import { randomUUID, randomBytes as cryptoRandomBytes, createHash } from "node:crypto"
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import { buildUserAgent, PINNED_IG_APP_VERSION, localeHeaders, normalizeLocale, tzOffsetSeconds, IG_APP_ID, BLOKS_VERSION_ID, BLOKS_PRISM_HEADERS, IG_CAPABILITIES } from "./devices"
import { NavSession, type NavClockSource } from "./nav-chain"
import { db } from "@/lib/db"
import { igAccounts, type IgAccount } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

const BASE_URL = "https://i.instagram.com"
// APP_ID, BLOKS_VERSION_ID, BLOKS_PRISM_HEADERS and IG_CAPABILITIES are
// imported from ./devices so the autoreg engine shares the same pinned values.

export interface DecodedToken {
  dsUserId: string
  sessionId: string
}

// Bearer tokens look like: IGT:2:<base64-json> where the json contains
// ds_user_id and sessionid. We decode it to fill _uid / ig-* headers.
export function decodeBearer(bearer: string): DecodedToken {
  try {
    const raw = bearer.replace(/^Bearer\s+/i, "").trim()
    const parts = raw.split(":")
    const b64 = parts[parts.length - 1]
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
    return {
      dsUserId: String(json.ds_user_id ?? ""),
      sessionId: String(json.sessionid ?? ""),
    }
  } catch {
    return { dsUserId: "", sessionId: "" }
  }
}

// The loopback uTLS sidecar (tls-proxy/). When set, ALL Instagram traffic is
// routed through it so the TLS/JA4 + HTTP/2 fingerprint matches a real iPhone
// instead of Node's OpenSSL stack. The account's real mobile proxy is chained
// downstream by the sidecar (passed per-request on the CONNECT headers).
const TLS_PROXY_URL = process.env.TLS_PROXY_URL || ""

// Normalise an account's proxy into a single URL string the sidecar understands
// (or the legacy agents consume). Returns "" for a direct connection.
function upstreamProxyUrl(account: IgAccount): string {
  if (!account.proxyUrl || account.proxyType === "none") return ""
  if (account.proxyType === "socks5") {
    return account.proxyUrl.startsWith("socks") ? account.proxyUrl : `socks5://${account.proxyUrl}`
  }
  return account.proxyUrl.startsWith("http") ? account.proxyUrl : `http://${account.proxyUrl}`
}

// https-proxy-agent applies the constructor's `rejectUnauthorized` ONLY to the
// hop that reaches the proxy itself (its `connectOpts`). The *destination* TLS
// handshake — here the loopback Go sidecar's MITM cert for i.instagram.com — is
// upgraded from the per-request `opts`, which never inherit the constructor
// flag. So a plain `new HttpsProxyAgent(url, { rejectUnauthorized:false })`
// still makes Node reject the sidecar's throwaway self-signed cert with
// "self-signed certificate" (ERR_TLS_*). We override `connect` to inject the
// flag into the per-request opts so it reaches the destination `tls.connect`.
//
// This is safe: it disables verification ONLY for the loopback Node -> sidecar
// hop (127.0.0.1). The security-relevant Go -> Instagram handshake is done by
// the sidecar with uTLS and still fully validates Instagram's real certificate.
class LoopbackTlsProxyAgent extends HttpsProxyAgent<string> {
  async connect(
    req: Parameters<HttpsProxyAgent<string>["connect"]>[0],
    opts: Parameters<HttpsProxyAgent<string>["connect"]>[1],
  ): ReturnType<HttpsProxyAgent<string>["connect"]> {
    // rejectUnauthorized lives on the https (secureEndpoint) branch of the opts
    // union; injecting it for the http branch is harmless and ignored, so cast.
    return super.connect(req, { ...opts, rejectUnauthorized: false } as typeof opts)
  }
}

function buildAgent(account: IgAccount) {
  const upstream = upstreamProxyUrl(account)

  // Preferred path: send everything through the uTLS sidecar. We hand it the
  // account's mobile proxy and the pinned app version via CONNECT headers so it
  // can pick the version-matched ClientHello and chain to the right proxy. The
  // Node -> sidecar hop is loopback with a throwaway self-signed cert, so we use
  // LoopbackTlsProxyAgent to skip verification of that hop only.
  if (TLS_PROXY_URL) {
    return new LoopbackTlsProxyAgent(TLS_PROXY_URL, {
      rejectUnauthorized: false,
      headers: {
        "x-upstream-proxy": upstream,
        "x-app-version": PINNED_IG_APP_VERSION,
      },
    })
  }

  // Legacy direct path (no sidecar): connect straight through the mobile proxy
  // using Node's TLS. Kept as a fallback so the app still works if the sidecar
  // isn't running, but this exposes Node's JA3/JA4 fingerprint — which is one of
  // the strongest "this is not a real iPhone" signals Instagram can see, since
  // every other header claims iOS. Running in this mode at scale is a very
  // likely cause of chain-bans, so we make it LOUD instead of silent.
  warnMissingTlsProxyOnce()
  // Opt-in hard stop: set TLS_PROXY_REQUIRED=1 in production so a misconfigured
  // deploy fails fast instead of silently burning accounts with a Node JA4.
  if (process.env.TLS_PROXY_REQUIRED === "1") {
    throw new Error(
      "TLS_PROXY_REQUIRED=1 but TLS_PROXY_URL is not set: refusing to send Instagram traffic with Node's JA3/JA4 fingerprint. Start the uTLS sidecar (see tls-proxy/README.md) and set TLS_PROXY_URL.",
    )
  }
  if (!upstream) return undefined
  if (upstream.startsWith("socks")) return new SocksProxyAgent(upstream)
  return new HttpsProxyAgent(upstream)
}

// Emit the missing-sidecar warning exactly once per process so logs aren't
// flooded (buildAgent runs per account/run).
let _warnedMissingTlsProxy = false
function warnMissingTlsProxyOnce() {
  if (_warnedMissingTlsProxy) return
  _warnedMissingTlsProxy = true
  console.warn(
    "[v0] WARNING: TLS_PROXY_URL is not set — Instagram traffic is using Node's TLS/JA4 fingerprint, NOT an iPhone's. " +
      "This mismatch against the iOS User-Agent is a primary ban signal. Start the uTLS sidecar (tls-proxy/, or `docker compose up`) " +
      "and set TLS_PROXY_URL, or set TLS_PROXY_REQUIRED=1 to hard-fail instead of running in this unsafe mode.",
  )
}

export interface IgResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
  url: string
  error?: string
}

export class InstagramClient {
  private account: IgAccount
  private decoded: DecodedToken
  private http: AxiosInstance
  // Per-account navigation + pigeon session state. Lives for the lifetime of
  // this client (one per account per run), so the nav chain and screen position
  // grow across every node the account executes, and the pigeon session id
  // rotates on its own ~20-30 min timer. Endpoints drive it via `nav.visit(...)`
  // and read `nav.chainString()` when they must echo the chain into the body.
  readonly nav: NavSession
  // Regional routing token (ig-u-rur). The real app receives it via the
  // `ig-set-ig-u-rur` response header right after login and echoes it back as
  // `ig-u-rur` on every subsequent request. We capture and replay it within the
  // run so our traffic carries the same routing hint a genuine session does.
  private rur = ""

  // In-memory cookie jar. Real iOS clients send a `cookie` header on every
  // request, carrying csrftoken, ds_user_id, sessionid, mid, ig_did, rur etc.
  // Without it, the absence of cookies alongside a full device header set is
  // an inconsistency. We seed it from the bearer token's sessionid + the
  // account's mid/deviceId, then capture set-cookie from every response so
  // the jar grows naturally over the run — just like a real session.
  private cookies = new Map<string, string>()

  // Per-connection UUID the Tigon/MNS networking layer attaches to every
  // request on the same h2 connection. 32 hex chars, stable for the lifetime
  // of the client instance (≈ one logical session / tunnel).
  private readonly connUuid = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("")

  // Per-run synthetic network profile. Real iOS clients attach live bandwidth
  // telemetry (x-ig-bandwidth-speed-kbps, x-fb-connection-quality, …) that drifts
  // request-to-request; a device that reports byte-identical speeds forever — or
  // omits them entirely — is an automation tell. We pick one plausible WiFi
  // baseline per client (== per publication run) so different publications look
  // like different sessions on different networks, then add light per-request
  // jitter in `bandwidthHeaders()`. Ranges mirror the captured dumps
  // (bandwidth ~450–1350 kbps, rtt ~2–8 ms, EXCELLENT quality on WiFi).
  private _net?: { baseKbps: number; rttBase: number }
  private get net(): { baseKbps: number; rttBase: number } {
    if (!this._net) {
      this._net = {
        baseKbps: 450 + Math.floor(this.accountRandom() * 900),
        rttBase: 2 + Math.floor(this.accountRandom() * 6),
      }
    }
    return this._net
  }

  // Fresh bandwidth telemetry for a single request. Jittered around the per-run
  // baseline so values move like a real radio does between calls.
  private bandwidthHeaders(): Record<string, string> {
    const r = () => this.accountRandom()
    const jitter = (base: number, pct: number) => base * (1 + (r() * 2 - 1) * pct)
    const kbps = jitter(this.net.baseKbps, 0.15)
    const sensitive = kbps * (0.95 + r() * 0.05)
    const rtt = Math.max(1, Math.round(jitter(this.net.rttBase, 0.4)))
    const c = 60 + Math.floor(r() * 140)
    const tbw = 30000 + Math.floor(r() * 90000)
    const uplat = 30 + Math.floor(r() * 300)
    const connSpeed = Math.max(10, Math.round(kbps * (0.2 + r() * 0.5)))
    const cmKbps = Math.max(20, jitter(this.net.baseKbps * 0.3, 0.5))
    const cmLatency = Math.max(1, jitter(this.net.rttBase * 0.6, 0.5))
    const abrKbps = Math.max(20, Math.round(jitter(this.net.baseKbps * 0.25, 0.4)))
    return {
      "x-ig-bandwidth-speed-kbps": kbps.toFixed(3),
      "x-ig-bandwidth-speed-kbps-sensitive": sensitive.toFixed(3),
      "x-ig-connection-speed": `${connSpeed}kbps`,
      "x-cm-bandwidth-kbps": cmKbps.toFixed(3),
      "x-cm-latency": cmLatency.toFixed(3),
      "x-ig-abr-connection-speed-kbps": String(abrKbps),
      "x-fb-connection-quality": `EXCELLENT; q=0.9, rtt=${rtt}, rtx=0, c=${c}, mss=1380, tbw=${tbw}, tp=-1, tpl=-1, uplat=${uplat}, ullat=0`,
    }
  }

  // ── Per-account fingerprint isolation ──────────────────────────────
  // Every client-facing timestamp (upload_id, publish_id, client_timestamp)
  // is generated via accountNow() so parallel accounts look like separate
  // phones whose clocks drift independently. Every random ID (waterfall_id,
  // session_id, UUID) is generated via accountRandom/accountRandomHex so
  // outputs from different accounts are cryptographically independent.
  private _clockOffsetMs: number
  private _prng: SeededPRNG

  constructor(account: IgAccount) {
    this.account = account
    this.decoded = decodeBearer(account.bearerToken)
    const agent = buildAgent(account)
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      httpAgent: agent,
      httpsAgent: agent,
      // Never throw on non-2xx so we can surface the IG error body.
      validateStatus: () => true,
      maxRedirects: 0,
    })
    // Init per-account clock and PRNG. Accounts without a seed (created
    // before this feature) get a fresh crypto-random seed per run, which
    // is still isolated from other accounts in the same process.
    this._clockOffsetMs = account.clockOffsetMs ?? 0
    const seed = account.prngSeed || cryptoRandomBytes(32).toString("hex")
    this._prng = new SeededPRNG(seed)
    // Wire the per-account virtual clock and PRNG into the navigation session
    // so pigeon timestamps, session rotation, and UUIDs are all isolated.
    const clockSource: NavClockSource = {
      nowMs: () => this.accountNow(),
      random: () => this.accountRandom(),
    }
    this.nav = new NavSession(clockSource)
    // Seed the cookie jar with values we already know, matching what a real
    // session's jar contains after login. Responses will add/update cookies
    // (csrftoken, rur, etc.) over the lifetime of this client.
    if (this.decoded.dsUserId) this.cookies.set("ds_user_id", this.decoded.dsUserId)
    if (this.decoded.sessionId) this.cookies.set("sessionid", this.decoded.sessionId)
    if (account.mid) this.cookies.set("mid", account.mid)
    if (account.deviceId) this.cookies.set("ig_did", account.deviceId)
  }

  /** Date.now() shifted by this account's stable clock offset. */
  accountNow(): number {
    return Date.now() + this._clockOffsetMs
  }

  /** accountNow() as whole seconds (for client_timestamp). */
  accountNowSec(): number {
    return Math.floor(this.accountNow() / 1000)
  }

  /** Per-account random float in [0, 1) — replaces Math.random(). */
  accountRandom(): number {
    return this._prng.next()
  }

  /** Per-account random hex string — replaces the global randomHex(). */
  accountRandomHex(len: number): string {
    let s = ""
    for (let i = 0; i < len; i++) s += Math.floor(this._prng.next() * 16).toString(16)
    return s
  }

  /** Per-account UUID v4 — replaces randomUUID(). */
  accountUuid(): string {
    const h = this.accountRandomHex(32)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + Math.floor(this._prng.next() * 4)).toString(16)}${h.slice(17, 20)}-${h.slice(20)}`
  }

  get uid(): string {
    // The explicit IG user id is authoritative for ig-u-ds-user-id /
    // ig-intended-user-id; fall back to the value decoded from the token.
    return this.account.igUserId || this.decoded.dsUserId
  }

  get uuid(): string {
    return this.account.deviceId
  }

  // The Bloks version id echoed in every bloks request body (bloks_versioning_id)
  // and the x-bloks-version-id header. Pinned to our build.
  get bloksVersionId(): string {
    return BLOKS_VERSION_ID
  }

  // Internal iPhone model identifier (e.g. "iPhone11,8"), used where request
  // bodies echo the device type (e.g. the effect_collection warmup query).
  get deviceType(): string {
    return this.account.iphoneModel || "iPhone11,8"
  }

  // The body `phone_id` field. Taken verbatim from the account's cookie blob
  // (device.phone_id); falls back to family_device_id / guid for older accounts
  // added before phone_id was captured separately.
  get phoneId(): string {
    return this.account.phoneId || this.account.familyDeviceId || this.account.deviceId
  }

  // The `x-ig-family-device-id` header. This is the blob's family_device_id,
  // which is a DISTINCT identifier from phone_id — kept separate so both are the
  // real values the device used, not the same UUID reused for both.
  get familyDeviceId(): string {
    return this.account.familyDeviceId || this.account.deviceId
  }

  // iOS version actually sent on the wire. We use whatever the account's real
  // device reported in its cookie blob (e.g. 16_4_1) VERBATIM — no clamping to a
  // preset table — so the UA matches the captured device exactly. Only the IG
  // app version is pinned to our build; the OS is the device's own.
  get iosVersion(): string {
    return this.account.iosVersion || "17_0"
  }

  // Account region fingerprint. `locale` (xx_YY) drives the UA locale + every
  // locale header; `timezone` drives the offset we send. All request bodies /
  // headers read these so the account presents ONE coherent region instead of
  // the old hardcoded "en_US + Moscow" that every account shared.
  get locale(): string {
    return normalizeLocale(this.account.locale)
  }

  get timezone(): string {
    return (this.account.timezone || "").trim() || "Europe/Moscow"
  }

  // Current UTC offset in seconds for the account's timezone (DST-aware). This
  // is the value IG expects in x-ig-timezone-offset and various body fields.
  get timezoneOffsetSeconds(): number {
    return tzOffsetSeconds(this.timezone)
  }

  get timezoneOffsetString(): string {
    return String(this.timezoneOffsetSeconds)
  }

  // Rotate the proxy IP by hitting the rotation link, if configured.
  // Returns a structured result so callers can gate requests on success.
  // `rotated: false` means there was no rotation URL (nothing to do).
  async rotateProxy(): Promise<{ ok: boolean; status: number; rotated: boolean; error?: string }> {
    if (!this.account.rotationUrl) return { ok: true, status: 0, rotated: false }
    try {
      const res = await axios.get(this.account.rotationUrl, {
        timeout: 20000,
        validateStatus: () => true,
      })
      const ok = res.status >= 200 && res.status < 400
      return { ok, status: res.status, rotated: true, error: ok ? undefined : `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, status: 0, rotated: true, error: e instanceof Error ? e.message : "Rotation request failed" }
    }
  }

  private bearer(): string {
    const b = this.account.bearerToken.trim()
    return b.toLowerCase().startsWith("bearer ") ? b : `Bearer ${b}`
  }

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const uid = this.uid
    // All locale headers come from the account's single locale value so they can
    // never disagree; the timezone offset is computed from the account timezone.
    const loc = localeHeaders(this.locale)
    return {
      "accept-language": loc.acceptLanguage,
      authorization: this.bearer(),
      "ig-intended-user-id": uid,
      "ig-u-ds-user-id": uid,
      // Send the account's stored User-Agent VERBATIM. It was built at add-time
      // from the cookie blob's real device (model / iOS / locale / screen) with
      // our PINNED app version baked in, so it already matches the captured
      // device exactly. Fall back to a rebuild only for legacy accounts that
      // have no stored UA.
      "user-agent":
        this.account.userAgent ||
        buildUserAgent({
          appVersion: PINNED_IG_APP_VERSION,
          iphoneModel: this.account.iphoneModel,
          iosVersion: this.iosVersion,
          deviceId: this.account.deviceId,
          locale: this.locale,
        }),
      "x-ig-app-id": IG_APP_ID,
      "x-ig-app-locale": loc.appLocale,
      "x-ig-device-id": this.account.deviceId,
      // Real traffic carries BOTH x-ig-device-id and the shorter x-device-id,
      // set to the SAME device UUID. Sending only one is an inconsistency.
      "x-device-id": this.account.deviceId,
      "x-ig-device-locale": loc.deviceLocale,
      "x-ig-family-device-id": this.familyDeviceId,
      "x-ig-mapped-locale": loc.mappedLocale,
      // Keyboard/system language set, derived from the account locale so it can
      // never disagree with the other locale headers.
      "x-ig-device-languages": JSON.stringify({
        keyboard_languages: `${loc.deviceLocale},emoji`,
        system_languages: loc.deviceLocale,
        keyboard_language: loc.deviceLocale,
      }),
      "x-ig-timezone-offset": this.timezoneOffsetString,
      "x-ig-www-claim": this.account.claim || "SKIP",
      "x-mid": this.account.mid,
      "x-ig-capabilities": IG_CAPABILITIES,
      "x-ig-connection-type": "WiFi",
      "x-fb-connection-type": "wifi",
      // Static per-request markers the real iOS client always sends. Their
      // absence next to a full device header set is an automation tell.
      "x-fb": "0",
      "x-messenger": "0",
      "x-whatsapp": "0",
      "x-ads-opt-out": "0",
      "x-ig-bloks-serialize-payload": "true",
      // Experiment salt id bundle (from the 436 capture; app-version scoped).
      "x-ig-salt-ids": "42139649",
      // Country where the app was first launched. Derived from the account
      // locale's region (en_US → US, ru_RU → RU). Absence alongside a full
      // device header set is a minor inconsistency.
      "x-ig-app-startup-country": (this.locale.split("_")[1] || "US").toUpperCase(),
      // Device attestation token, captured per account. Only sent when present —
      // a blank or invalid value would be worse than omitting it.
      ...(this.account.cloudTrustToken ? { "x-cloud-trust-token": this.account.cloudTrustToken } : {}),
      // Live-ish bandwidth telemetry, jittered per request around a per-run
      // baseline (see `net` / `bandwidthHeaders`).
      ...this.bandwidthHeaders(),
      // Bloks bundle hash + Prism UI flags — present on every genuine request.
      "x-bloks-version-id": BLOKS_VERSION_ID,
      ...BLOKS_PRISM_HEADERS,
      // Tigon/FB transport markers the real client always includes. Their
      // absence alongside a full device header set is an automation tell.
      // RFC 9218 priority header — real app sends "u=2, i" for API calls,
      // "u=4, i" for lower-priority ones. u=2 is the common case.
      priority: "u=2, i",
      "x-tigon-is-retry": "False",
      "x-fb-client-ip": "True",
      "x-fb-server-cluster": "True",
      // Tigon/MNS trailer headers the real networking stack always appends.
      // x-fb-http-engine identifies Meta's internal HTTP library — its absence
      // alongside other Meta headers is a strong automation tell.
      "x-fb-conn-uuid-client": this.connUuid,
      "x-fb-http-engine": "Tigon/MNS/TCP",
      "x-fb-rmd": "state=URL_ELIGIBLE",
      // Real Instagram iOS app sends ONLY "zstd" — not "zstd, gzip, deflate"
      // (captured via mitmproxy). The uTLS sidecar forwards this verbatim and
      // decompresses the response for us, so Node never sees raw zstd bytes.
      "accept-encoding": "zstd",
      // Regional routing token echoed from the server (empty until captured).
      ...(this.rur ? { "ig-u-rur": this.rur } : {}),
      // Telemetry + navigation fingerprint the real iOS app always sends. Their
      // absence (device headers present, these missing) is a strong bot tell, so
      // every request now carries a fresh pigeon time, the current pigeon session
      // id, the navigation back-stack, and the matching client endpoint (== the
      // last nav segment). A caller may still override any of these via `extra`.
      "x-pigeon-session-id": this.nav.getSessionId(),
      "x-pigeon-rawclienttime": this.nav.rawClientTime(),
      "x-ig-nav-chain": this.nav.chainString(),
      "x-ig-client-endpoint": this.nav.clientEndpoint(),
      // Cookie header — real iOS clients always send one. We build it from
      // the in-memory jar (seeded at construction, grows via set-cookie).
      ...(this.cookies.size > 0
        ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
      ...extra,
    }
  }

  // Instagram hands back a fresh www-claim on most authenticated responses via
  // the `x-ig-set-www-claim` header. Real clients must echo it back as
  // `x-ig-www-claim` on subsequent requests. If we keep sending the stale value
  // (often "SKIP"), strict endpoints like /feed/timeline/ answer with a 302 to
  // /accounts/login/ (and some return 403) even though the bearer is valid.
  // Capture it here: update the in-memory account so the very next request in
  // this run uses it, and persist it best-effort so future runs start fresh.
  private captureClaim(res: AxiosResponse): void {
    // Capture cookies from set-cookie response headers so the jar grows over
    // the run exactly like a real session. We only need the name=value; path/
    // domain/expiry are irrelevant since all requests go to i.instagram.com.
    const sc = res.headers?.["set-cookie"]
    if (sc) {
      const items = Array.isArray(sc) ? sc : [sc]
      for (const raw of items) {
        const pair = String(raw).split(";")[0]?.trim()
        if (!pair) continue
        const eq = pair.indexOf("=")
        if (eq <= 0) continue
        this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
    }

    // Capture the regional routing token so subsequent requests echo it like a
    // real session. Kept in memory for the lifetime of this client (one run).
    const rurRaw = res.headers?.["ig-set-ig-u-rur"] ?? res.headers?.["ig-u-rur"]
    const rur = Array.isArray(rurRaw) ? rurRaw[0] : rurRaw
    if (typeof rur === "string" && rur && rur !== this.rur) this.rur = rur

    const raw = res.headers?.["x-ig-set-www-claim"]
    const claim = Array.isArray(raw) ? raw[0] : raw
    if (typeof claim !== "string" || !claim || claim === this.account.claim) return
    this.account.claim = claim
    // Fire-and-forget; never let a DB hiccup break the IG request flow.
    void db
      .update(igAccounts)
      .set({ claim })
      .where(eq(igAccounts.id, this.account.id))
      .catch(() => {})
  }

  // Sign a form payload the way the captured requests do:
  // signed_body=SIGNATURE.<urlencoded-json>
  private signBody(payload: Record<string, unknown>): string {
    return `signed_body=SIGNATURE.${encodeURIComponent(JSON.stringify(payload))}`
  }

  async post<T = unknown>(
    path: string,
    payload: Record<string, unknown>,
    friendlyName?: string,
  ): Promise<IgResponse<T>> {
    const body = this.signBody(payload)
    const config: AxiosRequestConfig = {
      headers: this.baseHeaders({
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(friendlyName ? { "x-fb-friendly-name": friendlyName } : {}),
      }),
    }
    const res = await this.http.post(path, body, config)
    this.captureClaim(res)
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data as T, url: BASE_URL + path }
  }

  // Raw form POST (no SIGNATURE wrapper) — used by feed/timeline endpoints.
  async postForm<T = unknown>(
    path: string,
    form: Record<string, string>,
    friendlyName?: string,
  ): Promise<IgResponse<T>> {
    const body = new URLSearchParams(form).toString()
    const config: AxiosRequestConfig = {
      headers: this.baseHeaders({
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(friendlyName ? { "x-fb-friendly-name": friendlyName } : {}),
      }),
    }
    const res = await this.http.post(path, body, config)
    this.captureClaim(res)
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data as T, url: BASE_URL + path }
  }

  // GraphQL form POST. Defaults to /graphql/query, but the captured pando
  // queries (LinkedBarcelonaProfileQuery, FeedCrosspostToBarcelonaSettingsQuery)
  // hit /graphql_www and carry x-client-doc-id / x-root-field-name /
  // x-graphql-client-library headers, so those are configurable via `opts`.
  async graphql<T = unknown>(
    friendlyName: string,
    clientDocId: string,
    variables: Record<string, unknown>,
    extraForm: Record<string, string> = {},
    opts: { path?: string; rootFieldName?: string; pando?: boolean } = {},
  ): Promise<IgResponse<T>> {
    const path = opts.path ?? "/graphql/query"
    const form: Record<string, string> = {
      method: "post",
      pretty: "false",
      format: "json",
      server_timestamps: "true",
      locale: this.locale,
      fb_api_req_friendly_name: friendlyName,
      client_doc_id: clientDocId,
      enable_canonical_naming: "true",
      enable_canonical_variable_overrides: "true",
      enable_canonical_naming_ambiguous_type_prefixing: "true",
      variables: JSON.stringify(variables),
      ...extraForm,
    }
    const body = new URLSearchParams(form).toString()
    const res = await this.http.post(path, body, {
      headers: this.baseHeaders({
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-fb-friendly-name": friendlyName,
        // Headers the real pando GraphQL client attaches.
        "x-client-doc-id": clientDocId,
        ...(opts.rootFieldName ? { "x-root-field-name": opts.rootFieldName } : {}),
        ...(opts.pando ? { "x-graphql-client-library": "pando" } : {}),
      }),
    })
    this.captureClaim(res)
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      data: res.data as T,
      url: `${BASE_URL}${path}`,
    }
  }

  async get<T = unknown>(
    path: string,
    friendlyName?: string,
    responseType?: AxiosRequestConfig["responseType"],
  ): Promise<IgResponse<T>> {
    const res = await this.http.get(path, {
      headers: this.baseHeaders(friendlyName ? { "x-fb-friendly-name": friendlyName } : {}),
      ...(responseType ? { responseType } : {}),
    })
    this.captureClaim(res)
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data as T, url: BASE_URL + path }
  }

  // Fetch an ABSOLUTE image URL (e.g. the challenge captcha on
  // www.facebook.com) through the account's OWN mobile proxy, so the request
  // egresses from the same IP the challenge was issued on. IG challenge captcha
  // images are IP-bound: fetching from the app server's IP returns a broken /
  // mismatched image, so we must go out through the proxy. We deliberately do
  // NOT use the uTLS sidecar here — it MITMs i.instagram.com only, not facebook
  // hosts. We attach the account's real iPhone User-Agent + the image-media
  // friendly name so it looks like the app's own prefetch.
  async fetchImage(absoluteUrl: string): Promise<{ ok: boolean; status: number; data: Buffer | null; contentType: string }> {
    const upstream = upstreamProxyUrl(this.account)
    let agent: HttpsProxyAgent<string> | SocksProxyAgent | undefined
    if (upstream) {
      agent = upstream.startsWith("socks") ? new SocksProxyAgent(upstream) : new HttpsProxyAgent(upstream)
    }
    const ua =
      this.account.userAgent ||
      buildUserAgent({
        appVersion: PINNED_IG_APP_VERSION,
        iphoneModel: this.account.iphoneModel,
        iosVersion: this.iosVersion,
        deviceId: this.account.deviceId,
        locale: this.locale,
      })
    const res = await axios.get<ArrayBuffer>(absoluteUrl, {
      responseType: "arraybuffer",
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: 30000,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: {
        "user-agent": ua,
        accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
        "accept-language": "en-US;q=1.0",
        // Only advertise encodings Node can transparently decode. Facebook's
        // captcha CDN otherwise replies with zstd (matching the real app's
        // `accept-encoding: zstd`), which axios/Node do NOT decompress — the
        // browser then receives undecodable bytes and renders nothing.
        "accept-encoding": "gzip, deflate",
        "x-fb-friendly-name": "image-media",
        "x-fb-client-ip": "True",
        "x-fb-server-cluster": "True",
      },
    })
    const ok = res.status >= 200 && res.status < 300
    const contentType = String(res.headers?.["content-type"] || "image/jpeg")
    let buf = ok && res.data ? Buffer.from(res.data) : null
    // Belt-and-suspenders: if the CDN ignored our accept-encoding and still sent
    // zstd, decode it here so the client always receives a raw, renderable image.
    const enc = String(res.headers?.["content-encoding"] || "").toLowerCase()
    if (buf && enc.includes("zstd")) {
      try {
        const zlib = await import("node:zlib")
        const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Uint8Array })
          .zstdDecompressSync
        if (zstdDecompressSync) buf = Buffer.from(zstdDecompressSync(buf))
      } catch (e) {
        console.log("[v0] fetchImage zstd decode failed:", e instanceof Error ? e.message : e)
      }
    }
    return { ok, status: res.status, data: buf, contentType }
  }

  // Upload a selfie to the authenticity platform (UFAC selfie step 10).
  // This hits graph.facebook.com (NOT i.instagram.com), so — like fetchImage —
  // it egresses through the account's OWN mobile proxy directly, bypassing the
  // uTLS sidecar (which MITMs i.instagram.com only). The multipart body is built
  // by hand so it matches the captured request byte-for-byte (field order,
  // Content-Transfer-Encoding: binary on the image part). Returns the parsed
  // JSON (which carries the uploaded file handles) plus raw text for logging.
  async uploadAuthenticity(
  fields: Record<string, string>,
  image: Buffer,
  contentType = "image/jpeg",
  ): Promise<{ ok: boolean; status: number; data: unknown; raw: string; url: string }> {
    const url = "https://graph.facebook.com/authenticity_uploads/"
    const boundary = `----IGBoundary${randomUUID().replace(/-/g, "")}`
    const CRLF = "\r\n"
    const chunks: Buffer[] = []
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
          "utf8",
        ),
      )
    }
    chunks.push(
      Buffer.from(
  `--${boundary}${CRLF}Content-Disposition: form-data; name="upload1"; filename="upload1"${CRLF}` +
  `Content-Type: ${contentType}${CRLF}Content-Transfer-Encoding: binary${CRLF}${CRLF}`,
        "utf8",
      ),
    )
    chunks.push(image)
    chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8"))
    const body = Buffer.concat(chunks)

    const upstream = upstreamProxyUrl(this.account)
    let agent: HttpsProxyAgent<string> | SocksProxyAgent | undefined
    if (upstream) {
      agent = upstream.startsWith("socks") ? new SocksProxyAgent(upstream) : new HttpsProxyAgent(upstream)
    }
    const ua =
      this.account.userAgent ||
      buildUserAgent({
        appVersion: PINNED_IG_APP_VERSION,
        iphoneModel: this.account.iphoneModel,
        iosVersion: this.iosVersion,
        deviceId: this.account.deviceId,
        locale: this.locale,
      })
    const res = await axios.post(url, body, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: 90000,
      maxRedirects: 3,
      validateStatus: () => true,
      responseType: "text",
      transformResponse: [(d) => d],
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        "user-agent": ua,
        "accept-language": "en-US;q=1.0",
        "x-fb-friendly-name": "api",
        "x-fb-client-ip": "True",
        "x-fb-server-cluster": "True",
      },
    })
    const ok = res.status >= 200 && res.status < 300
    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "")
    let parsed: unknown = raw
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* keep raw */
    }
    return { ok, status: res.status, data: parsed, raw, url }
  }

  // Upload a photo via the resumable upload endpoint. Returns the upload_id.
  // Retries the rupload itself (not just configure) until Instagram confirms the
  // entity is fully received ({ status: "ok" }), so callers never fire configure
  // against a half-uploaded photo.
  async uploadPhoto(buffer: Buffer): Promise<{ ok: boolean; status: number; uploadId: string; data: unknown }> {
    const uploadId = this.accountNow().toString()
    const name = `${uploadId}_0_${Math.floor(this.accountRandom() * 9000000000 + 1000000000)}`
    const MAX_ATTEMPTS = 4
    let last = { status: 0, data: undefined as unknown }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ruploadParams = {
        retry_context: JSON.stringify({ num_step_auto_retry: 0, num_reupload: attempt, num_step_manual_retry: 0 }),
        media_type: "1",
        upload_id: uploadId,
        xsharing_user_ids: "[]",
        image_compression: JSON.stringify({ lib_name: "moz", lib_version: "3.1.m", quality: "80" }),
      }
      try {
        const res = await this.http.post(`/rupload_igphoto/${name}`, buffer, {
          // Photos can be several MB over a slow proxy; give the upload more than
          // the 30s default so it isn't cut off mid-transfer.
          timeout: 90000,
          headers: this.baseHeaders({
            "content-type": "application/octet-stream",
            "x-entity-type": "image/jpeg",
            offset: "0",
            "x-entity-name": name,
            "x-entity-length": String(buffer.length),
            "x-instagram-rupload-params": JSON.stringify(ruploadParams),
            "content-length": String(buffer.length),
          }),
        })
        last = { status: res.status, data: res.data }
        const httpOk = res.status >= 200 && res.status < 300
        // Success only when the body confirms the entity is complete.
        if (httpOk && ruploadBodyOk(res.data)) {
          return { ok: true, status: res.status, uploadId, data: res.data }
        }
        // A hard client error (4xx other than throttling) won't fix itself.
        if (res.status >= 400 && res.status !== 429 && res.status < 500) break
      } catch (e) {
        // Proxy dropped the byte-upload connection ("socket hang up" /
        // ECONNRESET / timeout). Retry rather than aborting the whole node.
        // Keep the error text so the run-log reason shows the real cause.
        last = { status: 0, data: { network_error: e instanceof Error ? e.message : String(e) } }
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(1500 * (attempt + 1)) // 1.5s, 3s, 4.5s
    }
    return { ok: false, status: last.status, uploadId, data: last.data }
  }

  // Step 34 in the captured flow: negotiate transcoding parameters with the
  // server before uploading the video bytes. The body is an octet-stream JSON
  // payload (not signed). Best-effort — the response carries suggested codec /
  // bitrate that the real app uses to pre-transcode; we upload as-is, so this
  // mainly reproduces the genuine client fingerprint.
  async uploadSettings(opts: {
    uploadId: string
    waterfallId: string
    durationMs: number
    width: number
    height: number
    fileSize: number
    // Real metadata probed from the file. The native app derives these from the
    // asset it is about to upload; sending values that contradict the actual
    // bytes (e.g. claiming hvc1 for an H.264 file, or an audio bitrate for a
    // silent clip) is a mismatch no genuine client produces.
    codec?: "avc1" | "hvc1"
    frameRate?: number
    hasAudio?: boolean
    rotationAngle?: number
  }): Promise<{ ok: boolean; status: number; data: unknown }> {
    const composerSessionId = `${opts.waterfallId}_${opts.uploadId}`
    const durationSec = Math.max(1, Math.round(opts.durationMs / 1000))
    const videoBitRate = Math.round((opts.fileSize * 8) / durationSec)
    // Report what the file actually is. Fall back to the safest common defaults
    // (H.264 / 30fps / has audio) only when probing failed to read a field.
    const sourceCodec = opts.codec ?? "avc1"
    const frameRate = opts.frameRate && opts.frameRate > 0 ? opts.frameRate : 30
    const hasAudio = opts.hasAudio ?? true
    const rotationAngle = opts.rotationAngle ?? 0
    const payload = {
      composer_session_id: composerSessionId,
      upload_setting_properties: {
        upload_settings_version: "v0.1",
        creative_tools: { transcoding_required: true },
        video: {
          // Only advertise an audio bitrate when the file genuinely has audio.
          ...(hasAudio ? { audio_bit_rate_bps: 128000 } : {}),
          proposed_target_video_codec: "hvc1",
          asset_id: `${opts.uploadId}${this.uid}`,
          filter_complexity_level: 0,
          video_original_file_size: opts.fileSize,
          video_duration_milliseconds: opts.durationMs,
          video_height: opts.height,
          video_partial_frame_size_bytes: 0,
          video_gop_size_sec: 0,
          source_video_codec: sourceCodec,
          video_key_frame_size_bytes: 0,
          video_rotation_angle: rotationAngle,
          video_frame_rate: frameRate,
          video_duration_seconds: durationSec,
          source_hdr: false,
          video_width: opts.width,
          video_bit_rate_bps: videoBitRate,
        },
        context: {
          transcode_hdr: false,
          quality: "not_specified",
          source_type: "clips",
          share_type: "reels",
          composer_session_id: composerSessionId,
        },
        network: { stitch_download_bandwidth: -1, upload_bandwidth: 0, download_bandwidth: 4509387 },
      },
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8")
    const res = await this.http.post(`/upload_settings/${this.uuid}`, body, {
      headers: this.baseHeaders({
        "content-type": "application/octet-stream",
        "x-entity-type": "text/json",
        "x-entity-name": "upload_settings_payload",
        "x-entity-length": String(body.length),
        offset: "0",
        "x-ig-bloks-serialize-payload": "true",
        "x-fb-friendly-name": "api",
        "content-length": String(body.length),
      }),
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data }
  }

  // Step 35: upload the video bytes (single chunk). rupload params and headers
  // mirror the captured reels upload from the iOS app.
  async uploadVideo(
    buffer: Buffer,
    opts: { durationMs: number; width: number; height: number; uploadId?: string; waterfallId?: string },
  ): Promise<{ ok: boolean; status: number; uploadId: string; data: unknown }> {
    const uploadId = opts.uploadId ?? this.accountNow().toString()
    const waterfallId = opts.waterfallId ?? this.accountRandomHex(32)
    const name = "video.mp4"
    const MAX_ATTEMPTS = 4
    let last = { status: 0, data: undefined as unknown }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ruploadParams = {
        retry_context: JSON.stringify({ num_step_auto_retry: 0, num_reupload: attempt, num_step_manual_retry: 0 }),
        media_type: 2,
        upload_media_duration_ms: opts.durationMs,
        mediasource: "1",
        content_tags: "portrait,source-type-library",
        xsharing_user_ids: [] as string[],
        is_clips_video: "1",
        share_type: "reels",
        extract_cover_frame: "1",
        upload_media_width: opts.width,
        is_optimistic_upload: 1,
        upload_id: uploadId,
        session_id: uploadId,
        upload_media_height: opts.height,
      }
      try {
        const res = await this.http.post(`/rupload_igvideo/${this.uuid}`, buffer, {
          // Reels videos are large and uploaded as a single chunk over a (possibly
          // slow) proxy. The 30s default timeout was firing mid-upload and killing
          // the Post Reel step; allow up to 3 minutes for the bytes to transfer.
          timeout: 180000,
          headers: this.baseHeaders({
            "content-type": "application/octet-stream",
            "x-entity-type": "video/mpeg",
            offset: "0",
            "x-entity-name": name,
            "x-entity-length": String(buffer.length),
            "x-instagram-rupload-params": JSON.stringify(ruploadParams),
            x_fb_video_waterfall_id: waterfallId,
            "x-fb-friendly-name": "api",
            "content-length": String(buffer.length),
          }),
        })
        last = { status: res.status, data: res.data }
        const httpOk = res.status >= 200 && res.status < 300
        // Only treat the upload as done once IG confirms the entity is complete —
        // otherwise configure_to_clips would run against a partial video.
        if (httpOk && ruploadBodyOk(res.data)) {
          return { ok: true, status: res.status, uploadId, data: res.data }
        }
        if (res.status >= 400 && res.status !== 429 && res.status < 500) break
      } catch (e) {
        // The proxy dropped the long byte-upload connection mid-transfer
        // ("socket hang up" / ECONNRESET / timeout). Axios throws here rather
        // than returning a status, so without this catch the whole Post Reel
        // node aborted. Treat it as a retryable attempt and re-upload. Keep the
        // error text so the run-log reason shows the real cause.
        last = { status: 0, data: { network_error: e instanceof Error ? e.message : String(e) } }
      }
      if (attempt < MAX_ATTEMPTS - 1) await sleep(2000 * (attempt + 1)) // 2s, 4s, 6s
    }
    return { ok: false, status: last.status, uploadId, data: last.data }
  }

  // Upload the reel COVER frame (the extra rupload_igphoto that fires right after
  // the video bytes in the captured gallery-reel publish). Params mirror dump 29
  // verbatim: it reuses the video's upload_id as both upload_id and session_id,
  // is tagged cover_photo_type:"nth_frame" with media_type:2 / is_clips_video:1 /
  // share_type:"reels", and carries the uikit image_compression + provenance
  // blocks the real client sends. Best-effort: a failure here doesn't stop the
  // publish (the video's extract_cover_frame:"1" still yields a server-side cover).
  async uploadReelCover(
    jpeg: Buffer,
    opts: { uploadId: string },
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const ruploadParams = {
      is_optimistic_upload: 1,
      upload_id: opts.uploadId,
      cover_photo_type: "nth_frame",
      image_compression: JSON.stringify({
        quality: 70,
        lib_version: "1979.100000",
        colorspace: "kCGColorSpaceDeviceRGB",
        lib_name: "uikit",
      }),
      provenance_metadata: JSON.stringify({
        tools: ["ADD"],
        origin: ["EXTERNAL"],
        c2pa_metadata: [
          {
            software_agent: "",
            contains_composite_synthetic: false,
            status: "c2pa_not_found",
            contains_computational_capture: false,
            digital_source_type: "",
            edited_with_genai: false,
            contains_composite_with_trained_algorithmic_media: false,
            created_with_genai: false,
            contains_trained_algorithmic_data: false,
            contains_trained_algorithmic_media: false,
            contains_digital_capture: false,
          },
        ],
        iptc_metadata: [{ status: "iptc_not_found", created_with_genai: false, edited_with_genai: false }],
      }),
      session_id: opts.uploadId,
      xsharing_user_ids: [] as string[],
      media_type: 2,
      is_clips_video: "1",
      extract_cover_frame: "1",
      share_type: "reels",
    }
    try {
      const res = await this.http.post(`/rupload_igphoto/${this.accountUuid().toUpperCase()}`, jpeg, {
        timeout: 90000,
        headers: this.baseHeaders({
          "content-type": "application/octet-stream",
          "x-entity-type": "image/jpeg",
          offset: "0",
          "x-entity-name": "image.jpeg",
          "x-entity-length": String(jpeg.length),
          "x-instagram-rupload-params": JSON.stringify(ruploadParams),
          "x-fb-friendly-name": "upload",
          "content-length": String(jpeg.length),
        }),
      })
      return { ok: res.status >= 200 && res.status < 300 && ruploadBodyOk(res.data), status: res.status, data: res.data }
    } catch (e) {
      return { ok: false, status: 0, data: { network_error: e instanceof Error ? e.message : String(e) } }
    }
  }
}

// Uppercase RFC4122-ish uuid used for rupload endpoint paths (the iOS app uses
// uppercase). Kept module-local so both the client and endpoint builders share it.
function genUpperUuid(): string {
  const h = randomHex(32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}

export function randomHex(len: number): string {
  let s = ""
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

// ── Per-account seeded PRNG ─────────────────────────────────────────────
// SplitMix64-based PRNG seeded from the account's hex seed. Deterministic
// but each account has its own independent sequence — outputs from two
// different accounts cannot be linked by PRNG state recovery.
class SeededPRNG {
  private s0: bigint
  private s1: bigint

  constructor(hexSeed: string) {
    // Derive two 64-bit state words from the seed via SHA-256 so even short
    // or similar seeds produce independent streams. Mix in a per-run nonce
    // so the same account doesn't replay the exact sequence across runs.
    const nonce = cryptoRandomBytes(8).toString("hex")
    const hash = createHash("sha256").update(hexSeed + nonce).digest()
    this.s0 = hash.readBigUInt64LE(0)
    this.s1 = hash.readBigUInt64LE(8)
    // Warm up: discard the first 16 outputs to diffuse initial state.
    for (let i = 0; i < 16; i++) this.next()
  }

  /** Returns a float in [0, 1) with 53 bits of precision. */
  next(): number {
    // xoroshiro128+ generator
    let s0 = this.s0
    let s1 = this.s1
    const result = (s0 + s1) & 0xFFFFFFFFFFFFFFFFn

    s1 ^= s0
    this.s0 = ((s0 << 24n) | (s0 >> 40n)) ^ s1 ^ (s1 << 16n)
    this.s1 = (s1 << 37n) | (s1 >> 27n)

    // Convert to a double in [0, 1): take the top 53 bits.
    return Number((result >> 11n) & 0x1FFFFFFFFFFFFFn) / 0x20000000000000
  }
}

// The resumable-upload endpoints answer HTTP 200 the moment they ACCEPT the
// connection — even if the bytes never fully arrived — and only the JSON body
// tells you whether the entity is actually complete on their side. A genuinely
// finished upload responds with { "status": "ok" }; a truncated / still-arriving
// one responds with { "status": "fail" } (often with an offset to resume from)
// or an empty body. Firing configure_* against a not-yet-complete upload is what
// produces "posted but nothing appeared" — so we must gate on this, not on HTTP.
export function ruploadBodyOk(data: unknown): boolean {
  let obj = data
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj)
    } catch {
      return false
    }
  }
  if (!obj || typeof obj !== "object") return false
  return (obj as { status?: string }).status === "ok"
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
