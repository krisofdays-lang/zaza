"""Reel-publish warmup / background traffic — full iOS gallery-reel capture.

Byte-for-byte port of lib/instagram/reel-warmup.ts. The captured gallery-reel
publish is NOT just upload + configure: as the composer opens the app fires a
large batch of read / settings / eligibility GraphQL + REST calls; more fire
once media is chosen and again when the share sheet loads; a couple run after
publish. Replaying this whole set makes the session look like a human walking
the composer UI instead of a bot that jumps straight to rupload.

EVERY request here is BEST-EFFORT (is_nav_critical:0 in the capture — one even
returns a server error while the post still succeeds). A warmup failure must
NEVER abort the publish.

friendly-names / client_doc_ids / paths / root fields / variables are copied
verbatim from the 436 dumps (dump # noted on each call). doc_ids hash the
GraphQL document, not the app build, so 436-captured ids replay safely under
the pinned 437 identity.
"""

from __future__ import annotations

import json
import logging
import uuid as uuidlib

from .client import InstagramClient

log = logging.getLogger("ig.warmup")

GRAPHQL_WWW = "/graphql_www"
SHARE_TO_FB_CONFIG_PATH = "/api/v1/clips/user/share_to_fb_config/"
CLIPS_INFO_FOR_CREATION_PATH = "/api/v1/clips/clips_info_for_creation/"
REEL_SETTINGS_PATH = "/api/v1/users/reel_settings/"

# client_doc_ids captured from the 436 gallery-reel publish (dump # in comment).
DOC = {
    "reels_crosspost_to_barcelona": "207786988113320450381559163170",  # dump 3
    "x_posting_platform": "101624613815074854505754822373",  # dump 4
    "mai_has_memu_profile": "2208694732390068729696755600",  # dump 5
    "native_ml_model": "307419864912720217557072942346",  # dump 6
    "sync_cxp_notice_state": "140880976316358297941391264993",  # dumps 7,8
    "ar_effect_categories": "336239785818098468688421154086",  # dump 12
    "mai_intent_card_user_status": "252071183814386664577405153",  # dumps 14,19
    "fetch_cxp_notices": "174085091372136269092400774",  # dump 15
    "effect_collection": "224196792815911226538321412785",  # dump 16 (inner)
    "basel_onboarded_bffs": "324948423116457329790692969758",  # dump 18
    "meta_one_benefit_eligibility": "2034366677506747789819884183",  # dump 21
    "content_scheduling_num_per_day": "33435866111151451256832221765",  # dump 22
    "nme_benefit_contextual_promo": "379440767916048031918269411675",  # dump 24
    "quick_promotion_surface": "27705028106129154052253015677",  # dump 25
    "set_oa_reuse_on_fb_nux_seen": "4861763783074325983277867483",  # dump 28
    "set_original_audio_reuse_meta_ai": "4571083028164163781608343319",  # dump 30
    "bloks_hypercard": "25336029836376690054300182513",  # dump 32
    "survey_integration_point": "11860379015204710912215093743",  # dump 33
    "search_batched_cdd_eligibility": "423544407213216292451739749153",  # dump 36
}

# The 17 crosspost notice variants the app syncs (dump 7/8), each impression 0.
CXP_NOTICE_VARIANTS = [
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

SETTINGS_LEGACY_FORM = {
    "ig_legacy_dict_validate_null": "true",
    "ig_legacy_eager_dict_validate_null": "true",
}


def _upper_uuid() -> str:
    return str(uuidlib.uuid4()).upper()


def _safe(label: str, fn) -> None:
    try:
        fn()
    except Exception as err:  # noqa: BLE001
        log.debug("reel warmup %s skipped: %s", label, err)


def _pando(c: InstagramClient, friendly_name: str, doc_id: str, variables: dict, root_field_name: str):
    return c.graphql(friendly_name, doc_id, variables, {}, path=GRAPHQL_WWW,
                     root_field_name=root_field_name, pando=True)


# --- Phase A — composer opened from the profile (dumps 3,4) -----------------
def warmup_composer_open(c: InstagramClient) -> None:
    c.nav_override.enter("profile")

    _safe("ReelsCrosspostToBarcelonaSettingsQuery", lambda: _pando(
        c, "ReelsCrosspostToBarcelonaSettingsQuery", DOC["reels_crosspost_to_barcelona"], {}, "me"))

    _safe("XPostingPlatform_iOS", lambda: _pando(
        c, "XPostingPlatform_iOS", DOC["x_posting_platform"],
        {
            "configs_request": {
                "source_app": "IG",
                "crosspost_app_surface_list": [
                    {
                        "destination_app": "FB",
                        "cross_app_share_type": "CROSSPOST",
                        "source_surface": "REELS",
                        "destination_surface": "REELS",
                    }
                ],
            }
        },
        "xcxp_unified_crossposting_configs_root"))


# --- Phase B — media chosen, clips gallery / post-capture (dumps 5–20) ------
def warmup_media_chosen(c: InstagramClient) -> None:
    # Reqs 5-16 fire from the clips gallery (endpoint clips_gallery).
    c.nav_override.enter("gallery")

    _safe("MAIHasMemuProfile", lambda: _pando(
        c, "MAIHasMemuProfile", DOC["mai_has_memu_profile"],
        {"user_id": "", "include_has_featured_media": False,
         "include_profile_pic_onboarding_eligible": False},
        "xfb_has_memu_profile"))

    _safe("NativeMLModelQuery", lambda: _pando(
        c, "NativeMLModelQuery", DOC["native_ml_model"],
        {
            "model_request_metadata": {"version": 50030, "name": "SceneUnderstanding"},
            "client_capability_metadata": {"cachedModelMetadatas": [], "bytecodeVersion": [4, 8]},
        },
        "aim_model_manifest"))

    notice_vars = {
        "client_states": [
            {"impression_count": 0, "variant": v, "sequence_number": 0} for v in CXP_NOTICE_VARIANTS
        ]
    }
    _safe("SyncCXPNoticeStateMutation#1", lambda: _pando(
        c, "SyncCXPNoticeStateMutation", DOC["sync_cxp_notice_state"], notice_vars, "xcxp_sync_notice_state"))
    _safe("SyncCXPNoticeStateMutation#2", lambda: _pando(
        c, "SyncCXPNoticeStateMutation", DOC["sync_cxp_notice_state"], notice_vars, "xcxp_sync_notice_state"))

    _safe("info_stream", lambda: c.post(
        f"/api/v1/users/{c.uid}/info_stream/",
        {"_uuid": c.uuid, "device_id": c.uuid, "_uid": c.uid}, "info_stream"))

    _safe("clips_info_for_creation", lambda: c.get(CLIPS_INFO_FOR_CREATION_PATH, CLIPS_INFO_FOR_CREATION_PATH))
    _safe("share_to_fb_config", lambda: c.get(SHARE_TO_FB_CONFIG_PATH, SHARE_TO_FB_CONFIG_PATH))

    _safe("ar_effect_categories", lambda: c.graphql(
        "api", DOC["ar_effect_categories"],
        {"product": "REELS_POSTCAPTURE", "include_flm_effects": True}, {},
        path="/graphql/query"))

    _safe("clips_audio_browser", lambda: c.post(
        "/api/v1/music/clips_audio_browser/",
        {"_uuid": c.uuid, "product": "story_camera_clips_v2",
         "browse_session_id": _upper_uuid(), "media_type": "video"},
        "music/clips_audio_browser/"))

    _safe("MAIIntentCardUserStatusQuery#stories", lambda: _pando(
        c, "MAIIntentCardUserStatusQuery", DOC["mai_intent_card_user_status"],
        {"intent_card_type": "IG_STORIES_AI_CREATIVE_TOOLS"}, "strong_id__"))

    _safe("FetchCXPNoticesQuery", lambda: _pando(
        c, "FetchCXPNoticesQuery", DOC["fetch_cxp_notices"],
        {
            "metadata": {"is_content_reshare": "false", "client_session_id": _upper_uuid()},
            "entrypoints": [
                "IG_REELS_PANAVISION_COMPOSER",
                "IG_REELS_PANAVISION_COMPOSER_SHARE_BUTTON",
                "IG_REELS_COMPOSER_SHARE_TO_THREADS",
            ],
        },
        "xcxp_fetch_notice_user"))

    def _effect_collection():
        query_params = json.dumps({
            "include_avatar_transparent_url": 0,
            "device_key": "MSL122111202",
            "include_preview_image": False,
            "preview_height": 432,
            "product": "REELS_POSTCAPTURE",
            "device_capabilities": {
                "texture_compression": "PVR",
                "are_capability_list_id": "2253588538496660",
                "supported_sdk_versions": {"min_version": "149", "max_version": "202"},
                "supported_beta_sdk_versions": {"min_version": "182", "max_version": "202"},
                "manifest_capabilities": ["worldTracker", "bodyTracking", "bodytracking3d",
                                          "deviceMotion", "hairSegmentation"],
            },
            "include_avatar_sdk_preset_glb_url": False,
            "device_type": c.device_type,
            "is_ads_mode": False,
            "include_avatar_type": False,
            "product_category_identifier": "SAVED",
            "include_flm_effects": True,
            "preview_width": 186,
            "supported_compression_types": ["ZIP", "TAR_BROTLI", "TAR_LZMA2"],
        }, separators=(",", ":"))
        return c.post(
            "/api/v1/creatives/effect_collection_api/",
            {"_uuid": c.uuid, "_uid": c.uid,
             "client_doc_id": DOC["effect_collection"], "query_params": query_params},
            "/creatives/effect_collection_api/")
    _safe("effect_collection_api", _effect_collection)

    # Req 17-19: entering the post-capture editor makes screens 6 & 7
    # (reel_multiedit_composer, clips_postcapture_camera) briefly FLICKER onto
    # the chain before being popped. The capture shows this only for this burst.
    c.nav_override.enter("edit_flicker")

    _safe("sticker_tray", lambda: c.post(
        "/api/v1/creatives/sticker_tray/",
        {"_uuid": c.uuid, "camera_entry_point": "71", "_uid": c.uid, "type": "static_stickers",
         "sticker_tray_surface": "CLIPS", "is_ads_mode": "false"},
        "/creatives/sticker_tray/"))

    _safe("BaselAppInstallOnboardedBFFsQueryQuery", lambda: _pando(
        c, "BaselAppInstallOnboardedBFFsQueryQuery", DOC["basel_onboarded_bffs"],
        {"variant": "DEFAULT"}, "xig_basel_fetch_onboarded_bffs"))

    _safe("MAIIntentCardUserStatusQuery#editWithAi", lambda: _pando(
        c, "MAIIntentCardUserStatusQuery", DOC["mai_intent_card_user_status"],
        {"intent_card_type": "EDIT_WITH_AI"}, "strong_id__"))

    # Req 20+: the flicker screens are popped; the editor settles on screen 5.
    c.nav_override.enter("edit")

    _safe("reel_settings", lambda: c.get(REEL_SETTINGS_PATH, "/users/reel_settings/"))


# --- Phase C1 — share-intent probes, still on the editor (dumps 21–25) -------
def warmup_share_eligibility(c: InstagramClient) -> None:
    # Reqs 21-25 fire from the post-capture editor (screen 5); the eligibility /
    # promo / scheduling probes run while the user is deciding to share. These
    # precede the video upload, so they run before upload_settings in the flow.
    c.nav_override.enter("edit")

    _safe("IGMetaOneBenefitEligibilityQuery", lambda: _pando(
        c, "IGMetaOneBenefitEligibilityQuery", DOC["meta_one_benefit_eligibility"],
        {"benefitType": "BIZ_LINKS_IN_REELS",
         "pacing_key": "IG_LINKS_IN_REELS_META_SUBS_PERMANENT_UPSELL"},
        "ig_meta_one_benefit_eligibility_query"))

    _safe("IGContentSchedulingNativeScheduledNumPerDayQuery", lambda: _pando(
        c, "IGContentSchedulingNativeScheduledNumPerDayQuery", DOC["content_scheduling_num_per_day"],
        {"user_id": c.uid}, "xig_fetch_user"))

    _safe("active_standalone_fundraisers", lambda: c.get(
        f"/api/v1/fundraiser/{c.uid}/active_standalone_fundraisers/",
        "fundraiser/%@/active_standalone_fundraisers/"))

    _safe("IGNMEBenefitContextualPromoConfigsQuery", lambda: _pando(
        c, "IGNMEBenefitContextualPromoConfigsQuery", DOC["nme_benefit_contextual_promo"],
        {"input": {"surface": "IG_REELS_PUBLISH_PAGE"}},
        "ig_nme_benefit_contextual_promo_ui_configs_query"))

    _safe("QuickPromotionSurfaceQuery", lambda: _pando(
        c, "QuickPromotionSurfaceQuery", DOC["quick_promotion_surface"],
        {
            "trigger_context": {"context_data_tuples": []},
            "surface_triggers": [
                {"triggers": ["instagram_clips_creation_share_sheet_loaded"],
                 "surface_id": "INSTAGRAM_FOR_IOS_TOOLTIP_QP"}
            ],
        },
        "ig_quick_promotion_batch_fetch_root"))


# --- Phase C2 — share sheet presented, after upload (dumps 28–33) -----------
def warmup_share_sheet_present(c: InstagramClient) -> None:
    # Req 28+: the share sheet is now presented. Screens 8-11 (clips_share_sheet,
    # ShareSheetV2, ig_publish_screen_caption, sundial-share-sheet NUX) push on;
    # endpoint becomes sundial-share-sheet. This is the chain's 7-segment peak.
    c.nav_override.enter("share")

    _safe("SetOAReuseOnFBNuxSeenRequest", lambda: c.graphql(
        "SetOAReuseOnFBNuxSeenRequest", DOC["set_oa_reuse_on_fb_nux_seen"],
        {"data": {"oa_reuse_on_fb_nux_seen": True}}, SETTINGS_LEGACY_FORM,
        path="/graphql/query", root_field_name="xdt_set_oa_reuse_on_fb_nux_seen", pando=True))

    _safe("IGSetOriginalAudioReuseOnMetaAiSettings", lambda: _pando(
        c, "IGSetOriginalAudioReuseOnMetaAiSettings", DOC["set_original_audio_reuse_meta_ai"],
        {"params": {"share_original_audio_to_meta_ai": True}},
        "xfb_genai_set_share_ig_original_audio_to_meta_ai_settings"))

    _safe("info_stream#self_profile", lambda: c.post(
        f"/api/v1/users/{c.uid}/info_stream/",
        {"is_profile_prefetch": "false", "_uuid": c.uuid, "entry_point": "self_profile",
         "device_id": c.uuid, "_uid": c.uid},
        "info_stream"))

    _safe("IGBloksAppRootQuery-hypercard", lambda: c.graphql(
        "IGBloksAppRootQuery-com.bloks.www.ig.pro_dash.entry_point.hypercard",
        DOC["bloks_hypercard"],
        {
            "bk_context": {
                "pixel_ratio": 3,
                "styles_id": "instagram",
                "theme_params": [{"design_system_name": "XMDS", "value": ["three_neutral_gray"]}],
            },
            "params": {},
        },
        {"purpose": "fetch"},
        path=GRAPHQL_WWW, root_field_name="bloks_app", pando=True))

    # Req 33: the share sheet is dismissed and the app returns to the profile
    # before configure fires -> IGSurveyIntegrationPointQuery carries self_profile:2.
    c.nav_override.enter("back_to_profile")

    _safe("IGSurveyIntegrationPointQuery", lambda: _pando(
        c, "IGSurveyIntegrationPointQuery", DOC["survey_integration_point"],
        {
            "integration_point_id": "206672463421539",
            "survey_context_data": [{"context_value": c.uid, "context_key": "ig_user_id"}],
        },
        "survey_integration_point"))


# --- Post-publish — feed follow-ups keyed off the new media id (dumps 36,37) -
def post_publish(c: InstagramClient, media_id: str | None) -> None:
    # After configure the app sits on the cold-started feed: reqs 36-37 carry the
    # same feed_timeline:1:cold_start header as configure (the "configure" stage).
    c.nav_override.enter("configure")
    if not media_id:
        return

    _safe("IGSearchBatchedCDDEligibilityAndPromptsFetchQuery", lambda: c.graphql(
        "IGSearchBatchedCDDEligibilityAndPromptsFetchQuery", DOC["search_batched_cdd_eligibility"],
        {
            "container_module": "feed_timeline",
            "generate_tier2_prompts": False,
            "caller_enum": 10,
            "media_list": [{"media_id": media_id}],
        },
        SETTINGS_LEGACY_FORM,
        path="/graphql/query",
        root_field_name="xdt_media__meta_ai_content_deep_dive_responses", pando=True))

    _safe("invalidate_privacy_violating_media_v2", lambda: c.post(
        "/api/v1/feed/invalidate_privacy_violating_media_v2/",
        {"_uuid": c.uuid,
         "media_ids_item_types": json.dumps([{"item_type": "media", "media_id": media_id}], separators=(",", ":")),
         "_uid": c.uid},
        "/feed/invalidate_privacy_violating_media_v2/"))
