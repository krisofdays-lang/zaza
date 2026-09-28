"""Reel publish vertical — byte-for-byte port of the TypeScript reel flow.

The public entrypoint is publish_reel_flow(), which reproduces the captured
gallery-reel publish end to end:

  1. composer opens from the profile        (warmup_composer_open)
  2. [human pause: browsing the gallery]
  3. clip chosen, crop screen               (warmup_media_chosen)
  4. [human pause: trimming / editing]
  5. upload_settings   (nav: post-capture editing screens)
  6. rupload_igvideo   (nav: share sheets)  - the video bytes
  7. rupload_igphoto   (cover frame, shared upload_id)  [best-effort]
  8. [human pause: typing the caption on the share sheet]
  9. header nav tabbed back to the feed
 10. configure_to_clips (async_publish:1, full body nav_chain)  - with retry
 11. post-publish resurrected-user check on the feed            [best-effort]

Warmup, cover upload and the post-publish check are all best-effort and never
abort the publish.
"""

from __future__ import annotations

import logging
import random
import time
import uuid as uuidlib

from .client import InstagramClient, gen_upper_uuid, random_hex
from .cover import extract_cover_frame
from .mp4 import probe_mp4, uniquify_mp4
from .nav_chain import ReelJourney
from .warmup import (
    post_publish,
    warmup_composer_open,
    warmup_media_chosen,
    warmup_share_eligibility,
    warmup_share_sheet_present,
)

log = logging.getLogger("ig.reel")

# --- human-pause ranges (ms) ------------------------------------------------
# Capped so back-to-back nodes stay responsive while keeping a manual cadence.
DEFAULT_DELAYS = {
    "pick": (1500, 5000),
    "edit": (6000, 22000),
    "caption": (2500, 9000),
}

# configure_to_clips retry budget (matches reel-publish.ts).
CONFIGURE_MAX_ATTEMPTS = 9
CONFIGURE_BACKOFF_S = [3, 5, 8, 12, 18, 25, 30, 30, 30]


def _wait_for(range_ms: tuple[int, int] | None) -> None:
    if not range_ms:
        return
    lo, hi = range_ms
    if hi <= 0:
        return
    lo = max(0, min(lo, hi))
    time.sleep((lo + random.random() * max(0, hi - lo)) / 1000.0)


# --- configure_to_clips success classifier (port of reelConfigureSucceeded) --

def reel_configure_succeeded(data: object) -> bool:
    if not isinstance(data, dict):
        return False
    status = data.get("status")
    if status and status != "ok":
        return False
    posts = data.get("posts")
    if isinstance(posts, list) and posts:
        def _ok(p: object) -> bool:
            if not isinstance(p, dict):
                return False
            err_type = (p.get("error_info") or {}).get("error_type")
            if err_type and err_type != "NO_ERROR":
                return False
            if p.get("status") == "COMPLETED":
                return True
            if p.get("status") in ("PENDING", "IN_PROGRESS"):
                mids = p.get("media_ids")
                return isinstance(mids, list) and len(mids) > 0
            return not p.get("status")
        return all(_ok(p) for p in posts)
    return status == "ok"


def _configure_reel(c: InstagramClient, upload_id: str, opts: dict, *, reuse_nav: bool):
    """Field-for-field copy of the captured media/configure_to_clips body."""
    w = opts.get("width") or 720
    h = opts.get("height") or 1280
    orig_w = opts.get("original_width") or w
    orig_h = opts.get("original_height") or h
    duration_ms = max(1, round(opts.get("duration_ms") or 15000))
    waterfall_id = opts.get("waterfall_id") or c.uuid
    publish_id = opts.get("publish_id") or str(int(time.time() * 1000))
    composition_id = opts.get("composition_id") or str(uuidlib.uuid4())
    colors = opts.get("colors") or {
        "averages": {"r": 128, "g": 128, "b": 128},
        "standard_deviations": {"r": 32, "g": 32, "b": 32},
    }
    # The full composer journey (screens 2-11) is supplied by the ReelJourney
    # and rides in the BODY, while the request HEADER stays on the cold-start
    # feed — exactly as the capture shows for media/configure_to_clips.
    nav_chain = opts.get("nav_chain") or ""
    return c.post(
        "/api/v1/media/configure_to_clips/",
        {
            "device_id": c.uuid,
            "clips_segments_metadata": {
                "num_segments": 1,
                "clips_segments": [
                    {
                        "original_segment_hash": str(uuidlib.uuid4()),
                        "x_transform": 0,
                        "media_type": "video",
                        "source": "library",
                        "source_type": "0",
                        "asset_media_subtype": [],
                        "face_effect_id": "",
                        "from_draft": "0",
                        "trimmed_start_time_ms": 0,
                        "index": 0,
                        "rotation": 0,
                        "y_transform": 0,
                        "speed": 100,
                        "original_media_type": 2,
                        "original_height": orig_h,
                        "media_folder": "",
                        "audio_type": "original",
                        "camera_position": 3,
                        "source_media_group_id": "",
                        "was_edited_by_ai_cut": "0",
                        "zoom": 1,
                        "duration_ms": duration_ms,
                        "source_media_id": None,
                        "original_width": orig_w,
                        "is_remix": "0",
                    }
                ],
            },
            "creation_tool_info": [],
            "sticker_ids": [],
            "third_party_downloads_enabled": "1",
            "smart_template_effect_id": "",
            "nav_chain": nav_chain,
            "effect_ids": [],
            "_uuid": c.uuid,
            "hide_from_profile_grid": "0",
            "like_and_view_counts_disabled": "0",
            "parent_template_clips_media_id": "",
            "clips_share_preview_to_feed": "1",
            "client_timestamp": str(int(time.time())),
            "is_gifting_enabled": "1",
            "capture_type": "clips_v2",
            "camera_upsell": "",
            "camera_session_id": waterfall_id,
            "ig_timeline_metadata": [
                {"action": "ADD", "surface_element": "STACKED_TIMELINE", "count": "1", "target": "VIDEO"}
            ],
            "publish_id": publish_id,
            "upload_id": upload_id,
            "camera_entry_point": 71,
            "source_type": "0",
            "caption": opts.get("caption") or "",
            "is_template_disabled": "0",
            "timezone_offset": c.timezone_offset_string,
            "create_pa_boost_post_access_token_not_expire": "false",
            "waterfall_id": waterfall_id,
            "overlay_data": [],
            "composition_id": composition_id,
            "funded_content_deal_id": "not_funded",
            "clips_creation_entry_point": "clips",
            "clips_audio_metadata": {"original": {"volume_level": 1}},
            "_uid": c.uid,
            "is_clips_edited": "0",
            "internal_features": "clips_format,clips_launch",
            "additional_audio_info": {"has_voiceover_attribution": "0"},
            "sticker_translations_enabled": "0",
            "text_overlay": [],
            "async_publish": "1",
            "filter_type": "0",
            "bottom_camera_dial_selected": 11,
            "contains_music_lyrics": "0",
            "stacked_timeline_metadata": [
                {"surface_element": "STACKED_TIMELINE", "action": "ADD", "target": "VIDEO", "count": "1"}
            ],
            "archive_only": "false",
            "is_paid_partnership": "false",
            "template_clips_media_id": "",
            "is_created_with_sound_sync": "1",
            "share_count_disabled": "0",
            "is_created_with_contextual_music_recs": "0",
            "quality_hints": {
                "colors": {
                    "sampled_standard_deviations": colors["standard_deviations"],
                    "sampled_averages": colors["averages"],
                }
            },
            "video_effects": [],
        },
        "media/configure_to_clips/",
    )


def _summarize_body(data: object) -> str:
    if data is None:
        return ""
    if isinstance(data, str):
        return data[:300]
    try:
        import json
        return json.dumps(data)[:300]
    except Exception:  # noqa: BLE001
        return str(data)[:300]


def configure_reel_with_retry(c: InstagramClient, upload_id: str, opts: dict) -> dict:
    """HTTP 202 = accepted, still transcoding. Re-POST is safe (IG dedupes on
    upload_id), so we poll with backoff until published or the budget expires."""
    last_status = 0
    last_detail = ""
    for attempt in range(CONFIGURE_MAX_ATTEMPTS):
        processing = False
        try:
            conf = _configure_reel(c, upload_id, opts, reuse_nav=attempt > 0)
            last_status = conf.status
            last_detail = _summarize_body(conf.data)
            if conf.ok and conf.status != 202 and reel_configure_succeeded(conf.data):
                return {"ok": True, "status": conf.status, "data": conf.data}
            body_processing = conf.status == 200 and not reel_configure_succeeded(conf.data)
            processing = conf.status == 202 or body_processing
            if not processing:
                return {"ok": False, "status": conf.status, "detail": last_detail}
        except Exception as e:  # noqa: BLE001 - network blip is retryable
            last_detail = str(e)
            processing = True
        if attempt < CONFIGURE_MAX_ATTEMPTS - 1:
            time.sleep(CONFIGURE_BACKOFF_S[attempt])
    return {"ok": False, "status": last_status or 202, "detail": last_detail or "still_processing"}


def _extract_media_id(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    media = data.get("media")
    if isinstance(media, dict):
        if isinstance(media.get("id"), str) and media["id"]:
            return media["id"]
        pk = media.get("pk")
        if isinstance(pk, str) and pk:
            return pk
        if isinstance(pk, (int, float)):
            return str(pk)
    if isinstance(data.get("media_id"), str) and data["media_id"]:
        return data["media_id"]
    return None


def publish_reel_flow(
    c: InstagramClient,
    buffer: bytes,
    *,
    caption: str = "",
    fallback_width: int | None = None,
    fallback_height: int | None = None,
    delays: dict | None | bool = None,
) -> dict:
    """Publish one reel for one account. Never raises for expected failure modes;
    returns {"ok": False, "detail": ...} so the caller can log the real reason."""
    active_delays: dict | None
    if delays is False:
        active_delays = None
    else:
        active_delays = {**DEFAULT_DELAYS, **(delays or {})} if delays is not True else dict(DEFAULT_DELAYS)

    probe = probe_mp4(buffer)
    width = (probe.width if probe else None) or fallback_width or 720
    height = (probe.height if probe else None) or fallback_height or 1280
    duration_ms = (probe.duration_ms if probe else None) or 15000
    # Unique bytes so IG can't dedupe two reels that share one source file.
    upload_buffer = uniquify_mp4(buffer)
    upload_id = str(int(time.time() * 1000))
    waterfall_id = random_hex(32)
    publish_id = str(int(time.time() * 1000) + random.randint(0, 999))
    composition_id = gen_upper_uuid()
    # One per-upload entity UUID shared by upload_settings + rupload_igvideo so
    # both halves land on the same /upload_settings|rupload_igvideo/{uuid} path.
    entity_id = gen_upper_uuid()

    # The entire journey replays the captured gallery-reel nav-chain. The
    # ReelJourney overrides the generic nav stack: every request below carries
    # the exact x-ig-nav-chain / x-ig-client-endpoint the app sent, with the
    # right non-sequential positions (2,4,5,8,9,10,11) and no truncation.
    journey = ReelJourney(c.nav)
    c.nav_override = journey
    try:
        # 1) Composer opens from the profile (screen 2).
        warmup_composer_open(c)
        # 2) Human browses the gallery and picks a clip.
        if active_delays:
            _wait_for(active_delays.get("pick"))
        # 3) Clip chosen -> gallery(4) -> editor flicker(5,6,7) -> editor(5).
        warmup_media_chosen(c)
        # 4) Human trims / edits before hitting share.
        if active_delays:
            _wait_for(active_delays.get("edit"))

        # 5) Share-intent eligibility/promo probes (reqs 21-25) still on the
        #    post-capture editor (screen 5).
        warmup_share_eligibility(c)

        # 6) The video uploads from the post-capture editor (screen 5) BEFORE the
        #    share sheet opens: upload_settings + rupload_igvideo both carry chain
        #    2:4:5 (capture reqs 26-27) and share one per-upload entity UUID.
        journey.enter("edit")
        try:
            c.upload_settings(
                upload_id=upload_id,
                waterfall_id=waterfall_id,
                duration_ms=duration_ms,
                width=width,
                height=height,
                file_size=len(upload_buffer),
                codec=probe.codec if probe else None,
                frame_rate=probe.frame_rate if probe else None,
                has_audio=probe.has_audio if probe else None,
                rotation_angle=probe.rotation_angle if probe else None,
                entity_id=entity_id,
            )
        except Exception as err:  # noqa: BLE001 - best-effort
            log.debug("upload_settings skipped: %s", err)

        up = c.upload_video(
            upload_buffer,
            upload_id=upload_id,
            waterfall_id=waterfall_id,
            duration_ms=duration_ms,
            width=width,
            height=height,
            entity_id=entity_id,
        )
        if not up.ok:
            return {"ok": False, "status": up.status, "detail": _summarize_body(up.data), "upload_id": upload_id}

        # 7) Share sheet is presented -> screens 8,9,10,11 all push on at once
        #    (there is no intermediate 2:4:5:8:9 in the capture). The cover frame
        #    (rupload_igphoto, req 29) uploads from this full chain, alongside the
        #    share background burst (reqs 28-32).
        journey.enter("share")
        colors = None
        try:
            cover = extract_cover_frame(buffer, 0)
            if cover:
                colors = {"averages": cover.colors.averages, "standard_deviations": cover.colors.standard_deviations}
                c.upload_reel_cover(cover.jpeg, upload_id=upload_id)
        except Exception as err:  # noqa: BLE001
            log.debug("reel cover upload skipped: %s", err)

        warmup_share_sheet_present(c)

        # 8) Human types the caption.
        if active_delays:
            _wait_for(active_delays.get("caption"))

        # 10) configure_to_clips: the HEADER resets to cold-start feed while the
        #     full composer journey rides the request BODY's nav_chain field.
        journey.enter("configure")

        # 11) configure_to_clips with retry (HTTP 202 = still transcoding). The
        #     full composer journey is echoed into the request BODY's nav_chain.
        conf = configure_reel_with_retry(
            c,
            upload_id,
            {
                "caption": caption,
                "width": width,
                "height": height,
                "duration_ms": duration_ms,
                "waterfall_id": waterfall_id,
                "original_width": width,
                "original_height": height,
                "publish_id": publish_id,
                "composition_id": composition_id,
                "colors": colors,
                "nav_chain": journey.body_chain(),
            },
        )

        # 12) Post-publish follow-ups (best-effort) on the cold-start feed.
        if conf["ok"]:
            post_publish(c, _extract_media_id(conf.get("data")))
    finally:
        # Never leak the reel journey onto subsequent unrelated requests.
        c.nav_override = None

    return {"ok": conf["ok"], "status": conf["status"], "detail": conf.get("detail"), "upload_id": upload_id}
