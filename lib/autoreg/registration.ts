import type { AxiosInstance, AxiosResponse } from "axios"
import {
  PINNED_IG_VERSION,
  PINNED_IG_BUILD,
  PINNED_BLOKS_VERSION_ID,
  PINNED_IG_APP_ID,
  PINNED_IG_CAPABILITIES,
  CLIENT_DOC_ID_APP,
  CLIENT_DOC_ID_ACTION,
  BK_CONTEXT,
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
  private qplInstanceId: number
  private aacInitTs: number

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
  private sessionid = ""
  private region = ""

  // Verification clients
  private emailClient: AnyMessageClient | null = null
  private smsClient: TextVerifiedClient | null = null

  private nuxConsentApproved = false
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
    this.qplInstanceId = Math.floor(Math.random() * 1e18)
    this.aacInitTs = Math.floor(Date.now() / 1000) - 30
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
      aac_init_timestamp: this.aacInitTs,
      aacjid: this.aacJid,
      aaccs: this.aacCs,
    })
  }

  // ── Common server params ───────────────────────────────────────────────

  private commonServerParams(extra?: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = {
      is_from_logged_out: 0,
      offline_experiment_group: "caa_launch_ig",
      family_device_id: null,
      layered_homepage_experiment_group: "igios_layered_landing_screen_experiment_ld_with_xmds_v2",
      INTERNAL__latency_qpl_instance_id: this.qplInstanceId,
      INTERNAL__latency_qpl_marker_id: "36707587_null",
      cloud_trust_token: this.cloudTrustToken,
      login_surface: "login_home",
      login_entry_point: "logged_out",
      waterfall_id: this.waterfallId,
      is_from_logged_in_switcher: 0,
      is_platform_login: 0,
      device_id: this.guid,
      access_flow_version: "pre_mt_behavior",
    }
    if (extra) Object.assign(base, extra)
    return base
  }

  // ── Common client params ───────────────────────────────────────────────

  private commonClientParams(): Record<string, unknown> {
    return {
      aac: this.aacString(),
      network_bssid: null,
      lois_settings: { lois_token: "" },
    }
  }

  // ── Flow info ──────────────────────────────────────────────────────────

  private flowInfo(): string {
    return JSON.stringify({ flow_name: "new_to_family_ig_default", flow_type: "ntf" })
  }

  // ── Full reg_info payload ──────────────────────────────────────────────

  private regInfo(opts?: {
    contactpoint?: string
    contactpointType?: string
    confirmationCode?: string
    encryptedPassword?: string
    username?: string
    birthday?: string
    firstName?: string
    lastName?: string
    fullName?: string
    shouldSavePassword?: boolean
  }): string {
    const o = opts || {}
    const cp = o.contactpoint || null
    const cpType = cp ? (o.contactpointType || "email") : null
    return JSON.stringify({
      first_name: o.firstName || null,
      last_name: o.lastName || null,
      full_name: o.fullName || null,
      contactpoint: cp,
      ar_contactpoint: null,
      attempted_empty_last_name: null,
      contactpoint_type: cpType,
      is_using_unified_cp: false,
      unified_cp_screen_variant: "control",
      is_cp_auto_confirmed: false,
      is_cp_auto_confirmable: false,
      is_cp_claimed: false,
      confirmation_code: o.confirmationCode || null,
      birthday: o.birthday || null,
      birthday_derived_from_age: null,
      age_range: null,
      did_use_age: null,
      os_shared_age_range: null,
      gender: null,
      use_custom_gender: false,
      custom_gender: null,
      encrypted_password: o.encryptedPassword || null,
      username: o.username || null,
      username_prefill: null,
      accounts_list_client: null,
      fb_conf_source: null,
      device_id: this.guid,
      ig4a_qe_device_id: null,
      family_device_id: null,
      fdid_available_on_start: false,
      fdid_rid_available_on_start: false,
      asdid_available_on_start: true,
      user_id: null,
      skip_slow_rel_check: true,
      machine_id: this.machineId,
      profile_photo: null,
      profile_photo_id: null,
      profile_photo_upload_id: null,
      avatar: null,
      email_oauth_token_no_contact_perm: null,
      email_oauth_token: null,
      email_oauth_tokens: null,
      sign_in_with_google_email: null,
      should_skip_two_step_conf: null,
      openid_tokens_for_testing: null,
      encrypted_msisdn: null,
      headers_last_infra_flow_id: null,
      headers_flow_id: null,
      was_headers_prefill_available: null,
      sso_enabled: null,
      existing_accounts: null,
      used_ig_birthday: null,
      create_new_to_app_account: null,
      skip_session_info: null,
      ck_error: null,
      ck_id: null,
      ck_nonce: null,
      should_save_password: o.shouldSavePassword ?? null,
      fb_access_token: null,
      is_msplit_reg: null,
      is_spectra_reg: null,
      dema_account_consent_given: null,
      spectra_entry_source: null,
      spectra_reg_token: null,
      spectra_reg_guardian_id: null,
      spectra_reg_guardian_logged_in_context: null,
      spectra_requester_user_id: null,
      user_id_of_msplit_creator: null,
      msplit_creator_nonce: null,
      dma_data_combination_consent_given: null,
      xapp_accounts: null,
      fb_device_id: null,
      fb_machine_id: null,
      ig_device_id: null,
      ig_machine_id: null,
      should_skip_nta_upsell: null,
      big_blue_token: null,
      caa_reg_flow_source: "login_home_native_integration_point",
      ig_authorization_token: null,
      full_sheet_flow: false,
      crypted_user_id: null,
      is_ca_late_teen: null,
      is_early_teen: null,
      is_caa_perf_enabled: true,
      is_preform: true,
      should_show_rel_error: false,
      ignore_suma_check: false,
      dismissed_login_upsell_with_cna: false,
      ignore_existing_login: false,
      ignore_existing_login_from_suma: false,
      ignore_existing_login_after_errors: false,
      suggested_first_name: null,
      suggested_last_name: null,
      suggested_full_name: null,
      frl_authorization_token: null,
      post_form_errors: null,
      skip_step_without_errors: false,
      existing_account_exact_match_checked: false,
      existing_account_fuzzy_match_checked: false,
      email_oauth_exists: false,
      confirmation_code_send_error: null,
      consent_jurisdiction_at_gate: null,
      consent_jurisdiction_at_inflow: null,
      pc_enforcement_outcome: null,
      pc_inflow_decision: null,
      is_too_young: false,
      source_account_type: null,
      whatsapp_installed_on_client: false,
      confirmation_medium: null,
      source_credentials_type: null,
      source_cuid: null,
      source_account_reg_info: null,
      soap_creation_source: null,
      source_account_type_to_reg_info: null,
      registration_flow_id: crypto.randomUUID(),
      should_skip_youth_tos: false,
      is_youth_regulation_flow_complete: false,
      is_on_cold_start: false,
      email_prefilled: false,
      cp_confirmed_by_auto_conf: false,
      in_sowa_experiment: false,
      conf_allow_back_nav_after_change_cp: null,
      conf_bouncing_cliff_screen_type: null,
      conf_show_bouncing_cliff: null,
      eligible_to_flash_call_in_ig4a: false,
      eligible_to_mo_sms_in_ig4a: false,
      mo_sms_ent_id: null,
      flash_call_permissions_status: null,
      gms_incoming_call_retriever_eligibility: null,
      attestation_result: null,
      request_data_and_challenge_nonce_string: null,
      confirmed_cp_and_code: null,
      notification_callback_id: null,
      reg_suma_state: 0,
      is_msplit_neutral_choice: false,
      msg_previous_cp: null,
      ntp_import_source_info: null,
      youth_consent_decision_time: null,
      sk_pipa_consent_given: null,
      should_show_spi_before_conf: true,
      google_oauth_account: null,
      is_reg_request_from_ig_suma: false,
      is_toa_reg: false,
      is_threads_public: false,
      spc_import_flow: false,
      caa_play_integrity_attestation_result: null,
      client_known_key_hash: null,
      flash_call_provider: null,
      is_in_gms_experience: null,
      flash_call_nonce_prefix_details: null,
      spc_birthday_input: false,
      failed_birthday_year_count: null,
      user_presented_medium_source: null,
      user_opted_out_of_ntp: null,
      is_from_registration_reminder: false,
      show_youth_reg_in_ig_spc: false,
      fb_suma_is_high_confidence: null,
      fb_email_login_upsell_skip_suma_post_tos: false,
      fb_suma_is_from_email_login_upsell: false,
      fb_suma_is_from_phone_login_upsell: false,
      should_prefill_cp_in_ar: null,
      ig_partially_created_account_user_id: null,
      ig_partially_created_account_nonce: null,
      ig_partially_created_account_nonce_expiry: null,
      force_sessionless_nux_experience: false,
      has_seen_suma_landing_page_pre_conf: false,
      has_seen_suma_candidate_page_pre_conf: false,
      has_seen_confirmation_screen: false,
      suma_on_conf_threshold: -1,
      should_show_error_msg: true,
      th_profile_photo_token: null,
      attempted_silent_auth_in_fb: false,
      attempted_silent_auth_in_ig: false,
      sa_prefetch_callback_id: null,
      cp_suma_results_map: null,
      source_username: null,
      next_uri: null,
      should_use_next_uri: null,
      linking_entry_point: null,
      fb_encrypted_partial_new_account_properties: null,
      starter_pack_name: null,
      starter_pack_creator_user_ids: null,
      wa_data_bundle: null,
      bloks_controller_source: null,
      airwave_registration_code: null,
      is_sessionless_nux: null,
      login_contactpoint: null,
      login_contactpoint_type: null,
      should_show_bday_after_name_suggestions: null,
      should_override_back_nav: false,
      ig_footer_variant: "control",
      device_network_info: null,
      is_from_web_lite_reg_controller: null,
      login_form_siwg_email: null,
      account_setup_waterfall_id: null,
      is_wanted_suma_user: false,
      device_zero_balance_state: null,
      wa_to_ig_merged_tos_variant: null,
      is_in_nta_single_form: false,
      source_account_image_asset_id: null,
      passkey_eligible_device: null,
      nta_control_reason: null,
      nta_risk_type: null,
      nta_single_form_variant: null,
      enable_survey: null,
      phone_prefetch_outcome: null,
      tos_accepted_on_profile_info: null,
    })
  }

  // ── Update state from response ─────────────────────────────────────────

  private updateState(resp: AxiosResponse) {
    const auth = captureAuthHeaders(resp)
    if (auth.bearer) this.bearer = auth.bearer
    if (auth.mid) this.mid = auth.mid
    if (auth.claim) this.claim = auth.claim
    if (auth.dsUserId) this.dsUserId = auth.dsUserId
    if (auth.csrf) this.csrf = auth.csrf
    if (auth.rur) this.rur = auth.rur
    if (auth.sessionid) this.sessionid = auth.sessionid
    if (auth.region) this.region = auth.region

    const ctx = extractRegContext(resp)
    if (ctx) this.regContext = ctx
  }

  // ── Detect restriction/ban ─────────────────────────────────────────────
  // Matches the reference _detect_restriction markers exactly (case-insensitive).

  private detectRestriction(resp: AxiosResponse): string | null {
    const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
    const low = raw.toLowerCase()

    const markers: [string, string][] = [
      ["enrollment_waiting_room", "UFAC enrollment waiting room"],
      ["checkpoint.ufac", "UFAC checkpoint"],
      [".ufac.", "UFAC"],
      ["ufac_", "UFAC"],
      ["www.checkpoint", "checkpoint"],
      ["challenge_required", "challenge required"],
      ["account_disabled", "account disabled"],
      ['is_disabled":true', "account disabled"],
      ["account_suspended", "account suspended"],
      ["spam", "spam detection triggered"],
      ["try_again_later", "rate limited"],
      ["try again later", "rate limited"],
      ["generic_request_error", "generic request error"],
    ]
    for (const [needle, reason] of markers) {
      if (low.includes(needle)) return reason
    }
    return null
  }

  // ── Random delay between steps ─────────────────────────────────────────

  private async stepDelay() {
    const ms = STEP_DELAY_MIN_MS + Math.random() * (STEP_DELAY_MAX_MS - STEP_DELAY_MIN_MS)
    const chunk = 500
    let waited = 0
    while (waited < ms) {
      if (this.cancelled) throw new Error("Registration cancelled")
      await sleep(Math.min(chunk, ms - waited))
      waited += chunk
    }
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
      "com.bloks.www.bloks.caa.reg.aymh_create_account_button.async",
      {
        zero_balance_state: "",
        network_bssid: null,
        cloud_trust_token: this.cloudTrustToken,
        should_show_nested_nta_bottom_sheet: 0,
        aac: this.aacString(),
        username_input: "",
        accounts_list: [],
        lois_settings: { lois_token: "" },
      },
      this.commonServerParams({
        is_from_lid_welcome_screen: 0,
        should_show_wa_nta_bottom_sheet: 0,
        event_step: "landing",
        is_eligible_for_igds_sac_reg_flow: 0,
        should_expand_layered_bottom_sheet: 0,
        reg_flow_source: "login_home_native_integration_point",
        is_caa_perf_enabled: 1,
        entrypoint: "login_home_async",
      }),
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
      "com.bloks.www.bloks.caa.reg.contactpoint_email",
      {
        ...this.commonClientParams(),
        email: this.email,
        email_prefilled: 0,
        confirmed_cp_and_code: {},
        is_from_device_emails: 0,
        prefetch_version: 11,
        block_store_machine_id: "",
        fb_ig_device_id: [],
        accounts_list: [],
        zero_balance_state: "",
        cloud_trust_token: this.cloudTrustToken,
      },
      this.commonServerParams({
        aac: this.aacString(),
        flow_info: this.flowInfo(),
        reg_info: this.regInfo({ contactpoint: this.email }),
        current_step: 0,
        cp_funnel: 0,
        cp_source: 0,
        prefetch_on_field: 1,
        is_from_logged_out: 1,
      }),
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
        aac: this.aacString(),
        machine_id: this.machineId,
        network_bssid: null,
        cloud_trust_token: this.cloudTrustToken,
        lois_settings: { lois_token: "" },
        contactpoint: this.email,
      },
      this.commonServerParams({
        flow_info: this.flowInfo(),
        reg_info: this.regInfo({ contactpoint: this.email }),
        reg_context: this.regContext || "",
        current_step: 0,
      }),
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
      "com.bloks.www.bloks.caa.reg.confirmation.async",
      {
        confirmed_cp_and_code: {},
        fb_ig_device_id: null,
        network_bssid: null,
        cloud_trust_token: this.cloudTrustToken,
        code: this.verificationCode,
        family_device_id: null,
        device_id: this.guid,
        block_store_machine_id: "",
        aac: this.aacString(),
        lois_settings: { lois_token: "" },
      },
      this.commonServerParams({
        event_request_id: crypto.randomUUID(),
        sms_retriever_started_prior_step: 0,
        flow_info: this.flowInfo(),
        text_input_id: Date.now(),
        wa_timer_id: "wa_retriever",
        reg_context: this.regContext || "",
        reg_info: this.regInfo({ contactpoint: this.email, confirmationCode: this.verificationCode }),
        current_step: 3,
      }),
    )
    this.updateState(resp)
  }

  /** Step 5 (SMS): Submit SMS verification code (code as integer) */
  private async step5Sms(): Promise<void> {
    this.onStep("step5_verify_sms", `Verifying code: ${this.verificationCode}`)
    const codeInt = Number(this.verificationCode.replace(/\D/g, ""))
    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.confirmation.async",
      {
        confirmed_cp_and_code: {},
        fb_ig_device_id: [],
        network_bssid: null,
        cloud_trust_token: this.cloudTrustToken,
        code: codeInt,
        family_device_id: null,
        device_id: this.guid,
        block_store_machine_id: "",
        aac: this.aacString(),
        lois_settings: { lois_token: "" },
      },
      this.commonServerParams({
        event_request_id: crypto.randomUUID(),
        sms_retriever_started_prior_step: 0,
        flow_info: this.flowInfo(),
        text_input_id: Date.now(),
        wa_timer_id: "wa_retriever",
        reg_context: this.regContext || "",
        reg_info: this.regInfo({ contactpoint: this.phone, contactpointType: "phone" }),
        confirmation_medium: "sms",
        current_step: 3,
      }),
    )
    this.updateState(resp)
  }

  /** Step 6: Set password */
  private async step6Password(): Promise<void> {
    this.onStep("step6_password", "Setting password")

    if (!this.passwordKey?.publicKey) throw new Error("No password key available")
    this.encryptedPassword = encryptPassword(this.password, this.passwordKey)

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.password.async",
      {
        ...this.commonClientParams(),
        encrypted_password: this.encryptedPassword,
        spi_action: null,
        fb_ig_device_id: null,
        cloud_trust_token: this.cloudTrustToken,
        family_device_id: null,
        device_id: this.guid,
        block_store_machine_id: this.machineId || "",
      },
      this.commonServerParams({
        event_request_id: crypto.randomUUID(),
        flow_info: this.flowInfo(),
        reg_context: this.regContext || "",
        reg_info: this.regInfo({
          contactpoint: this.email || this.phone,
          encryptedPassword: this.encryptedPassword,
          shouldSavePassword: true,
          confirmationCode: this.verificationCode,
        }),
        current_step: 4,
      }),
    )
    this.updateState(resp)
  }

  /** Step 7: Set birthday (DD-MM-YYYY) */
  private async step7Birthday(): Promise<void> {
    this.onStep("step7_birthday", `Setting birthday: ${this.birthday}`)

    const [day, month, year] = this.birthday.split("-").map(Number)
    const birthdayTs = Math.floor(
      new Date(Date.UTC(year, month - 1, day)).getTime() / 1000
    )

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.birthday.async",
      {
        lois_settings: { lois_token: "" },
        client_timezone: this.geo?.timezone || "America/Chicago",
        is_youth_regulation_flow_complete: 0,
        network_bssid: null,
        birthday_or_current_date_string: this.birthday,
        os_age_range: "",
        should_skip_youth_tos: 0,
        birthday_timestamp: birthdayTs,
        aac: this.aacString(),
        accounts_list: [],
        zero_balance_state: "",
      },
      this.commonServerParams({
        reg_context: this.regContext || "",
        flow_info: this.flowInfo(),
        reg_info: this.regInfo({ contactpoint: this.email || this.phone, birthday: this.birthday }),
        current_step: 6,
      }),
    )
    this.updateState(resp)
  }

  private ageRange(): string {
    const [day, month, year] = this.birthday.split("-").map(Number)
    const today = new Date()
    let age = today.getFullYear() - year
    if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) {
      age--
    }
    return age >= 18 ? "o18" : "u18"
  }

  private regInfoWithAccumulated(extra?: Record<string, unknown>): string {
    const base = JSON.parse(this.regInfo({
      contactpoint: this.email || this.phone,
      confirmationCode: this.verificationCode,
      birthday: this.birthday,
      encryptedPassword: this.encryptedPassword,
      username: this.username,
      firstName: this.firstName,
      shouldSavePassword: true,
    }))
    base.age_range = this.ageRange()
    base.should_skip_youth_tos = true
    if (extra) Object.assign(base, extra)
    return JSON.stringify(base)
  }

  /** Step 8: Set name (name_ig_and_soap, comes after birthday in the flow) */
  private async step8Name(): Promise<void> {
    this.onStep("step8_name", `Setting name: ${this.fullName}`)

    const regInfo = this.regInfoWithAccumulated({
      screen_visited: [
        "CAA_REG_CONTACT_POINT_PHONE",
        "CAA_REG_CONTACT_POINT_EMAIL",
        "CAA_REG_CONFIRMATION_SCREEN",
        "CAA_REG_PASSWORD",
        "bloks.caa.reg.birthday",
        "CAA_REG_IG_NAME_SCREEN",
      ],
    })

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.name_ig_and_soap.async",
      {
        ...this.commonClientParams(),
        zero_balance_state: "",
        accounts_list: [],
        cloud_trust_token: this.cloudTrustToken,
        name: this.fullName,
      },
      this.commonServerParams({
        reg_context: this.regContext || "",
        flow_info: this.flowInfo(),
        reg_info: regInfo,
        current_step: 7,
      }),
    )
    this.updateState(resp)
  }

  /** Step 9: Set username (comes after name in the flow) */
  private async step9Username(): Promise<void> {
    this.onStep("step9_username", `Setting username: ${this.username}`)

    const regInfo = this.regInfoWithAccumulated({
      full_name: this.fullName,
      last_name: this.lastName,
      screen_visited: [
        "CAA_REG_CONTACT_POINT_PHONE",
        "CAA_REG_CONTACT_POINT_EMAIL",
        "CAA_REG_CONFIRMATION_SCREEN",
        "CAA_REG_PASSWORD",
        "bloks.caa.reg.birthday",
        "CAA_REG_IG_NAME_SCREEN",
        "CAA_REG_USERNAME",
      ],
    })

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.username.async",
      {
        ...this.commonClientParams(),
        zero_balance_state: "",
        accounts_list: [],
        cloud_trust_token: this.cloudTrustToken,
        validation_text: this.username,
        username: this.username,
      },
      this.commonServerParams({
        reg_context: this.regContext || "",
        flow_info: this.flowInfo(),
        reg_info: regInfo,
        current_step: 8,
        action: 1,
        post_tos: 0,
        text_input_id: Math.floor(Math.random() * 9e14) + 1e14,
        suggestions_container_id: Math.floor(Math.random() * 9e14) + 1e14,
        screen_id: Math.floor(Math.random() * 9e14) + 1e14,
        input_id: Math.floor(Math.random() * 9e14) + 1e14,
      }),
    )
    this.updateState(resp)
  }

  /** Step 10: Create account (uses async_action endpoint) */
  private async step10CreateAccount(): Promise<void> {
    this.onStep("step10_create", "Creating account")

    const regInfo = this.regInfoWithAccumulated({
      full_name: this.fullName,
      last_name: this.lastName,
      screen_visited: [
        "CAA_REG_CONTACT_POINT_PHONE",
        "CAA_REG_CONTACT_POINT_EMAIL",
        "CAA_REG_CONFIRMATION_SCREEN",
        "CAA_REG_PASSWORD",
        "bloks.caa.reg.birthday",
        "CAA_REG_IG_NAME_SCREEN",
        "CAA_REG_USERNAME",
      ],
    })

    const resp = await postAsyncAction(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.create.account.async",
      {
        ...this.commonClientParams(),
        passkey_eligible_device: 0,
        ck_error: "",
        failed_birthday_year_count: "",
        headers_last_infra_flow_id: "",
        ig_partially_created_account_nonce_expiry: 0,
        should_ignore_existing_login: 0,
        reached_from_tos_screen: 1,
        ig_partially_created_account_nonce: "",
        has_dismissed_suma_pre_conf: 0,
        ck_nonce: "",
        force_sessionless_nux_experience: 0,
        ig_partially_created_account_user_id: 0,
        ck_id: "",
        no_contact_perm_email_oauth_token: "",
        encrypted_msisdn: "",
      },
      this.commonServerParams({
        reg_context: this.regContext || "",
        flow_info: this.flowInfo(),
        reg_info: regInfo,
        current_step: 9,
        sa_prefetch_callback_id: "",
        should_ignore_suma_check: 0,
        bloks_controller_source: "bk_caa_reg_tos_screen",
        app_id: 0,
      }),
    )
    this.updateState(resp)

    // Check for restrictions
    const restriction = this.detectRestriction(resp)
    if (restriction) {
      throw new Error(restriction)
    }

    // Extract ig_user_id from response (multiple patterns like reference)
    const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data)
    const unescaped = raw.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\\//g, "/")

    // created_user pk (reference pattern)
    if (!this.igUserId) {
      for (const text of [raw, unescaped]) {
        const m = /"created_user"\s*:\s*\{[^}]*?"pk"\s*:\s*"?(\d+)"?/.exec(text)
        if (m) { this.igUserId = m[1]; break }
      }
    }
    // user_id / pk / ds_user_id generic patterns
    if (!this.igUserId) {
      const m = /"(?:pk|user_id|ds_user_id)"\s*:\s*"?(\d{6,})"?/.exec(raw)
      if (m) this.igUserId = m[1]
    }
    // Escaped pk pattern
    if (!this.igUserId) {
      const m = /\\"pk\\"\s*:\s*\\?"?(\d{6,})\\?"/.exec(raw)
      if (m) this.igUserId = m[1]
    }
    // Fallback to ds_user_id from headers/cookies
    if (!this.igUserId && this.dsUserId) {
      this.igUserId = this.dsUserId
    }

    // Check for signs of success (like reference: ds_user_id, sessionid, account_created in body)
    const hasSuccessIndicator = raw.includes("ds_user_id") ||
      raw.includes("sessionid") ||
      raw.includes("account_created") ||
      raw.includes("created_user") ||
      !!this.bearer ||
      !!this.igUserId

    if (!hasSuccessIndicator) {
      throw new Error("Account creation failed — no bearer token or user_id in response")
    }
  }

  // ── NUX (New User Experience) completion ───────────────────────────────
  // These 3 steps are required to transition the account out of
  // "partially_created" state, which prevents bans.

  /** NUX Step 1: Profile skip */
  private async nuxProfileSkip(): Promise<void> {
    this.onStep("nux_profile_skip", "Completing NUX: profile skip")

    const regInfo = this.regInfoWithAccumulated({
      full_name: this.fullName,
      last_name: this.lastName,
      family_device_id: this.familyDeviceId,
      profile_photo: null,
    })

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.registration.profile.async",
      {},
      {
        is_from_logged_out: 0,
        offline_experiment_group: "caa_launch_ig",
        family_device_id: this.familyDeviceId,
        layered_homepage_experiment_group: "default_control",
        INTERNAL__latency_qpl_instance_id: this.qplInstanceId,
        login_surface: "unknown",
        flow_info: this.flowInfo(),
        reg_info: regInfo,
      },
    )
    this.updateState(resp)
  }

  /** NUX Step 2: Registration transition */
  private async nuxRegTransition(): Promise<void> {
    this.onStep("nux_reg_transition", "Completing NUX: registration transition")

    const regInfo = JSON.stringify({
      first_name: this.firstName || null,
      last_name: this.lastName || null,
      full_name: this.fullName || null,
      contactpoint: null,
      contactpoint_type: "email",
      username: this.username,
      family_device_id: this.familyDeviceId,
      user_id: this.igUserId || this.dsUserId || null,
    })

    const resp = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.bloks.caa.reg.transition.async",
      {},
      {
        is_from_logged_out: 0,
        offline_experiment_group: null,
        family_device_id: this.familyDeviceId,
        layered_homepage_experiment_group: null,
        INTERNAL__latency_qpl_instance_id: this.qplInstanceId,
        login_surface: "unknown",
        flow_info: this.flowInfo(),
        reg_info: regInfo,
      },
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
      "com.bloks.www.privacy.consent.prompt.action",
      {},
      {
        flow_name: "new_users_meta_flow",
        source: "source",
      },
    )
    this.updateState(resp1)

    // Check if the PROMPT response itself already contains APPROVED
    const raw1 = typeof resp1.data === "string" ? resp1.data : JSON.stringify(resp1.data)
    if (raw1.includes("APPROVED")) {
      this.nuxConsentApproved = true
      this.onStep("nux_consent", "Consent APPROVED (from PROMPT phase)")
      return
    }

    // Extract experience_id from response
    const expMatch = /"experience_id"\s*:\s*"([^"]+)"/.exec(raw1)
    const experienceId = expMatch ? expMatch[1] : ""

    if (!experienceId) {
      this.onStep("nux_consent_warn", "No experience_id in consent PROMPT — skipping ACTION phase")
      return
    }

    await sleep(1000)

    // Phase 2: ACTION — submit with experience_id, expect APPROVED
    const resp2 = await postGraphqlBloks(
      this.client,
      this.headers(),
      "com.bloks.www.privacy.consent.prompt.action",
      {},
      {
        flow_name: "new_users_meta_flow",
        INTERNAL__latency_qpl_marker_id: "36707587_null",
        INTERNAL__latency_qpl_instance_id: this.qplInstanceId,
        _w_s228763: "",
        source: "source",
        experience_id: experienceId,
      },
    )
    this.updateState(resp2)

    const raw2 = typeof resp2.data === "string" ? resp2.data : JSON.stringify(resp2.data)
    this.nuxConsentApproved = raw2.includes("APPROVED")
    this.onStep(
      "nux_consent",
      this.nuxConsentApproved
        ? "Consent APPROVED — onboarding complete"
        : "Consent not approved — account may remain partially_created",
    )
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

      // Step 8: name (comes before username in the flow)
      this.checkCancelled()
      await this.step8Name()
      await this.stepDelay()

      // Step 9: username
      this.checkCancelled()
      await this.step9Username()
      await this.stepDelay()

      // Step 10: create account
      this.checkCancelled()
      await this.step10CreateAccount()
      await this.stepDelay()

      // ── Phase 4: NUX completion ─────────────────────────────────────
      // Required to transition account out of partially_created state.
      // Without APPROVED from consent, the account gets banned in ~30 min.
      this.checkCancelled()
      let nuxConsentReached = false
      try {
        await this.nuxProfileSkip()
        await sleep(3000)
        await this.nuxRegTransition()
        await sleep(3000)
        nuxConsentReached = true
        await this.nuxPrivacyConsent()
      } catch (e) {
        this.onStep("nux_warning", `NUX partial: ${(e as Error).message}`)
      }

      // ── Phase 5: Warmup ─────────────────────────────────────────────
      await this.warmup()

      // Gate final success on APPROVED: only fully onboarded accounts
      // are considered successful. But if consent was never reached
      // (earlier NUX step threw), don't reject based on a flag we
      // never got to set.
      if (nuxConsentReached && !this.nuxConsentApproved) {
        this.onStep("not_approved", "Account created but consent not APPROVED — partially_created")
        return this.buildResult(false, "NUX consent not approved — account partially_created")
      }

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
    const iosVer = this.device.iosVersion.replace(/_/g, ".")
    const dsUid = this.dsUserId ? (
      /^\d+$/.test(this.dsUserId) ? Number(this.dsUserId) : this.dsUserId
    ) : ""
    const tz = this.geo?.timezone || "America/Chicago"
    const country = this.geo?.country || "US"
    const locale = this.geo?.locale || "en_US"

    const sessionBlob = {
      saved_at: Math.floor(Date.now() / 1000),
      username: this.username,
      password: this.password,
      totp_seed: "",
      email: this.email,
      session: {
        authorization: this.bearer,
        ds_user_id: dsUid,
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
        network_bssid: "",
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
        os_ver_dotted: iosVer,
        os_build: this.device.iosBuild,
        locale,
        country,
        tz_name: tz,
        scale: this.device.scale,
        resolution: this.device.resolution,
        w_logical: this.device.wLogical,
        h_logical: this.device.hLogical,
        ios_ver: iosVer,
      },
      cookies: [] as string[],
      ios_az_state: {
        fingerprint: {
          app_session: {
            pigeon_session: this.pigeonSession,
            analytics_session_id: this.waterfallId,
            bandwidth_type: this.connection.ig_connection_type,
            bandwidth_estimate: this.connection.ig_bandwidth_speed_kbps,
            aac_jid: this.aacJid,
            aac_cs: this.aacCs,
            aac_init_ts: this.aacInitTs,
          },
          installation: {
            device_id: this.guid,
            family_device_id: this.familyDeviceId,
            phone_id: this.phoneId,
            fb_anon_id: this.fbAnonId,
            waterfall_id: this.waterfallId,
            machine_id: this.machineId,
            cloud_trust_token: this.cloudTrustToken,
            marketing_name: this.device.name,
            ram_bytes: this.device.ramBytes,
            ios_version: this.device.iosVersion,
            ios_build: this.device.iosBuild,
          },
          profile: {
            doc_id_app: CLIENT_DOC_ID_APP,
            doc_id_action: CLIENT_DOC_ID_ACTION,
            bk_context_json: JSON.stringify(BK_CONTEXT),
            query_hashes: [],
            document_ids: [],
            capabilities: PINNED_IG_CAPABILITIES,
          },
        },
        session_state: {
          avatar: "",
          contact_type: this.config.method === "email" ? "email" : "phone",
          fbid: this.igUserId || String(dsUid),
          routing: {
            ig_u_rur: this.rur,
            ig_u_region: this.region,
            ig_u_ds_user_id: String(dsUid),
            www_claim: this.claim,
          },
          transport_profile: {
            connection_type: this.connection.type,
            bandwidth_type: this.connection.ig_connection_type,
            bandwidth_estimate: this.connection.ig_bandwidth_speed_kbps,
          },
          two_factor: {
            enabled: false,
            totp_seed: "",
          },
        },
        auth: {
          authorization_bearer: this.bearer,
          sessionid: this.sessionid,
          csrftoken: this.csrf,
        },
        password_encryption: {
          key_id: this.passwordKey?.keyId ?? 0,
          public_key_b64: this.passwordKey?.publicKeyRaw || "",
        },
        totp: {
          seed: "",
          otpauth_uri: "",
          enabled: false,
        },
      },
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
