"""Pigeon session + navigation-chain modeling for the private IG iOS API.

Ported 1:1 from lib/instagram/nav-chain.ts. The real app attaches three headers
to essentially every request:

    x-pigeon-session-id     per-foreground-session UUID, rotates every ~20-30 min
    x-pigeon-rawclienttime  unix seconds (sub-second precision), fresh each request
    x-ig-nav-chain          the screen back-stack the user walked to reach the view

x-ig-client-endpoint is always the LAST segment's "VC:module". For action
endpoints the same chain is duplicated into the request body as nav_chain.

One NavSession lives on each InstagramClient; the chain/position grow naturally
across sequential requests and only reset when the pigeon session rotates.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Protocol


class ClockSource(Protocol):
    def now_ms(self) -> float: ...
    def random(self) -> float: ...


@dataclass(frozen=True)
class ScreenDef:
    vc: str
    module: str
    click_point: str = ""


@dataclass
class _Segment:
    vc: str
    module: str
    click_point: str
    position: int
    enter: float  # unix seconds


# Session rotation window, mirroring instagrapi's pigeon-session behavior.
_SESSION_MIN_MS = 20 * 60 * 1000
_SESSION_MAX_MS = 30 * 60 * 1000
# Bound the rendered chain; overflow beyond this collapses into TRUNCATEDxN.
_MAX_SEGMENTS = 12
_KEEP_HEAD = 1

# Cold-start root, matching the captured configure header exactly.
_ROOT = ScreenDef("IGMainFeedViewController", "feed_timeline", "cold_start")


def _now_sec() -> float:
    return time.time()


def _rand(lo: float, hi: float) -> float:
    return lo + random.random() * (hi - lo)


def _upper_uuid() -> str:
    s = "".join(random.choice("0123456789abcdef") for _ in range(32))
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:]}".upper()


class NavSession:
    def __init__(self, clock_source: "ClockSource | None" = None) -> None:
        self._clock = clock_source
        self._session_id = ""
        self._session_expiry = 0.0  # ms epoch
        self._session_counter = 0
        self._position = 0
        self._last_ts = 0.0
        self._stack: list[_Segment] = []
        self._reset_session()

    def _now_ms(self) -> float:
        return self._clock.now_ms() if self._clock else time.time() * 1000

    def _rand(self, lo: float = 0.0, hi: float = 1.0) -> float:
        r = self._clock.random() if self._clock else random.random()
        return lo + r * (hi - lo)

    def _reset_session(self) -> None:
        self._session_counter += 1
        self._session_id = _upper_uuid()
        self._session_expiry = self._now_ms() + self._rand(_SESSION_MIN_MS, _SESSION_MAX_MS)
        self._position = 0
        self._last_ts = 0.0
        self._stack = []
        self._push_screen(_ROOT)

    def _ensure_session(self) -> None:
        if not self._session_id or self._now_ms() >= self._session_expiry:
            self._reset_session()

    def get_session_id(self) -> str:
        self._ensure_session()
        return self._session_id

    def raw_client_time(self) -> str:
        return f"{self._now_ms() / 1000:.6f}"

    def _next_ts(self) -> float:
        t = max(self._now_ms() / 1000, self._last_ts + self._rand(0.1, 1.4))
        self._last_ts = t
        return t

    def _push_screen(self, s: ScreenDef) -> None:
        self._position += 1
        self._stack.append(
            _Segment(s.vc, s.module, s.click_point, self._position, self._next_ts())
        )

    def visit(self, path: list[ScreenDef] | tuple[ScreenDef, ...]) -> None:
        """Navigate along a screen path, reconciling with the current stack tail
        so an already-active context isn't re-pushed."""
        self._ensure_session()
        if not path:
            return
        max_k = min(len(self._stack), len(path))
        k = 0
        for cand in range(max_k, -1, -1):
            ok = True
            for i in range(cand):
                seg = self._stack[len(self._stack) - cand + i]
                scr = path[i]
                if seg.vc != scr.vc or seg.module != scr.module:
                    ok = False
                    break
            if ok:
                k = cand
                break
        for i in range(k, len(path)):
            self._push_screen(path[i])

    def _render_segments(self, segs: list[_Segment]) -> list[str]:
        out: list[str] = []
        for i, seg in enumerate(segs):
            # A screen's exit is when the next screen was entered; the current
            # (last) screen has enter == exit, matching captured chains.
            exit_ts = segs[i + 1].enter if i < len(segs) - 1 else seg.enter
            out.append(
                f"{seg.vc}:{seg.module}:{seg.position}:{seg.click_point}:"
                f"{seg.enter:.6f}:::{exit_ts:.6f}"
            )
        return out

    def _collapse(self, segs: list[_Segment]) -> str:
        if len(segs) <= _MAX_SEGMENTS:
            return ",".join(self._render_segments(segs))
        head = segs[:_KEEP_HEAD]
        tail_count = _MAX_SEGMENTS - _KEEP_HEAD
        tail = segs[len(segs) - tail_count:]
        collapsed = len(segs) - len(head) - len(tail)
        return ",".join(
            [*self._render_segments(head), f"TRUNCATEDx{collapsed}", *self._render_segments(tail)]
        )

    def chain_string(self) -> str:
        self._ensure_session()
        return self._collapse(self._stack)

    def detached_chain(self, path: list[ScreenDef] | tuple[ScreenDef, ...]) -> str:
        """Render a self-contained chain for a screen path WITHOUT mutating the
        shared stack. Used where the request carries a full composer chain in the
        BODY while the header nav-chain stays on the current screen."""
        self._ensure_session()
        if not path:
            return self.chain_string()
        segs: list[_Segment] = []
        for s in path:
            self._position += 1
            segs.append(_Segment(s.vc, s.module, s.click_point, self._position, self._next_ts()))
        return self._collapse(segs)

    def current_module(self) -> str:
        return self._stack[-1].module if self._stack else ""

    def client_endpoint(self) -> str:
        self._ensure_session()
        top = self._stack[-1] if self._stack else None
        return f"{top.vc}:{top.module}" if top else f"{_ROOT.vc}:{_ROOT.module}"


# ---------------------------------------------------------------------------
# Screen registry — every VC:module below is taken verbatim from captured
# traffic of the real iOS app. Paths are ordered root-most first.
# ---------------------------------------------------------------------------

_S = {
    "feed": ScreenDef("IGMainFeedViewController", "feed_timeline"),
    "reels": ScreenDef("IGSundialFeedViewController", "clips_viewer_clips_tab", "main_discover_video"),
    "comments": ScreenDef("IGCommentThreadViewController", "comments_v2", "media_comments"),
    "profile": ScreenDef("IGProfileViewController", "self_clips_profile", "main_profile"),
    "self_profile": ScreenDef("IGProfileViewController", "self_profile", "main_profile"),
    "user_profile": ScreenDef("IGProfileViewController", "profile", "username"),
    "explore": ScreenDef("IGExploreGridViewController", "explore_popular", "search_tab"),
    "edit_profile": ScreenDef("IGEditProfileViewController", "edit_profile"),
    "bio": ScreenDef("IGEditProfileBioViewController", "edit_profile"),
    "name": ScreenDef("IGEditProfileNameViewController", "edit-profile-name"),
    "custom_alert": ScreenDef("IGCustomAlertViewController", "custom_alert"),
    "links_list": ScreenDef("IGEditProfileMultipleLinksViewController", "edit_profile_links_list"),
    "link_custom": ScreenDef(
        "IGEditProfileMultipleLinksCustomLinkViewController",
        "edit-profile-bio-links-custom-link",
    ),
    "settings": ScreenDef("IGSettings2Renderer", "main_settings_screen"),
    "privacy": ScreenDef("IGSettings2Renderer", "account_privacy"),
}

_EDIT_PROFILE = [_S["profile"], _S["edit_profile"]]

_REEL_COMPOSER_CROP = [
    ScreenDef("IGStoryCameraViewController", "reel_composer_camera", "main_camera"),
    ScreenDef("IGCameraNavigationController", "camera_nav"),
    ScreenDef("IGMediaCaptureViewController", "media_capture"),
    ScreenDef("IGMediaLibraryViewController", "feed_gallery"),
    ScreenDef("IGMediaCropViewController", "media_crop_view"),
]

_REEL_COMPOSER_EDIT = [
    *_REEL_COMPOSER_CROP,
    ScreenDef(
        "IGSundialPostCaptureEditingViewController.IGSundialPostCaptureEditingViewController",
        "clips_postcapture_camera",
    ),
    ScreenDef(
        "IGSundialPostcaptureSwift.IGSundialMediaCompositionEditingViewController",
        "reel_multiedit_composer",
    ),
    ScreenDef("IGStoryMediaCompositionEditingViewController", "clips_postcapture_camera"),
]

_REEL_COMPOSER_SHARE = [
    *_REEL_COMPOSER_EDIT,
    ScreenDef("IGSundialShareSheetViewController", "panavideo_share_sheet"),
    ScreenDef("IGSundialShareSheetV2ViewController", "IGSundialShareSheetV2ViewController"),
]

_REEL_COMPOSER = [
    *_REEL_COMPOSER_SHARE,
    ScreenDef("IGSundialShareSheetNux.IGSundialOaReuseNuxViewController", "reels_oa_reuse_nux"),
]

_REEL_GALLERY_EDIT = [
    ScreenDef("IGProfileViewController", "self_profile", "main_profile"),
    ScreenDef("IGStoryCameraViewController", "clips_gallery"),
    ScreenDef(
        "IGSundialPostCaptureEditingViewController.IGSundialPostCaptureEditingViewController",
        "clips_postcapture_camera",
    ),
]

_REEL_GALLERY_SHARE = [
    *_REEL_GALLERY_EDIT,
    ScreenDef("IGSundialShareSheetViewController", "clips_share_sheet"),
    ScreenDef("IGSundialShareSheetV2ViewController", "IGSundialShareSheetV2ViewController"),
]

_REEL_GALLERY = [
    *_REEL_GALLERY_SHARE,
    ScreenDef("IGPublishScreenCaption.IGPublishScreenCaptionViewController", "ig_publish_screen_caption"),
    ScreenDef("IGSundialNewNUXViewController", "sundial-share-sheet"),
]

_POST_COMPOSER = [
    ScreenDef("IGStoryCameraViewController", "reel_composer_camera"),
    ScreenDef("IGCameraNavigationController", "camera_nav"),
    ScreenDef("IGMediaCaptureViewController", "media_capture"),
    ScreenDef("IGMediaLibraryViewController", "feed_gallery"),
    ScreenDef("IGMediaCropViewController", "media_crop_view"),
    ScreenDef("IGPhotoEditorViewController", "photo_filter"),
    ScreenDef("IGBroadcastShareManager", "media_broadcast_share"),
    ScreenDef("IGPublishScreenCaption.IGPublishScreenCaptionViewController", "ig_publish_screen_caption"),
]

_STORY_COMPOSER = [
    ScreenDef("IGProfileViewController", "self_clips_profile", "main_profile"),
    ScreenDef("IGStoryCameraViewController", "stories_precapture_camera"),
    ScreenDef("IGStoryGalleryFirstViewController", "stories_gallery"),
    ScreenDef("IGStoryPostCaptureEditingViewController", "stories_postcapture_camera"),
    ScreenDef("IGStoryMediaCompositionEditingViewController", "reel_multiedit_composer"),
]


class _Nav:
    FEED = [_S["feed"]]
    REELS = [_S["reels"]]
    COMMENTS = [_S["comments"]]
    PROFILE = [_S["profile"]]
    SELF_PROFILE = [_S["self_profile"]]
    USER_PROFILE = [_S["feed"], _S["user_profile"]]
    EXPLORE = [_S["feed"], _S["explore"]]
    EDIT_PROFILE = _EDIT_PROFILE
    BIO = [*_EDIT_PROFILE, _S["bio"]]
    NAME = [*_EDIT_PROFILE, _S["name"], _S["custom_alert"]]
    USERNAME = _EDIT_PROFILE
    LINKS = [*_EDIT_PROFILE, _S["links_list"]]
    LINKS_CUSTOM = [*_EDIT_PROFILE, _S["links_list"], _S["link_custom"]]
    SETTINGS = [_S["profile"], _S["settings"]]
    PRIVACY = [_S["profile"], _S["settings"], _S["privacy"]]
    REEL_COMPOSER = _REEL_COMPOSER
    REEL_COMPOSER_CROP = _REEL_COMPOSER_CROP
    REEL_COMPOSER_EDIT = _REEL_COMPOSER_EDIT
    REEL_COMPOSER_SHARE = _REEL_COMPOSER_SHARE
    REEL_GALLERY = _REEL_GALLERY
    REEL_GALLERY_EDIT = _REEL_GALLERY_EDIT
    REEL_GALLERY_SHARE = _REEL_GALLERY_SHARE
    POST_COMPOSER = _POST_COMPOSER
    STORY_COMPOSER = _STORY_COMPOSER


NAV = _Nav()

# Actions (like/save/follow/comment) don't push a new screen — they fire from
# whatever surface the user is currently on.
_MODULE_SCREEN: dict[str, ScreenDef] = {
    "feed_timeline": _S["feed"],
    "clips_viewer_clips_tab": _S["reels"],
    "comments_v2": _S["comments"],
    "profile": _S["user_profile"],
    "self_clips_profile": _S["profile"],
    "explore_popular": _S["explore"],
}


def action_chain(nav: NavSession, container_module: str | None) -> str:
    """Ensure the nav session sits on the surface an action fires from, then
    return the rendered chain to echo into the request body's nav_chain."""
    screen = _MODULE_SCREEN.get(container_module) if container_module else None
    if screen and nav.current_module() != screen.module:
        if screen is _S["feed"] or screen is _S["profile"]:
            nav.visit([screen])
        else:
            nav.visit([_S["feed"], screen])
    return nav.chain_string()


# ===========================================================================
# ReelJourney — capture-accurate nav-chain for the gallery reel post.
#
# Ported directly from the 37-request capture (profile -> clips_gallery reel
# journey), NOT synthesized. Key facts the capture proves that a naive growing
# stack gets wrong:
#
#   * Positions are NON-sequential: 2, 4, 5, (6, 7 transient), 8, 9, 10, 11.
#     They come from a global screen counter that also counted screens which
#     never appear in this chain (cold-start feed=1, a skipped 3, etc.). We bake
#     the real numbers instead of counting 1,2,3,...
#   * Screens 6 & 7 (reel_multiedit_composer, clips_postcapture_camera) FLICKER:
#     they appear only in the sticker_tray burst (reqs 17-19) then get popped.
#   * The chain never truncates here (7 visible segments max) — a TRUNCATEDxN is
#     an automation tell for this journey.
#   * At configure_to_clips the HEADER x-ig-nav-chain RESETS to a fresh
#     feed_timeline:1:cold_start, while the full composer journey rides in the
#     request BODY's nav_chain field.
#
# Each stage maps a flow checkpoint to the exact set of visible segments. Enter
# timestamps preserve the capture's relative deltas but are anchored to "now",
# and the live (last) segment's exit tracks the current request time.
# ===========================================================================

# Baked segments: (key, vc, module, click_point, position). Deltas below are the
# real inter-screen gaps (seconds) observed in the capture, from journey start.
_RJ_SEG = {
    "profile": ("IGProfileViewController", "self_profile", "main_profile", 2),
    "gallery": ("IGStoryCameraViewController", "clips_gallery", "", 4),
    "edit": (
        "IGSundialPostCaptureEditingViewController.IGSundialPostCaptureEditingViewController",
        "clips_postcapture_camera",
        "",
        5,
    ),
    "multiedit": (
        "IGSundialPostcaptureSwift.IGSundialMediaCompositionEditingViewController",
        "reel_multiedit_composer",
        "",
        6,
    ),
    "edit2": ("IGStoryMediaCompositionEditingViewController", "clips_postcapture_camera", "", 7),
    "share": ("IGSundialShareSheetViewController", "clips_share_sheet", "", 8),
    "sharev2": (
        "IGSundialShareSheetV2ViewController",
        "IGSundialShareSheetV2ViewController",
        "",
        9,
    ),
    "caption": (
        "IGPublishScreenCaption.IGPublishScreenCaptionViewController",
        "ig_publish_screen_caption",
        "",
        10,
    ),
    "nux": ("IGSundialNewNUXViewController", "sundial-share-sheet", "", 11),
}

# Relative enter offsets (seconds from journey start), from the capture.
_RJ_ENTER = {
    "profile": 0.0,
    "gallery": 1.6,
    "edit": 183.8,
    "multiedit": 183.87,
    "edit2": 183.88,
    "share": 516.45,
    "sharev2": 516.46,
    "caption": 683.42,
    "nux": 688.89,
}

# The visible stack at each flow checkpoint (ordered root-most first).
_RJ_STAGES: dict[str, list[str]] = {
    "profile": ["profile"],
    "gallery": ["profile", "gallery"],
    "edit_flicker": ["profile", "gallery", "edit", "multiedit", "edit2"],
    # edit: post-capture editor (screen 5). The video upload_settings +
    # rupload_igvideo (capture reqs 26-27) fire from HERE -> chain 2:4:5. The
    # capture never shows an intermediate 2:4:5:8:9, so there is no share_upload
    # stage: it jumps straight from 2:4:5 to the full 2:4:5:8:9:10:11.
    "edit": ["profile", "gallery", "edit"],
    # share: full share sheet (screens 8-11). The cover rupload_igphoto (req 29)
    # and the share background burst (reqs 28-32) fire from here.
    "share": ["profile", "gallery", "edit", "share", "sharev2", "caption", "nux"],
    # back_to_profile: share sheet dismissed, app returns to the profile (reqs
    # 33-34, survey + feed config prefetch) -> self_profile:2.
    "back_to_profile": ["profile"],
}

_RJ_STAGE_ORDER = [
    "profile", "gallery", "edit_flicker", "edit", "share", "back_to_profile", "configure",
]

# Cold-start feed root the configure HEADER resets to (verbatim from req #35).
_RJ_FEED_ROOT = ("IGHomeMainFeed.IGHomeMainFeedViewController", "feed_timeline", "cold_start", 1)


class ReelJourney:
    """Replays the captured gallery-reel nav-chain. One instance per publish."""

    def __init__(self, session: NavSession) -> None:
        self._session = session  # reuse pigeon session-id / rawclienttime
        self._t0 = _now_sec()
        self._stage = "profile"
        self._feed_root_enter = self._t0 - 3.0  # feed cold-started just before

    # -- session passthrough (headers shared with the rest of the app) --------
    def get_session_id(self) -> str:
        return self._session.get_session_id()

    def raw_client_time(self) -> str:
        return self._session.raw_client_time()

    # -- stage control ---------------------------------------------------------
    def enter(self, stage: str) -> None:
        # "configure" is a virtual stage: it renders the cold-start feed header
        # (see header_chain / client_endpoint) rather than a visible stack.
        if stage != "configure" and stage not in _RJ_STAGES:
            raise ValueError(f"unknown reel stage: {stage}")
        self._stage = stage

    def _segments(self, keys: list[str]) -> list[_Segment]:
        segs: list[_Segment] = []
        for k in keys:
            vc, module, click, pos = _RJ_SEG[k]
            segs.append(_Segment(vc, module, click, pos, self._t0 + _RJ_ENTER[k]))
        return segs

    def _render(self, segs: list[_Segment], live_exit: float) -> str:
        out: list[str] = []
        for i, seg in enumerate(segs):
            # Non-live screens froze their exit at the next screen's enter; the
            # live (top) screen's exit is the current request time.
            exit_ts = segs[i + 1].enter if i < len(segs) - 1 else live_exit
            out.append(
                f"{seg.vc}:{seg.module}:{seg.position}:{seg.click_point}:"
                f"{seg.enter:.6f}:::{exit_ts:.6f}"
            )
        return ",".join(out)

    def header_chain(self) -> str:
        """x-ig-nav-chain header for the current stage."""
        # ONLY configure_to_clips and the post-publish feed follow-ups RESET the
        # header to a fresh cold-start feed (feed_timeline:1); the composer
        # journey rides the request body only. back_to_profile still renders the
        # visible profile stack (self_profile:2), matching reqs 33-34.
        if self._stage == "configure":
            return self.configure_header_chain()
        segs = self._segments(_RJ_STAGES[self._stage])
        return self._render(segs, live_exit=_now_sec())

    # NavSession-compatible alias so the client can treat a ReelJourney as a
    # drop-in nav override when building request headers.
    def chain_string(self) -> str:
        return self.header_chain()

    def client_endpoint(self) -> str:
        if self._stage == "configure":
            return self.configure_endpoint()
        top = _RJ_STAGES[self._stage][-1]
        vc, module, _click, _pos = _RJ_SEG[top]
        return f"{vc}:{module}"

    def configure_header_chain(self) -> str:
        """At configure_to_clips the header RESETS to a fresh cold-start feed."""
        vc, module, click, pos = _RJ_FEED_ROOT
        now = _now_sec()
        return f"{vc}:{module}:{pos}:{click}:{self._feed_root_enter:.6f}:::{now:.6f}"

    def configure_endpoint(self) -> str:
        vc, module, _c, _p = _RJ_FEED_ROOT
        return f"{vc}:{module}"

    def body_chain(self) -> str:
        """Full composer journey echoed into the configure_to_clips BODY."""
        segs = self._segments(_RJ_STAGES["share"])
        # In the body the top (nux) screen's exit equals its enter (frozen).
        return self._render(segs, live_exit=segs[-1].enter)
