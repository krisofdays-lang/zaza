// Pigeon session + navigation-chain modeling for the private IG iOS API.
//
// The real Instagram iOS app (410.1.0.36.70, captured) attaches three headers
// to essentially every request that our client was previously omitting:
//
//   x-pigeon-session-id     — a per-foreground-session UUID that rotates every
//                             ~20-30 min. A new session always begins a fresh
//                             navigation chain from a cold-start feed root.
//   x-pigeon-rawclienttime  — unix seconds (with sub-second precision), fresh
//                             on every single request.
//   x-ig-nav-chain          — the screen back-stack the user walked to reach
//                             the current view, plus x-ig-client-endpoint which
//                             is always the LAST segment's "VC:module".
//
// The chain is a comma-separated list of segments, each:
//   ViewControllerClass:module:position:click_point:enter_ts:::exit_ts
// (click_point is frequently empty). `position` is a monotonic screen counter
// that grows across the WHOLE session, not per request. When the stack gets
// long the real client collapses the middle into a single `TRUNCATEDxN` marker.
//
// For action endpoints (follow, save, configure_to_clips, ...) the very same
// chain string is ALSO duplicated into the request body as `nav_chain`.
//
// One NavSession lives on each InstagramClient instance. Because a client is
// created once per account per run and threaded through every node, the chain
// and position grow naturally across sequential nodes (e.g. three Post Reels in
// a row keep advancing the same chain) and only reset when the pigeon session
// rotates. This is used uniformly by workflow, publications, and warmup.

export interface ScreenDef {
  vc: string
  module: string
  clickPoint?: string
}

interface Segment {
  vc: string
  module: string
  clickPoint: string
  position: number
  enter: number // unix seconds
}

// Session rotation window, mirroring instagrapi's pigeon-session behavior.
const SESSION_MIN_MS = 20 * 60 * 1000
const SESSION_MAX_MS = 30 * 60 * 1000
// Bound the rendered chain; overflow beyond this collapses into TRUNCATEDxN.
const MAX_SEGMENTS = 12
const KEEP_HEAD = 1

// Cold-start root. Matches the captured configure_to_story header exactly:
//   IGMainFeedViewController:feed_timeline:1:cold_start:<ts>:::<ts>
const ROOT: ScreenDef = { vc: "IGMainFeedViewController", module: "feed_timeline", clickPoint: "cold_start" }

// Clock & PRNG hooks injected by the owning InstagramClient so every account
// gets its own virtual clock offset and deterministic random sequence.
export interface NavClockSource {
  /** Current time in ms (like Date.now(), but with per-account offset). */
  nowMs(): number
  /** Uniform random float in [0, 1). */
  random(): number
}

// Fallback for standalone / test usage — raw system clock + Math.random().
const SYSTEM_CLOCK: NavClockSource = {
  nowMs: () => Date.now(),
  random: () => Math.random(),
}

export class NavSession {
  private sessionId = ""
  private sessionExpiry = 0
  private sessionCounter = 0
  private position = 0
  private lastTs = 0
  private stack: Segment[] = []
  private clock: NavClockSource

  constructor(clock?: NavClockSource) {
    this.clock = clock ?? SYSTEM_CLOCK
    this.resetSession()
  }

  // Start (or rotate to) a fresh pigeon session: new id, new expiry window, and
  // a brand new navigation chain seeded from the cold-start feed root.
  private resetSession(): void {
    this.sessionCounter += 1
    // The real app's x-pigeon-session-id is a plain uppercase UUID (verified
    // against captured traffic), NOT a "UFS-…-n" string — matching the capture
    // exactly avoids an easy format-based automation tell.
    this.sessionId = this.upperUuid()
    this.sessionExpiry = this.clock.nowMs() + this.rand(SESSION_MIN_MS, SESSION_MAX_MS)
    this.position = 0
    this.lastTs = 0
    this.stack = []
    this.pushScreen(ROOT)
  }

  private ensureSession(): void {
    if (!this.sessionId || this.clock.nowMs() >= this.sessionExpiry) this.resetSession()
  }

  getSessionId(): string {
    this.ensureSession()
    return this.sessionId
  }

  rawClientTime(): string {
    return (this.clock.nowMs() / 1000).toFixed(6)
  }

  // Monotonic, strictly-increasing timestamps that mostly track real wall time
  // but never go backwards (so rapid multi-screen pushes still order correctly).
  private nextTs(): number {
    const t = Math.max(this.clock.nowMs() / 1000, this.lastTs + this.rand(0.1, 1.4))
    this.lastTs = t
    return t
  }

  private rand(min: number, max: number): number {
    return min + this.clock.random() * (max - min)
  }

  private upperUuid(): string {
    let s = ""
    for (let i = 0; i < 32; i++) s += Math.floor(this.clock.random() * 16).toString(16)
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`.toUpperCase()
  }

  private pushScreen(s: ScreenDef): void {
    this.position += 1
    this.stack.push({
      vc: s.vc,
      module: s.module,
      clickPoint: s.clickPoint ?? "",
      position: this.position,
      enter: this.nextTs(),
    })
  }

  // Navigate along a screen path, reconciling with the current stack tail so an
  // already-active context isn't re-pushed. We find the largest k where the last
  // k stack screens equal the first k screens of `path`, then push the rest.
  // e.g. stack tail [profile, edit_profile] + visit([profile, edit_profile, bio])
  // pushes only [bio]; but visiting a different branch re-pushes from the top,
  // which mirrors the user tapping back and navigating again.
  visit(path: readonly ScreenDef[]): void {
    this.ensureSession()
    if (path.length === 0) return
    const maxK = Math.min(this.stack.length, path.length)
    let k = 0
    for (let cand = maxK; cand >= 0; cand--) {
      let ok = true
      for (let i = 0; i < cand; i++) {
        const seg = this.stack[this.stack.length - cand + i]
        const scr = path[i]
        if (seg.vc !== scr.vc || seg.module !== scr.module) {
          ok = false
          break
        }
      }
      if (ok) {
        k = cand
        break
      }
    }
    for (let i = k; i < path.length; i++) this.pushScreen(path[i])
  }

  private renderSegments(segs: Segment[]): string[] {
    return segs.map((seg, i) => {
      // A screen's exit is when the next screen was entered; the current (last)
      // screen has enter == exit, matching the captured chains.
      const exit = i < segs.length - 1 ? segs[i + 1].enter : seg.enter
      return `${seg.vc}:${seg.module}:${seg.position}:${seg.clickPoint}:${seg.enter.toFixed(6)}:::${exit.toFixed(6)}`
    })
  }

  // The full x-ig-nav-chain value. Collapses the middle of an overlong stack
  // into a single TRUNCATEDxN marker, like the real client.
  chainString(): string {
    this.ensureSession()
    if (this.stack.length <= MAX_SEGMENTS) {
      return this.renderSegments(this.stack).join(",")
    }
    const head = this.stack.slice(0, KEEP_HEAD)
    const tailCount = MAX_SEGMENTS - KEEP_HEAD
    const tail = this.stack.slice(this.stack.length - tailCount)
    const collapsed = this.stack.length - head.length - tail.length
    return [...this.renderSegments(head), `TRUNCATEDx${collapsed}`, ...this.renderSegments(tail)].join(",")
  }

  // Render a self-contained chain for a screen path WITHOUT mutating the shared
  // stack. Used by surfaces (story publish) where the captured request carries a
  // full composer chain in the request BODY while the header nav-chain stays on
  // the current screen. Positions continue from the live session counter and the
  // middle collapses to TRUNCATEDxN like a real overlong chain.
  detachedChain(path: readonly ScreenDef[]): string {
    this.ensureSession()
    if (path.length === 0) return this.chainString()
    const segs: Segment[] = path.map((s) => {
      this.position += 1
      return {
        vc: s.vc,
        module: s.module,
        clickPoint: s.clickPoint ?? "",
        position: this.position,
        enter: this.nextTs(),
      }
    })
    if (segs.length <= MAX_SEGMENTS) return this.renderSegments(segs).join(",")
    const head = segs.slice(0, KEEP_HEAD)
    const tailCount = MAX_SEGMENTS - KEEP_HEAD
    const tail = segs.slice(segs.length - tailCount)
    const collapsed = segs.length - head.length - tail.length
    return [...this.renderSegments(head), `TRUNCATEDx${collapsed}`, ...this.renderSegments(tail)].join(",")
  }

  // The module of the screen currently on top of the stack.
  currentModule(): string {
    const top = this.stack[this.stack.length - 1]
    return top ? top.module : ""
  }

  // x-ig-client-endpoint is always the last segment's "VC:module".
  clientEndpoint(): string {
    this.ensureSession()
    const top = this.stack[this.stack.length - 1]
    return top ? `${top.vc}:${top.module}` : `${ROOT.vc}:${ROOT.module}`
  }
}

// ---------------------------------------------------------------------------
// Screen registry — every VC:module below is taken verbatim from captured
// traffic of the real iOS app. Paths are ordered root-most first.
// ---------------------------------------------------------------------------

const S = {
  feed: { vc: "IGMainFeedViewController", module: "feed_timeline" } as ScreenDef,
  reels: { vc: "IGSundialFeedViewController", module: "clips_viewer_clips_tab", clickPoint: "main_discover_video" } as ScreenDef,
  comments: { vc: "IGCommentThreadViewController", module: "comments_v2", clickPoint: "media_comments" } as ScreenDef,
  // The captured self-profile root (edit/settings/story flows) uses the
  // self_clips_profile module, not self_profile.
  profile: { vc: "IGProfileViewController", module: "self_clips_profile", clickPoint: "main_profile" } as ScreenDef,
  // The reel-composer warmup queries (LinkedBarcelona/FeedCrosspost/share_to_fb)
  // fire from the profile with the plain self_profile module — captured verbatim.
  selfProfile: { vc: "IGProfileViewController", module: "self_profile", clickPoint: "main_profile" } as ScreenDef,
  userProfile: { vc: "IGProfileViewController", module: "profile", clickPoint: "username" } as ScreenDef,
  explore: { vc: "IGExploreGridViewController", module: "explore_popular", clickPoint: "search_tab" } as ScreenDef,
  editProfile: { vc: "IGEditProfileViewController", module: "edit_profile" } as ScreenDef,
  bio: { vc: "IGEditProfileBioViewController", module: "edit_profile" } as ScreenDef,
  name: { vc: "IGEditProfileNameViewController", module: "edit-profile-name" } as ScreenDef,
  customAlert: { vc: "IGCustomAlertViewController", module: "custom_alert" } as ScreenDef,
  linksList: { vc: "IGEditProfileMultipleLinksViewController", module: "edit_profile_links_list" } as ScreenDef,
  linkCustom: {
    vc: "IGEditProfileMultipleLinksCustomLinkViewController",
    module: "edit-profile-bio-links-custom-link",
  } as ScreenDef,
  settings: { vc: "IGSettings2Renderer", module: "main_settings_screen" } as ScreenDef,
  privacy: { vc: "IGSettings2Renderer", module: "account_privacy" } as ScreenDef,
}

const EDIT_PROFILE = [S.profile, S.editProfile]

// Reel composer journey — verbatim screen order from the captured reel-publish
// dumps. Crucially, the real app builds this chain PROGRESSIVELY across three
// requests, so each carries a different x-ig-client-endpoint (== last segment):
//   • upload_settings  → ends on IGStoryMediaComposition…:clips_postcapture_camera
//   • rupload_igvideo  → ends on IGSundialShareSheetV2ViewController
//   • configure_to_clips → ends on …IGSundialOaReuseNuxViewController:reels_oa_reuse_nux
// We model that as three CUMULATIVE stages. Because NavSession.visit() reconciles
// against the current stack tail, visiting EDIT → SHARE → CONFIGURE pushes only
// the newly-entered screens each time, reproducing the exact captured chain
// (including the IGMediaLibraryViewController:feed_gallery screen the app inserts
// between media_capture and media_crop_view, which we previously omitted).

// Stage 0 — camera → gallery → crop. This is exactly where the app sits when the
// "media chosen" warmup batch (info_stream / share_to_fb_config / effect_collection)
// fires: x-ig-client-endpoint == IGMediaCropViewController:media_crop_view.
const REEL_COMPOSER_CROP: ScreenDef[] = [
  { vc: "IGStoryCameraViewController", module: "reel_composer_camera", clickPoint: "main_camera" },
  { vc: "IGCameraNavigationController", module: "camera_nav" },
  { vc: "IGMediaCaptureViewController", module: "media_capture" },
  { vc: "IGMediaLibraryViewController", module: "feed_gallery" },
  { vc: "IGMediaCropViewController", module: "media_crop_view" },
]

// Stage 1 — through the post-capture editing screens (sent with upload_settings).
const REEL_COMPOSER_EDIT: ScreenDef[] = [
  ...REEL_COMPOSER_CROP,
  {
    vc: "IGSundialPostCaptureEditingViewController.IGSundialPostCaptureEditingViewController",
    module: "clips_postcapture_camera",
  },
  {
    vc: "IGSundialPostcaptureSwift.IGSundialMediaCompositionEditingViewController",
    module: "reel_multiedit_composer",
  },
  { vc: "IGStoryMediaCompositionEditingViewController", module: "clips_postcapture_camera" },
]

// Stage 2 — adds the share sheets (sent with the rupload_igvideo bytes).
const REEL_COMPOSER_SHARE: ScreenDef[] = [
  ...REEL_COMPOSER_EDIT,
  { vc: "IGSundialShareSheetViewController", module: "panavideo_share_sheet" },
  { vc: "IGSundialShareSheetV2ViewController", module: "IGSundialShareSheetV2ViewController" },
]

// Stage 3 (full) — adds the OA-reuse NUX (sent with configure_to_clips).
const REEL_COMPOSER: ScreenDef[] = [
  ...REEL_COMPOSER_SHARE,
  { vc: "IGSundialShareSheetNux.IGSundialOaReuseNuxViewController", module: "reels_oa_reuse_nux" },
]

// Gallery reel composer journey — verbatim from the captured gallery-reel publish
// (dumps 21–37, iOS 436). Unlike the camera reel above, the user picks an existing
// clip from the library, so the journey starts on the profile, opens the clips
// gallery, edits, then walks the share sheets to publish. The captured body
// nav_chain of configure_to_clips is exactly this path:
//   IGProfileViewController:self_profile → IGStoryCameraViewController:clips_gallery
//   → …PostCaptureEditing…:clips_postcapture_camera
//   → IGSundialShareSheetViewController:clips_share_sheet
//   → IGSundialShareSheetV2ViewController:IGSundialShareSheetV2ViewController
//   → IGPublishScreenCaption…:ig_publish_screen_caption
//   → IGSundialNewNUXViewController:sundial-share-sheet
// The header x-ig-nav-chain on configure stays on feed_timeline (the user tabbed
// back to the feed while the async publish completed), so the full journey is
// rendered via detachedChain() into the request BODY only.
const REEL_GALLERY_EDIT: ScreenDef[] = [
  { vc: "IGProfileViewController", module: "self_profile", clickPoint: "main_profile" },
  { vc: "IGStoryCameraViewController", module: "clips_gallery" },
  {
    vc: "IGSundialPostCaptureEditingViewController.IGSundialPostCaptureEditingViewController",
    module: "clips_postcapture_camera",
  },
]

const REEL_GALLERY_SHARE: ScreenDef[] = [
  ...REEL_GALLERY_EDIT,
  { vc: "IGSundialShareSheetViewController", module: "clips_share_sheet" },
  { vc: "IGSundialShareSheetV2ViewController", module: "IGSundialShareSheetV2ViewController" },
]

const REEL_GALLERY: ScreenDef[] = [
  ...REEL_GALLERY_SHARE,
  {
    vc: "IGPublishScreenCaption.IGPublishScreenCaptionViewController",
    module: "ig_publish_screen_caption",
  },
  { vc: "IGSundialNewNUXViewController", module: "sundial-share-sheet" },
]

// Photo/feed post composer journey — verbatim from the captured media/configure/
// nav_chain (camera → capture → gallery → crop → filter → broadcast share →
// publish caption screen).
const POST_COMPOSER: ScreenDef[] = [
  { vc: "IGStoryCameraViewController", module: "reel_composer_camera" },
  { vc: "IGCameraNavigationController", module: "camera_nav" },
  { vc: "IGMediaCaptureViewController", module: "media_capture" },
  { vc: "IGMediaLibraryViewController", module: "feed_gallery" },
  { vc: "IGMediaCropViewController", module: "media_crop_view" },
  { vc: "IGPhotoEditorViewController", module: "photo_filter" },
  { vc: "IGBroadcastShareManager", module: "media_broadcast_share" },
  {
    vc: "IGPublishScreenCaption.IGPublishScreenCaptionViewController",
    module: "ig_publish_screen_caption",
  },
]

// Story composer journey — verbatim from the captured configure_to_story BODY
// nav_chain (profile → precapture camera → gallery → post-capture edit →
// composition). Note the story composer starts from the clips profile, distinct
// from the reel/photo composers which start from the camera.
const STORY_COMPOSER: ScreenDef[] = [
  { vc: "IGProfileViewController", module: "self_clips_profile", clickPoint: "main_profile" },
  { vc: "IGStoryCameraViewController", module: "stories_precapture_camera" },
  { vc: "IGStoryGalleryFirstViewController", module: "stories_gallery" },
  { vc: "IGStoryPostCaptureEditingViewController", module: "stories_postcapture_camera" },
  { vc: "IGStoryMediaCompositionEditingViewController", module: "reel_multiedit_composer" },
]

// UFAC (authenticity/selfie) checkpoint Bloks screens. Verified against a
// captured selfie_capture_flow_capture request whose
//   x-ig-client-endpoint = com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard:com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard
// and whose x-ig-nav-chain carries com.bloks.www.checkpoint.ufac.controller at
// an earlier position. For these Bloks screens the nav segment uses the full
// bloks module id as BOTH the VC and the module (so clientEndpoint() renders the
// "id:id" pair the server routes the flow instance by). Every UFAC wizard/capture
// request MUST sit on the authenticity_wizard screen or the server can't locate
// the flow instance and returns field_exception / "Payload returned is null".
const ufacController: ScreenDef = {
  vc: "com.bloks.www.checkpoint.ufac.controller",
  module: "com.bloks.www.checkpoint.ufac.controller",
}
const authenticityWizard: ScreenDef = {
  vc: "com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard",
  module: "com.bloks.www.ig.ixt.triggers.screen.authenticity_wizard",
}

export const NAV = {
  FEED: [S.feed],
  // The UFAC checkpoint controller (wizard fires FROM here) and the full path
  // ending on the authenticity_wizard screen (capture fires FROM here).
  UFAC_CONTROLLER: [ufacController],
  UFAC_WIZARD: [ufacController, authenticityWizard],
  REELS: [S.reels],
  COMMENTS: [S.comments],
  PROFILE: [S.profile],
  // Self profile with the plain self_profile module (reel composer open warmup).
  SELF_PROFILE: [S.selfProfile],
  // Viewing a target account (opened from feed while scrolling).
  USER_PROFILE: [S.feed, S.userProfile],
  EXPLORE: [S.feed, S.explore],
  EDIT_PROFILE,
  BIO: [...EDIT_PROFILE, S.bio],
  NAME: [...EDIT_PROFILE, S.name, S.customAlert],
  // The captured username flow (identity reminder + update) fires from the edit
  // profile screen itself — it doesn't push a dedicated username VC.
  USERNAME: EDIT_PROFILE,
  LINKS: [...EDIT_PROFILE, S.linksList],
  LINKS_CUSTOM: [...EDIT_PROFILE, S.linksList, S.linkCustom],
  SETTINGS: [S.profile, S.settings],
  PRIVACY: [S.profile, S.settings, S.privacy],
  // Full reel composer (used by configure_to_clips). The two earlier stages are
  // visited by upload_settings / rupload so the chain grows progressively.
  REEL_COMPOSER,
  REEL_COMPOSER_CROP,
  REEL_COMPOSER_EDIT,
  REEL_COMPOSER_SHARE,
  // Gallery reel (library clip) — used when posting a pre-made video, which is
  // exactly what our nodes do. REEL_GALLERY is the full body nav_chain for
  // configure_to_clips; the two earlier stages drive the header client-endpoint
  // as the upload progresses.
  REEL_GALLERY,
  REEL_GALLERY_EDIT,
  REEL_GALLERY_SHARE,
  POST_COMPOSER,
  STORY_COMPOSER,
} as const

// Actions (like / save / follow / comment) don't push a new screen — they fire
// from whatever surface the user is currently on. Callers pass the same
// `container_module` they send in the body; we make sure the nav chain's top
// reflects that surface so the header and body agree. If the chain is already
// sitting on that surface we leave it untouched; otherwise we navigate to it.
const MODULE_SCREEN: Record<string, ScreenDef> = {
  feed_timeline: S.feed,
  clips_viewer_clips_tab: S.reels,
  comments_v2: S.comments,
  profile: S.userProfile,
  self_clips_profile: S.profile,
  explore_popular: S.explore,
}

// Ensure the nav session is sitting on the surface an action fires from, then
// return the rendered chain so it can be echoed into the request body's
// `nav_chain` field (follow / save / configure_* all carry this).
export function actionChain(nav: NavSession, containerModule: string | undefined): string {
  const screen = containerModule ? MODULE_SCREEN[containerModule] : undefined
  if (screen && nav.currentModule() !== screen.module) {
    // Actions from the reels tab / comments / profile assume the user already
    // navigated there; seed that surface only if the chain isn't already on it.
    // feed_timeline and self_profile are reached directly from the tab bar;
    // everything else is entered from the feed.
    if (screen === S.feed || screen === S.profile) nav.visit([screen])
    else nav.visit([S.feed, screen])
  }
  return nav.chainString()
}
