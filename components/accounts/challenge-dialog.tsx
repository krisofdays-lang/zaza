"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Loader2, ShieldCheck, RefreshCw, Pencil } from "lucide-react"
import {
  startChallenge,
  confirmHuman,
  answerCaptcha,
  submitPhone,
  updateMobileNumber,
  resendChallengeCode,
  answerCode,
  pollChallenge,
  submitSelfie,
  type ChallengeResult,
} from "@/app/actions/challenge"
import type { UfacLog } from "@/lib/instagram/ufac"
import type { DisplayAccount } from "@/app/actions/accounts"

type Step = ChallengeResult["step"]

const inputClass =
  "h-11 w-full rounded-lg border border-input bg-secondary/40 px-3 text-sm outline-none transition-colors focus:border-[#d62976]"

// Country dial codes for the phone step's picker. `iso` is the unique key (dial
// codes are not unique — +1 is US and CA), `dial` is what gets prepended to the
// typed number and sent as the checkpoint's contact_point.
const COUNTRIES: { iso: string; name: string; dial: string }[] = [
  { iso: "US", name: "United States", dial: "+1" },
  { iso: "CA", name: "Canada", dial: "+1" },
  { iso: "GB", name: "United Kingdom", dial: "+44" },
  { iso: "IE", name: "Ireland", dial: "+353" },
  { iso: "DE", name: "Germany", dial: "+49" },
  { iso: "FR", name: "France", dial: "+33" },
  { iso: "ES", name: "Spain", dial: "+34" },
  { iso: "PT", name: "Portugal", dial: "+351" },
  { iso: "IT", name: "Italy", dial: "+39" },
  { iso: "NL", name: "Netherlands", dial: "+31" },
  { iso: "BE", name: "Belgium", dial: "+32" },
  { iso: "CH", name: "Switzerland", dial: "+41" },
  { iso: "AT", name: "Austria", dial: "+43" },
  { iso: "SE", name: "Sweden", dial: "+46" },
  { iso: "NO", name: "Norway", dial: "+47" },
  { iso: "DK", name: "Denmark", dial: "+45" },
  { iso: "FI", name: "Finland", dial: "+358" },
  { iso: "PL", name: "Poland", dial: "+48" },
  { iso: "CZ", name: "Czechia", dial: "+420" },
  { iso: "SK", name: "Slovakia", dial: "+421" },
  { iso: "HU", name: "Hungary", dial: "+36" },
  { iso: "RO", name: "Romania", dial: "+40" },
  { iso: "BG", name: "Bulgaria", dial: "+359" },
  { iso: "GR", name: "Greece", dial: "+30" },
  { iso: "UA", name: "Ukraine", dial: "+380" },
  { iso: "RU", name: "Russia", dial: "+7" },
  { iso: "KZ", name: "Kazakhstan", dial: "+7" },
  { iso: "TR", name: "Turkey", dial: "+90" },
  { iso: "IL", name: "Israel", dial: "+972" },
  { iso: "AE", name: "United Arab Emirates", dial: "+971" },
  { iso: "SA", name: "Saudi Arabia", dial: "+966" },
  { iso: "EG", name: "Egypt", dial: "+20" },
  { iso: "ZA", name: "South Africa", dial: "+27" },
  { iso: "NG", name: "Nigeria", dial: "+234" },
  { iso: "KE", name: "Kenya", dial: "+254" },
  { iso: "MA", name: "Morocco", dial: "+212" },
  { iso: "IN", name: "India", dial: "+91" },
  { iso: "PK", name: "Pakistan", dial: "+92" },
  { iso: "BD", name: "Bangladesh", dial: "+880" },
  { iso: "ID", name: "Indonesia", dial: "+62" },
  { iso: "MY", name: "Malaysia", dial: "+60" },
  { iso: "SG", name: "Singapore", dial: "+65" },
  { iso: "PH", name: "Philippines", dial: "+63" },
  { iso: "TH", name: "Thailand", dial: "+66" },
  { iso: "VN", name: "Vietnam", dial: "+84" },
  { iso: "CN", name: "China", dial: "+86" },
  { iso: "HK", name: "Hong Kong", dial: "+852" },
  { iso: "TW", name: "Taiwan", dial: "+886" },
  { iso: "JP", name: "Japan", dial: "+81" },
  { iso: "KR", name: "South Korea", dial: "+82" },
  { iso: "AU", name: "Australia", dial: "+61" },
  { iso: "NZ", name: "New Zealand", dial: "+64" },
  { iso: "MX", name: "Mexico", dial: "+52" },
  { iso: "BR", name: "Brazil", dial: "+55" },
  { iso: "AR", name: "Argentina", dial: "+54" },
  { iso: "CL", name: "Chile", dial: "+56" },
  { iso: "CO", name: "Colombia", dial: "+57" },
  { iso: "PE", name: "Peru", dial: "+51" },
]

// Pick the best country entry for a server-provided default: prefer an exact ISO
// match, else the first country whose dial code matches.
function findCountry(iso?: string, dial?: string): { iso: string; name: string; dial: string } | undefined {
  if (iso) {
    const byIso = COUNTRIES.find((c) => c.iso.toLowerCase() === iso.toLowerCase())
    if (byIso) return byIso
  }
  if (dial) return COUNTRIES.find((c) => c.dial === dial)
  return undefined
}

export function ChallengeDialog({
  account,
  open,
  onOpenChange,
}: {
  account: DisplayAccount
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [step, setStep] = useState<Step>("intro")
  const [busy, setBusy] = useState(false)
  const [captchaUrl, setCaptchaUrl] = useState<string | undefined>()
  // Bumped every time a captcha URL arrives so the proxied <img> reloads a fresh
  // image (e.g. after a wrong code returns a new captcha) instead of caching.
  const [captchaRefresh, setCaptchaRefresh] = useState(0)
  const [message, setMessage] = useState<string | undefined>()

  const [rootId, setRootId] = useState("")
  const [captcha, setCaptcha] = useState("")
  const [phone, setPhone] = useState("")
  const [countryCode, setCountryCode] = useState("")
  const [countryName, setCountryName] = useState("")
  const [countryIso, setCountryIso] = useState("")
  const [medium, setMedium] = useState<"sms" | "whatsapp">("sms")
  const [code, setCode] = useState("")
  const [logs, setLogs] = useState<UfacLog[]>([])
  // Authenticity (selfie) step: chosen JPEG + optional operator overrides for the
  // ids/tokens the truncated wizard capture may not surface automatically.
  const [selfie, setSelfie] = useState<{ file: File; previewUrl: string; name: string } | null>(null)
  const [selfieVideo, setSelfieVideo] = useState<{ file: File; previewUrl: string; name: string } | null>(null)
  const [showOverrides, setShowOverrides] = useState(false)
  const [ovSubmissionId, setOvSubmissionId] = useState("")
  const [ovCuid, setOvCuid] = useState("")
  const [ovAccessToken, setOvAccessToken] = useState("")
  const [ovSerializedState, setOvSerializedState] = useState("")
  const started = useRef(false)

  // Download a log (single entry or the full array) as a file so nothing is
  // truncated and it can be shared for debugging.
  function downloadLog(filename: string, contents: string) {
    const blob = new Blob([contents], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // Kick the flow off when the dialog opens.
  useEffect(() => {
    if (!open) {
      started.current = false
      setStep("intro")
      setCaptchaUrl(undefined)
      setMessage(undefined)
      setCaptcha("")
      setCode("")
      return
    }
    if (started.current) {
      return
    }
    // Clear per-session UI state on (re)open.
    setLogs([])
    setCountryCode("")
    setCountryName("")
    started.current = true
    const seeded = ((account as Record<string, unknown>).challengeState as { challengeRootId?: string } | null)?.challengeRootId
    if (seeded) setRootId(seeded)
    void run(() => startChallenge(account.id, seeded))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function apply(res: ChallengeResult) {
    setStep(res.step)
    if (res.captchaUrl && res.captchaUrl !== captchaUrl) setCaptchaRefresh((n) => n + 1)
    // Keep the last good captcha URL while we're still on the captcha step — a
    // follow-up result without one must not blank out the image being shown.
    if (res.captchaUrl) setCaptchaUrl(res.captchaUrl)
    else if (res.step !== "captcha") setCaptchaUrl(undefined)
    setMessage(res.message)
    // Seed the country picker from the server default. Prefer the ISO (so we pick
    // the exact country when a dial code is shared, e.g. +1 US vs CA), otherwise
    // fall back to matching the dial code.
    if (res.countryCode || res.countryIso) {
      const match = findCountry(res.countryIso, res.countryCode)
      setCountryCode(res.countryCode || match?.dial || "")
      setCountryName(res.countryName || match?.name || "")
      setCountryIso(res.countryIso || match?.iso || "")
    }
    if (res.logs?.length) setLogs((prev) => [...prev, ...res.logs])
    if (res.step === "review") {
      toast.success("Verification pending — status set to Review")
    }
  }

  async function run(fn: () => Promise<ChallengeResult>) {
    setBusy(true)
    try {
      apply(await fn())
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong")
      setStep("error")
    } finally {
      setBusy(false)
    }
  }

  function close() {
    // Keep the saved checkpoint state so re-opening resumes on the exact screen
    // the operator left off (captcha / phone / code / authenticity) instead of
    // restarting the flow.
    onOpenChange(false)
  }

  const handle = account.username || account.label || `Account ${account.id}`

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-chart-4" />
            Resolve challenge
          </DialogTitle>
          <DialogDescription>
            {handle} — Instagram flagged this account and wants identity verification.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-[180px]">
          {step === "intro" && (
            <div className="flex flex-col gap-4">
              {message ? (
                <>
                  <p className="text-sm text-muted-foreground">{message}</p>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground">challenge_root_id</label>
                    <input
                      value={rootId}
                      onChange={(e) => setRootId(e.target.value)}
                      placeholder="e.g. 148635148100001"
                      className={inputClass}
                    />
                  </div>
                  <Button disabled={busy || !rootId.trim()} onClick={() => run(() => startChallenge(account.id, rootId))}>
                    {busy && <Loader2 className="size-4 animate-spin" />} Load challenge
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Instagram needs to confirm a human is operating this account. Start by confirming below — this
                    requests the captcha.
                  </p>
                  <Button disabled={busy} onClick={() => run(() => confirmHuman(account.id))}>
                    {busy && <Loader2 className="size-4 animate-spin" />} Confirm you&apos;re human
                  </Button>
                </>
              )}
            </div>
          )}

          {step === "captcha" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">Enter the code shown in the image.</p>
              {captchaUrl ? (
                <div className="flex h-[80px] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    // The captcha is IP-bound to the account's proxy, so it must be
                    // fetched server-side through our proxy route — NOT loaded from
                    // the raw facebook URL by the browser (that returns a broken
                    // image). captchaRefresh busts the cache on retry.
                    src={`/api/challenge/captcha?accountId=${account.id}&t=${captchaRefresh}`}
                    alt="Captcha challenge"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="flex h-[80px] items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                  No captcha image returned
                </div>
              )}
              <input
                value={captcha}
                onChange={(e) => setCaptcha(e.target.value)}
                placeholder="Captcha code"
                autoFocus
                className={inputClass}
              />
              <Button disabled={busy || !captcha.trim()} onClick={() => run(() => answerCaptcha(account.id, captcha))}>
                {busy && <Loader2 className="size-4 animate-spin" />} Submit code
              </Button>
            </div>
          )}

          {step === "phone" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Enter your phone number to receive the verification code. The country is prefilled from Instagram —
                change it if needed, then type only the rest of the digits.
              </p>
              <div className="flex gap-2">
                <select
                  value={countryIso}
                  onChange={(e) => {
                    const c = COUNTRIES.find((x) => x.iso === e.target.value)
                    if (c) {
                      setCountryIso(c.iso)
                      setCountryCode(c.dial)
                      setCountryName(c.name)
                    }
                  }}
                  className={`${inputClass} w-[130px] shrink-0 cursor-pointer appearance-none font-medium`}
                  aria-label="Country code"
                >
                  {countryIso === "" && <option value="">{countryCode || "+"}</option>}
                  {COUNTRIES.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.dial} {c.iso}
                    </option>
                  ))}
                </select>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^\d\s-]/g, ""))}
                  placeholder="760759783"
                  inputMode="tel"
                  autoFocus
                  className={`${inputClass} flex-1`}
                />
              </div>
              <div className="flex gap-2">
                {(["sms", "whatsapp"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMedium(m)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                      medium === m ? "border-[#d62976] text-foreground" : "border-input text-muted-foreground"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <Button
                disabled={busy || !phone.replace(/\D/g, "")}
                onClick={() => run(() => submitPhone(account.id, `${countryCode}${phone.replace(/\D/g, "")}`, medium))}
              >
                {busy && <Loader2 className="size-4 animate-spin" />} Send code
              </Button>
            </div>
          )}

          {step === "code" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Enter the code sent to {phone || "your number"} via {medium.toUpperCase()}.
              </p>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                autoFocus
                className={inputClass}
              />
              <Button disabled={busy || !code.trim()} onClick={() => run(() => answerCode(account.id, code))}>
                {busy && <Loader2 className="size-4 animate-spin" />} Verify code
              </Button>
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => resendChallengeCode(account.id, medium === "sms"))}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  <RefreshCw className="size-3.5" /> Resend {medium === "sms" ? "as SMS" : "via WhatsApp"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPhone("")
                    setCode("")
                    run(() => updateMobileNumber(account.id))
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  <Pencil className="size-3.5" /> Update mobile number
                </button>
              </div>
            </div>
          )}

          {step === "authenticity" && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Instagram is asking for a selfie (authenticity check). Upload a selfie video and a selfie photo — both
                are sent to the authenticity platform and the capture flow is submitted, exactly like the app.
              </p>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-muted-foreground">Selfie video</label>
                <input
                  type="file"
                  accept="video/mp4,video/quicktime"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setSelfieVideo({ file, previewUrl: URL.createObjectURL(file), name: file.name })
                  }}
                  className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                />
                {selfieVideo && (
                  <div className="flex items-center gap-3 rounded-lg border border-border p-2">
                    <video src={selfieVideo.previewUrl} className="size-14 rounded-md object-cover" muted playsInline />
                    <span className="truncate text-xs text-muted-foreground">{selfieVideo.name}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-muted-foreground">Selfie photo</label>
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setSelfie({ file, previewUrl: URL.createObjectURL(file), name: file.name })
                  }}
                  className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                />
                {selfie && (
                  <div className="flex items-center gap-3 rounded-lg border border-border p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={selfie.previewUrl || "/placeholder.svg"} alt="Selfie preview" className="size-14 rounded-md object-cover" />
                    <span className="truncate text-xs text-muted-foreground">{selfie.name}</span>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setShowOverrides((v) => !v)}
                className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showOverrides ? "Hide" : "Show"} advanced overrides
              </button>
              {showOverrides && (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
                  <p className="text-[11px] text-muted-foreground">
                    Only needed if the upload is rejected — paste values read off the downloaded wizard log.
                  </p>
                  <input value={ovSubmissionId} onChange={(e) => setOvSubmissionId(e.target.value)} placeholder="submission_id" className={inputClass} />
                  <input value={ovCuid} onChange={(e) => setOvCuid(e.target.value)} placeholder="id_or_cuid (cuid_…)" className={inputClass} />
                  <input value={ovAccessToken} onChange={(e) => setOvAccessToken(e.target.value)} placeholder="access_token (appId|secret)" className={inputClass} />
                  <textarea
                    value={ovSerializedState}
                    onChange={(e) => setOvSerializedState(e.target.value)}
                    placeholder="serialized_state (long token from capture)"
                    rows={2}
                    className={`${inputClass} h-auto resize-y py-2`}
                  />
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  disabled={busy || !selfie || !selfieVideo}
                  onClick={() =>
                    run(async () => {
                      // POST both files as multipart FormData to a route handler.
                      // Route handlers have no Server Action body limit, so large
                      // videos come through intact on any host (no Blob, no base64).
                      const fd = new FormData()
                      fd.append("accountId", String(account.id))
                      fd.append("video", selfieVideo!.file, selfieVideo!.name)
                      fd.append("photo", selfie!.file, selfie!.name)
                      fd.append(
                        "overrides",
                        JSON.stringify({
                          submissionId: ovSubmissionId.trim() || undefined,
                          cuid: ovCuid.trim() || undefined,
                          accessToken: ovAccessToken.trim() || undefined,
                          serializedState: ovSerializedState.trim() || undefined,
                        }),
                      )
                      const res = await fetch("/api/selfie", { method: "POST", body: fd })
                      if (!res.ok) {
                        const err = (await res.json().catch(() => null)) as { error?: string } | null
                        throw new Error(err?.error || `Selfie upload failed (${res.status})`)
                      }
                      return (await res.json()) as ChallengeResult
                    })
                  }
                >
                  {busy && <Loader2 className="size-4 animate-spin" />} Upload selfie
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => pollChallenge(account.id))}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  Check status
                </button>
              </div>
            </div>
          )}

          {step === "verifying" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="size-6 animate-spin text-chart-4" />
              <p className="text-sm text-muted-foreground">Verifying…</p>
            </div>
          )}

          {step === "review" && (
            <div className="flex flex-col gap-3 py-2">
              <p className="text-sm">
                Submitted. The account is now under <span className="font-medium text-chart-4">Review</span> while
                Instagram verifies. Close this and refresh later.
              </p>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          )}

          {step === "error" && message && (
            <div className="flex flex-col gap-3 py-2">
              <p className="text-sm text-destructive">{message}</p>
              <Button variant="outline" onClick={() => run(() => startChallenge(account.id, rootId))}>
                Retry
              </Button>
            </div>
          )}

          {message && step !== "intro" && step !== "error" && (
            <p className="mt-3 text-xs text-muted-foreground">{message}</p>
          )}
        </div>

        {/* Temporary debug panel: every UFAC request/response while resolving the challenge. */}
        <div className="mt-2 border-t border-border pt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Request log{logs.length ? ` (${logs.length})` : ""}
            </span>
            {logs.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => downloadLog(`ufac-challenge-${account.id}-all.json`, JSON.stringify(logs, null, 2))}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  download all
                </button>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              </div>
            )}
          </div>
          <div className="max-h-44 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-secondary/30 p-2 font-mono text-[10px] leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">No requests yet.</p>
            ) : (
              logs.map((l, i) => (
                <div key={`${l.ts}-${i}`} className="mb-2 min-w-0 last:mb-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={l.ok ? "text-chart-4" : "text-destructive"}>{l.status || "ERR"}</span>
                    <span className="min-w-0 truncate text-foreground">{l.label}</span>
                    <button
                      type="button"
                      onClick={() =>
                        downloadLog(
                          `ufac-${account.id}-${i + 1}-${(l.label || "step").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`,
                          JSON.stringify(l, null, 2),
                        )
                      }
                      className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      download
                    </button>
                  </div>
                  <div className="break-all text-muted-foreground">
                    {l.method} {l.endpoint}
                  </div>
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">request</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{l.request}</pre>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">response</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">{l.response}</pre>
                  </details>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
