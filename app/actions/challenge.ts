"use server"

import { db } from "@/lib/db"
import { igAccounts } from "@/lib/db/schema"
import { eq, and } from "drizzle-orm"
import { requireUserId } from "@/lib/auth/session"
import { logToFile } from "@/lib/debug-log"
import { InstagramClient } from "@/lib/instagram/client"
import {
  showIntro,
  completeIntro,
  submitCaptcha,
  setContactPoint,
  unsetContactPoint,
  resendCode,
  submitCode,
  poll,
  screenToStep,
  openAuthenticityWizard,
  fetchAimVersions,
  uploadSelfie,
  submitSelfieCapture,
  extractUfacSignals,
  extractAuthSignals,
  signalsLog,
  authSignalsLog,
  extractWizardTrigger,
  wizardTriggerLog,
  randomLowerUuid,
  type UfacState,
  type UfacStep,
  type UfacLog,
} from "@/lib/instagram/ufac"

// Constant entry-point id for the `igds_ufac_button` UFAC flow. Every captured
// challenge_required dump — across different accounts — carries the identical
// value, sitting right next to the other hardcoded client identifiers
// (bloks_versioning_id, client_doc_id). It is not a per-account secret but the
// fixed id of the UFAC component itself, which is why the very first request
// already contains it without any prior fetch. Used as a fallback so the intro
// button always renders instead of dead-ending on manual entry.
const DEFAULT_UFAC_ROOT_ID = "148635148100001"

// Result shape returned to the dialog after every step. `state` is the source of
// truth the client re-sends on the next call; `captchaUrl` is surfaced so the UI
// can render the image; `logs` are appended to the dialog's request-log panel.
export type ChallengeResult = {
  ok: boolean
  step: UfacStep
  captchaUrl?: string
  countryCode?: string
  countryName?: string
  countryIso?: string
  message?: string
  logs: UfacLog[]
}

async function loadAccount(id: number) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igAccounts)
    .where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

// Postgres jsonb rejects NUL bytes (\u0000) and lone UTF-16 surrogates inside
// string values ("unsupported Unicode escape sequence"). Response tokens we
// harvest into state.auth (serialized_state, ids) can contain them, so any such
// character makes the whole jsonb write throw. Strip them before persisting so
// a poisoned token can never blow up saveState (and, in a catch handler, escape
// the Server Action as an uncaught error).
function sanitizeForJsonb<T>(value: T): T {
  const clean = (s: string) =>
    s
      .replace(/\u0000/g, "")
      // drop unpaired high/low surrogates that JSON.stringify can't encode
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clean(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  return walk(value) as T
}

async function saveState(id: number, state: UfacState, status?: string) {
  const safe = sanitizeForJsonb(state)
  await db
    .update(igAccounts)
    .set({ challengeState: safe as unknown as Record<string, unknown>, ...(status ? { status } : {}) })
    .where(eq(igAccounts.id, id))
}

function result(state: UfacState, logs: UfacLog[]): ChallengeResult {
  return {
    ok: state.step !== "error",
    step: state.step,
    captchaUrl: state.captchaUrl,
    countryCode: state.countryCode,
    countryName: state.countryName,
    countryIso: state.countryIso,
    message: state.message,
    logs,
  }
}

  function fail(message: string): ChallengeResult {
  return { ok: false, step: "error", message, logs: [] }
  }

// Push a log entry to the in-memory array AND persist it to debug.log right away.
// Persisting per-request means a later failure (a throwing revalidate/re-render,
// or a discarded return value) can never make the request log "disappear" — the
// full request/response is already on disk.
function recordLog(logs: UfacLog[], log: UfacLog) {
  logs.push(log)
  // logToFile is best-effort and swallows its own errors, but guard anyway so a
  // logging failure can never take down the flow it is trying to record.
  try {
    logToFile(`${log.method} ${log.label} -> ${log.status}`, {
      endpoint: log.endpoint,
      ok: log.ok,
      request: log.request,
      response: log.response,
    })
  } catch {}
}

// Terminal step for an action: build the result WITHOUT ever letting an error
// escape and WITHOUT triggering an RSC re-render. We deliberately do NOT call
// revalidatePath here: revalidatePath() does not throw synchronously — the
// dashboard re-render it schedules runs AFTER this action returns, as part of
// Next's response stream, so a try/catch around it catches nothing. If that
// re-render throws, Next replaces the whole action response with the generic
// "Server Components render" error and discards this return value together with
// its logs — exactly the "the log disappeared" symptom. The dialog updates its
// UI from this returned result, and state is already persisted via saveState, so
// no server revalidation is needed. The client calls router.refresh() itself on
// the terminal `review` step (after the logs are applied) to refresh the badge.
function finish(state: UfacState | null, logs: UfacLog[], fallback: string): ChallengeResult {
  return state ? result(state, logs) : fail(fallback)
}

// Best-effort discovery of the challenge_root_id from whatever the account
// already carries (the checkpoint response is stored in lastError / profile).
function findChallengeRootId(row: { lastError: string | null; profile: unknown; challengeState: unknown }): string | null {
  const existing = (row.challengeState as UfacState | null)?.challengeRootId
  if (existing) return existing
  const hay = `${row.lastError ?? ""} ${JSON.stringify(row.profile ?? {})}`
  // Allow backslashes between the key and the value: when the id is stored inside
  // a JSON-encoded dump the quote is escaped, e.g. challenge_root_id\":148635148100001.
  const m = hay.match(/challenge_root_id[\\"'\s:=]+(\d{10,})/i) || hay.match(/(\d{15,})/)
  return m ? m[1] : null
}

// The checkpoint session token (crpd_…) IG returns in the initial
// challenge_required body. It scopes every UFAC request to this account's live
// checkpoint state — without it the async_action calls come back as an empty
// Bloks skeleton with no captcha/phone/code screen.
function findChallengeContext(row: { lastError: string | null; profile: unknown; challengeState: unknown }): string | null {
  const existing = (row.challengeState as UfacState | null)?.challengeContext
  if (existing) return existing
  const hay = `${row.lastError ?? ""} ${JSON.stringify(row.profile ?? {})}`
  const m =
  hay.match(/"challenge_context"\s*:\s*"([^"]+)"/i) ||
  hay.match(/challenge_context[\\"'\s:=]+([A-Za-z0-9_-]{20,})/i) ||
  hay.match(/(crpd_[A-Za-z0-9_-]{20,})/)
  return m ? m[1] : null
}

// ── step actions (each returns the state the dialog should render next) ──────

// Apply the signals parsed from a Bloks response onto the carried state, then
// route to the matching step. Instagram's checkpoint is stateful: re-entering it
// can land directly on captcha / phone / code rather than the intro, so we honor
// whatever screen the response actually reports. When the screen is a captcha but
// the tfbimage URL hasn't arrived yet (it comes on a later poll), poll a few
// short times until it shows up — and bail early if a poll reveals we've actually
// moved on to phone/code/authenticity.
async function resolveScreen(
  client: InstagramClient,
  state: UfacState,
  sig: ReturnType<typeof extractUfacSignals>,
  logs: UfacLog[],
): Promise<void> {
  if (sig.persistedData) state.persistedData = sig.persistedData
  if (sig.captchaUrl) state.captchaUrl = sig.captchaUrl
  if (sig.countryCode) state.countryCode = sig.countryCode
  if (sig.countryName) state.countryName = sig.countryName
  if (sig.countryIso) state.countryIso = sig.countryIso
  if (sig.screen) state.screen = sig.screen

  if (state.screen === "captcha" && !state.captchaUrl) {
    for (let i = 0; i < 5 && !state.captchaUrl; i++) {
      await new Promise((r) => setTimeout(r, 700))
      const p = await poll(client, state)
      logs.push(p.log)
      const psig = extractUfacSignals(p.data)
      logs.push(signalsLog(psig))
      if (psig.persistedData) state.persistedData = psig.persistedData
      if (psig.captchaUrl) state.captchaUrl = psig.captchaUrl
      if (psig.countryCode) state.countryCode = psig.countryCode
      if (psig.countryName) state.countryName = psig.countryName
      if (psig.countryIso) state.countryIso = psig.countryIso
      console.log("[v0] resolveScreen poll", i, "captchaUrl=", psig.captchaUrl ?? "(none)", "screen=", psig.screen ?? "(none)")
      // A poll can reveal the checkpoint already advanced past the captcha.
      if (psig.screen && psig.screen !== "captcha") {
        state.screen = psig.screen
        break
      }
    }
  }

  const mapped = screenToStep(state.screen)
  if (mapped) state.step = mapped
}

// Start / re-open the flow. We render the intro button component, then render the
// UFAC controller to discover which screen the checkpoint is actually on and jump
// straight to it (captcha with no button, phone entry, code entry, …). Only when
// detection is inconclusive do we fall back to the manual "Confirm you're human".
export async function startChallenge(accountId: number, challengeRootId?: string): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")

  const saved = acc.challengeState as UfacState | null
  const resumable: UfacStep[] = ["captcha", "phone", "code", "authenticity", "review"]

  // ── Resume BEFORE any live probing ──────────────────────────────────────────
  // The UFAC checkpoint is stateful SERVER-SIDE (keyed by the authenticated
  // session + the constant challenge_root_id — the dumps never carry a
  // challenge_context), so a saved mid-flow step is authoritative. Re-running the
  // intro here would call complete_intro and ADVANCE the checkpoint, skipping
  // screens (e.g. captcha → phone), which is exactly what we must avoid.
  //
  // "review" is the terminal, verification-pending state and must always reopen
  // there — even when only the account status recorded it (older rows whose
  // challengeState was thin, or a review set by a background status refresh).
  const statusReview = acc.status === "review"
  if ((saved && resumable.includes(saved.step)) || statusReview) {
    const state: UfacState =
      saved && (resumable.includes(saved.step) || statusReview)
        ? saved
        : { challengeRootId: (challengeRootId || "").trim() || DEFAULT_UFAC_ROOT_ID, step: "review" }
    if (!state.challengeRootId) state.challengeRootId = (challengeRootId || "").trim() || DEFAULT_UFAC_ROOT_ID
    // A status of "review" pins the review screen unless we're mid-selfie.
    if (statusReview && state.step !== "authenticity") state.step = "review"

    const logs: UfacLog[] = []
    if (state.step === "review") {
      state.message = state.message ?? "Verification pending."
    } else {
      // Re-derive the CURRENT screen from the live checkpoint with a read-only
      // poll — the same principle as instagrapi re-reading last_json after each
      // step. The captured review-stage poll shows this call does NOT advance the
      // checkpoint, so it can only correct a stale local step, never skip one.
      // Best-effort: on any failure we keep the saved step as-is.
      try {
        const client = new InstagramClient(acc)
        const p = await poll(client, state)
        logs.push(p.log)
        const sig = extractUfacSignals(p.data)
        logs.push(signalsLog(sig))
        if (sig.persistedData) state.persistedData = sig.persistedData
        if (sig.captchaUrl) state.captchaUrl = sig.captchaUrl
        if (sig.countryCode) state.countryCode = sig.countryCode
        if (sig.countryName) state.countryName = sig.countryName
        if (sig.countryIso) state.countryIso = sig.countryIso
        const mapped = screenToStep(sig.screen)
        if (mapped) state.step = mapped
      } catch (e) {
        console.log("[v0] startChallenge resume poll (non-fatal):", e instanceof Error ? e.message : e)
      }
      state.message = undefined
    }
    await saveState(accountId, state, state.step === "review" ? "review" : undefined)
    console.log("[v0] startChallenge: resuming step=", state.step)
    return result(state, logs)
  }

  // ── First-time open: discover the root id, then render ONLY the intro button ──
  let rootId = (challengeRootId || "").trim() || findChallengeRootId(acc)
  // challengeContext is the login flow's crpd_ token — informational only (never
  // sent in a UFAC request), kept on state for debugging/log correlation.
  let context = findChallengeContext(acc) || undefined

  // If stored data has no id, re-fetch the checkpoint LIVE and harvest it from
  // the fresh challenge_required body — the exact place refreshAccountProfile
  // first saw it. Accounts flagged before we began seeding challengeState only
  // carry the short classified string in lastError (the raw dump was thrown
  // away), so scraping stored text finds nothing. Probing live is what lets the
  // intro button render instead of the dead-end "paste it manually" screen.
  if (!rootId) {
    try {
      const probeClient = new InstagramClient(acc)
      const { profileInfo } = await import("@/lib/instagram/endpoints")
      const { extractChallengeIds } = await import("@/lib/instagram/status-classify")
      const probe = await profileInfo(probeClient, acc.igUserId || probeClient.uid)
      const ids = extractChallengeIds(probe.data)
      console.log("[v0] startChallenge live probe: rootId=", ids.rootId ?? "(none)", "context=", ids.context ?? "(none)")
      if (ids.rootId) {
        rootId = ids.rootId
        context = context || ids.context || undefined
      }
    } catch (e) {
      console.log("[v0] startChallenge live probe failed:", e instanceof Error ? e.message : e)
    }
  }

  if (!rootId) {
    // Neither stored data nor the live probe yielded a per-account id, so fall
    // back to the constant UFAC entry-point id. This is what the client itself
    // hardcodes, so the intro request succeeds and the "Confirm you're human"
    // button renders — instead of dead-ending on a manual-paste form.
    rootId = DEFAULT_UFAC_ROOT_ID
    console.log("[v0] startChallenge: using default UFAC root id fallback")
  }

  // First-time open (or a fresh intro/error state): render ONLY the intro button.
  // Step 1 (the button component) runs to harvest persisted_data and log it, but
  // the checkpoint is NOT advanced — the captcha is requested only when the
  // operator taps "Confirm you're human" (confirmHuman → completeIntro → captcha).
  const logs: UfacLog[] = []
  const state: UfacState = { ...(saved ?? {}), challengeRootId: rootId, challengeContext: context, step: "intro", message: undefined }
  console.log("[v0] startChallenge: rootId=", rootId, "challengeContext=", context ?? "(none)")
  try {
    const client = new InstagramClient(acc)
    const intro = await showIntro(client, rootId)
    logs.push(intro.log)
    const introSig = extractUfacSignals(intro.data)
    logs.push(signalsLog(introSig))
    if (introSig.persistedData) state.persistedData = introSig.persistedData
  } catch (e) {
    state.message = e instanceof Error ? e.message : "Failed to load the challenge"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// User tapped "Confirm you're human" -> fetch the captcha.
export async function confirmHuman(accountId: number): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = (acc.challengeState as UfacState | null) ?? { challengeRootId: "", step: "intro" }
  if (!state.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await completeIntro(client, state)
    logs.push(res.log)
    const sig = extractUfacSignals(res.data)
    logs.push(signalsLog(sig))
    console.log(
      "[v0] confirmHuman: ok=",
      res.ok,
      "status=",
      res.status,
      "screen=",
      sig.screen,
      "captchaUrl=",
      sig.captchaUrl ?? "(none)",
    )

    // The complete_intro response usually only signals that a captcha screen is
    // COMING (the image_upload_challenge_ui_state marker) without carrying the
    // tfbimage URL yet — resolveScreen polls until it shows up and routes to
    // whatever screen the checkpoint actually reports.
    await resolveScreen(client, state, sig, logs)
    if (!screenToStep(state.screen)) state.step = "captcha"
    if (state.step === "captcha" && !state.captchaUrl) {
      state.message = "Instagram did not return a captcha — try again."
    }
  } catch (e) {
    state.step = "error"
    state.message = e instanceof Error ? e.message : "Failed"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// Submit the captcha the user read from the image. The success response is the
// phone screen, which carries the default country code (e.g. "+46").
export async function answerCaptcha(accountId: number, captcha: string): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = acc.challengeState as UfacState | null
  if (!state?.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await submitCaptcha(client, state, captcha.trim())
    logs.push(res.log)
    const sig = extractUfacSignals(res.data)
    logs.push(signalsLog(sig))
    if (sig.persistedData) state.persistedData = sig.persistedData
    if (res.ok || sig.screen === "phone") {
      state.step = "phone"
      state.captchaUrl = undefined
      if (sig.countryCode) state.countryCode = sig.countryCode
      if (sig.countryName) state.countryName = sig.countryName
      if (sig.countryIso) state.countryIso = sig.countryIso
    } else if (sig.captchaUrl) {
      // Wrong captcha — a fresh image comes back.
      state.captchaUrl = sig.captchaUrl
      state.step = "captcha"
      state.message = "Incorrect code, try the new image."
    } else {
      state.message = "Captcha rejected."
    }
  } catch (e) {
    state.step = "error"
    state.message = e instanceof Error ? e.message : "Failed"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// Submit the phone number. `phone` is the full E.164 number the dialog assembled
// from the country prefix + local digits. medium picks WhatsApp vs SMS.
export async function submitPhone(
  accountId: number,
  phone: string,
  medium: "whatsapp" | "sms" = "sms",
): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = acc.challengeState as UfacState | null
  if (!state?.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await setContactPoint(client, state, phone.trim(), medium)
    logs.push(res.log)
    const sig = extractUfacSignals(res.data)
    if (sig.persistedData) state.persistedData = sig.persistedData
    state.contactPoint = phone.trim()
    state.medium = medium
    state.step = res.ok || sig.screen === "code" ? "code" : "phone"
    if (state.step === "phone") state.message = "Instagram did not accept that number."
  } catch (e) {
    state.step = "error"
    state.message = e instanceof Error ? e.message : "Failed"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// "Update mobile number" (shown while waiting for the code): clear the submitted
// contact point so the checkpoint re-renders the phone picker, then route back to
// the phone step so the operator can enter a different number.
export async function updateMobileNumber(accountId: number): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = acc.challengeState as UfacState | null
  if (!state?.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await unsetContactPoint(client, state)
    logs.push(res.log)
    const sig = extractUfacSignals(res.data)
    logs.push(signalsLog(sig))
    await resolveScreen(client, state, sig, logs)
    // The unset response is the phone-picker screen; force the phone step and
    // drop the old number/medium so the dialog starts fresh.
    state.step = screenToStep(state.screen) === "phone" ? "phone" : "phone"
    state.contactPoint = undefined
    state.medium = undefined
    state.message = "Enter a new mobile number."
  } catch (e) {
    state.step = "error"
    state.message = e instanceof Error ? e.message : "Could not update the number"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// Resend the code / switch WhatsApp <-> SMS.
export async function resendChallengeCode(accountId: number, viaSms: boolean): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = acc.challengeState as UfacState | null
  if (!state?.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await resendCode(client, state, viaSms)
    logs.push(res.log)
    state.medium = viaSms ? "sms" : "whatsapp"
    state.message = `Code re-sent via ${viaSms ? "SMS" : "WhatsApp"}.`
    state.step = "code"
  } catch (e) {
    state.message = e instanceof Error ? e.message : "Resend failed"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// Submit the code, then poll to learn what the checkpoint wants next. On success
// the account moves to "Review" (verification pending) unless a selfie is asked.
export async function answerCode(accountId: number, code: string): Promise<ChallengeResult> {
  const logs: UfacLog[] = []
  // Declared outside the try so the catch/finish can still persist and return it
  // even when loadAccount or an early step throws (otherwise the throw surfaces as
  // a generic "Server Components render" crash and the logs disappear).
  let state: UfacState | null = null
  try {
    const acc = await loadAccount(accountId)
    if (!acc) return finish(null, logs, "Account not found")
    state = acc.challengeState as UfacState | null
    if (!state?.challengeRootId) return finish(null, logs, "Challenge not started")

    const client = new InstagramClient(acc)
    const sub = await submitCode(client, state, code.trim())
    recordLog(logs, sub.log)

    const sig = extractUfacSignals(sub.data)
    recordLog(logs, signalsLog(sig))
    if (sig.persistedData) state.persistedData = sig.persistedData

    // The consent screen embeds the session-specific wizard-trigger ids (they
    // change every checkpoint run). Capture them so we open the wizard with the
    // ids the server actually minted instead of stale placeholders.
    const trig = extractWizardTrigger(sub.data)
    recordLog(logs, wizardTriggerLog(trig))
    state.auth = {
      ...(state.auth ?? {}),
      triggerSessionId: trig.triggerSessionId ?? state.auth?.triggerSessionId,
      externalFlowId: trig.externalFlowId ?? state.auth?.externalFlowId,
      ixtInitialScreenId: trig.ixtInitialScreenId ?? state.auth?.ixtInitialScreenId,
      location: trig.location ?? state.auth?.location,
    }

    // The real client polls the checkpoint state machine right after submitting
    // the code (dump: poll_ufac_api with v2_polling:1 +
    // hashed_ui_state:"image_upload_challenge_ui_state") BEFORE opening the
    // authenticity wizard. This poll is what advances the server-side flow to the
    // selfie/scripted screen — without it the wizard only returns the consent
    // screen and never mints a cuid. Poll a few times to let the state machine
    // move forward. (state.step is still "code" here, so poll() sends the correct
    // image_upload_challenge_ui_state.)
    for (let i = 0; i < 3; i++) {
      const p = await poll(client, state)
      recordLog(logs, p.log)
      const psig = extractUfacSignals(p.data)
      recordLog(logs, signalsLog(psig))
      if (psig.persistedData) state.persistedData = psig.persistedData
      // A later poll may be the one that carries the wizard-trigger action; keep
      // the freshest ids we see.
      const ptrig = extractWizardTrigger(p.data)
      if (ptrig.externalFlowId || ptrig.ixtInitialScreenId || ptrig.triggerSessionId) {
        recordLog(logs, wizardTriggerLog(ptrig))
        state.auth = {
          ...(state.auth ?? {}),
          triggerSessionId: ptrig.triggerSessionId ?? state.auth?.triggerSessionId,
          externalFlowId: ptrig.externalFlowId ?? state.auth?.externalFlowId,
          ixtInitialScreenId: ptrig.ixtInitialScreenId ?? state.auth?.ixtInitialScreenId,
          location: ptrig.location ?? state.auth?.location,
        }
      }
      if (psig.screen === "authenticity") break
      await new Promise((r) => setTimeout(r, 700))
    }

    // The submit_code response does NOT reliably announce a selfie step — the
    // phone app asks for a selfie even when our body looks like "review". So we
    // ALWAYS open the authenticity wizard (dumps 7–9) after the code and let the
    // WIZARD response decide, rather than guessing from the thin submit body.
    state.step = "authenticity"
    const wiz = await runAuthenticityWizard(client, state, logs)

    // Selfie is required unless the wizard clearly finished (outro) with no
    // upload params. We lean toward showing the selfie step: if the wizard
    // opened or handed back any upload params, or the submit body already
    // flagged authenticity, present the upload UI.
    const needsSelfie =
      (wiz.hasSelfieParams || wiz.opened || sig.screen === "authenticity") && !(wiz.outro && !wiz.hasSelfieParams)

    if (needsSelfie) {
      state.step = "authenticity"
      state.message = "Instagram requires a selfie (authenticity). Upload a selfie photo below to continue."
      await saveState(accountId, state, "checkpoint")
    } else {
      state.step = "review"
      state.message = "Code submitted — verification pending."
      await saveState(accountId, state, "review")
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed"
    logToFile("answerCode failed", e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e))
    if (state) {
      state.step = "error"
      state.message = msg
      try {
        await saveState(accountId, state)
      } catch (saveErr) {
        logToFile("answerCode: saveState in catch also failed", String(saveErr))
      }
    } else {
      return finish(null, logs, msg)
    }
  }
  return finish(state, logs, "Failed")
}

// Poll the checkpoint (used by the "verifying" / authenticity waiting screens).
export async function pollChallenge(accountId: number): Promise<ChallengeResult> {
  const acc = await loadAccount(accountId)
  if (!acc) return fail("Account not found")
  const state = acc.challengeState as UfacState | null
  if (!state?.challengeRootId) return fail("Challenge not started")

  const logs: UfacLog[] = []
  try {
    const client = new InstagramClient(acc)
    const res = await poll(client, state)
    logs.push(res.log)
    const sig = extractUfacSignals(res.data)
    if (sig.persistedData) state.persistedData = sig.persistedData
    if (sig.screen === "authenticity") state.step = "authenticity"
    else if (res.ok) {
      state.step = "review"
      await saveState(accountId, state, "review")
      return result(state, logs)
    }
  } catch (e) {
    state.message = e instanceof Error ? e.message : "Poll failed"
  }
  await saveState(accountId, state)
  return result(state, logs)
}

// Replay the authenticity wizard (step 8) + AIM version fetch (step 9) and
// harvest the ids the upload/capture need. Stored on state.auth (best-effort;
// truncated captures mean some fields may be blank and require manual entry).
// Opens the authenticity (selfie) wizard — dumps 7–9. Returns what the wizard
// response told us: whether it opened, whether it handed back selfie upload
// params, and whether it already shows the outro (selfie stage finished/not
// required). The caller uses this to decide selfie-vs-review.
async function runAuthenticityWizard(
  client: InstagramClient,
  state: UfacState,
  logs: UfacLog[],
): Promise<{ opened: boolean; hasSelfieParams: boolean; outro: boolean }> {
  // Prefer the trigger_session_id the server minted (extracted from the consent
  // screen); only mint a random one as a last resort.
  const triggerSessionId = state.auth?.triggerSessionId || randomLowerUuid()
  state.auth = { ...(state.auth ?? {}), triggerSessionId }
  let opened = false
  let hasSelfieParams = false
  let outro = false
  try {
    const wiz = await openAuthenticityWizard(client, {
      triggerSessionId,
      externalFlowId: state.auth?.externalFlowId,
      ixtInitialScreenId: state.auth?.ixtInitialScreenId,
      location: state.auth?.location,
    })
    recordLog(logs, wiz.log)
    opened = wiz.ok
    const asig = extractAuthSignals(wiz.data)
    recordLog(logs, authSignalsLog(asig))
    // Diagnostic: definitively record whether the raw wizard response even
    // contains a cuid_ token, and a window around it, so we can tell a
    // request-shape problem (no cuid in response) from an extraction problem.
    try {
      const raw = typeof wiz.data === "string" ? wiz.data : JSON.stringify(wiz.data)
      const idx = raw.indexOf("cuid_")
      logToFile(
        `wizard response: ok=${wiz.ok} status=${wiz.status} len=${raw.length} hasCuid=${idx >= 0} ` +
          `parsed.cuid=${asig.cuid ?? "null"} parsed.serializedState=${asig.serializedState ? "yes" : "null"} ` +
          `parsed.submissionId=${asig.submissionId ?? "null"}` +
          (idx >= 0 ? `\n  cuidWindow: ${raw.slice(Math.max(0, idx - 40), idx + 160)}` : `\n  head: ${raw.slice(0, 400)}`),
      )
    } catch {}
    outro = Boolean(asig.outro)
    hasSelfieParams = Boolean(asig.serializedState || asig.submissionId || asig.cuid)
    state.auth = {
      ...state.auth,
      serializedState: asig.serializedState ?? state.auth.serializedState,
      serializedStateCandidates: asig.serializedStates ?? state.auth.serializedStateCandidates,
      submissionId: asig.submissionId ?? state.auth.submissionId,
      cuid: asig.cuid ?? state.auth.cuid,
      uploadSessionId: asig.uploadSessionId ?? state.auth.uploadSessionId,
      accessToken: asig.accessToken ?? state.auth.accessToken,
      machineId: asig.machineId ?? state.auth.machineId,
    }
  } catch (e) {
    recordLog(logs, errorLog("8. Open authenticity wizard", e))
  }
  // Step 9 is non-fatal (native camera model versions).
  try {
    const aim = await fetchAimVersions(client)
    recordLog(logs, aim.log)
  } catch (e) {
    recordLog(logs, errorLog("9. Fetch AIM model versions", e))
  }
  return { opened, hasSelfieParams, outro }
}

// Upload a selfie (step 10) then submit the capture flow (step 11). `dataUrl` is
// a data: URL (data:image/jpeg;base64,…) captured from the dialog's file input.
// `overrides` lets the operator paste ids/tokens read off the downloaded logs
// when the truncated wizard response didn't yield them automatically.
export async function submitSelfie(
  accountId: number,
  photo: Buffer,
  video: Buffer,
  overrides?: Partial<NonNullable<UfacState["auth"]>>,
): Promise<ChallengeResult> {
  const logs: UfacLog[] = []
  // Declared outside the try so the catch/finish can still persist and return it
  // even when loadAccount or an early step throws.
  let state: UfacState | null = null

  try {
    const acc = await loadAccount(accountId)
    if (!acc) return fail("Account not found")
    state = acc.challengeState as UfacState | null
    if (!state?.challengeRootId) return fail("Challenge not started")

    // Bytes arrive as raw buffers via the /api/selfie route handler (multipart
    // FormData). Route handlers have no Server Action body limit, so large
    // selfie videos come through intact on any host — no Blob, no base64.
    if (!photo?.length) return fail("Could not read the selfie photo")
    if (!video?.length) return fail("Could not read the selfie video")

    state.auth = { ...(state.auth ?? {}), ...(overrides ?? {}) }

    const client = new InstagramClient(acc)

    // 10. Upload both files to the authenticity platform. A real device uploads
    // a selfie VIDEO and a selfie PHOTO, in that order, and the capture step
    // references both ent_ids (order: video, photo). Upload sequentially so the
    // same submission binds both files.
    const wizardSerialized = state.auth.serializedState
    const uploadedFiles: { entId: string; payloadType: string }[] = []
    let allUploadsOk = true
    for (const item of [
      { kind: "video" as const, buffer: video },
      { kind: "photo" as const, buffer: photo },
    ]) {
      const up = await uploadSelfie(
        client,
        item.buffer,
        {
          submissionId: state.auth.submissionId,
          cuid: state.auth.cuid,
          uploadSessionId: state.auth.uploadSessionId,
          accessToken: state.auth.accessToken,
          machineId: state.auth.machineId,
        },
        item.kind,
      )
      recordLog(logs, up.log)
      // labeledOnly: the real serialized_state comes from the wizard/capture-config
      // (already on state.auth). Don't let the blind "longest token" fallback grab a
      // file handle out of the upload response and clobber it. We still read a
      // submission_id from the upload response if one appears.
      const upSig = extractAuthSignals(up.data, { labeledOnly: true })
      recordLog(logs, authSignalsLog(upSig))
      if (upSig.submissionId) state.auth.submissionId = upSig.submissionId
      if (up.entId) uploadedFiles.push({ entId: up.entId, payloadType: up.payloadType ?? `selfie_${item.kind}` })
      if (!up.ok) allUploadsOk = false
    }
    state.auth.uploaded = allUploadsOk

    recordLog(logs, {
      ts: Date.now(),
      label: "↳ uploaded file ent_ids",
      method: "PARSE",
      endpoint: "(local)",
      request: "",
      status: 200,
      ok: uploadedFiles.length > 0,
      response: JSON.stringify({ files: uploadedFiles, count: uploadedFiles.length }, null, 2),
    })

    // Diagnostic: which serialized_state will step 11 send, and where did it come
    // from? field_exception / "Payload returned is null" on the capture almost
    // always means this blob is empty, stale, or from the wrong sub-screen.
    const chosen = wizardSerialized
    recordLog(logs, {
      ts: Date.now(),
      label: "↳ serialized_state for capture",
      method: "PARSE",
      endpoint: "(local)",
      request: "",
      status: 200,
      ok: Boolean(chosen),
      response: JSON.stringify(
        {
          source: wizardSerialized ? "wizard response" : "none",
          length: chosen?.length ?? 0,
          preview: chosen ? `${chosen.slice(0, 32)}…${chosen.slice(-16)}` : null,
          uploaded_files: uploadedFiles.length,
          wizard_had_state: Boolean(wizardSerialized),
        },
        null,
        2,
      ),
    })

    if (!allUploadsOk || uploadedFiles.length === 0) {
      state.message = "Selfie upload was rejected. Check the log — you may need to paste the access_token / submission id from the wizard response."
      await saveState(accountId, state, "checkpoint")
      return finish(state, logs, "Selfie step failed")
    }

    // 11. Submit the capture flow with the wizard's serialized_state.
    //
    // Verified against a real device capture: the capture request carries the EXACT
    // serialized_state embedded in the wizard response (client_input_params), sent
    // verbatim as params.server_params.serialized_state and nothing else. We send a
    // SINGLE request with that one token on purpose — a wrong token yields 404 /
    // "Payload returned is null" (field_exception = flow instance not found), and a
    // failed submit can poison the server-side flow instance, so retrying with other
    // blobs would only make a good token fail too.
    if (!wizardSerialized) {
      state.message = "Selfie uploaded, but no serialized_state was found in the wizard response. Paste it from the wizard log to finish."
      await saveState(accountId, state, "checkpoint")
      return finish(state, logs, "Selfie step failed")
    }

    const cap = await submitSelfieCapture(client, wizardSerialized, uploadedFiles)
    recordLog(logs, cap.log)
    const capSig = extractAuthSignals(cap.data)
    recordLog(logs, authSignalsLog(capSig))

    if (cap.ok || capSig.outro) {
      state.auth.serializedState = wizardSerialized
      state.auth.done = true
      state.step = "review"
      state.message = "Selfie accepted — verification pending."
      await saveState(accountId, state, "review")
    } else {
      state.message = "Capture submit did not confirm (no authenticity_wizard_outro). Check the log."
      await saveState(accountId, state, "checkpoint")
    }
  } catch (e) {
    // Persist the true cause to disk and NEVER rethrow: an uncaught throw here
    // becomes a generic "Server Components render" error on the client and drops
    // the request log. debug.log keeps the real message + stack.
    logToFile("submitSelfie failed", e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e))
    if (state) {
      state.step = "error"
      state.message = e instanceof Error ? e.message : "Selfie step failed"
      try {
        await saveState(accountId, state)
      } catch (saveErr) {
        logToFile("submitSelfie saveState failed", saveErr instanceof Error ? `${saveErr.message}\n${saveErr.stack ?? ""}` : String(saveErr))
      }
    }
  }

  return finish(state, logs, "Selfie step failed")
}

function errorLog(label: string, e: unknown): UfacLog {
  return {
    ts: Date.now(),
    label,
    method: "ERROR",
    endpoint: "(local)",
    request: "",
    status: 0,
    ok: false,
    response: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
  }
}

// Discard the in-progress flow.
export async function cancelChallenge(accountId: number): Promise<void> {
  await db.update(igAccounts).set({ challengeState: null }).where(eq(igAccounts.id, accountId))
}
