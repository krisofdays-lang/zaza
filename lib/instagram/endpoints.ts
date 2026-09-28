import { InstagramClient } from "./client"
import { NAV, actionChain } from "./nav-chain"

// Doc ids captured from the live mobile app GraphQL queries.
const DOC_ID_PROFILE_TIMELINE = "56030350817523507465335489036"
const DOC_ID_CLIPS_PROFILE = "173237147512041978966513271921"

/** Per-account UUID using the client's isolated PRNG. */
function genUuid(c: InstagramClient): string {
  return c.accountUuid().toUpperCase()
}

/** Per-account random float using the client's isolated PRNG. */
function rnd(c: InstagramClient, min: number, max: number): number {
  return min + c.accountRandom() * (max - min)
}

// The real iOS app attaches camera EXIF to `additional_exif_data` on photo
// configure (verified against captured traffic). Sending an Apple-style device
// object is NOT what iOS does — iOS uses a top-level `device_id` (the UUID) plus
// this EXIF block. We generate plausible per-post camera settings so each publish
// carries a unique-but-realistic fingerprint instead of the Android `device`
// dict (android_version/android_release) that contradicts the iOS user-agent.
function iosExifData(c: InstagramClient) {
  return {
    camera_settings: {
      focal_length: Number(rnd(c, 4.2, 6.9).toFixed(13)),
      aperture: Number(rnd(c, 1.5, 2.4).toFixed(13)),
      iso: [Math.floor(rnd(c, 64, 400))],
      shutter_speed: Number(rnd(c, 4, 9).toFixed(13)),
      metering_mode: 5,
      exposure_time: Number((1 / Math.floor(rnd(c, 60, 250))).toFixed(16)),
      flash_status: 16,
    },
  }
}

// Resolve a username to its numeric user id (pk). Follow/unfollow operate on
// the pk, not the handle, so this runs once per target before the action.
export function resolveUsername(c: InstagramClient, username: string) {
  const clean = username.trim().replace(/^@+/, "")
  return c.get<{ user?: { pk?: string | number } }>(
    `/api/v1/users/${encodeURIComponent(clean)}/usernameinfo/`,
    "usernameinfo",
  )
}

// Account privacy (IGSettings2). Two-step flow captured from the app:
// 1) IGSettingsBooleanQuery (get_bool) reads the current account_privacy value,
// 2) IGSettingsBooleanMutation (set_bool) writes the desired value.
// value:true => account becomes private, value:false => public.
const DOC_ID_SETTINGS_GET_BOOL = "32033103815122380260183280751"
const DOC_ID_SETTINGS_SET_BOOL = "266926195018351726772295833929"
const SETTINGS_LEGACY_FORM = {
  ig_legacy_dict_validate_null: "true",
  ig_legacy_eager_dict_validate_null: "true",
}

type SettingsBoolData = {
  data?: {
    xdt_api__v1__settings__get_bool?: { value?: boolean | null }
    xdt_api__v1__settings__set_bool?: { value?: boolean | null }
  }
  status?: string
}

// Step 1: read the current account privacy state.
export function getAccountPrivacy(c: InstagramClient) {
  c.nav.visit(NAV.PRIVACY)
  return c.graphql<SettingsBoolData>(
    "IGSettingsBooleanQuery",
    DOC_ID_SETTINGS_GET_BOOL,
    { setting_id: "account_privacy_setting" },
    SETTINGS_LEGACY_FORM,
  )
}

// Step 2: set account privacy. private = true, public = false.
export function setAccountPrivacy(c: InstagramClient, isPrivate: boolean) {
  c.nav.visit(NAV.PRIVACY)
  return c.graphql<SettingsBoolData>(
    "IGSettingsBooleanMutation",
    DOC_ID_SETTINGS_SET_BOOL,
    {
      callsite: "igs2.account_privacy",
      value: isPrivate,
      allow_error_codes: true,
      setting_id: "account_privacy_setting",
    },
    SETTINGS_LEGACY_FORM,
  )
}

// Edit profile / biography. Two-step flow captured from the app:
// 1) GET /accounts/current_user/?edit=true reads the current biography,
// 2) POST /accounts/set_biography/ writes the new raw_text (supports \n + emoji).
type BioLink = { link_id?: number | string; url?: string; title?: string }
type CurrentUserData = {
  user?: { pk?: number; biography?: string; bio_links?: BioLink[] }
  status?: string
}
export function getCurrentUser(c: InstagramClient) {
  c.nav.visit(NAV.EDIT_PROFILE)
  return c.get<CurrentUserData>("/api/v1/accounts/current_user/?edit=true", "/accounts/current_user/")
}

type SetBiographyData = { user?: { biography?: string }; status?: string }
export function setBiography(c: InstagramClient, rawText: string) {
  c.nav.visit(NAV.BIO)
  return c.post<SetBiographyData>(
    "/api/v1/accounts/set_biography/",
    { _uuid: c.uuid, raw_text: rawText, device_id: c.uuid, _uid: c.uid },
    "/accounts/set_biography/",
  )
}

// Name change. POST /accounts/update_profile_name/ with a signed body carrying
// the new first_name. Response is { user: {...}, status: "ok" } on success.
type UpdateNameData = { user?: { full_name?: string }; status?: string }
export function updateProfileName(c: InstagramClient, firstName: string) {
  c.nav.visit(NAV.NAME)
  return c.post<UpdateNameData>(
    "/api/v1/accounts/update_profile_name/",
    { _uuid: c.uuid, first_name: firstName, _uid: c.uid },
    "/accounts/update_profile_name/",
  )
}

// Profile picture. Runs AFTER c.uploadPhoto() returns an upload_id. The captured
// signed body carries upload_id plus the standard identity + session fields.
type ChangePfpData = { user?: { profile_pic_url?: string }; status?: string }
export function changeProfilePicture(c: InstagramClient, uploadId: string) {
  c.nav.visit(NAV.EDIT_PROFILE)
  const waterfallId = c.accountRandomHex(32)
  return c.post<ChangePfpData>(
    "/api/v1/accounts/change_profile_picture/",
    {
      waterfall_id: waterfallId,
      _uuid: c.uuid,
      _uid: c.uid,
      device_id: c.uuid,
      timezone_offset: c.timezoneOffsetString,
      upload_id: uploadId,
      client_timestamp: c.accountNowSec().toString(),
      include_e2ee_mentioned_user_list: "0",
    },
    "/accounts/change_profile_picture/",
  )
}

// Username change. Two-step flow captured from the app:
// 1) IGFXIMGenericIdentityReminderQuery (GraphQL pando) — a passive identity
//    reminder check the app fires before opening the username editor,
// 2) POST /accounts/update_profile_username/ with the new username (signed body).
const DOC_ID_IDENTITY_REMINDER = "26741364192168346543752691203"
type IdentityReminderData = { data?: { fxim_viewer_identity?: unknown }; status?: string }
export function identityReminderUsername(c: InstagramClient) {
  c.nav.visit(NAV.USERNAME)
  return c.graphql<IdentityReminderData>(
    "IGFXIMGenericIdentityReminderQuery",
    DOC_ID_IDENTITY_REMINDER,
    { field: "USERNAME", type: "UPDATE_PASSIVE" },
  )
}

type UpdateUsernameData = { user?: { username?: string }; status?: string }
export function updateProfileUsername(c: InstagramClient, username: string) {
  c.nav.visit(NAV.USERNAME)
  return c.post<UpdateUsernameData>(
    "/api/v1/accounts/update_profile_username/",
    { _uuid: c.uuid, username, _uid: c.uid },
    "/accounts/update_profile_username/",
  )
}

// Bio links (Link in Bio / Remove Bio Links). The app opens the links editor
// with a passive promo-config GraphQL query before showing the list page.
const DOC_ID_LINK_PROMO_CONFIGS = "37944076795595095435605174735"
export function bioLinksPromoConfigs(c: InstagramClient) {
  c.nav.visit(NAV.LINKS)
  return c.graphql<{ data?: unknown; status?: string }>(
    "IGNMEBenefitContextualPromoConfigsQuery",
    DOC_ID_LINK_PROMO_CONFIGS,
    { input: { surface: "IG_PROFILE_EDIT_LINK_LIST_PAGE" } },
  )
}

// Link in Bio: set the account's external bio links. `updated_links` is a
// JSON-encoded string of link objects (matching the captured signed body).
type BioLinksData = { user?: { bio_links?: BioLink[] }; status?: string }
export function updateBioLinks(c: InstagramClient, links: { url: string; title?: string }[]) {
  const updated = links.map((l) => ({
    title: l.title ?? "",
    url: l.url,
    link_type: "external",
    link_id: null,
  }))
  c.nav.visit(NAV.LINKS)
  return c.post<BioLinksData>(
    "/api/v1/accounts/update_bio_links/",
    { updated_links: JSON.stringify(updated), _uuid: c.uuid, _uid: c.uid },
    "/accounts/update_bio_links/",
  )
}

// Remove Bio Links: delete the given link ids. `link_ids` is a JSON-encoded
// string array of ids (matching the captured signed body).
export function removeBioLinks(c: InstagramClient, linkIds: (string | number)[]) {
  c.nav.visit(NAV.LINKS)
  return c.post<BioLinksData>(
    "/api/v1/accounts/remove_bio_links/",
    { link_ids: JSON.stringify(linkIds.map(String)), _uuid: c.uuid, _uid: c.uid },
    "/accounts/remove_bio_links/",
  )
}

// 1. Profile info -----------------------------------------------------------
// info_stream returns a chunked NDJSON stream of `{"user":{...}}` objects. The
// captured request (dump 31) shows a crucial detail: when you open your OWN
// profile, the app sends entry_point:"self_profile" from the self_profile nav
// module — NOT entry_point:"profile" (which is what viewing SOMEONE ELSE's
// profile sends, reached via feed → user_profile). Sending "profile" for your
// own id makes Instagram answer a cold session with a guarded HTTP 200 that has
// no `user` object, which surfaced as the bogus "Refresh failed 200". So we
// branch on whether this is the signed-in user's own profile and mirror the
// captured self_profile request exactly.
export function profileInfo(c: InstagramClient, userId: string) {
  const isOwnProfile = String(userId) === String(c.uid)
  c.nav.visit(isOwnProfile ? NAV.SELF_PROFILE : NAV.USER_PROFILE)
  return c.post(
    `/api/v1/users/${userId}/info_stream/`,
    {
      is_profile_prefetch: "false",
      _uuid: c.uuid,
      entry_point: isOwnProfile ? "self_profile" : "profile",
      device_id: c.uuid,
      _uid: c.uid,
    },
    "info_stream",
  )
}

// 2. Posts from profile (paginated grid) ------------------------------------
export function profilePosts(c: InstagramClient, userId: string, maxId: string | null = null) {
  c.nav.visit(NAV.USER_PROFILE)
  return c.graphql("IGProfileTimelineQuery", DOC_ID_PROFILE_TIMELINE, {
    use_lightweight_carousel: true,
    exclude_pinned_posts: false,
    defer_carousel_media_count: false,
    pinned_profile_grid_items_ids: null,
    num_previews_for_associated_highlights: 3,
    defer_media_user_fields: false,
    user_id: userId,
    IGFeedItemLikeCountCellFragment_skip_not_implemented_fields: true,
    profile_grid_items_cursor: maxId,
    lightweight_carousel_type: "DELAYED_METADATA",
    should_fetch_attribution_ui: true,
    IGFeedItemUFICellFragment_skip_not_implemented_fields: true,
    IGFeedItemTextCellFragment_skip_explore: true,
    include_unseen_media_ids: false,
    include_originality_info: true,
    include_is_eligible_for_autodub_upsell: true,
    fetch_all_highlights: false,
    include_profile_grid_rendering_option: false,
    count: 9,
    max_id: maxId,
    source: "grid",
    carousel_initial_count: 1,
  })
}

// 3. Reels from profile (streaming) -----------------------------------------
export function profileReels(c: InstagramClient, userId: string, maxId: string | null = null) {
  c.nav.visit(NAV.USER_PROFILE)
  return c.graphql(
    "IGClipsProfileQuery",
    DOC_ID_CLIPS_PROFILE,
    {
      initial_stream_count: 6,
      fetch_byoa_langs: false,
      defer_hints: false,
      include_wearables_attribution_info: false,
      enable_hints: false,
      fetch_voice_translations_consumption_data: false,
      data: {
        target_user_id: userId,
        should_stream_response: "true",
        no_of_medias_in_each_chunk: 6,
        include_feed_video: "true",
        just_watched_context: {},
        ...(maxId ? { max_id: maxId } : {}),
      },
      include_gen_ai_tool_info: true,
    },
    { ig_legacy_dict_validate_null: "true", ig_legacy_eager_dict_validate_null: "true" },
  )
}

// 4. Highlights tray --------------------------------------------------------
export function highlights(c: InstagramClient, userId: string) {
  const caps = encodeURIComponent(
    JSON.stringify([
      { name: "hair_segmentation", value: "hair_segmentation_enabled" },
      { name: "WORLD_TRACKER", value: "WORLD_TRACKER_ENABLED" },
      { name: "body_tracking", value: "body_tracking_enabled" },
    ]),
  )
  c.nav.visit(NAV.USER_PROFILE)
  return c.get(
    `/api/v1/highlights/${userId}/highlights_tray/?supported_capabilities_new=${caps}`,
    "/highlights/%@/highlights_tray/",
  )
}

// 7. Feed request 1 — reels tray (stories) ----------------------------------
export function reelsTray(c: InstagramClient) {
  c.nav.visit(NAV.FEED)
  return c.post(
    "/api/v1/feed/reels_tray/",
    {
      supported_capabilities_new: JSON.stringify([{ name: "SUPPORTED_SDK_VERSIONS", value: "166.0" }]),
      reason: "cold_start",
      timezone_offset: c.timezoneOffsetString,
      tray_session_id: genUuid(c),
      request_id: genUuid(c),
      _uuid: c.uuid,
    },
    "/feed/reels_tray/",
  )
}

// 8 & 10. Feed timeline (initial + scrolling pagination) --------------------
export async function feedTimeline(
  c: InstagramClient,
  opts: { isPullToRefresh?: boolean; maxId?: string | null; reason?: string } = {},
) {
  c.nav.visit(NAV.FEED)
  const buildForm = () => {
    const form: Record<string, string> = {
      cancel_ongoing_fetch: "0",
      is_async_ads_double_request: "0",
      session_id: `${c.uid}_${genUuid(c)}`,
      _uuid: c.uuid,
      device_id: c.uuid,
      is_async_ads_rti: "0",
      has_seen_aart_on: "1",
      request_id: `${c.uid}_${genUuid(c)}`,
      is_pull_to_refresh: opts.isPullToRefresh ? "1" : "0",
      reason: opts.reason ?? (opts.maxId ? "pagination" : "cold_start_fetch"),
      is_async_ads_in_headload_enabled: "0",
      _uid: c.uid,
    }
    if (opts.maxId) form.max_id = opts.maxId
    return form
  }

  const res = await c.postForm("/api/v1/feed/timeline/", buildForm(), "IGFeedRequestConfigCreateRequest")

  // /feed/timeline/ is strict about the www-claim: a stale/SKIP value makes IG
  // answer 302 (redirect to /accounts/login/) or 403 even with a valid bearer.
  // The reels_tray request is the real app's "Feed request 1" at cold start and
  // returns a fresh x-ig-set-www-claim, which the client captures + reuses. Prime
  // it once and retry so the first feed page in a run isn't lost to a stale claim.
  if (res.status === 302 || res.status === 403) {
    await reelsTray(c).catch(() => undefined)
    return c.postForm("/api/v1/feed/timeline/", buildForm(), "IGFeedRequestConfigCreateRequest")
  }
  return res
}

// 9. Feed request 3 — reels media stream (story playback) -------------------
export function reelsMediaStream(c: InstagramClient, reelIds: string[]) {
  c.nav.visit(NAV.FEED)
  return c.post(
    "/api/v1/feed/reels_media_stream/",
    {
      _uuid: c.uuid,
      _uid: c.uid,
      reel_ids: reelIds,
      source: "feed_timeline",
    },
    "/feed/reels_media_stream/",
  )
}

// 11. Explore / Search ------------------------------------------------------
export function explore(c: InstagramClient, opts: { batteryLevel?: number; isCharging?: boolean } = {}) {
  const params = new URLSearchParams({
    ad_client_delivery_session_id: c.accountRandomHex(32),
    att_permission_status: "3",
    battery_level: String(opts.batteryLevel ?? 42),
    cluster_id: "explore_all:0",
    has_seen_aart_on: "1",
    is_charging: opts.isCharging ? "1" : "0",
    is_dark_mode: "0",
    is_nonpersonalized_explore: "false",
    is_ptr: "true",
    omit_cover_media: "true",
    phone_id: c.phoneId,
    timezone_offset: c.timezoneOffsetString,
  })
  c.nav.visit(NAV.EXPLORE)
  return c.get(`/api/v1/discover/topical_explore/?${params.toString()}`, "/discover/topical_explore/")
}

// 12. Reel scrolling (clips discover stream) --------------------------------
// Mirrors the captured POST /clips/discover/stream/ request from the reels tab.
// The body is form-encoded and carries the reels that were already "seen" plus a
// stable per-session `session_id` so pagination behaves like a real session.
export function reelScroll(
  c: InstagramClient,
  opts: { maxId?: string | null; sessionId?: string; seenReels?: string[] } = {},
) {
  c.nav.visit(NAV.REELS)
  const sessionId = opts.sessionId ?? `${c.uid}_${genUuid(c)}`
  const seenReels = (opts.seenReels ?? []).map((id) => ({ id: id.includes("_") ? id.split("_")[0] : id }))
  const form: Record<string, string> = {
    stories_seen_info: "[]",
    seen_reels: JSON.stringify(seenReels),
    client_flashcache_size: "3",
    _uuid: c.uuid,
    pct_reels: "0",
    inflight_ad_request: "0",
    tab_type: "clips_tab",
    session_id: sessionId,
    container_module: "clips_viewer_clips_tab",
  }
  if (opts.maxId) form.max_id = opts.maxId
  return c.postForm("/api/v1/clips/discover/stream/", form, "IGFeedRequestConfigCreateRequest")
}

// 13. Like media ------------------------------------------------------------
export function likeMedia(
  c: InstagramClient,
  mediaId: string,
  opts: { containerModule?: string; sourceOfLike?: string } = {},
) {
  const containerModule = opts.containerModule ?? "feed_timeline"
  // Align the nav chain with the surface the like fires from (feed / reels /
  // comments), so the header nav-chain and the body container_module agree.
  actionChain(c.nav, containerModule)
  return c.post(
    `/api/v1/media/${mediaId}/like/?d=0`,
    {
      _uuid: c.uuid,
      _uid: c.uid,
      media_id: mediaId,
      source_of_like: opts.sourceOfLike ?? "button",
      container_module: containerModule,
      device_id: c.uuid,
    },
    "/media/like/",
  )
}

// 14. Check media comments --------------------------------------------------
export function mediaComments(c: InstagramClient, mediaId: string) {
  c.nav.visit(NAV.COMMENTS)
  return c.get(
    `/api/v1/media/${mediaId}/comments/?can_support_threading=true&include_preview_comments=false&should_fetch_creator_comment_nudge=true`,
    "/media/%@/comments/",
  )
}

// 15. Check comment replies (inline child comments) -------------------------
export function commentReplies(c: InstagramClient, mediaId: string, commentId: string) {
  c.nav.visit(NAV.COMMENTS)
  return c.get(
    `/api/v1/media/${mediaId}/comments/${commentId}/inline_child_comments/?paging_direction=view_more`,
    "/media/%@/comments/%@/inline_child_comments/",
  )
}

// 16. Comment like ----------------------------------------------------------
export function commentLike(c: InstagramClient, commentId: string) {
  c.nav.visit(NAV.COMMENTS)
  return c.post(
    `/api/v1/media/${commentId}/comment_like/`,
    {
      comment_id: commentId,
      source_of_like: "button",
      delivery_class: "organic",
      _uuid: c.uuid,
      _uid: c.uid,
    },
    "/media/%@/%@/",
  )
}

// 17. Request before make comment — offensive check -------------------------
export function checkOffensiveComment(c: InstagramClient, mediaId: string, commentText: string) {
  c.nav.visit(NAV.COMMENTS)
  return c.post(
    "/api/v1/media/comment/check_offensive_comment/",
    {
      media_id: mediaId,
      _uuid: c.uuid,
      _uid: c.uid,
      comment_text: commentText,
      comment_session_id: c.accountRandomHex(32),
    },
    "/media/comment/check_offensive_comment/",
  )
}

// 18. Make comment ----------------------------------------------------------
export function makeComment(c: InstagramClient, mediaId: string, commentText: string) {
  c.nav.visit(NAV.COMMENTS)
  return c.post(
    `/api/v1/media/${mediaId}/comment/`,
    {
      comment_text: commentText,
      _uuid: c.uuid,
      _uid: c.uid,
      media_id: mediaId,
      idempotence_token: genUuid(c).toLowerCase(),
      container_module: "comments_v2",
    },
    "/media/%@/comment/",
  )
}

// 20. Configure a single photo post (after rupload_igphoto) -----------------
export function configurePhoto(
  c: InstagramClient,
  uploadId: string,
  opts: { caption?: string; width?: number; height?: number } = {},
) {
  const w = opts.width ?? 1080
  const h = opts.height ?? 1080
  // Walk the feed post composer screen journey (camera → gallery → crop →
  // filter → share) so the chain matches a genuine photo publish, then echo it.
  c.nav.visit(NAV.POST_COMPOSER)
  return c.post(
    "/api/v1/media/configure/",
    {
      upload_id: uploadId,
      source_type: "4",
      caption: opts.caption ?? "",
      _uuid: c.uuid,
      _uid: c.uid,
      device_id: c.uuid,
      // iOS publish fingerprint: camera EXIF + Apple lens, NOT an Android device
      // dict (which would contradict the iOS user-agent).
      additional_exif_data: iosExifData(c),
      lens_make: "Apple",
      client_timestamp: c.accountNowSec().toString(),
      nav_chain: c.nav.chainString(),
      edits: {
        crop_original_size: [w, h],
        crop_center: [0.0, 0.0],
        crop_zoom: 1.0,
      },
      extra: { source_width: w, source_height: h },
    },
    "/media/configure/",
  )
}

// 20b. Configure a carousel/album (after each child is rupload'ed) ----------
// Mirrors the captured `media/configure_sidecar/` request: one entry per child
// in `children_metadata` (each carrying its own upload_id), plus a shared
// caption and client_sidecar_id. Children may be photos or videos.
export interface SidecarChild {
  uploadId: string
  kind: "image" | "video"
  width?: number
  height?: number
  durationMs?: number
}
export function configureSidecar(
  c: InstagramClient,
  children: SidecarChild[],
  opts: { caption?: string } = {},
) {
  const childrenMetadata = children.map((child) => {
    const w = child.width ?? 1080
    const h = child.height ?? 1080
    if (child.kind === "video") {
      return {
        upload_id: child.uploadId,
        source_type: "library",
        timezone_offset: c.timezoneOffsetString,
        length: (child.durationMs ?? 0) / 1000,
        clips_metadata: {},
        like_and_view_counts_disabled: false,
        share_count_disabled: false,
        disable_comments: false,
        allow_multi_configures: false,
      }
    }
    return {
      upload_id: child.uploadId,
      source_type: "library",
      like_and_view_counts_disabled: false,
      share_count_disabled: false,
      edits: { filter_identifier: "normal", filter_strength: 0.5 },
      camera_position: "unknown",
      disable_comments: false,
      scene_capture_type: "standard",
      extra: { source_width: w, source_height: h },
      allow_multi_configures: false,
    }
  })

  c.nav.visit(NAV.POST_COMPOSER)
  return c.post(
    "/api/v1/media/configure_sidecar/",
    {
      client_sidecar_id: c.accountNow().toString(),
      caption: opts.caption ?? "",
      children_metadata: childrenMetadata,
      _uuid: c.uuid,
      _uid: c.uid,
      device_id: c.uuid,
      nav_chain: c.nav.chainString(),
      disable_comments: "0",
      timezone_offset: c.timezoneOffsetString,
      source_type: "library",
      client_timestamp: c.accountNowSec().toString(),
    },
    "media/configure_sidecar/",
  )
}

// 21. Configure a reels clip (after rupload_igvideo) ------------------------
// This is a FIELD-FOR-FIELD copy of the captured gallery-reel
// `media/configure_to_clips/` body (iOS 436, library clip → share). Every key,
// value type, and string/number distinction below is taken verbatim from the
// dump so the publish is indistinguishable from a genuine "post a saved clip"
// flow. The only values that vary per-publish are the ids (upload/publish/
// composition/session), caption, dimensions, duration, timestamps, nav_chain,
// and the quality-hint colors sampled from the cover frame.
//
// nav-chain handling differs from the old camera-composer model: in the capture
// the HEADER x-ig-nav-chain sits on feed_timeline (the user tabbed back while the
// async publish finished), while the full gallery composer journey is carried in
// the BODY. So we DON'T push the composer onto the live stack; we render it with
// detachedChain() into the body and leave the header wherever the caller left it
// (the orchestrator moves it to the feed before calling this).
export function configureReel(
  c: InstagramClient,
  uploadId: string,
  opts: {
    caption?: string
    width?: number
    height?: number
    durationMs?: number
    waterfallId?: string
    // Real source-video pixel dimensions (segment original_width/height). Falls
    // back to the export width/height when the probe couldn't read them.
    originalWidth?: number
    originalHeight?: number
    // publish_id is a distinct numeric id from upload_id in the capture; the
    // orchestrator generates one per publish and reuses it across configure
    // retries so IG dedupes correctly.
    publishId?: string
    // composition_id is stable across retries for the same publish.
    compositionId?: string
    // Sampled cover-frame color stats for quality_hints (from reel-cover). When
    // omitted we send neutral values.
    colors?: {
      averages: { r: number; g: number; b: number }
      standardDeviations: { r: number; g: number; b: number }
    }
    // Set on configure RETRIES (202 polling): the body nav_chain / ids were
    // already established on the first attempt; we keep them stable so a retry is
    // a byte-identical re-POST that IG dedupes on upload_id.
    reuseNav?: boolean
  } = {},
) {
  const w = opts.width ?? 720
  const h = opts.height ?? 1280
  const origW = opts.originalWidth ?? w
  const origH = opts.originalHeight ?? h
  const durationMs = Math.max(1, Math.round(opts.durationMs ?? 15000))
  const waterfallId = opts.waterfallId ?? c.uuid
  const publishId = opts.publishId ?? c.accountNow().toString()
  const compositionId = opts.compositionId ?? genUuid(c)
  const colors = opts.colors ?? {
    averages: { r: 128, g: 128, b: 128 },
    standardDeviations: { r: 32, g: 32, b: 32 },
  }
  // Render the gallery composer journey into the BODY nav_chain without touching
  // the live stack (the header stays on the feed, matching the capture).
  const navChain = c.nav.detachedChain(NAV.REEL_GALLERY)
  return c.post(
    "/api/v1/media/configure_to_clips/",
    {
      device_id: c.uuid,
      clips_segments_metadata: {
        num_segments: 1,
        clips_segments: [
          {
            original_segment_hash: genUuid(c),
            x_transform: 0,
            media_type: "video",
            source: "library",
            source_type: "0",
            asset_media_subtype: [],
            face_effect_id: "",
            from_draft: "0",
            trimmed_start_time_ms: 0,
            index: 0,
            rotation: 0,
            y_transform: 0,
            speed: 100,
            original_media_type: 2,
            original_height: origH,
            media_folder: "",
            audio_type: "original",
            camera_position: 3,
            source_media_group_id: "",
            was_edited_by_ai_cut: "0",
            zoom: 1,
            duration_ms: durationMs,
            source_media_id: null,
            original_width: origW,
            is_remix: "0",
          },
        ],
      },
      creation_tool_info: [],
      sticker_ids: [],
      third_party_downloads_enabled: "1",
      smart_template_effect_id: "",
      nav_chain: navChain,
      effect_ids: [],
      _uuid: c.uuid,
      hide_from_profile_grid: "0",
      like_and_view_counts_disabled: "0",
      parent_template_clips_media_id: "",
      clips_share_preview_to_feed: "1",
      client_timestamp: c.accountNowSec().toString(),
      is_gifting_enabled: "1",
      capture_type: "clips_v2",
      camera_upsell: "",
      camera_session_id: waterfallId,
      ig_timeline_metadata: [{ action: "ADD", surface_element: "STACKED_TIMELINE", count: "1", target: "VIDEO" }],
      publish_id: publishId,
      upload_id: uploadId,
      camera_entry_point: 71,
      source_type: "0",
      caption: opts.caption ?? "",
      is_template_disabled: "0",
      timezone_offset: c.timezoneOffsetString,
      create_pa_boost_post_access_token_not_expire: "false",
      waterfall_id: waterfallId,
      overlay_data: [],
      composition_id: compositionId,
      funded_content_deal_id: "not_funded",
      clips_creation_entry_point: "clips",
      clips_audio_metadata: { original: { volume_level: 1 } },
      _uid: c.uid,
      is_clips_edited: "0",
      internal_features: "clips_format,clips_launch",
      additional_audio_info: { has_voiceover_attribution: "0" },
      sticker_translations_enabled: "0",
      text_overlay: [],
      async_publish: "1",
      filter_type: "0",
      bottom_camera_dial_selected: 11,
      contains_music_lyrics: "0",
      stacked_timeline_metadata: [
        { surface_element: "STACKED_TIMELINE", action: "ADD", target: "VIDEO", count: "1" },
      ],
      archive_only: "false",
      is_paid_partnership: "false",
      template_clips_media_id: "",
      is_created_with_sound_sync: "1",
      share_count_disabled: "0",
      is_created_with_contextual_music_recs: "0",
      quality_hints: {
        colors: {
          sampled_standard_deviations: colors.standardDeviations,
          sampled_averages: colors.averages,
        },
      },
      video_effects: [],
    },
    "media/configure_to_clips/",
  )
}

// 22. Story & Highlight =====================================================

// 22a. Validate an optional story link URL before publishing. Fired for both
// plain stories (when a link sticker is present) and highlights. Returns
// { status: "ok" } when the URL is accepted.
export function validateStoryUrl(c: InstagramClient, url: string) {
  return c.post(
    "/api/v1/media/validate_reel_url/",
    { url, _uuid: c.uuid, _uid: c.uid },
    "/media/validate_reel_url/",
  )
}

// 22b. "Save story to archive" setting (igs2). Highlights can only be built
// from archived stories, so before posting a highlight we read this flag and,
// if it's off, switch it on. Same get_bool / set_bool graphql as privacy, with
// a different setting_id.
export function getSaveStoryToArchive(c: InstagramClient) {
  return c.graphql<SettingsBoolData>(
    "IGSettingsBooleanQuery",
    DOC_ID_SETTINGS_GET_BOOL,
    { setting_id: "archiving_save_story_to_archive" },
    SETTINGS_LEGACY_FORM,
  )
}

export function setSaveStoryToArchive(c: InstagramClient, enabled: boolean) {
  return c.graphql<SettingsBoolData>(
    "IGSettingsBooleanMutation",
    DOC_ID_SETTINGS_SET_BOOL,
    {
      callsite: "igs2.archiving_save_story_to_archive",
      value: enabled,
      allow_error_codes: true,
      setting_id: "archiving_save_story_to_archive",
    },
    SETTINGS_LEGACY_FORM,
  )
}

// Default normalized geometry of an IG link sticker (size = 100%). The size
// slider scales both dimensions; x/y are the sticker's normalized centre.
const STORY_LINK_BASE_WIDTH = 0.31533388529998668
const STORY_LINK_BASE_HEIGHT = 0.059782611060401732

export interface StoryLinkSticker {
  url: string
  text?: string
  rotation?: number // degrees
  size?: number // percent (e.g. 70–100)
  x?: number // normalized centre, 0–1
  y?: number // normalized centre, 0–1
}

// 22c. Configure a story (after rupload_igphoto / rupload_igvideo). Mirrors the
// captured `media/configure_to_story/` request and, when a link is supplied,
// attaches a `story_link_stickers` payload positioned via x/y + size + rotation.
// The response carries the new story's media id (used to build a highlight).
export function configureStory(
  c: InstagramClient,
  uploadId: string,
  opts: {
    width?: number
    height?: number
    link?: StoryLinkSticker | null
    // When the link pill was baked into the photo, the caller passes its exact
    // normalized geometry so the tappable link area lines up with the visible
    // baked pill.
    linkBox?: { x: number; y: number; width: number; height: number; rotation: number } | null
  } = {},
) {
  const w = opts.width ?? 1080
  const h = opts.height ?? 1920
  const nowSec = c.accountNowSec().toString()
  // Unlike feed/reel publishes, the captured story request keeps its HEADER
  // nav-chain on the feed root while carrying the full story-composer journey in
  // the BODY. `detachedChain` renders that body chain without disturbing the
  // shared header stack (which stays on feed_timeline).
  c.nav.visit(NAV.FEED)
  const payload: Record<string, unknown> = {
    upload_id: uploadId,
    source_type: "4",
    configure_mode: "1",
    caption: "",
    _uuid: c.uuid,
    _uid: c.uid,
    device_id: c.uuid,
    nav_chain: c.nav.detachedChain(NAV.STORY_COMPOSER),
    client_shared_at: nowSec,
    client_timestamp: nowSec,
    timezone_offset: c.timezoneOffsetString,
    edits: { crop_original_size: [w, h], crop_center: [0.0, 0.0], crop_zoom: 1.0 },
    extra: { source_width: w, source_height: h },
    // iOS story publish carries camera EXIF + Apple lens, not an Android device dict.
    additional_exif_data: iosExifData(c),
    lens_make: "Apple",
  }

  if (opts.link && opts.link.url) {
    const scale = (opts.link.size ?? 100) / 100
    // Register the tappable link the way Instagram's mobile (private) API
    // actually expects it — mirrored from instagrapi's photo_configure_to_story.
    // The mobile endpoint does NOT read `story_link_stickers` (that's a web-only
    // field); a link story is registered through `tap_models` + a
    // `story_sticker_ids` entry, after `media/validate_reel_url/` has been
    // called (done in story.ts). Sending only `story_link_stickers` is exactly
    // why the baked pill wasn't clickable. The visible pill is baked into the
    // photo, so we use the baked box geometry to line the tap zone up with it.
    const box = opts.linkBox
    const x = box?.x ?? opts.link.x ?? 0.5
    const y = box?.y ?? opts.link.y ?? 0.76
    const width = box?.width ?? STORY_LINK_BASE_WIDTH * scale
    const height = box?.height ?? STORY_LINK_BASE_HEIGHT * scale
    const rotation = box?.rotation ?? opts.link.rotation ?? 0

    const tapModel = {
      x,
      y,
      z: 0,
      width,
      height,
      rotation,
      type: "story_link",
      is_sticker: true,
      selected_index: 0,
      tap_state: 0,
      link_type: "web",
      url: opts.link.url,
      tap_state_str_id: "link_sticker_default",
    }
    payload.tap_models = JSON.stringify([tapModel])
    payload.story_sticker_ids = "link_sticker_default"
  }

  return c.post<{ media?: { id?: string; pk?: string | number } }>(
    "/api/v1/media/configure_to_story/",
    payload,
    "/media/configure_to_story/",
  )
}

// 22d. Open the story archive (request fired right before creating a highlight).
// Returns archived story "day shells"; best-effort — we mainly use it to mirror
// the genuine client flow before /highlights/create_reel/.
export function storyArchive(c: InstagramClient) {
  return c.get(
    "/api/v1/archive/reel/day_shells_paginated/?include_suggested_highlights=false&is_in_archive_home=true&include_cover=1",
    "/archive/reel/day_shells_paginated/",
  )
}

// 22e. Create a highlight from one or more archived story media ids. Mirrors the
// captured `highlights/create_reel/` request (title, media_ids, cover crop).
export function createHighlight(
  c: InstagramClient,
  opts: { title: string; mediaIds: string[]; coverMediaId?: string; cropRect?: string },
) {
  const coverMediaId = opts.coverMediaId ?? opts.mediaIds[0]
  const cropRect = opts.cropRect ?? "[0,0.21875,1,0.78125]"
  return c.post(
    "/api/v1/highlights/create_reel/",
    {
      should_add_to_main_grid: "false",
      source: "self_profile",
      _uuid: c.uuid,
      creation_id: c.accountNow().toString(),
      _uid: c.uid,
      title: opts.title,
      media_ids: JSON.stringify(opts.mediaIds),
      cover: JSON.stringify({ crop_rect: cropRect, media_id: coverMediaId }),
    },
    "/highlights/create_reel/",
  )
}

// 19. Follow ----------------------------------------------------------------
// Body mirrors the captured `friendships/create/{id}/` request fired from the
// reels viewer (media_id_attribution, container_module, friction check, etc.).
export function follow(
  c: InstagramClient,
  targetUserId: string,
  opts: { mediaId?: string; containerModule?: string } = {},
) {
  const containerModule = opts.containerModule ?? "clips_viewer_clips_tab"
  const body: Record<string, unknown> = {
    user_id: targetUserId,
    _uuid: c.uuid,
    _uid: c.uid,
    device_id: c.uuid,
    check_pastis: "true",
    include_follow_friction_check: "1",
    container_module: containerModule,
    // friendships/create/ echoes the navigation chain in its body (captured).
    nav_chain: actionChain(c.nav, containerModule),
  }
  if (opts.mediaId) body.media_id_attribution = opts.mediaId
  return c.post(`/api/v1/friendships/create/${targetUserId}/`, body, "/friendships/%@/%@/")
}

// Save media (bookmark) — POST /media/{id}/save/ with a signed body.
// Mirrors the captured IGSaveRequestManager request from the clips viewer.
export function saveMedia(c: InstagramClient, mediaId: string, opts: { containerModule?: string } = {}) {
  const containerModule = opts.containerModule ?? "feed_timeline"
  return c.post(
    `/api/v1/media/${mediaId}/save/`,
    {
      delivery_class: "organic",
      _uuid: c.uuid,
      _uid: c.uid,
      device_id: c.uuid,
      container_module: containerModule,
      // media/{id}/save/ echoes the navigation chain in its body (captured).
      nav_chain: actionChain(c.nav, containerModule),
    },
    "IGSaveRequestManager",
  )
}

// Repost (create note) — POST /media/create_note/v2/. This is a plain (unsigned)
// form post, mirroring the captured /media/create_note/v2/ request. `mediaId`
// must be the full `pk_ownerId` id.
export function repost(c: InstagramClient, mediaId: string, opts: { containerModule?: string; text?: string } = {}) {
  const containerModule = opts.containerModule ?? "feed_timeline"
  actionChain(c.nav, containerModule)
  const form: Record<string, string> = {
    _uuid: c.uuid,
    note_style: "13",
    audience: "7",
    text: opts.text ?? "",
    event_source: "ufi",
    media_id: mediaId,
    container_module: containerModule,
  }
  return c.postForm("/api/v1/media/create_note/v2/", form, "/media/create_note/v2/")
}

// Unfollow (friendships/destroy) — the inverse action for the Follow/Unfollow toggle.
export function unfollow(
  c: InstagramClient,
  targetUserId: string,
  opts: { mediaId?: string; containerModule?: string } = {},
) {
  const containerModule = opts.containerModule ?? "clips_viewer_clips_tab"
  const body: Record<string, unknown> = {
    user_id: targetUserId,
    _uuid: c.uuid,
    _uid: c.uid,
    device_id: c.uuid,
    container_module: containerModule,
    // friendships/destroy/ echoes the navigation chain in its body (captured).
    nav_chain: actionChain(c.nav, containerModule),
  }
  if (opts.mediaId) body.media_id_attribution = opts.mediaId
  return c.post(`/api/v1/friendships/destroy/${targetUserId}/`, body, "/friendships/%@/%@/")
}

// Pre-unfollow check — GET /friendships/unfollow_chaining_count/{id}/. The real
// app fires this right before an unfollow (it returns how many accounts you'd
// stop seeing). We mirror it so the unfollow flow matches captured traffic.
export function unfollowChainingCount(c: InstagramClient, targetUserId: string) {
  return c.get(`/api/v1/friendships/unfollow_chaining_count/${targetUserId}/`, "/friendships/unfollow_chaining_count/")
}
