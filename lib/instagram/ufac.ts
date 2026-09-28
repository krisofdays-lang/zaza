// UFAC ("User-Facing Account Checkpoint") challenge-resolution client.
//
// Reproduces the exact Bloks request sequence captured from the iOS app when an
// account is gated with a "Challenge" (checkpoint_required). Every request shape
// here — endpoint path, signed_body params, server_params / client_input_params
// split — is transcribed verbatim from the captured traffic. The pinned app
// version, bloks-version-id, app-id and cloud-trust-token all come from the
// shared InstagramClient headers, so these calls carry the same fingerprint as
// the rest of the app.
//
// Flow (one step per user action in the dialog):
//   1. showIntro()      -> renders the "Confirm you're human" UFAC button
//   2. completeIntro()  -> user tapped confirm; server returns the CAPTCHA screen
//   3. submitCaptcha()  -> user typed the captcha; server returns the phone screen
//                          (the response carries the phone picker's default
//                           country code, e.g. "+46" / "Sweden")
//   4. setContactPoint()-> user entered a phone; server sends a code (wa/sms)
//   5. resendCode()     -> optional: resend / switch WhatsApp<->SMS
//   6. submitCode()     -> user typed the SMS/WhatsApp code
//   7. poll()           -> advances the state machine (verifying / next screen)
//   8. authenticity*    -> optional selfie ("authenticity") sub-flow
//
// IMPORTANT — Bloks responses are lispy bytecode trees, not clean JSON. The
// signals the next step needs (captcha image URL, `persisted_data`, phone
// country defaults, which screen is now showing) are embedded in that payload.
// We extract them best-effort by scanning the raw response text for the known
// patterns (see extractUfacSignals). This is the one part that can drift if
// Instagram reshapes the payload.

import type { InstagramClient } from "./client"
import { NAV } from "./nav-chain"

// Fixed values observed across the capture. The latency QPL marker is stable per
// app build; the instance ids vary per request but the server tolerates our own.
const QPL_MARKER_ID = 36707139

// The selfie upload (step 10) authenticates to graph.facebook.com with an
// APP-SCOPED token: "<app_id>|<client_token>". Both halves are baked into the
// iOS app binary — the app id is the same APP_ID we send as x-ig-app-id, and the
// client token does NOT rotate per session or per account, so it never shows up
// in any Bloks response we could parse. To replay the captured upload verbatim we
// default to the exact value observed in the "10. Upload authenticity" dump. An
// operator can still override it via the auth.accessToken field if IG ever rotates
// the client token in a future app build.
const DEFAULT_UFAC_UPLOAD_ACCESS_TOKEN = "124024574287414|84a456d620314b6e92a16d8ff1c792dc"

function qplInstanceId(c?: InstagramClient): number {
  // A plausible 15-digit instance id (the app derives these from a QPL counter).
  const now = c ? c.accountNowSec() : Math.floor(Date.now() / 1000)
  const rnd = c ? Math.floor(c.accountRandom() * 1000) : Math.floor(Math.random() * 1000)
  return Number(`${now}${rnd}`)
}

function bkClientContext(): string {
  // Must match the real iOS client exactly: theme_params (XMDS design system)
  // precedes styles_id/pixel_ratio. The bloks runtime uses this to resolve the
  // screen; omitting theme_params made the server return an error/consent screen
  // instead of the scripted selfie screen that mints the cuid.
  return JSON.stringify({
    theme_params: [{ design_system_name: "XMDS", value: ["three_neutral_gray"] }],
    styles_id: "instagram",
    pixel_ratio: 3,
  })
}

// The persistent state we carry between steps (stored on the account row).
export interface UfacState {
  challengeRootId: string
  // Opaque token (crpd_…) from the ORIGINAL login `challenge_required` body
  // (api_path "/challenge/"). It belongs to the legacy web-challenge flow —
  // instagrapi threads it through that flow's requests. The iOS UFAC/Bloks flow
  // we replay is stateful SERVER-SIDE (keyed by the authenticated session + the
  // constant challenge_root_id), and every captured UFAC dump — through review —
  // sends only challenge_root_id, never a challenge_context. So we keep this for
  // reference/logging only and never put it in a UFAC request body.
  challengeContext?: string
  persistedData?: string
  contactPoint?: string
  medium?: "whatsapp" | "sms"
  step: UfacStep
  captchaUrl?: string
  // Phone picker defaults surfaced by the captcha-submit response.
  countryCode?: string // e.g. "+46"
  countryName?: string // e.g. "Sweden"
  countryIso?: string // e.g. "SE"
  // Free-form: last screen hint / error surfaced.
  screen?: string
  message?: string
  // Authenticity (selfie) sub-flow. `triggerSessionId` is the UUID we mint for
  // the wizard; it doubles as the capture flow's `session_id`. The rest are
  // pulled from the wizard/upload responses (best-effort) and can be overridden.
  auth?: {
    triggerSessionId?: string
    // Session-specific wizard-trigger params minted by the server and embedded in
    // the submit_code consent screen's "start selfie" Bloks action. They MUST be
    // echoed when opening the authenticity wizard — hardcoding values from another
    // session makes the server return the consent screen instead of the scripted
    // screen, so no cuid is ever minted. Extracted via extractWizardTrigger.
    externalFlowId?: string
    ixtInitialScreenId?: string
    location?: string
    serializedState?: string
    // Every serialized_state the wizard emitted, so the capture step can try each.
    serializedStateCandidates?: string[]
    submissionId?: string
    cuid?: string
    uploadSessionId?: string
    accessToken?: string
    machineId?: string
    uploaded?: boolean
    done?: boolean
  }
}

export type UfacStep =
  | "intro"
  | "captcha"
  | "phone"
  | "code"
  | "verifying"
  | "authenticity"
  | "review"
  | "done"
  | "error"

// Map a detected Bloks "screen" hint to the dialog step that renders it. Returns
// undefined when the screen is unknown/inconclusive so callers can keep their own
// fallback (e.g. show the manual "Confirm you're human" intro).
export function screenToStep(screen?: string): UfacStep | undefined {
  switch (screen) {
    case "captcha":
      return "captcha"
    case "phone":
      return "phone"
    case "code":
      return "code"
    case "authenticity":
      return "authenticity"
    case "intro":
      return "intro"
    default:
      return undefined
  }
}

// One captured request/response pair, surfaced to the dialog's log panel.
export interface UfacLog {
  ts: number
  label: string
  method: string
  endpoint: string
  request: string
  status: number
  ok: boolean
  response: string
}

// A single HTTP step's outcome plus the log entry describing it.
export interface UfacCall {
  ok: boolean
  status: number
  data: unknown
  log: UfacLog
  // Only set by uploadSelfie: the entity id of the uploaded file, needed by the
  // capture step's client_input_params.uploaded_files_ent_ids.
  entId?: string
  // Only set by uploadSelfie: the payload type of the uploaded file
  // (selfie_video / selfie_photo), paired with entId in the capture step.
  payloadType?: string
  }

function truncate(s: string): string {
  return s
}

function buildLog(
  label: string,
  method: string,
  endpoint: string,
  request: unknown,
  res: { status: number; ok: boolean; data: unknown },
): UfacLog {
  return {
    ts: Date.now(),
    label,
    method,
    endpoint,
    request: truncate(rawText(request)),
    status: res.status,
    ok: res.ok,
    response: truncate(rawText(res.data)),
  }
}

// ── response scanning ──────────────────────────────────────────────────────

function rawText(data: unknown): string {
  if (typeof data === "string") return data
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

// Bloks JSON escapes forward slashes and unicode-escapes `&` / `=` inside URLs.
function unescapeText(text: string): string {
  return text
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/&amp;/g, "&")
}

// The captcha comes through as a (often scheme-less, slash-escaped)
// facebook.com/captcha/tfbimage/… URL buried in the Bloks tree. The query
// string (captcha_challenge_code / captcha_challenge_hash) identifies the exact
// captcha instance, so it MUST be preserved byte-for-byte — a mangled query
// makes facebook mint a different image and the answer never matches.
function extractCaptchaUrl(text: string): string | undefined {
  const u = unescapeText(text)
  const stop = `[^\\s"'\\\\)]+` // URL body: stop at quote, backslash, whitespace, close-paren

  // 1. Classic captcha path on any Meta host (facebook.com, fbcdn.net,
  //    cdninstagram.com, fbsbx.com), with or without scheme/host.
  const patterns: RegExp[] = [
    new RegExp(`https?://[a-z0-9.-]*(?:facebook\\.com|fbcdn\\.net|cdninstagram\\.com|fbsbx\\.com)/captcha/tfbimage/${stop}`, "i"),
    new RegExp(`https?://[a-z0-9.-]+/captcha/tfbimage/${stop}`, "i"),
    // 2. Any Meta-host image URL whose path/query mentions captcha.
    new RegExp(`https?://[a-z0-9.-]*(?:facebook\\.com|fbcdn\\.net|cdninstagram\\.com|fbsbx\\.com)/${stop}captcha${stop}`, "i"),
    // 3. Scheme-less classic path.
    new RegExp(`(?:[a-z0-9.-]*facebook\\.com)?/?captcha/tfbimage/${stop}`, "i"),
  ]
  for (const re of patterns) {
    const m = u.match(re)
    if (m) {
      let url = m[0]
      if (!/^https?:\/\//i.test(url)) {
        url = url.replace(/^\/+/, "")
        url = /^[a-z0-9.-]*facebook\.com/i.test(url) ? `https://${url}` : `https://www.facebook.com/${url}`
      }
      return url
    }
  }

  // 4. Fallback: the whole-URL regex missed, but the identifying pieces may
  //    still be present separately (a split node, an unusual host, etc.).
  //    Reassemble from the tfbimage id + the two challenge params — these are
  //    what actually bind the image, so a rebuilt URL is valid.
  const id = u.match(/tfbimage\/(\d+)/i)?.[1]
  const code = u.match(/captcha_challenge_code=([^\s"'\\)&]+)/i)?.[1]
  const hash = u.match(/captcha_challenge_hash=([^\s"'\\)&]+)/i)?.[1]
  if (id && code && hash) {
    return `https://www.facebook.com/captcha/tfbimage/${id}/?captcha_challenge_code=${code}&captcha_challenge_hash=${hash}`
  }

  // Nothing matched. Log a snippet around a captcha marker so the exact URL
  // shape can be recovered from the live debug log and the regex tightened.
  if (/tfbimage|bot_captcha|from the image|captcha_challenge/i.test(u)) {
    const idx = u.search(/tfbimage|bot_captcha|from the image|captcha_challenge/i)
    console.log("[v0] captcha URL not matched. context:", u.slice(Math.max(0, idx - 300), idx + 500))
  } else {
    // The captcha screen was detected but nothing captcha-shaped is in the body
    // at all — dump the head so we can see what IG actually returned.
    console.log("[v0] captcha screen but no captcha tokens. head:", u.slice(0, 800))
  }
  return undefined
}

// The captcha-submit request must echo back a server-issued `persisted_data`
// token that ties the typed answer to this captcha instance. In the captcha
// SCREEN response that token is NOT labelled `persisted_data` (that label only
// appears later, in the request we build) — it is bound deep in the Bloks tree
// as a long base64url blob with an "AZ" prefix. Capture it directly.
function extractPersistedData(text: string, captchaUrl?: string): string | undefined {
  const u = unescapeText(text)
  // If a request-style label is present, prefer it.
  const labeled = u.match(/persisted_data["\\:=\s]+([A-Za-z0-9_-]{40,})/i)
  if (labeled) return labeled[1]
  // Otherwise the long "AZ…" token (>=40 chars). The captcha_challenge_hash is
  // also "AZ"-prefixed but far shorter, so the length threshold excludes it.
  const hash = captchaUrl?.match(/captcha_challenge_hash=([A-Za-z0-9_-]+)/)?.[1]
  const tokens = u.match(/AZ[A-Za-z0-9_-]{40,}/g) || []
  const best = tokens.filter((t) => t !== hash).sort((a, b) => b.length - a.length)[0]
  return best
}

// Read a Bloks `gs`/`ls` node's `initial` value by its key, tolerant of field
// ordering, e.g.  ..."selected_country_code_value","mode":"d","initial":"+46".
function keyInitial(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = text.match(new RegExp(`${escaped}"[^}]*?"initial":"([^"]*)"`, "i"))
  return m && m[1] ? m[1] : undefined
}

// Pull the signals the next step needs out of a Bloks response.
export function extractUfacSignals(data: unknown): {
  captchaUrl?: string
  persistedData?: string
  screen?: string
  countryCode?: string
  countryName?: string
  countryIso?: string
} {
  const text = rawText(data)
  const out: {
    captchaUrl?: string
    persistedData?: string
    screen?: string
    countryCode?: string
    countryName?: string
    countryIso?: string
  } = {}

  const cap = extractCaptchaUrl(text)
  if (cap) out.captchaUrl = cap

  // persisted_data blob threaded through server_params of the next request.
  const pd = extractPersistedData(text, cap)
  if (pd) out.persistedData = pd

  // Phone picker defaults (present on the screen that asks for a number).
  out.countryCode = keyInitial(text, "IG_UFAC_PHONE_NUMBER_PICKER:selected_country_code_value") ||
    keyInitial(text, "selected_country_code_value")
  out.countryName = keyInitial(text, "IG_UFAC_PHONE_NUMBER_PICKER:selected_country_name") ||
    keyInitial(text, "selected_country_name")
  out.countryIso = keyInitial(text, "IG_UFAC_PHONE_NUMBER_PICKER:selected_country_code_name") ||
    keyInitial(text, "selected_country_code_name")

  // Which screen is now showing — drives the step transition. Order matters:
  // most-specific signal first so a residual token can't misroute the step.
  // `image_upload_challenge` is the post-code selfie/photo step — the account is
  // asked to UPLOAD an image (authenticity), which is distinct from the bot
  // captcha where you read a code FROM an image (`bot_captcha` + "from the image").
  if (/authenticity_wizard|ufac_selfie|selfie_capture|image_upload_challenge/i.test(text)) out.screen = "authenticity"
  else if (/6-digit code|contact_point\.(resend|submit)_code|confirmation code/i.test(text)) out.screen = "code"
  else if (out.countryCode || /IG_UFAC_PHONE_NUMBER_PICKER|set_contact_point|phone number/i.test(text)) out.screen = "phone"
  else if (out.captchaUrl || /Enter the code from the image|bot_captcha/i.test(text))
    out.screen = "captcha"
  else if (/checkpoint\.ufac\.controller|challenge_root_id/i.test(text)) out.screen = "intro"

  return out
}

// ── authenticity (selfie) signal extraction ─────────────────────────────────
//
// The wizard / capture-config responses carry the values the upload (step 10)
// and capture (step 11) requests must echo. They are bound in the Bloks tree,
// so we scan best-effort for their known shapes.

export interface AuthSignals {
  serializedState?: string
  // The wizard bloks response embeds several serialized_state blobs (one per
  // sub-screen: consent, capture, outro…). Only one is the instance the capture
  // endpoint accepts; the others yield 404 / field_exception. We keep them all
  // (document order, deduped) so the capture step can try each until one confirms.
  serializedStates?: string[]
  submissionId?: string
  cuid?: string
  uploadSessionId?: string
  accessToken?: string
  machineId?: string
  outro?: boolean
}

export function extractAuthSignals(data: unknown, opts: { labeledOnly?: boolean } = {}): AuthSignals {
  const u = unescapeText(rawText(data))
  const out: AuthSignals = {}

  // serialized_state: very long base64url blob (often "QVRT…"), threaded into
  // the capture request's server_params. Prefer a labelled match, else (unless
  // labeledOnly) the single longest base64url token in the payload. labeledOnly
  // is used when parsing the upload response, whose longest token is a file
  // handle — grabbing it would clobber the real serialized_state from the wizard.
  // Collect EVERY labelled serialized_state (global match), not just the first —
  // the wizard response carries one per sub-screen and only one is the instance
  // the capture endpoint accepts. Keep them all, deduped, in document order.
  const labeled = [...u.matchAll(/serialized_state["\\:=\s]+([A-Za-z0-9_-]{80,})/gi)].map((m) => m[1])
  const uniqueLabeled = [...new Set(labeled)]
  if (uniqueLabeled.length) {
    out.serializedState = uniqueLabeled[0]
    out.serializedStates = uniqueLabeled
  } else if (!opts.labeledOnly) {
    const longToks = (u.match(/[A-Za-z0-9_-]{120,}/g) || []).sort((a, b) => b.length - a.length)
    if (longToks[0]) {
      out.serializedState = longToks[0]
      out.serializedStates = [longToks[0]]
    }
  }

  // submission_id: a long numeric id (>=15 digits) issued for this selfie.
  // In the wizard bloks response the literal "submission_id" only appears as a
  // logging field name (followed by null), never next to the real value. The
  // actual id is emitted as `(eud <digits>)` right after the cuid/graph_api
  // structure, e.g. `(fom 16064 35 "cuid_…" 36 "graph_api" 38 (eud 18101…))`.
  // Anchor on the cuid first, then fall back to the label form and finally to
  // the first standalone `(eud <digits>)`.
  out.submissionId =
    u.match(/submission_id["\\:=\s]+"?(\d{15,})"?/i)?.[1] ||
    u.match(/cuid_[A-Za-z0-9_-]{20,}[^(]*?\(eud\s+(\d{15,})\)/)?.[1] ||
    u.match(/\(eud\s+(\d{15,})\)/)?.[1] ||
    undefined

  // id_or_cuid: opaque "cuid_…" handle.
  out.cuid = u.match(/(cuid_[A-Za-z0-9_-]{20,})/)?.[1]

  // Upload session id (a UUID) and access_token ("<appId>|<secret>").
  out.uploadSessionId = u.match(/"?(?:upload_)?session_id["\\:=\s]+"?([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})"?/i)?.[1]
  out.accessToken = u.match(/(\d{12,}\|[A-Za-z0-9_-]{20,})/)?.[1]
  out.machineId = u.match(/machine_id["\\:=\s]+"?([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})"?/i)?.[1]

  // authenticity_wizard_outro in the capture response = selfie accepted.
  if (/authenticity_wizard_outro/i.test(u)) out.outro = true

  return out
}

function authSignalsLog(sig: AuthSignals): UfacLog {
  const summary = {
    outro: sig.outro ?? false,
    serialized_state: sig.serializedState ? `${sig.serializedState.slice(0, 24)}… (${sig.serializedState.length})` : null,
    submission_id: sig.submissionId ?? null,
    cuid: sig.cuid ?? null,
    upload_session_id: sig.uploadSessionId ?? null,
    access_token: sig.accessToken ? `${sig.accessToken.split("|")[0]}|…` : null,
    machine_id: sig.machineId ?? null,
  }
  return {
    ts: Date.now(),
    label: "↳ parsed authenticity signals",
    method: "PARSE",
    endpoint: "(local)",
    request: "",
    status: 200,
    ok: Boolean(sig.serializedState || sig.submissionId || sig.cuid || sig.outro),
    response: JSON.stringify(summary, null, 2),
  }
}

export { authSignalsLog }

// ── wizard-trigger extraction ───────────────────────────────────────────────
//
// The submit_code (and poll) consent screen embeds the "start selfie" Bloks
// action that opens the authenticity wizard. That action carries the SESSION-
// SPECIFIC ids the wizard must echo: external_flow_id, ixt_initial_screen_id and
// the trigger_session_id the server itself minted. In the Bloks tree they appear
// as a positional value tuple right after the alphabetically-sorted parameter
// name list, e.g.:
//   … "trigger_session_id") (dkc false 153 (eud 1554948319237793) "playground"
//      true "lgyj0i:9" "ufac_selfie" "authenticity_wizard_trigger" "af23…")
// So: external_flow_id = the (eud <int>) value, ixt_initial_screen_id = a token
// shaped like "lgyj0i:9", trigger_session_id = the UUID after the trigger name.
export interface WizardTrigger {
  externalFlowId?: string
  ixtInitialScreenId?: string
  triggerSessionId?: string
  location?: string
}

export function extractWizardTrigger(data: unknown): WizardTrigger {
  const u = unescapeText(rawText(data))
  const out: WizardTrigger = {}
  const i = u.indexOf("authenticity_wizard_trigger")
  if (i < 0) return out
  // Window over the trigger action's value tuple (values precede the trigger
  // name; trigger_session_id follows it).
  const before = u.slice(Math.max(0, i - 400), i)
  const after = u.slice(i, i + 120)
  // external_flow_id: the last (eud <digits>) before the trigger name.
  const eud = [...before.matchAll(/\(eud\s+(\d{10,})\)/g)]
  if (eud.length) out.externalFlowId = eud[eud.length - 1][1]
  // ixt_initial_screen_id: token like "lgyj0i:9" (lower-alnum, colon, digits).
  const ixt = before.match(/"([a-z0-9]{4,}:\d{1,4})"/)
  if (ixt) out.ixtInitialScreenId = ixt[1]
  // location: e.g. "ufac_selfie".
  const loc = before.match(/"(ufac_[a-z_]+)"/)
  if (loc) out.location = loc[1]
  // trigger_session_id: the UUID immediately after the trigger name.
  const uuid = after.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if (uuid) out.triggerSessionId = uuid[1]
  return out
}

export function wizardTriggerLog(t: WizardTrigger): UfacLog {
  return {
    ts: Date.now(),
    label: "↳ parsed wizard trigger",
    method: "PARSE",
    endpoint: "(local)",
    request: "",
    status: 200,
    ok: Boolean(t.externalFlowId || t.ixtInitialScreenId || t.triggerSessionId),
    response: JSON.stringify(
      {
        external_flow_id: t.externalFlowId ?? null,
        ixt_initial_screen_id: t.ixtInitialScreenId ?? null,
        trigger_session_id: t.triggerSessionId ?? null,
        location: t.location ?? null,
      },
      null,
      2,
    ),
  }
}

// Build a synthetic log entry describing what we PARSED out of a Bloks response
// (captcha URL, persisted_data, detected screen), so the dialog's log panel
// shows not just the raw traffic but the signals that drive the next step.
export function signalsLog(sig: {
  captchaUrl?: string
  persistedData?: string
  screen?: string
  countryCode?: string
  countryName?: string
}): UfacLog {
  const summary = {
    screen: sig.screen ?? null,
    captchaUrl: sig.captchaUrl ?? null,
    persisted_data: sig.persistedData ? `${sig.persistedData.slice(0, 24)}… (${sig.persistedData.length} chars)` : null,
    country: sig.countryCode ? `${sig.countryCode} ${sig.countryName ?? ""}`.trim() : null,
  }
  return {
    ts: Date.now(),
    label: "↳ parsed signals",
    method: "PARSE",
    endpoint: "(local)",
    request: "",
    status: 200,
    ok: Boolean(sig.captchaUrl || sig.persistedData || sig.screen),
    response: JSON.stringify(summary, null, 2),
  }
}

// A bloks async_action returns { status: "ok" } on success; failures carry a
// message / feedback in the payload.
function actionOk(data: unknown): boolean {
  return /"status"\s*:\s*"ok"/i.test(rawText(data))
}

// ── request builders (verbatim shapes from the capture) ─────────────────────

function serverParams(state: UfacState, extra: Record<string, unknown> = {}, c?: InstagramClient): Record<string, unknown> {
  // NOTE: no challenge_context here. The captured UFAC async_action requests
  // (intro → captcha → phone → code → authenticity → review poll) carry only
  // challenge_root_id + the QPL markers + the step's own params. The checkpoint
  // is resolved server-side against the session, so echoing the login flow's
  // crpd_ token would deviate from the real traffic.
  return {
    challenge_root_id: Number(state.challengeRootId) || state.challengeRootId,
    INTERNAL__latency_qpl_marker_id: QPL_MARKER_ID,
    INTERNAL__latency_qpl_instance_id: qplInstanceId(c),
    ...extra,
  }
}

function asyncBody(
  c: InstagramClient,
  state: UfacState,
  serverExtra: Record<string, unknown>,
  clientInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    _uuid: c.uuid,
    _uid: c.uid,
    params: JSON.stringify({
      server_params: serverParams(state, serverExtra, c),
      client_input_params: clientInput,
    }),
    bloks_versioning_id: c.bloksVersionId,
    bk_client_context: bkClientContext(),
  }
}

async function asyncAction(
  c: InstagramClient,
  action: string,
  body: Record<string, unknown>,
  label: string,
): Promise<UfacCall> {
  const endpoint = `/api/v1/bloks/async_action/${action}/`
  const res = await c.post(endpoint, body, "bloks/async_action/")
  return {
    ok: res.ok && actionOk(res.data),
    status: res.status,
    data: res.data,
    log: buildLog(label, "POST", endpoint, body.params ?? body, res),
  }
}

// ── steps ────────────────────────────────────────────────────────────────

// 1. Render the "Confirm you're human" UFAC button (intro screen).
export async function showIntro(c: InstagramClient, challengeRootId: string): Promise<UfacCall> {
  const endpoint = "/graphql_www · igds_ufac_button.component.query"
  const params = {
    challenge_root_id: Number(challengeRootId) || challengeRootId,
    support_chat_data: "",
    hashed_ui_state: "intro_ui_state",
  }
  const res = await c.graphql(
    "BKComponentQuery-com.bloks.www.ccs.conversational_support.igds_ufac_button.component.query",
    "31939790275712390953081558291",
    {
      params: {
        bloks_versioning_id: c.bloksVersionId,
        app_id: "com.bloks.www.ccs.conversational_support.igds_ufac_button.component.query",
        params: JSON.stringify(params),
      },
      use_new_wire_protocol: true,
      bk_context: { ios_gpu_family: 9, pixel_ratio: 3, bloks_version: c.bloksVersionId, gpu_memory_mb: 5461 },
    },
    {},
    { path: "/graphql_www", rootFieldName: "bloks_component_query", pando: true },
  )
  return { ok: res.ok, status: res.status, data: res.data, log: buildLog("1. Load challenge (intro)", "POST", endpoint, params, res) }
}

// 2. User tapped "Confirm you're human" -> server returns the captcha screen.
export async function completeIntro(c: InstagramClient, state: UfacState): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.complete_intro",
    asyncBody(c, state, {}, {}),
    "2. Confirm human → captcha",
  )
}

// 3. Submit the typed captcha -> server returns the phone screen.
export async function submitCaptcha(c: InstagramClient, state: UfacState, captchaResponse: string): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.bot_captcha.submit",
    asyncBody(c, state, state.persistedData ? { persisted_data: state.persistedData } : {}, {
      captcha_response: captchaResponse,
    }),
    "3. Submit captcha → phone",
  )
}

// 4. Submit the phone number -> server sends a code via WhatsApp or SMS.
//    `phone` must already be the full E.164 number (country code + local part),
//    exactly as captured: contact_point = "+46760759783".
export async function setContactPoint(
  c: InstagramClient,
  state: UfacState,
  phone: string,
  medium: "whatsapp" | "sms",
): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.set_contact_point.submit",
    asyncBody(c, state, { medium }, { contact_point: phone, use_existing_contact_point: 0 }),
    `4. Submit phone (${phone}, ${medium})`,
  )
}

// 4b. "Update mobile number" — clear the contact point we already submitted so
//     the checkpoint re-renders the phone-number picker and the operator can
//     enter a different number. Captured as contact_point.unset (empty params;
//     the response is the full phone-picker screen again).
export async function unsetContactPoint(c: InstagramClient, state: UfacState): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.contact_point.unset",
    asyncBody(c, state, {}, {}),
    "Update mobile number (unset)",
  )
}

// 5. Resend / switch delivery. send_by_whatsapp=0 + was_sent_by_whatsapp=1 means
//    "it went to WhatsApp, resend it as SMS instead" (from the capture).
export async function resendCode(c: InstagramClient, state: UfacState, viaSms: boolean): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.contact_point.resend_code",
    asyncBody(c, state, { send_by_whatsapp: viaSms ? 0 : 1, was_sent_by_whatsapp: viaSms ? 1 : 0 }, {}),
    `resend code (${viaSms ? "SMS" : "WhatsApp"})`,
  )
}

// 6. Submit the code the user received.
// Verbatim from the captured submit_code request: the code goes in
// client_input_params as `captcha_code` (NOT `code`), and server_params carries
// `show_toast: 0` alongside the usual challenge_root_id + QPL markers. Sending
// the wrong key made IG reject the code silently (tiny 2.7KB "still on code"
// screen) so the wizard never advanced to the selfie screen that mints the cuid.
export async function submitCode(c: InstagramClient, state: UfacState, code: string): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.contact_point.submit_code",
    asyncBody(c, state, { show_toast: 0 }, { captcha_code: code }),
    "6. Submit code",
  )
}

// 7. Poll the checkpoint state machine (used while "verifying" and to detect the
//    next screen — captcha done, phone needed, authenticity requested, etc.).
export async function poll(c: InstagramClient, state: UfacState): Promise<UfacCall> {
  return asyncAction(
    c,
    "com.bloks.www.checkpoint.ufac.poll_ufac_api",
    asyncBody(
      c,
      state,
      // After code submission the real client polls the selfie/photo step with
      // `image_upload_challenge_ui_state` (see dump "6. After entering code").
      // The review-stage poll (dump 12) sends an empty state, so key it off step.
      {
        v2_polling: 1,
        hashed_ui_state:
          state.step === "code" || state.step === "authenticity" ? "image_upload_challenge_ui_state" : "",
      },
      {},
    ),
    "poll checkpoint",
  )
}

// A random lowercase UUID (Bloks trigger_session_id shape, e.g. b733b1ed-…).
function randomLowerUuid(): string {
  const h = "0123456789abcdef"
  const r = (n: number) => Array.from({ length: n }, () => h[Math.floor(Math.random() * 16)]).join("")
  return `${r(8)}-${r(4)}-4${r(3)}-${h[8 + Math.floor(Math.random() * 4)]}${r(3)}-${r(12)}`
}

// 8. Open the authenticity (selfie) wizard, if the checkpoint asks for it.
// The trigger params (trigger_session_id, external_flow_id, ixt_initial_screen_id,
// location) are SESSION-SPECIFIC and must come from the submit_code consent screen
// (see extractWizardTrigger). We fall back to placeholder constants only when the
// consent screen didn't yield them, but that path won't mint a cuid.
export async function openAuthenticityWizard(
  c: InstagramClient,
  trigger: {
    triggerSessionId: string
    externalFlowId?: string
    ixtInitialScreenId?: string
    location?: string
  },
): Promise<UfacCall> {
  const endpoint = "/api/v1/bloks/apps/com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard/"
  const body = {
    _uuid: c.uuid,
    _uid: c.uid,
    params: JSON.stringify({
      server_params: {
        location: trigger.location || "ufac_selfie",
        authenticity_product: 153,
        trigger_event_type: "authenticity_wizard_trigger",
        trigger_session_id: trigger.triggerSessionId,
        is_blocking: 1,
        authenticity_document_sidedness_preview: 0,
        ixt_initial_screen_id: trigger.ixtInitialScreenId || "ouz6x7:11",
        ig_container_module: "playground",
        external_flow_id: Number(trigger.externalFlowId) || 1068672522432333,
      },
    }),
    bloks_versioning_id: c.bloksVersionId,
    bk_client_context: bkClientContext(),
  }
  // The wizard trigger fires FROM the UFAC checkpoint controller screen, so the
  // request's x-ig-client-endpoint / nav-chain must sit on ufac.controller (the
  // response then renders the authenticity_wizard screen). Without this the
  // request carries a stale feed_timeline endpoint and the server can't bind it
  // to the checkpoint flow.
  c.nav.visit(NAV.UFAC_CONTROLLER)
  const res = await c.post(endpoint, body, "bloks/apps/")
  return { ok: res.ok, status: res.status, data: res.data, log: buildLog("8. Open authenticity wizard", "POST", endpoint, body.params, res) }
}

// 9. Fetch the AIM/Facetracker model versions the native camera would load.
// Not functionally required for a server-side selfie submit (we don't run the
// on-device face tracker), but we replay it so the traffic pattern matches the
// captured flow. Failures here are non-fatal.
export async function fetchAimVersions(c: InstagramClient): Promise<UfacCall> {
  const endpoint = "/graphql_www · FetchCapabilityLatestAimVersionQuery"
  // Values transcribed verbatim from the captured request (dump 9). The old
  // placeholder client_doc_id "0" + capabilities[] variables were what made IG
  // return 404 here. The real query is a pando GraphQL POST with a concrete
  // persisted doc id, root field aim_model_version_manifest and a models[] list.
  const models = [
    "MetaDetTrack",
    "VideoHighlights",
    "FaceExpressionFittingRTRRetargeting",
    "Saliency",
    "IGReelsXRay",
    "Recognition",
    "SceneUnderstanding",
    "EnlightenGAN",
    "MultitaskPeopleSegmentation",
    "FaceExpressionFitting",
    "UTwoNet",
    "HandGesture",
    "HairSegmentation",
    "BodyTracking",
    "SegmentAnything",
    "DepthEstimation",
    "HandTracker",
    "Facetracker",
    "Segmentation",
    "MulticlassSegmentation",
    "FaceWave",
  ]
  const res = await c.graphql(
    "FetchCapabilityLatestAimVersionQuery",
    "8742123482498900803731925939",
    { models },
    {},
    { path: "/graphql_www", rootFieldName: "aim_model_version_manifest", pando: true },
  ).catch((e) => ({ ok: false, status: 0, data: e instanceof Error ? e.message : String(e), url: endpoint }))
  return { ok: res.ok, status: res.status, data: res.data, log: buildLog("9. Fetch AIM model versions", "POST", endpoint, `models: ${models.length}`, res) }
}

// 10. Upload the selfie JPEG to the authenticity platform (graph.facebook.com).
// Every field is transcribed from the captured multipart request. `image` is the
// raw JPEG bytes; the id fields come from the wizard response (or manual entry).
export async function uploadSelfie(
  c: InstagramClient,
  media: Buffer,
  auth: {
    submissionId?: string
    cuid?: string
    uploadSessionId?: string
    accessToken?: string
    machineId?: string
  },
  kind: "photo" | "video" = "photo",
): Promise<UfacCall> {
  // A real device uploads TWO files to the authenticity platform — a selfie
  // video and a selfie photo — and the capture step references both by their
  // ent_ids. Each upload only differs by upload_medium / content-type / the
  // payload_type it maps to in the capture request.
  const isVideo = kind === "video"
  const payloadType = isVideo ? "selfie_video" : "selfie_photo"
  const contentType = isVideo ? "video/mp4" : "image/jpeg"
  const fields: Record<string, string> = {
    product: "IG_UFAC_SELFIE_SCRIPTED",
    device_id: c.uuid,
    upload_medium: isVideo ? "SELFIE_VIDEO_NATIVE" : "SELFIE_PHOTO_NATIVE",
    id_or_cuid: auth.cuid ?? "",
    return_file_handles: "true",
    session_id: auth.uploadSessionId || randomUpperUuid(),
    submission_id: auth.submissionId ?? "",
    submit_to_authenticity_platform: "false",
    access_token: auth.accessToken || DEFAULT_UFAC_UPLOAD_ACCESS_TOKEN,
    machine_id: auth.machineId || randomUpperUuid(),
  }
  const res = await c.uploadAuthenticity(fields, media, contentType)
  const redactedReq = {
    ...fields,
    access_token: fields.access_token ? `${fields.access_token.split("|")[0]}|…` : "",
    upload1: `<${isVideo ? "mp4" : "jpeg"} ${media.length} bytes>`,
  }
  // The capture step (11) must reference the uploaded file by its entity id in
  // client_input_params.uploaded_files_ent_ids (verified against a real device
  // capture). `return_file_handles: "true"` makes this endpoint return that id.
  // Field name varies, so extract the first long numeric id from the response.
  const entId = extractUploadedEntId(res.data, res.raw)
  return {
    ok: res.ok,
    status: res.status,
    data: res.data,
    entId,
    payloadType,
    log: buildLog(`10. Upload selfie ${kind}`, "POST(multipart)", res.url, redactedReq, { status: res.status, ok: res.ok, data: res.raw }),
  }
}

// Pull the uploaded file's entity id out of the authenticity_uploads response.
// The response (with return_file_handles=true) carries the id under a handle/id
// field; shapes vary, so we prefer known keys then fall back to the first 15+
// digit numeric token in the raw body.
function extractUploadedEntId(data: unknown, raw: string): string | undefined {
  const fromKeys = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined
    for (const key of ["ent_id", "entity_id", "file_handle", "file_id", "id", "media_id", "upload_id"]) {
      const v = (obj as Record<string, unknown>)[key]
      if (typeof v === "string" && /^\d{15,}$/.test(v)) return v
      if (typeof v === "number" && String(v).length >= 15) return String(v)
    }
    // file_handles: ["…"] or handles arrays
    for (const key of ["file_handles", "handles", "uploaded_files_ent_ids"]) {
      const v = (obj as Record<string, unknown>)[key]
      if (Array.isArray(v) && typeof v[0] === "string" && /^\d{15,}$/.test(v[0])) return v[0]
    }
    return undefined
  }
  const keyed = fromKeys(data)
  if (keyed) return keyed
  const m = raw.match(/\b\d{15,}\b/)
  return m ? m[0] : undefined
}

// 11. Submit the selfie capture flow — the final step that ties the uploaded
// selfie to the checkpoint. server_params.serialized_state is the long blob the
// wizard/capture-config issued; success = response contains authenticity_wizard_outro.
export async function submitSelfieCapture(
  c: InstagramClient,
  serializedState: string,
  uploadedFiles: { entId: string; payloadType: string }[] = [],
): Promise<UfacCall> {
  const endpoint = "/api/v1/bloks/apps/com.bloks.www.bloks_screen.ixt.screen.selfie_capture_flow_capture/"
  // The working reference request for this endpoint carries EXACTLY three signed
  // fields: _uuid, _uid, params. Extra top-level fields (bloks_versioning_id,
  // bk_client_context) are absent there and make this strict screen fail
  // deserialization (field_exception / "Payload returned is null"). Match it 1:1.
  //
  // params carries TWO blocks (verified against a real device capture):
  //   server_params.serialized_state       — the wizard's opaque flow token
  //   client_input_params.uploaded_files_* — binds the uploaded file(s) to the
  //                                           flow by their entity ids. WITHOUT
  //                                           this the server can't find the
  //                                           uploaded selfie → "Payload null".
  const params: Record<string, unknown> = { server_params: { serialized_state: serializedState } }
  if (uploadedFiles.length > 0) {
    params.client_input_params = {
      uploaded_files_ent_ids: uploadedFiles.map((f) => f.entId),
      uploaded_files_payload_type: uploadedFiles.map((f) => f.payloadType),
    }
  }
  const body = {
    _uuid: c.uuid,
    _uid: c.uid,
    params: JSON.stringify(params),
  }
  // Capture fires FROM the authenticity_wizard screen. This step runs in a
  // SEPARATE server action (user taps "Upload selfie"), so the client — and its
  // NavSession — is brand new and otherwise sits on feed_timeline. The captured
  // real request sends
  //   x-ig-client-endpoint: com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard:…authenticity_wizard
  // and the server routes the Bloks flow instance by exactly this endpoint, so we
  // MUST put the nav on the wizard screen here or it 404s (field_exception).
  c.nav.visit(NAV.UFAC_WIZARD)
  const res = await c.post(endpoint, body, "bloks/apps/")
  const outro = /authenticity_wizard_outro/i.test(rawText(res.data))
  // Log the FULL signed body (_uuid, _uid, params), not just params, so the
  // panel reflects exactly what is wrapped into signed_body=SIGNATURE.<json>.
  return { ok: res.ok && outro, status: res.status, data: res.data, log: buildLog("11. Submit selfie capture", "POST", endpoint, JSON.stringify(body), res) }
}

// Upper-case UUID (matches session_id / machine_id shape in the capture).
function randomUpperUuid(): string {
  const h = "0123456789ABCDEF"
  const r = (n: number) => Array.from({ length: n }, () => h[Math.floor(Math.random() * 16)]).join("")
  return `${r(8)}-${r(4)}-4${r(3)}-${h[8 + Math.floor(Math.random() * 4)]}${r(3)}-${r(12)}`
}

export { randomLowerUuid }
