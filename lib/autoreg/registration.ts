import type { AxiosInstance, AxiosResponse } from "axios"
import {
  PINNED_IG_VERSION,
  PINNED_IG_BUILD,
  PINNED_BLOKS_VERSION_ID,
  PINNED_IG_APP_ID,
  PINNED_IG_CAPABILITIES,
  STEP_DELAY_MIN_MS,
  STEP_DELAY_MAX_MS,
  CODE_WAIT_TIMEOUT_MS,
  CODE_POLL_INTERVAL_MS,
} from "./constants"
import {
  createClient,
  buildUserAgent,
  randomDeviceProfile,
  resolveGeo,
  commonHeaders,
  signedBody,
  postGraphqlBloks,
  postAsyncAction,
  parseBloksResponse,
  extractRegContext,
  captureAuthHeaders,
  randomConnectionProfile,
  tzOffsetSeconds,
  type DeviceProfile,
  type GeoInfo,
  type ConnectionProfile,
  type HeadersContext,
  type AuthCapture,
} from "./transport"
import { encryptPassword, parsePasswordKeyFromHeaders, type PasswordKey } from "./crypto"
import {
  randomName,
  randomBirthday,
  generateUsername,
  generatePassword,
  genDeviceId,
  genWaterfallId,
  genCloudTrustToken,
  genAacJid,
  genMachineId,
  genAacCs,
  genFbAnonId,
} from "./identity"
import { AnyMessageClient } from "./anymessage"
import { TextVerifiedClient } from "./textverified"

const BASE_URL = "https://i.instagram.com"

export type RegMethod = "email" | "sms"

export interface RegConfig {
  method: RegMethod
  proxyUrl: string
  anymessageApiKey?: string   // required for email method
  anymessageDomain?: string   // gmail | icloud | outlook
  textverifiedToken?: string  // required for sms method
}

export interface RegResult {
  success: boolean
  username: string
  password: string
  email: string
  phone: string
  igUserId: string
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
  error?: string
}

type StepCallback = (step: string, detail?: string) => void

// ── Instagram Registration Engine ────────────────────────────────────────
// Implements the full 10-step CAA (Create Account Across) flow + 3 NUX
// steps + warmup, matching the Python reference implementation exactly.

export class InstagramRegistration {
  private client: AxiosInstance
  private device: DeviceProfile
  private geo!: GeoInfo
  private connection: ConnectionProfile
  private userAgent = ""

  // Per-account unique identifiers
  private guid: string
  private familyDeviceId: string
  private phoneId: string
  private pigeonSession: string
  private fbAnonId: string
  private waterfallId: string
  private machineId: string
  private cloudTrustToken: string
  private aacJid: string
  private aacCs: string

  // Registration state
  private firstName = ""
  private lastName = ""
  private fullName = ""
  private username = ""
  private password = ""
  private birthday = ""
  private email = ""
  private phone = ""
  private verificationCode = ""

  // Server-side state accumulated across steps
  private regContext = ""
  private passwordKey: PasswordKey | null = null
  private encryptedPassword = ""

  // Auth tokens captured from responses
  private bearer = ""
  private mid = ""
  private claim = ""
  private dsUserId = ""
  private csrf = ""
  private rur = ""
  private igUserId = ""

  // Verification clients
  private emailClient: AnyMessageClient | null = null
  private smsClient: TextVerifiedClient | null = null

  private cancelled = false
  private onStep: StepCallback = () => {}

  constructor(
    private config: RegConfig,
  ) {
    this.client = createClient(config.proxyUrl)
    this.device = randomDeviceProfile()
    this.connection = randomConnectionProfile()

    // Generate all unique IDs
    this.guid = genDeviceId()
    this.familyDeviceId = genDeviceId()
    this.phoneId = genDeviceId()
    this.pigeonSession = `UFS-${genDeviceId()}-0`
    this.fbAnonId = genFbAnonId()
    this.waterfallId = genWaterfallId()
    this.machineId = genMachineId()
    this.cloudTrustToken = genCloudTrustToken()
    this.aacJid = genAacJid()
    this.aacCs = genAacCs()
  }

  /** Set callback for step progress updates. */
  setOnStep(cb: StepCallback) {
    this.onStep = cb
  }

  /** Cancel the registration. */
  cancel() {
    this.cancelled = true
  }

  private checkCancelled() {
    if (this.cancelled) throw new Error("Registration cancelled")
  }

  // ── Header context ─────────────────────────────────────────────────────

  private headersCtx(): HeadersContext {
    return {
      userAgent: this.userAgent,
      deviceId: this.guid,
      familyDeviceId: this.familyDeviceId,
      phoneId: this.phoneId,
      pigeonSession: this.pigeonSession,
      machineId: this.machineId,
      cloudTrustToken: this.cloudTrustToken,
      mid: this.mid,
      geo: this.geo,
      connection: this.connection,
      bearer: this.bearer || undefined,
      dsUserId: this.dsUserId || undefined,
      claim: this.claim || undefined,
      csrf: this.csrf || undefined,
    }
  }

  private headers(): Record<string, string> {
    return commonHeaders(this.headersCtx())
  }

  // ── AAC string (anti-abuse) ────────────────────────────────────────────

  private aacString(): string {
    return JSON.stringify({
      aac_init_timestamp: Math.floor(Date.now() / 1000) - 30,
      aacjid: this.aacJid,
      aaccs: this.aacCs,
    })
  }

  // ── Common server params ───────────────────────────────────────────────

  private commonServerParams(): Record<string, unknown> {
    return {
      login_surface: "caa_signup",
      waterfall_id: this.waterfallId,
      device_id: this.guid,
      cloud_trust_token: this.cloudTrustToken,
      reg_context: this.regContext,
      INTERNAL__latency_qpl_marker_id: "36707587_null",
      INTERNAL__latency_qpl_instance_id: Math.floor(Math.random() * 1e18),
      server_params: {
        credential_type: "email",
        device_id: this.guid,
        waterfall_id: this.waterfallId,
        is_from_logged_out: 1,
      },
    }
  }

  // ── Common client params ───────────────────────────────────────────────

  private commonClientParams(): Record<string, unknown> {
    return {
      aac: this.aacString(),
      network_bssid: "02:00:00:00:00:00",
      lois_settings: JSON.stringify({
        lois_token: "",
        lois_blob: "",
      }),
    }
  }

  // ── Flow info ──────────────────────────────────────────────────────────

  private flowInfo(): Record<string, string> {
    return {
      flow_name: "new_to_family_ig_default",
      flow_type: "ntf",
    }
  }

  // ── Full reg_info payload ──────────────────────────────────────────────

  private regInfo(): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000)
    return {
      // Device
      device_id: this.guid,
      waterfall_id: this.waterfallId,
      phone_id: this.phoneId,
      family_device_id: this.familyDeviceId,
      guid: this.guid,
      // App
      app_version: PINNED_IG_VERSION,
      bloks_version_id: PINNED_BLOKS_VERSION_ID,
      ig_app_id: PINNED_IG_APP_ID,
      // User data
      username: this.username,
      first_name: this.firstName,
      password: this.encryptedPassword,
      birthday: this.birthday,
      email: this.email,
      phone_number: this.phone,
      // Verification
      email_verification_code: this.verificationCode,
      sms_code: this.verificationCode,
      // Timestamps
      client_timestamp: now,
      timestamp: now,
      // Flow
      ...this.flowInfo(),
      // Anti-abuse
      ...this.commonClientParams(),
      // Capabilities
      force_sign_up_code: "",
      tos_version: "row",
      has_sms_consent: true,
      one_tap_opt_in: true,
    }
  }

  // ── Update state from response ─────────────────────────────────────────

  private updateState(resp: AxiosResponse) {
    // Capture auth headers
    const auth = captureAuthHeaders(resp)
    if (auth.bearer) this.bearer = auth.bearer
    if (auth.mid) this.mid = auth.mid
    if (auth.claim) this.claim = auth.claim
    if (auth.dsUserId) this.dsUserId = auth.dsUserId
    if (auth.csrf) this.csrf = auth.csrf
    if (auth.rur) this.rur = auth.rur

    const ctx = extractRegContext(resp)
    if (ctx) this.regContext = ctx
  }

  // ── Detect restriction/ban ─────────────────────────────────────────────

  private detectRestriction(resp: AxiosResponse): string | null {
    const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
    const lower = raw.toLowerCase()

    if (lower.includes("ufac") || lower.includes("checkpoint")) {
      return "UFAC/Checkpoint detected"
    }
    if (lower.includes("account_disabled") || lower.includes("account_suspended")) {
      return "Account disabled/suspended"
    }
    if (lower.includes("spam") || lower.includes("abuse")) {
      return "Spam/abuse detection triggered"
    }
    if (lower.includes("try_again_later") || lower.includes("try again later")) {
      return "Rate limited — try again later"
    }
    if (lower.includes("generic_request_error")) {
      return "Generic request error"
    }
    return null
  }

  // ── Random delay between steps ─────────────────────────────────────────

  private async stepDelay() {
    const ms = STEP_DELAY_MIN_MS + Math.random() * (STEP_DELAY_MAX_MS - STEP_DELAY_MIN_MS)
    await sleep(ms)
  }

  // ══════════════════════════════════════════════════════════════════════
  //  REGISTRATION STEPS
  // ══════════════════════════════════════════════════════════════════════

  /** Step 1: AYMH create_account_button */
  private async step1(): Promise<void> {
    this.onStep("step1_aymh", "Initiating registration flow")
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.login.aymh.create_account_button",
      {
        ...this.commonClientParams(),
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Fetch RSA password encryption key (POST with signed_body, key from headers) */
  private async fetchPasswordKey(): Promise<void> {
    this.onStep("fetch_key", "Fetching password encryption key")
    const ts = String(Math.floor(Date.now() / 1000))
    const paramsObj = {
      device_id: this.guid,
      ts,
      client_context: '["opt,value_hash"]',
      bool_opt_policy: "0",
      unit_type: "1",
      fetch_type: "ASYNC_FULL",
      query_hash: "8ace8ac76cd0763f17ad9f3672ded0e5d9709b4db7237ea5a7bfc8c20a7f45bb",
      api_version: "3",
      use_case: "STANDARD",
      fetch_mode: "CONFIG_SYNC_ONLY",
    }
    const body = signedBody(paramsObj)
    const hdrs = {
      ...this.headers(),
      "x-fb-friendly-name": "api",
      "x-bloks-is-panorama-enabled": "true",
      "x-bloks-is-prism-enabled": "false",
      "x-bloks-prism-font-enabled": "false",
      "x-bloks-prism-colors-enabled": "false",
      "x-ig-connection-speed": "-1kbps",
      "x-ig-abr-connection-speed-kbps": "0",
    }
    const resp = await this.client.post(
      `${BASE_URL}/api/v1/launcher/mobileconfig/`,
      body,
      { headers: hdrs },
    )
    this.passwordKey = parsePasswordKeyFromHeaders(resp)
    this.updateState(resp)
  }

  /** Step 2: Expose NTM experiment (async_action endpoint) */
  private async step2(): Promise<void> {
    this.onStep("step2_expose", "Exposing NTM experiment")
    const resp = await postAsyncAction(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.async.expose_ntm_experiment.async",
      {
        ...this.commonClientParams(),
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 3 (email): Set contact point (email) */
  private async step3Email(): Promise<void> {
    this.onStep("step3_email", `Setting email: ${this.email}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.contactpoint_email",
      {
        ...this.commonClientParams(),
        email: this.email,
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 3 (SMS): Set contact point (phone) */
  private async step3Phone(): Promise<void> {
    this.onStep("step3_phone", `Setting phone: ${this.phone}`)

    // Step 3.1: contactpoint_phone (sync)
    const resp1 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.contactpoint_phone",
      {
        ...this.commonClientParams(),
        phone_number: this.phone,
      },
      this.commonServerParams(),
    )
    this.updateState(resp1)
    await this.stepDelay()

    // Step 3.2: contactpoint_phone_async
    const resp2 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.contactpoint_phone.async",
      {
        ...this.commonClientParams(),
        phone_number: this.phone,
      },
      this.commonServerParams(),
    )
    this.updateState(resp2)
    await this.stepDelay()

    // Step 3.5: confirm_sms_dispatch
    const resp3 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.confirm_sms_dispatch",
      {
        ...this.commonClientParams(),
        phone_number: this.phone,
      },
      this.commonServerParams(),
    )
    this.updateState(resp3)
  }

  /** Step 4 (email): Send confirmation email (async_action endpoint) */
  private async step4Email(): Promise<void> {
    this.onStep("step4_send_email", "Sending confirmation email")
    const resp = await postAsyncAction(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.send_confirmation_email.async",
      {
        ...this.commonClientParams(),
        machine_id: this.machineId,
        cloud_trust_token: this.cloudTrustToken,
        contactpoint: this.email,
      },
      {
        ...this.commonServerParams(),
        flow_info: this.flowInfo(),
        reg_info: JSON.stringify(this.regInfo()),
        current_step: 0,
      },
    )
    this.updateState(resp)
  }

  /** Step 4 (SMS): Send confirmation SMS */
  private async step4Sms(): Promise<void> {
    this.onStep("step4_send_sms", "Sending confirmation SMS")
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.send_confirmation_sms",
      {
        ...this.commonClientParams(),
        phone_number: this.phone,
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 5 (email): Submit email verification code (code as string) */
  private async step5Email(): Promise<void> {
    this.onStep("step5_verify_email", `Verifying code: ${this.verificationCode}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.confirmation_email",
      {
        ...this.commonClientParams(),
        email: this.email,
        email_verification_code: this.verificationCode,  // string for email
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 5 (SMS): Submit SMS verification code (code as integer) */
  private async step5Sms(): Promise<void> {
    this.onStep("step5_verify_sms", `Verifying code: ${this.verificationCode}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.confirmation",
      {
        ...this.commonClientParams(),
        phone_number: this.phone,
        sms_code: Number(this.verificationCode),  // integer for SMS
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 6: Set password */
  private async step6Password(): Promise<void> {
    this.onStep("step6_password", "Setting password")

    // Encrypt the password
    if (!this.passwordKey?.publicKey) throw new Error("No password key available")
    this.encryptedPassword = encryptPassword(this.password, this.passwordKey)

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.password",
      {
        ...this.commonClientParams(),
        password: this.encryptedPassword,
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 7: Set birthday (DD-MM-YYYY) */
  private async step7Birthday(): Promise<void> {
    this.onStep("step7_birthday", `Setting birthday: ${this.birthday}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.birthday",
      {
        ...this.commonClientParams(),
        birthday: this.birthday,
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 8: Set username (actually comes after birthday in the flow) */
  private async step8Username(): Promise<void> {
    this.onStep("step8_username", `Setting username: ${this.username}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.username",
      {
        ...this.commonClientParams(),
        username: this.username,
        ...this.regInfo(),
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 9: Set name (name_ig_and_soap, actually shown after username in the UI) */
  private async step9Name(): Promise<void> {
    this.onStep("step9_name", `Setting name: ${this.fullName}`)
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.name_ig_and_soap",
      {
        ...this.commonClientParams(),
        first_name: this.fullName,
        ...this.regInfo(),
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** Step 10: Create account (uses async_action endpoint) */
  private async step10CreateAccount(): Promise<void> {
    this.onStep("step10_create", "Creating account")
    const resp = await postAsyncAction(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.register.ntm.create_account.async",
      {
        ...this.commonClientParams(),
        ...this.regInfo(),
      },
      this.commonServerParams(),
    )
    this.updateState(resp)

    // Check for restrictions
    const restriction = this.detectRestriction(resp)
    if (restriction) {
      throw new Error(restriction)
    }

    // Extract ig_user_id from response
    const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
    const uidMatch = /"user_id"\s*:\s*"?(\d+)"?/.exec(raw)
    if (uidMatch) this.igUserId = uidMatch[1]

    // Also try from ds_user_id if not found
    if (!this.igUserId && this.dsUserId) {
      this.igUserId = this.dsUserId
    }

    if (!this.bearer && !this.igUserId) {
      throw new Error("Account creation failed — no bearer token or user_id in response")
    }
  }

  // ── NUX (New User Experience) completion ───────────────────────────────
  // These 3 steps are required to transition the account out of
  // "partially_created" state, which prevents bans.

  /** NUX Step 1: Profile skip */
  private async nuxProfileSkip(): Promise<void> {
    this.onStep("nux_profile_skip", "Completing NUX: profile skip")
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.registration.profile.async",
      {
        ...this.commonClientParams(),
      },
      {
        ...this.commonServerParams(),
        server_params: {
          ...((this.commonServerParams().server_params as object) || {}),
          user_id: this.igUserId || this.dsUserId,
        },
      },
    )
    this.updateState(resp)
  }

  /** NUX Step 2: Registration transition */
  private async nuxRegTransition(): Promise<void> {
    this.onStep("nux_reg_transition", "Completing NUX: registration transition")
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.transition.async",
      {
        ...this.commonClientParams(),
        created_user_id: this.igUserId || this.dsUserId,
        fb_uid: this.igUserId || this.dsUserId,
      },
      this.commonServerParams(),
    )
    this.updateState(resp)
  }

  /** NUX Step 3: Privacy consent (two-phase: PROMPT → ACTION) */
  private async nuxPrivacyConsent(): Promise<void> {
    this.onStep("nux_privacy", "Completing NUX: privacy consent")

    // Phase 1: PROMPT — get experience_id
    const resp1 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.registration.consent.dsa_v2_ig_one_tap_v2_0.async",
      {
        ...this.commonClientParams(),
        type: "PROMPT",
      },
      this.commonServerParams(),
    )
    this.updateState(resp1)

    // Extract experience_id from response
    const raw1 = typeof resp1.data === "string" ? resp1.data : JSON.stringify(resp1.data)
    const expMatch = /"experience_id"\s*:\s*"([^"]+)"/.exec(raw1)
    const experienceId = expMatch ? expMatch[1] : ""

    await sleep(2000)

    // Phase 2: ACTION — submit APPROVED with experience_id
    const resp2 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.registration.consent.dsa_v2_ig_one_tap_v2_0.async",
      {
        ...this.commonClientParams(),
        type: "ACTION",
        experience_id: experienceId,
        consent_status: "APPROVED",
      },
      this.commonServerParams(),
    )
    this.updateState(resp2)
  }

  // ── Post-registration warmup ───────────────────────────────────────────
  // Simulates the initial feed load a real app does after signup.

  private async warmup(): Promise<void> {
    this.onStep("warmup", "Running post-registration warmup")
    try {
      // Reels tray cold start
      await this.client.get(
        `${BASE_URL}/api/v1/feed/reels_tray/?reason=cold_start`,
        { headers: this.headers() },
      )
      await sleep(2000 + Math.random() * 3000)

      // Timeline cold start fetch
      const body = signedBody({
        feed_view_info: "[]",
        phone_id: this.phoneId,
        reason: "cold_start_fetch",
        battery_level: 70 + Math.floor(Math.random() * 30),
        timezone_offset: String(tzOffsetSeconds(this.geo.timezone)),
        device_id: this.guid,
        request_id: genWaterfallId(),
        is_pull_to_refresh: "0",
        is_async_ads_double_request: "0",
        is_async_ads_rti: "0",
      })
      await this.client.post(
        `${BASE_URL}/api/v1/feed/timeline/`,
        body,
        { headers: this.headers() },
      )
    } catch {
      // Warmup is best-effort — don't fail the registration
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  MAIN ORCHESTRATION
  // ══════════════════════════════════════════════════════════════════════

  async run(): Promise<RegResult> {
    try {
      // ── Phase 0: Setup ──────────────────────────────────────────────
      this.onStep("init", "Resolving geo and generating identity")
      this.geo = await resolveGeo(this.config.proxyUrl)
      this.userAgent = buildUserAgent(this.device, this.geo.locale)

      // Generate identity
      const { firstName, lastName } = randomName()
      this.firstName = firstName
      this.lastName = lastName
      this.fullName = `${firstName} ${lastName}`
      this.username = generateUsername(firstName, lastName)
      this.password = generatePassword()
      this.birthday = randomBirthday()

      // ── Phase 1: Verification setup ─────────────────────────────────
      if (this.config.method === "email") {
        if (!this.config.anymessageApiKey) throw new Error("AnyMessage API key required for email method")
        this.emailClient = new AnyMessageClient(this.config.anymessageApiKey)
        const { email } = await this.emailClient.orderEmail(this.config.anymessageDomain)
        this.email = email
        this.onStep("email_ordered", `Email ordered: ${email}`)
      } else {
        if (!this.config.textverifiedToken) throw new Error("TextVerified token required for SMS method")
        this.smsClient = new TextVerifiedClient(this.config.textverifiedToken)
        const { phone } = await this.smsClient.orderPhone()
        this.phone = phone
        this.onStep("phone_ordered", `Phone ordered: ${phone}`)
      }

      // ── Phase 2: Registration steps ─────────────────────────────────
      this.checkCancelled()
      await this.step1()
      await this.stepDelay()

      this.checkCancelled()
      await this.fetchPasswordKey()
      await this.stepDelay()

      this.checkCancelled()
      await this.step2()
      await this.stepDelay()

      // Step 3: contact point
      this.checkCancelled()
      if (this.config.method === "email") {
        await this.step3Email()
      } else {
        await this.step3Phone()
      }
      await this.stepDelay()

      // Step 4: send verification
      this.checkCancelled()
      if (this.config.method === "email") {
        await this.step4Email()
      } else {
        await this.step4Sms()
      }

      // ── Phase 3: Wait for verification code ────────────────────────
      this.checkCancelled()
      this.onStep("waiting_code", "Waiting for verification code")
      if (this.config.method === "email") {
        this.verificationCode = await this.emailClient!.waitForCode(
          CODE_WAIT_TIMEOUT_MS,
          CODE_POLL_INTERVAL_MS,
        )
      } else {
        this.verificationCode = await this.smsClient!.waitForCode(
          CODE_WAIT_TIMEOUT_MS,
          CODE_POLL_INTERVAL_MS,
        )
      }
      this.onStep("code_received", `Code: ${this.verificationCode}`)
      await this.stepDelay()

      // Step 5: verify code
      this.checkCancelled()
      if (this.config.method === "email") {
        await this.step5Email()
      } else {
        await this.step5Sms()
      }
      await this.stepDelay()

      // Step 6: password
      this.checkCancelled()
      await this.step6Password()
      await this.stepDelay()

      // Step 7: birthday
      this.checkCancelled()
      await this.step7Birthday()
      await this.stepDelay()

      // Step 8: username (comes before name in the actual flow)
      this.checkCancelled()
      await this.step8Username()
      await this.stepDelay()

      // Step 9: name
      this.checkCancelled()
      await this.step9Name()
      await this.stepDelay()

      // Step 10: create account
      this.checkCancelled()
      await this.step10CreateAccount()
      await this.stepDelay()

      // ── Phase 4: NUX completion ─────────────────────────────────────
      this.checkCancelled()
      try {
        await this.nuxProfileSkip()
        await sleep(3000)
        await this.nuxRegTransition()
        await sleep(3000)
        await this.nuxPrivacyConsent()
      } catch (e) {
        // NUX failures are logged but don't fail the registration
        this.onStep("nux_warning", `NUX partial: ${(e as Error).message}`)
      }

      // ── Phase 5: Warmup ─────────────────────────────────────────────
      await this.warmup()

      this.onStep("done", `Account created: ${this.username}`)

      return this.buildResult(true)
    } catch (err) {
      const errorMsg = (err as Error).message || "Unknown error"
      this.onStep("error", errorMsg)

      // Cleanup verification orders
      try {
        if (this.emailClient) await this.emailClient.cancelEmail()
        if (this.smsClient) await this.smsClient.cancelPhone()
      } catch {}

      return this.buildResult(false, errorMsg)
    }
  }

  // ── Build result object ────────────────────────────────────────────────

  private buildResult(success: boolean, error?: string): RegResult {
    const sessionBlob = {
      saved_at: new Date().toISOString(),
      username: this.username,
      password: this.password,
      totp_seed: "",
      email: this.email,
      session: {
        authorization: this.bearer,
        ds_user_id: this.dsUserId,
        mid: this.mid,
        csrf: this.csrf,
        www_claim: this.claim,
      },
      device: {
        guid: this.guid,
        family_device_id: this.familyDeviceId,
        phone_id: this.phoneId,
        device_id: this.guid,
        pigeon_session: this.pigeonSession,
        fb_anon_id: this.fbAnonId,
        waterfall_id: this.waterfallId,
        network_bssid: "02:00:00:00:00:00",
        reg_flow_id: "",
        aac_jid: this.aacJid,
        machine_id: this.machineId,
        cloud_trust: this.cloudTrustToken,
      },
      app: {
        ig_version: PINNED_IG_VERSION,
        app_id: PINNED_IG_APP_ID,
        app_version: PINNED_IG_VERSION,
        build_number: PINNED_IG_BUILD,
        bloks_version: PINNED_BLOKS_VERSION_ID,
      },
      ua_profile: {
        ua_version: PINNED_IG_VERSION,
        device_model: this.device.model,
        os_version: this.device.iosVersion,
        os_build: this.device.iosBuild,
        locale: this.geo?.locale || "en_US",
        country: this.geo?.country || "US",
        tz_name: this.geo?.timezone || "America/Chicago",
        scale: this.device.scale,
        resolution: this.device.resolution,
        w_logical: this.device.wLogical,
        h_logical: this.device.hLogical,
      },
      cookies: {},
    }

    return {
      success,
      username: this.username,
      password: this.password,
      email: this.email,
      phone: this.phone,
      igUserId: this.igUserId,
      bearer: this.bearer,
      mid: this.mid,
      claim: this.claim,
      dsUserId: this.dsUserId,
      csrf: this.csrf,
      rur: this.rur,
      deviceId: this.guid,
      familyDeviceId: this.familyDeviceId,
      phoneId: this.phoneId,
      pigeonSession: this.pigeonSession,
      fbAnonId: this.fbAnonId,
      waterfallId: this.waterfallId,
      machineId: this.machineId,
      cloudTrustToken: this.cloudTrustToken,
      aacJid: this.aacJid,
      aacCs: this.aacCs,
      iphoneModel: this.device.model,
      iosVersion: this.device.iosVersion,
      appVersion: PINNED_IG_VERSION,
      locale: this.geo?.locale || "en_US",
      timezone: this.geo?.timezone || "America/Chicago",
      userAgent: this.userAgent,
      sessionBlob,
      error,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Re-export for runner usage
export { genWaterfallId }
