"""InstagramClient: header assembly + post/get/graphql/upload primitives.

Ported 1:1 from lib/instagram/client.ts. One client is created per account per
publish; it owns a NavSession (nav chain + pigeon session) and captures the
server-issued www-claim / regional rur in memory for the lifetime of the call.

Unlike the TS version it does NOT touch the database — the refreshed claim/rur are
returned to Next.js via the API response so the caller persists them.
"""

from __future__ import annotations

import base64
import json
import random
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from .config import APP_ID, BASE_URL, BLOKS_PRISM_HEADERS, BLOKS_VERSION_ID
from .devices import (
    PINNED_IG_APP_VERSION,
    build_user_agent,
    locale_headers,
    normalize_locale,
    resolve_ios_for_model,
    tz_offset_seconds,
)
from .models import Account
from .nav_chain import NavSession
from .transport import build_client


# ── JS-compatible serialization ────────────────────────────────────────────
# Match JSON.stringify (compact separators, no ASCII escaping) and
# encodeURIComponent so signed bodies / rupload params are byte-identical to the
# TypeScript client's wire output.
def js_json(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def encode_uri_component(s: str) -> str:
    # encodeURIComponent leaves A-Za-z0-9 and -_.!~*'() unescaped.
    return quote(s, safe="!~*'()")


def random_hex(length: int) -> str:
    return "".join(random.choice("0123456789abcdef") for _ in range(length))


def gen_upper_uuid() -> str:
    h = random_hex(32)
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}".upper()


def rupload_body_ok(data: Any) -> bool:
    """Resumable-upload endpoints answer 200 the moment they ACCEPT the
    connection; only { "status": "ok" } in the body confirms the entity is
    complete. Gate configure on this, not on HTTP status."""
    obj = data
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except ValueError:
            return False
    if not isinstance(obj, dict):
        return False
    return obj.get("status") == "ok"


@dataclass
class IgResponse:
    ok: bool
    status: int
    data: Any
    url: str
    error: str | None = None


@dataclass
class UploadResult:
    ok: bool
    status: int
    upload_id: str
    data: Any


def decode_bearer(bearer: str) -> tuple[str, str]:
    """Bearer tokens look like IGT:2:<base64-json> carrying ds_user_id +
    sessionid. Returns (ds_user_id, session_id)."""
    try:
        raw = bearer
        if raw.lower().startswith("bearer "):
            raw = raw[7:]
        raw = raw.strip()
        b64 = raw.split(":")[-1]
        b64 += "=" * (-len(b64) % 4)  # Python needs padding; JS Buffer tolerates none
        decoded = base64.b64decode(b64)
        obj = json.loads(decoded.decode("utf-8"))
        return str(obj.get("ds_user_id", "")), str(obj.get("sessionid", ""))
    except Exception:
        return "", ""


class InstagramClient:
    def __init__(self, account: Account) -> None:
        self.account = account
        self._ds_user_id, self._session_id = decode_bearer(account.bearer_token)
        self.nav = NavSession()
        # When set (e.g. to a ReelJourney), its header chain / endpoint override
        # the generic nav stack for the duration of a scripted publish flow.
        self.nav_override = None
        self._rur = ""
        self._net: dict[str, float] | None = None
        self._http = build_client(account)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "InstagramClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ── identity accessors (mirror the TS getters) ──────────────────────────
    @property
    def uid(self) -> str:
        return self.account.ig_user_id or self._ds_user_id

    @property
    def uuid(self) -> str:
        return self.account.device_id

    @property
    def device_type(self) -> str:
        return self.account.iphone_model or "iPhone11,8"

    @property
    def phone_id(self) -> str:
        # Body `phone_id`: the blob's real phone_id, distinct from the family
        # device id (which feeds the x-ig-family-device-id header). Falls back
        # for older accounts captured before phone_id was stored separately.
        return self.account.phone_id_field or self.account.family_device_id or self.account.device_id

    @property
    def ios_version(self) -> str:
        return resolve_ios_for_model(self.account.iphone_model, self.account.ios_version)

    @property
    def locale(self) -> str:
        return normalize_locale(self.account.locale)

    @property
    def timezone(self) -> str:
        return (self.account.timezone or "").strip() or "Europe/Moscow"

    @property
    def timezone_offset_seconds(self) -> int:
        return tz_offset_seconds(self.timezone)

    @property
    def timezone_offset_string(self) -> str:
        return str(self.timezone_offset_seconds)

    @property
    def claim(self) -> str:
        return self.account.claim

    @property
    def rur(self) -> str:
        return self._rur

    # ── synthetic per-run network telemetry ─────────────────────────────────
    @property
    def _net_baseline(self) -> dict[str, float]:
        if self._net is None:
            self._net = {
                "base_kbps": 450 + random.randint(0, 899),
                "rtt_base": 2 + random.randint(0, 5),
            }
        return self._net

    def _bandwidth_headers(self) -> dict[str, str]:
        def jitter(base: float, pct: float) -> float:
            return base * (1 + (random.random() * 2 - 1) * pct)

        net = self._net_baseline
        kbps = jitter(net["base_kbps"], 0.15)
        sensitive = kbps * (0.95 + random.random() * 0.05)
        rtt = max(1, round(jitter(net["rtt_base"], 0.4)))
        c = 60 + random.randint(0, 139)
        tbw = 30000 + random.randint(0, 89999)
        uplat = 30 + random.randint(0, 299)
        conn_speed = max(10, round(kbps * (0.2 + random.random() * 0.5)))
        cm_kbps = max(20.0, jitter(net["base_kbps"] * 0.3, 0.5))
        cm_latency = max(1.0, jitter(net["rtt_base"] * 0.6, 0.5))
        abr_kbps = max(20, round(jitter(net["base_kbps"] * 0.25, 0.4)))
        return {
            "x-ig-bandwidth-speed-kbps": f"{kbps:.3f}",
            "x-ig-bandwidth-speed-kbps-sensitive": f"{sensitive:.3f}",
            "x-ig-connection-speed": f"{conn_speed}kbps",
            "x-cm-bandwidth-kbps": f"{cm_kbps:.3f}",
            "x-cm-latency": f"{cm_latency:.3f}",
            "x-ig-abr-connection-speed-kbps": str(abr_kbps),
            "x-fb-connection-quality": (
                f"EXCELLENT; q=0.9, rtt={rtt}, rtx=0, c={c}, mss=1380, tbw={tbw}, "
                f"tp=-1, tpl=-1, uplat={uplat}, ullat=0"
            ),
        }

    def _bearer(self) -> str:
        b = self.account.bearer_token.strip()
        return b if b.lower().startswith("bearer ") else f"Bearer {b}"

    def _base_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        uid = self.uid
        loc = locale_headers(self.locale)
        headers: dict[str, str] = {
            "accept-language": loc.accept_language,
            "authorization": self._bearer(),
            "ig-intended-user-id": uid,
            "ig-u-ds-user-id": uid,
            "user-agent": build_user_agent(
                app_version=PINNED_IG_APP_VERSION,
                iphone_model=self.account.iphone_model,
                ios_version=self.ios_version,
                locale=self.locale,
            ),
            "x-ig-app-id": APP_ID,
            "x-ig-app-locale": loc.app_locale,
            "x-ig-device-id": self.account.device_id,
            "x-device-id": self.account.device_id,
            "x-ig-device-locale": loc.device_locale,
            "x-ig-family-device-id": self.phone_id,
            "x-ig-mapped-locale": loc.mapped_locale,
            "x-ig-device-languages": js_json(
                {
                    "keyboard_languages": f"{loc.device_locale},emoji",
                    "system_languages": loc.device_locale,
                    "keyboard_language": loc.device_locale,
                }
            ),
            "x-ig-timezone-offset": self.timezone_offset_string,
            "x-ig-www-claim": self.account.claim or "SKIP",
            "x-mid": self.account.mid,
            "x-ig-capabilities": "36r/F/8=",
            "x-ig-connection-type": "WiFi",
            "x-fb-connection-type": "wifi",
            "x-fb": "0",
            "x-messenger": "0",
            "x-whatsapp": "0",
            "x-ads-opt-out": "0",
            "x-ig-bloks-serialize-payload": "true",
            "x-ig-salt-ids": "42139649",
        }
        if self.account.cloud_trust_token:
            headers["x-cloud-trust-token"] = self.account.cloud_trust_token
        headers.update(self._bandwidth_headers())
        headers["x-bloks-version-id"] = BLOKS_VERSION_ID
        headers.update(BLOKS_PRISM_HEADERS)
        headers["priority"] = "u=0"
        headers["x-tigon-is-retry"] = "False"
        headers["x-fb-client-ip"] = "True"
        headers["x-fb-server-cluster"] = "True"
        if self._rur:
            headers["ig-u-rur"] = self._rur
        headers["x-pigeon-session-id"] = self.nav.get_session_id()
        headers["x-pigeon-rawclienttime"] = self.nav.raw_client_time()
        nav_src = self.nav_override or self.nav
        headers["x-ig-nav-chain"] = nav_src.chain_string()
        headers["x-ig-client-endpoint"] = nav_src.client_endpoint()
        if extra:
            headers.update(extra)
        return headers

    def _capture_claim(self, res: httpx.Response) -> None:
        rur = res.headers.get("ig-set-ig-u-rur") or res.headers.get("ig-u-rur")
        if rur and rur != self._rur:
            self._rur = rur
        claim = res.headers.get("x-ig-set-www-claim")
        if claim and claim != self.account.claim:
            self.account.claim = claim

    def _sign_body(self, payload: dict[str, Any]) -> str:
        return f"signed_body=SIGNATURE.{encode_uri_component(js_json(payload))}"

    # ── request primitives ──────────────────────────────────────────────────
    def post(self, path: str, payload: dict[str, Any], friendly_name: str | None = None) -> IgResponse:
        body = self._sign_body(payload)
        extra = {"content-type": "application/x-www-form-urlencoded; charset=UTF-8"}
        if friendly_name:
            extra["x-fb-friendly-name"] = friendly_name
        res = self._http.post(path, content=body, headers=self._base_headers(extra))
        self._capture_claim(res)
        return self._to_response(res, path)

    def post_form(self, path: str, form: dict[str, str], friendly_name: str | None = None) -> IgResponse:
        body = urlencode(form)
        extra = {"content-type": "application/x-www-form-urlencoded; charset=UTF-8"}
        if friendly_name:
            extra["x-fb-friendly-name"] = friendly_name
        res = self._http.post(path, content=body, headers=self._base_headers(extra))
        self._capture_claim(res)
        return self._to_response(res, path)

    def graphql(
        self,
        friendly_name: str,
        client_doc_id: str,
        variables: dict[str, Any],
        extra_form: dict[str, str] | None = None,
        *,
        path: str = "/graphql/query",
        root_field_name: str | None = None,
        pando: bool = False,
    ) -> IgResponse:
        form: dict[str, str] = {
            "method": "post",
            "pretty": "false",
            "format": "json",
            "server_timestamps": "true",
            "locale": self.locale,
            "fb_api_req_friendly_name": friendly_name,
            "client_doc_id": client_doc_id,
            "enable_canonical_naming": "true",
            "enable_canonical_variable_overrides": "true",
            "enable_canonical_naming_ambiguous_type_prefixing": "true",
            "variables": js_json(variables),
        }
        if extra_form:
            form.update(extra_form)
        body = urlencode(form)
        extra = {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-fb-friendly-name": friendly_name,
            "x-client-doc-id": client_doc_id,
        }
        if root_field_name:
            extra["x-root-field-name"] = root_field_name
        if pando:
            extra["x-graphql-client-library"] = "pando"
        res = self._http.post(path, content=body, headers=self._base_headers(extra))
        self._capture_claim(res)
        return self._to_response(res, path)

    def get(self, path: str, friendly_name: str | None = None) -> IgResponse:
        extra = {"x-fb-friendly-name": friendly_name} if friendly_name else {}
        res = self._http.get(path, headers=self._base_headers(extra))
        self._capture_claim(res)
        return self._to_response(res, path)

    def _to_response(self, res: httpx.Response, path: str) -> IgResponse:
        try:
            data: Any = res.json()
        except Exception:
            data = res.text
        return IgResponse(
            ok=200 <= res.status_code < 300,
            status=res.status_code,
            data=data,
            url=BASE_URL + path,
        )

    # ── resumable uploads ────────────────────────────────────────────────────
    def upload_photo(self, buffer: bytes) -> UploadResult:
        upload_id = str(int(time.time() * 1000))
        name = f"{upload_id}_0_{random.randint(1000000000, 9999999999)}"
        max_attempts = 4
        last_status = 0
        last_data: Any = None
        for attempt in range(max_attempts):
            rupload_params = {
                "retry_context": js_json(
                    {"num_step_auto_retry": 0, "num_reupload": attempt, "num_step_manual_retry": 0}
                ),
                "media_type": "1",
                "upload_id": upload_id,
                "xsharing_user_ids": "[]",
                "image_compression": js_json({"lib_name": "moz", "lib_version": "3.1.m", "quality": "80"}),
            }
            try:
                res = self._http.post(
                    f"/rupload_igphoto/{name}",
                    content=buffer,
                    timeout=90.0,
                    headers=self._base_headers(
                        {
                            "content-type": "application/octet-stream",
                            "x-entity-type": "image/jpeg",
                            "offset": "0",
                            "x-entity-name": name,
                            "x-entity-length": str(len(buffer)),
                            "x-instagram-rupload-params": js_json(rupload_params),
                            "content-length": str(len(buffer)),
                        }
                    ),
                )
                data = self._body(res)
                last_status, last_data = res.status_code, data
                if 200 <= res.status_code < 300 and rupload_body_ok(data):
                    return UploadResult(True, res.status_code, upload_id, data)
                if 400 <= res.status_code < 500 and res.status_code != 429:
                    break
            except Exception as e:
                last_status, last_data = 0, {"network_error": str(e)}
            if attempt < max_attempts - 1:
                time.sleep(1.5 * (attempt + 1))
        return UploadResult(False, last_status, upload_id, last_data)

    def upload_settings(
        self,
        *,
        upload_id: str,
        waterfall_id: str,
        duration_ms: int,
        width: int,
        height: int,
        file_size: int,
        codec: str | None = None,
        frame_rate: int | None = None,
        has_audio: bool | None = None,
        rotation_angle: int | None = None,
        entity_id: str | None = None,
    ) -> IgResponse:
        # Shares the per-upload entity UUID with the rupload_igvideo path so the
        # server correlates the settings preamble with the actual bytes.
        entity_id = entity_id or gen_upper_uuid()
        composer_session_id = f"{waterfall_id}_{upload_id}"
        duration_sec = max(1, round(duration_ms / 1000))
        video_bit_rate = round((file_size * 8) / duration_sec)
        source_codec = codec or "avc1"
        fr = frame_rate if (frame_rate and frame_rate > 0) else 30
        has_a = True if has_audio is None else has_audio
        rot = rotation_angle if rotation_angle is not None else 0
        video: dict[str, Any] = {}
        if has_a:
            video["audio_bit_rate_bps"] = 128000
        video.update(
            {
                "proposed_target_video_codec": "hvc1",
                "asset_id": f"{upload_id}{self.uid}",
                "filter_complexity_level": 0,
                "video_original_file_size": file_size,
                "video_duration_milliseconds": duration_ms,
                "video_height": height,
                "video_partial_frame_size_bytes": 0,
                "video_gop_size_sec": 0,
                "source_video_codec": source_codec,
                "video_key_frame_size_bytes": 0,
                "video_rotation_angle": rot,
                "video_frame_rate": fr,
                "video_duration_seconds": duration_sec,
                "source_hdr": False,
                "video_width": width,
                "video_bit_rate_bps": video_bit_rate,
            }
        )
        payload = {
            "composer_session_id": composer_session_id,
            "upload_setting_properties": {
                "upload_settings_version": "v0.1",
                "creative_tools": {"transcoding_required": True},
                "video": video,
                "context": {
                    "transcode_hdr": False,
                    "quality": "not_specified",
                    "source_type": "clips",
                    "share_type": "reels",
                    "composer_session_id": composer_session_id,
                },
                "network": {"stitch_download_bandwidth": -1, "upload_bandwidth": 0, "download_bandwidth": 4509387},
            },
        }
        body = js_json(payload).encode("utf-8")
        res = self._http.post(
            f"/upload_settings/{entity_id}",
            content=body,
            headers=self._base_headers(
                {
                    "content-type": "application/octet-stream",
                    "x-entity-type": "text/json",
                    "x-entity-name": "upload_settings_payload",
                    "x-entity-length": str(len(body)),
                    "offset": "0",
                    "x-ig-bloks-serialize-payload": "true",
                    "x-fb-friendly-name": "api",
                    "content-length": str(len(body)),
                }
            ),
        )
        return self._to_response(res, f"/upload_settings/{entity_id}")

    def upload_video(
        self,
        buffer: bytes,
        *,
        duration_ms: int,
        width: int,
        height: int,
        upload_id: str | None = None,
        waterfall_id: str | None = None,
        entity_id: str | None = None,
    ) -> UploadResult:
        upload_id = upload_id or str(int(time.time() * 1000))
        waterfall_id = waterfall_id or random_hex(32)
        # The path segment is a fresh per-upload entity UUID (uppercase), NOT the
        # device id. It must match the uuid used by the preceding upload_settings
        # call so the server ties both halves to the same upload session.
        entity_id = entity_id or gen_upper_uuid()
        name = "video.mp4"
        # Provenance block the app attaches to library reels (no genai / no c2pa).
        provenance_metadata = js_json(
            {
                "tools": ["ADD"],
                "origin": ["EXTERNAL"],
                "c2pa_metadata": [
                    {
                        "software_agent": "",
                        "contains_composite_synthetic": False,
                        "status": "c2pa_not_found",
                        "contains_computational_capture": False,
                        "digital_source_type": "",
                        "edited_with_genai": False,
                        "contains_composite_with_trained_algorithmic_media": False,
                        "created_with_genai": False,
                        "contains_trained_algorithmic_data": False,
                        "contains_trained_algorithmic_media": False,
                        "contains_digital_capture": False,
                    }
                ],
                "iptc_metadata": [
                    {"status": "iptc_not_found", "created_with_genai": False, "edited_with_genai": False}
                ],
            }
        )
        max_attempts = 4
        last_status = 0
        last_data: Any = None
        for attempt in range(max_attempts):
            # Key order matches the captured request byte-for-byte.
            rupload_params = {
                "mediasource": "1",
                "media_type": 2,
                "upload_media_duration_ms": duration_ms,
                "xsharing_user_ids": [],
                "share_type": "reels",
                "is_clips_video": "1",
                "provenance_metadata": provenance_metadata,
                "extract_cover_frame": "1",
                "upload_media_width": width,
                "upload_id": upload_id,
                "is_optimistic_upload": 1,
                "session_id": upload_id,
                "upload_media_height": height,
            }
            try:
                res = self._http.post(
                    f"/rupload_igvideo/{entity_id}",
                    content=buffer,
                    timeout=180.0,
                    headers=self._base_headers(
                        {
                            "content-type": "application/octet-stream",
                            "x-entity-type": "video/mpeg",
                            "offset": "0",
                            "x-entity-name": name,
                            "x-entity-length": str(len(buffer)),
                            "x-instagram-rupload-params": js_json(rupload_params),
                            "x_fb_video_waterfall_id": waterfall_id,
                            "x-ig-bloks-serialize-payload": "true",
                            "media_hash": "",
                            "x-fb-friendly-name": "api",
                            "content-length": str(len(buffer)),
                        }
                    ),
                )
                data = self._body(res)
                last_status, last_data = res.status_code, data
                if 200 <= res.status_code < 300 and rupload_body_ok(data):
                    return UploadResult(True, res.status_code, upload_id, data)
                if 400 <= res.status_code < 500 and res.status_code != 429:
                    break
            except Exception as e:
                last_status, last_data = 0, {"network_error": str(e)}
            if attempt < max_attempts - 1:
                time.sleep(2.0 * (attempt + 1))
        return UploadResult(False, last_status, upload_id, last_data)

    def upload_reel_cover(self, jpeg: bytes, *, upload_id: str) -> IgResponse:
        rupload_params = {
            "is_optimistic_upload": 1,
            "upload_id": upload_id,
            "cover_photo_type": "nth_frame",
            "image_compression": js_json(
                {
                    "quality": 70,
                    "lib_version": "1979.100000",
                    "colorspace": "kCGColorSpaceDeviceRGB",
                    "lib_name": "uikit",
                }
            ),
            "provenance_metadata": js_json(
                {
                    "tools": ["ADD"],
                    "origin": ["EXTERNAL"],
                    "c2pa_metadata": [
                        {
                            "software_agent": "",
                            "contains_composite_synthetic": False,
                            "status": "c2pa_not_found",
                            "contains_computational_capture": False,
                            "digital_source_type": "",
                            "edited_with_genai": False,
                            "contains_composite_with_trained_algorithmic_media": False,
                            "created_with_genai": False,
                            "contains_trained_algorithmic_data": False,
                            "contains_trained_algorithmic_media": False,
                            "contains_digital_capture": False,
                        }
                    ],
                    "iptc_metadata": [
                        {"status": "iptc_not_found", "created_with_genai": False, "edited_with_genai": False}
                    ],
                }
            ),
            "session_id": upload_id,
            "xsharing_user_ids": [],
            "media_type": 2,
            "is_clips_video": "1",
            "extract_cover_frame": "1",
            "share_type": "reels",
        }
        path = f"/rupload_igphoto/{gen_upper_uuid()}"
        try:
            res = self._http.post(
                path,
                content=jpeg,
                timeout=90.0,
                headers=self._base_headers(
                    {
                        "content-type": "application/octet-stream",
                        "x-entity-type": "image/jpeg",
                        "offset": "0",
                        "x-entity-name": "image.jpeg",
                        "x-entity-length": str(len(jpeg)),
                        "x-instagram-rupload-params": js_json(rupload_params),
                        "x-fb-friendly-name": "upload",
                        "content-length": str(len(jpeg)),
                    }
                ),
            )
            data = self._body(res)
            ok = 200 <= res.status_code < 300 and rupload_body_ok(data)
            return IgResponse(ok=ok, status=res.status_code, data=data, url=BASE_URL + path)
        except Exception as e:
            return IgResponse(ok=False, status=0, data={"network_error": str(e)}, url=BASE_URL + path)

    def rotate_proxy(self) -> dict[str, Any]:
        if not self.account.rotation_url:
            return {"ok": True, "status": 0, "rotated": False}
        try:
            res = httpx.get(self.account.rotation_url, timeout=20.0)
            ok = 200 <= res.status_code < 400
            return {"ok": ok, "status": res.status_code, "rotated": True, "error": None if ok else f"HTTP {res.status_code}"}
        except Exception as e:
            return {"ok": False, "status": 0, "rotated": True, "error": str(e)}

    @staticmethod
    def _body(res: httpx.Response) -> Any:
        try:
            return res.json()
        except Exception:
            return res.text
