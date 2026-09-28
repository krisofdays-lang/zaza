// Classifies what Instagram actually returned for a request so the UI can show
// WHY an account stopped working instead of a bare "HTTP 400". The private API
// signals account state through the response body message, not the HTTP code
// (most of these come back as HTTP 400 with { "status": "fail", "message": ... }).
//
// The distinctions matter operationally:
//   - checkpoint  -> Instagram wants identity verification (challenge/checkpoint).
//                    The account is gated but recoverable via the app.
//   - feedback_required (UFAC) -> action was blocked ("We restrict certain
//                    activity"). Account is alive but rate/behaviour flagged.
//   - login_required -> the session/token is no longer valid: effectively a
//                    logout. Needs re-auth, NOT a behaviour problem.
//   - consent_required -> ToS / consent gate.
//   - not_found -> the target user id is gone (deleted/renamed) — not a ban.
//   - ok / error -> healthy, or an unclassified transport error.

export type AccountStatus =
  | "ok"
  | "checkpoint"
  | "feedback_required"
  | "login_required"
  | "consent_required"
  | "not_found"
  | "error"

export type ClassifiedStatus = {
  status: AccountStatus
  // Short, human-readable detail stored in lastError and shown in the UI.
  detail: string
  // The raw message Instagram sent, if we could extract one (for debugging).
  igMessage: string
}

// Pull a readable string out of whatever info_stream / error body we got. The
// body can be a parsed object, or a chunked multi-JSON string, so we normalise
// to a lowercase haystack plus a best-effort parsed `message`.
function normalize(data: unknown): { haystack: string; message: string } {
  let message = ""
  let haystack = ""
  if (typeof data === "string") {
    haystack = data
    // Chunked info_stream can concatenate several JSON objects; try to find a
    // message field without assuming a single clean object.
    const m = data.match(/"message"\s*:\s*"([^"]+)"/i)
    if (m) message = m[1]
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    if (typeof obj.message === "string") message = obj.message
    try {
      haystack = JSON.stringify(obj)
    } catch {
      haystack = String(obj.message ?? "")
    }
  }
  return { haystack: haystack.toLowerCase(), message: message || "" }
}

// Pull the challenge_root_id + challenge_context out of the raw challenge_required
// body IG returns the moment it gates the account. This is the ONLY place those
// ids exist, so we harvest them here (at detection time) and persist them into
// challengeState — otherwise the body is discarded and the resolve dialog has no
// id to start from. The body may be a parsed object or a chunked JSON string, and
// when it's JSON-encoded the quote after the key is escaped (challenge_root_id\":).
export function extractChallengeIds(data: unknown): { rootId: string | null; context: string | null } {
  let hay = ""
  if (typeof data === "string") hay = data
  else {
    try {
      hay = JSON.stringify(data ?? {})
    } catch {
      hay = ""
    }
  }
  const rid = hay.match(/challenge_root_id[\\"'\s:=]+(\d{10,})/i) || hay.match(/(\d{15,})/)
  const ctx =
    hay.match(/"challenge_context"\s*:\s*"([^"]+)"/i) ||
    hay.match(/challenge_context[\\"'\s:=]+([A-Za-z0-9_-]{20,})/i) ||
    hay.match(/(crpd_[A-Za-z0-9_-]{20,})/)
  return { rootId: rid ? rid[1] : null, context: ctx ? ctx[1] : null }
}

export function classifyResponse(httpStatus: number, data: unknown): ClassifiedStatus {
  const { haystack, message } = normalize(data)
  const has = (needle: string) => haystack.includes(needle)

  // Challenge / checkpoint — identity verification gate.
  if (has("checkpoint_required") || has("challenge_required") || has('"challenge"') || has("checkpoint_url")) {
    return {
      status: "checkpoint",
      detail: "Challenge / checkpoint required — account gated, needs verification in-app",
      igMessage: message || "checkpoint_required",
    }
  }

  // Consent gate (ToS / age / policy).
  if (has("consent_required")) {
    return { status: "consent_required", detail: "Consent required — ToS/policy gate", igMessage: message || "consent_required" }
  }

  // UFAC / action block — account alive but behaviour flagged.
  if (has("feedback_required") || has('"spam":true') || has('"spam": true') || has("feedback_message")) {
    return {
      status: "feedback_required",
      detail: "Action blocked (feedback_required / UFAC) — behaviour flagged, account still alive",
      igMessage: message || "feedback_required",
    }
  }

  // Session invalid — effectively logged out. This is the "разлогин" case.
  if (has("login_required") || has("logged out") || has("bad_password") || has("invalid_user")) {
    return {
      status: "login_required",
      detail: "Logged out (login_required) — session/token invalid, needs re-auth",
      igMessage: message || "login_required",
    }
  }

  // Target user missing (deleted/renamed) — 404 with user-not-found.
  if (httpStatus === 404 || has("user not found") || has('"users":[]')) {
    return { status: "not_found", detail: "User not found (deleted/renamed)", igMessage: message || "not_found" }
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: "ok", detail: "", igMessage: "" }
  }

  return {
    status: "error",
    detail: message ? `HTTP ${httpStatus}: ${message}` : `HTTP ${httpStatus}`,
    igMessage: message,
  }
}
