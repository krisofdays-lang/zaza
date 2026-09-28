import type { InstagramClient } from "./client"
import { NAV } from "./nav-chain"

// ---------------------------------------------------------------------------
// Reel-publish "warmup" / background traffic — full iOS 436 gallery-reel capture.
//
// The captured gallery-reel publish (dumps 1–37) is NOT just upload + configure.
// As the composer opens from the profile, the app fires a large batch of read /
// settings / eligibility GraphQL queries and REST calls; more fire once media is
// chosen (clips gallery) and again when the share sheet loads; a couple more run
// after the publish. Replaying this whole set makes our session look like a human
// walking the real composer UI instead of a bot that jumps straight to rupload.
//
// EVERY request here is BEST-EFFORT. In the capture they are all marked
// is_nav_critical:0 and one even returns a server error while the post still
// succeeds, so a warmup failure must NEVER abort the publish.
//
// friendly-names / client_doc_ids / paths / root fields / variables are copied
// verbatim from the 436 dumps (dump number noted on each call). doc_ids are a
// hash of the GraphQL document, NOT the app build, so 436-captured ids replay
// safely under our pinned 437 identity; best-effort covers the rare changed one.
// The wire identity (UA 437 / bloks / app-id / device) is applied by the client.
// ---------------------------------------------------------------------------

const GRAPHQL_WWW = "/graphql_www"
const SHARE_TO_FB_CONFIG_PATH = "/api/v1/clips/user/share_to_fb_config/"
const CLIPS_INFO_FOR_CREATION_PATH = "/api/v1/clips/clips_info_for_creation/"
const REEL_SETTINGS_PATH = "/api/v1/users/reel_settings/"

// client_doc_ids captured from the 436 gallery-reel publish (dump # in comment).
const DOC = {
  reelsCrosspostToBarcelona: "207786988113320450381559163170", // dump 3
  xPostingPlatform: "101624613815074854505754822373", // dump 4
  maiHasMemuProfile: "2208694732390068729696755600", // dump 5
  nativeMLModel: "307419864912720217557072942346", // dump 6
  syncCxpNoticeState: "140880976316358297941391264993", // dumps 7,8
  arEffectCategories: "336239785818098468688421154086", // dump 12
  maiIntentCardUserStatus: "252071183814386664577405153", // dumps 14,19
  fetchCxpNotices: "174085091372136269092400774", // dump 15
  effectCollection: "224196792815911226538321412785", // dump 16 (inner client_doc_id)
  baselOnboardedBffs: "324948423116457329790692969758", // dump 18
  metaOneBenefitEligibility: "2034366677506747789819884183", // dump 21
  contentSchedulingNumPerDay: "33435866111151451256832221765", // dump 22
  nmeBenefitContextualPromo: "379440767916048031918269411675", // dump 24
  quickPromotionSurface: "27705028106129154052253015677", // dump 25
  setOaReuseOnFbNuxSeen: "4861763783074325983277867483", // dump 28
  setOriginalAudioReuseMetaAi: "4571083028164163781608343319", // dump 30
  bloksHypercard: "25336029836376690054300182513", // dump 32
  surveyIntegrationPoint: "11860379015204710912215093743", // dump 33
  searchBatchedCddEligibility: "423544407213216292451739749153", // dump 36
} as const

// The 17 crosspost notice variants the app syncs (dump 7/8), each impression 0.
const CXP_NOTICE_VARIANTS = [
  "BOTTOMSHEET_DUAL_DESTPICKER_STORIES",
  "BOTTOMSHEET_FEED",
  "BOTTOMSHEET_MIGRATION_FEED_WAVE2",
  "BOTTOMSHEET_MIGRATION_STORIES_WAVE2",
  "BOTTOMSHEET_PANAVISION_DISCLOSURE",
  "BOTTOMSHEET_STORY",
  "BOTTOMSHEET_UNLINKED_USER_FEED",
  "DIALOG_3_OPTION_STORY",
  "DIALOG_AUTO_OFF_ONE_TIME_SHARE_ON_STORY",
  "DIALOG_AUTO_ON_ONE_TIME_SHARE_OFF_STORY",
  "DIALOG_3_OPTION_TURN_OFF_STORY",
  "DIALOG_STORY",
  "DIALOG_STORY_SHARE_SHEET_ACCOUNT_LINKING",
  "ROWSHARE_SINGLE_FEED",
  "ROWSHARE_SINGLE_STORY",
  "TOOLTIP_CURRENTLY_SHARING_FEED",
  "TOOLTIP_SHORTCUT_DESTINATION_PICKER_STORIES",
]

const SETTINGS_LEGACY_FORM = {
  ig_legacy_dict_validate_null: "true",
  ig_legacy_eager_dict_validate_null: "true",
}

// Per-account UUID — warmup functions receive the client, so we use its PRNG.
function upperUuid(c: InstagramClient): string {
  return c.accountUuid().toUpperCase()
}

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.log(`[v0] reel warmup ${label} skipped:`, err instanceof Error ? err.message : String(err))
  }
}

// A pando GraphQL query on /graphql_www (the majority of the filler traffic).
function pando(
  c: InstagramClient,
  friendlyName: string,
  docId: string,
  variables: Record<string, unknown>,
  rootFieldName: string,
): Promise<unknown> {
  return c.graphql(friendlyName, docId, variables, {}, { path: GRAPHQL_WWW, rootFieldName, pando: true })
}

// ---------------------------------------------------------------------------
// Phase A — composer opened from the profile (dumps 3,4).
// x-ig-client-endpoint: IGProfileViewController:self_profile.
// ---------------------------------------------------------------------------
export async function warmupComposerOpen(c: InstagramClient): Promise<void> {
  c.nav.visit(NAV.SELF_PROFILE)

  // dump 3 — Threads/Barcelona crosspost setting for reels.
  await safe("ReelsCrosspostToBarcelonaSettingsQuery", () =>
    pando(c, "ReelsCrosspostToBarcelonaSettingsQuery", DOC.reelsCrosspostToBarcelona, {}, "me"),
  )

  // dump 4 — unified crossposting configs (IG→FB reels).
  await safe("XPostingPlatform_iOS", () =>
    pando(
      c,
      "XPostingPlatform_iOS",
      DOC.xPostingPlatform,
      {
        configs_request: {
          source_app: "IG",
          crosspost_app_surface_list: [
            {
              destination_app: "FB",
              cross_app_share_type: "CROSSPOST",
              source_surface: "REELS",
              destination_surface: "REELS",
            },
          ],
        },
      },
      "xcxp_unified_crossposting_configs_root",
    ),
  )
}

// ---------------------------------------------------------------------------
// Phase B — media chosen, app in the clips gallery / post-capture (dumps 5–20).
// The heaviest batch: profile/model prefetch, notice sync, effect + sticker +
// audio browsers, intent cards, onboarded BFFs, reel settings.
// ---------------------------------------------------------------------------
export async function warmupMediaChosen(c: InstagramClient): Promise<void> {
  c.nav.visit(NAV.REEL_GALLERY_EDIT)

  // dump 5 — Meta AI (memu) profile presence.
  await safe("MAIHasMemuProfile", () =>
    pando(
      c,
      "MAIHasMemuProfile",
      DOC.maiHasMemuProfile,
      { user_id: "", include_has_featured_media: false, include_profile_pic_onboarding_eligible: false },
      "xfb_has_memu_profile",
    ),
  )

  // dump 6 — on-device ML model manifest (SceneUnderstanding).
  await safe("NativeMLModelQuery", () =>
    pando(
      c,
      "NativeMLModelQuery",
      DOC.nativeMLModel,
      {
        model_request_metadata: { version: 50030, name: "SceneUnderstanding" },
        client_capability_metadata: { cachedModelMetadatas: [], bytecodeVersion: [4, 8] },
      },
      "aim_model_manifest",
    ),
  )

  // dumps 7 & 8 — crosspost notice-state sync (fired twice in the capture).
  const noticeVars = {
    client_states: CXP_NOTICE_VARIANTS.map((variant) => ({ impression_count: 0, variant, sequence_number: 0 })),
  }
  await safe("SyncCXPNoticeStateMutation#1", () =>
    pando(c, "SyncCXPNoticeStateMutation", DOC.syncCxpNoticeState, noticeVars, "xcxp_sync_notice_state"),
  )
  await safe("SyncCXPNoticeStateMutation#2", () =>
    pando(c, "SyncCXPNoticeStateMutation", DOC.syncCxpNoticeState, noticeVars, "xcxp_sync_notice_state"),
  )

  // dump 9 — profile info stream (signed) fired when the gallery opens.
  await safe("info_stream", () =>
    c.post(`/api/v1/users/${c.uid}/info_stream/`, { _uuid: c.uuid, device_id: c.uuid, _uid: c.uid }, "info_stream"),
  )

  // dump 10 — clips creation config (trial / auto-reshare / voice translation).
  await safe("clips_info_for_creation", () => c.get(CLIPS_INFO_FOR_CREATION_PATH, CLIPS_INFO_FOR_CREATION_PATH))

  // dump 11 — share-to-FB config.
  await safe("share_to_fb_config", () => c.get(SHARE_TO_FB_CONFIG_PATH, SHARE_TO_FB_CONFIG_PATH))

  // dump 12 — AR effect discovery categories (minimal GraphQL).
  await safe("ar_effect_categories", () =>
    c.graphql(
      "api",
      DOC.arEffectCategories,
      { product: "REELS_POSTCAPTURE", include_flm_effects: true },
      {},
      { path: "/graphql/query" },
    ),
  )

  // dump 13 — clips music/audio browser.
  await safe("clips_audio_browser", () =>
    c.post(
      "/api/v1/music/clips_audio_browser/",
      {
        _uuid: c.uuid,
        product: "story_camera_clips_v2",
        browse_session_id: upperUuid(c),
        media_type: "video",
      },
      "music/clips_audio_browser/",
    ),
  )

  // dump 14 — AI creative-tools intent card status.
  await safe("MAIIntentCardUserStatusQuery#stories", () =>
    pando(
      c,
      "MAIIntentCardUserStatusQuery",
      DOC.maiIntentCardUserStatus,
      { intent_card_type: "IG_STORIES_AI_CREATIVE_TOOLS" },
      "strong_id__",
    ),
  )

  // dump 15 — crosspost notices for the composer entrypoints.
  await safe("FetchCXPNoticesQuery", () =>
    pando(
      c,
      "FetchCXPNoticesQuery",
      DOC.fetchCxpNotices,
      {
        metadata: { is_content_reshare: "false", client_session_id: upperUuid(c) },
        entrypoints: [
          "IG_REELS_PANAVISION_COMPOSER",
          "IG_REELS_PANAVISION_COMPOSER_SHARE_BUTTON",
          "IG_REELS_COMPOSER_SHARE_TO_THREADS",
        ],
      },
      "xcxp_fetch_notice_user",
    ),
  )

  // dump 16 — effect collection (saved effects tray). Signed body carries an
  // inner client_doc_id + a JSON query_params string exactly like the app.
  await safe("effect_collection_api", () => {
    const queryParams = JSON.stringify({
      include_avatar_transparent_url: 0,
      device_key: "MSL122111202",
      include_preview_image: false,
      preview_height: 432,
      product: "REELS_POSTCAPTURE",
      device_capabilities: {
        texture_compression: "PVR",
        are_capability_list_id: "2253588538496660",
        supported_sdk_versions: { min_version: "149", max_version: "202" },
        supported_beta_sdk_versions: { min_version: "182", max_version: "202" },
        manifest_capabilities: ["worldTracker", "bodyTracking", "bodytracking3d", "deviceMotion", "hairSegmentation"],
      },
      include_avatar_sdk_preset_glb_url: false,
      device_type: c.deviceType,
      is_ads_mode: false,
      include_avatar_type: false,
      product_category_identifier: "SAVED",
      include_flm_effects: true,
      preview_width: 186,
      supported_compression_types: ["ZIP", "TAR_BROTLI", "TAR_LZMA2"],
    })
    return c.post(
      "/api/v1/creatives/effect_collection_api/",
      { _uuid: c.uuid, _uid: c.uid, client_doc_id: DOC.effectCollection, query_params: queryParams },
      "/creatives/effect_collection_api/",
    )
  })

  // dump 17 — static sticker tray for the clips composer.
  await safe("sticker_tray", () =>
    c.post(
      "/api/v1/creatives/sticker_tray/",
      {
        _uuid: c.uuid,
        camera_entry_point: "71",
        _uid: c.uid,
        type: "static_stickers",
        sticker_tray_surface: "CLIPS",
        is_ads_mode: "false",
      },
      "/creatives/sticker_tray/",
    ),
  )

  // dump 18 — Basel (app-install) onboarded BFFs.
  await safe("BaselAppInstallOnboardedBFFsQueryQuery", () =>
    pando(
      c,
      "BaselAppInstallOnboardedBFFsQueryQuery",
      DOC.baselOnboardedBffs,
      { variant: "DEFAULT" },
      "xig_basel_fetch_onboarded_bffs",
    ),
  )

  // dump 19 — edit-with-AI intent card status.
  await safe("MAIIntentCardUserStatusQuery#editWithAi", () =>
    pando(
      c,
      "MAIIntentCardUserStatusQuery",
      DOC.maiIntentCardUserStatus,
      { intent_card_type: "EDIT_WITH_AI" },
      "strong_id__",
    ),
  )

  // dump 20 — reel settings.
  await safe("reel_settings", () => c.get(REEL_SETTINGS_PATH, "/users/reel_settings/"))
}

// ---------------------------------------------------------------------------
// Phase C — share sheet loaded, just before configure (dumps 21–33).
// Benefit eligibility, scheduling, fundraiser, promo configs, quick-promotion,
// OA-reuse NUX writes, bloks hypercard, survey.
// ---------------------------------------------------------------------------
export async function warmupShareSheet(c: InstagramClient): Promise<void> {
  c.nav.visit(NAV.REEL_GALLERY_SHARE)

  // dump 21 — Meta One benefit eligibility (links in reels).
  await safe("IGMetaOneBenefitEligibilityQuery", () =>
    pando(
      c,
      "IGMetaOneBenefitEligibilityQuery",
      DOC.metaOneBenefitEligibility,
      { benefitType: "BIZ_LINKS_IN_REELS", pacing_key: "IG_LINKS_IN_REELS_META_SUBS_PERMANENT_UPSELL" },
      "ig_meta_one_benefit_eligibility_query",
    ),
  )

  // dump 22 — content scheduling: number already scheduled per day.
  await safe("IGContentSchedulingNativeScheduledNumPerDayQuery", () =>
    pando(
      c,
      "IGContentSchedulingNativeScheduledNumPerDayQuery",
      DOC.contentSchedulingNumPerDay,
      { user_id: c.uid },
      "xig_fetch_user",
    ),
  )

  // dump 23 — active standalone fundraisers for the user.
  await safe("active_standalone_fundraisers", () =>
    c.get(
      `/api/v1/fundraiser/${c.uid}/active_standalone_fundraisers/`,
      "fundraiser/%@/active_standalone_fundraisers/",
    ),
  )

  // dump 24 — NME benefit contextual promo configs for the reels publish page.
  await safe("IGNMEBenefitContextualPromoConfigsQuery", () =>
    pando(
      c,
      "IGNMEBenefitContextualPromoConfigsQuery",
      DOC.nmeBenefitContextualPromo,
      { input: { surface: "IG_REELS_PUBLISH_PAGE" } },
      "ig_nme_benefit_contextual_promo_ui_configs_query",
    ),
  )

  // dump 25 — quick-promotion surface (share-sheet tooltips).
  await safe("QuickPromotionSurfaceQuery", () =>
    pando(
      c,
      "QuickPromotionSurfaceQuery",
      DOC.quickPromotionSurface,
      {
        trigger_context: { context_data_tuples: [] },
        surface_triggers: [
          {
            triggers: ["instagram_clips_creation_share_sheet_loaded"],
            surface_id: "INSTAGRAM_FOR_IOS_TOOLTIP_QP",
          },
        ],
      },
      "ig_quick_promotion_batch_fetch_root",
    ),
  )

  // dump 28 — mark the OA-reuse-on-FB NUX as seen (graphql/query mutation).
  await safe("SetOAReuseOnFBNuxSeenRequest", () =>
    c.graphql(
      "SetOAReuseOnFBNuxSeenRequest",
      DOC.setOaReuseOnFbNuxSeen,
      { data: { oa_reuse_on_fb_nux_seen: true } },
      SETTINGS_LEGACY_FORM,
      { path: "/graphql/query", rootFieldName: "xdt_set_oa_reuse_on_fb_nux_seen", pando: true },
    ),
  )

  // dump 30 — share original audio to Meta AI setting.
  await safe("IGSetOriginalAudioReuseOnMetaAiSettings", () =>
    pando(
      c,
      "IGSetOriginalAudioReuseOnMetaAiSettings",
      DOC.setOriginalAudioReuseMetaAi,
      { params: { share_original_audio_to_meta_ai: true } },
      "xfb_genai_set_share_ig_original_audio_to_meta_ai_settings",
    ),
  )

  // dump 31 — self-profile info stream refresh (entry_point self_profile).
  await safe("info_stream#self_profile", () =>
    c.post(
      `/api/v1/users/${c.uid}/info_stream/`,
      {
        is_profile_prefetch: "false",
        _uuid: c.uuid,
        entry_point: "self_profile",
        device_id: c.uuid,
        _uid: c.uid,
      },
      "info_stream",
    ),
  )

  // dump 32 — Bloks pro-dash hypercard entry point.
  await safe("IGBloksAppRootQuery-hypercard", () =>
    c.graphql(
      "IGBloksAppRootQuery-com.bloks.www.ig.pro_dash.entry_point.hypercard",
      DOC.bloksHypercard,
      {
        bk_context: {
          pixel_ratio: 3,
          styles_id: "instagram",
          theme_params: [{ design_system_name: "XMDS", value: ["three_neutral_gray"] }],
        },
        params: {},
      },
      { purpose: "fetch" },
      { path: GRAPHQL_WWW, rootFieldName: "bloks_app", pando: true },
    ),
  )

  // dump 33 — survey integration point for the publish page.
  await safe("IGSurveyIntegrationPointQuery", () =>
    pando(
      c,
      "IGSurveyIntegrationPointQuery",
      DOC.surveyIntegrationPoint,
      {
        integration_point_id: "206672463421539",
        survey_context_data: [{ context_value: c.uid, context_key: "ig_user_id" }],
      },
      "survey_integration_point",
    ),
  )
}

// ---------------------------------------------------------------------------
// Post-publish — the app tabs back to the feed and runs a couple of follow-up
// calls (dumps 36,37). Both need the freshly-published reel's media id, so they
// only fire when configure returned one. Best-effort, never affects the publish.
// ---------------------------------------------------------------------------
export async function postPublish(c: InstagramClient, mediaId?: string): Promise<void> {
  c.nav.visit(NAV.FEED)
  if (!mediaId) return

  // dump 36 — Meta AI content-deep-dive eligibility for the new media.
  await safe("IGSearchBatchedCDDEligibilityAndPromptsFetchQuery", () =>
    c.graphql(
      "IGSearchBatchedCDDEligibilityAndPromptsFetchQuery",
      DOC.searchBatchedCddEligibility,
      {
        container_module: "feed_timeline",
        generate_tier2_prompts: false,
        caller_enum: 10,
        media_list: [{ media_id: mediaId }],
      },
      SETTINGS_LEGACY_FORM,
      { path: "/graphql/query", rootFieldName: "xdt_media__meta_ai_content_deep_dive_responses", pando: true },
    ),
  )

  // dump 37 — invalidate privacy-violating media cache for the new media id.
  await safe("invalidate_privacy_violating_media_v2", () =>
    c.post(
      "/api/v1/feed/invalidate_privacy_violating_media_v2/",
      {
        _uuid: c.uuid,
        media_ids_item_types: JSON.stringify([{ item_type: "media", media_id: mediaId }]),
        _uid: c.uid,
      },
      "/feed/invalidate_privacy_violating_media_v2/",
    ),
  )
}
