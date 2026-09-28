"""iPhone hardware presets + realistic iOS User-Agent / locale / timezone.

Ported 1:1 from lib/instagram/devices.ts. The "model" is the internal identifier
Instagram sends (e.g. iPhone11,8). Only iPhones that can run iOS 17+ are listed
(iOS 17 needs an A12 chip), and each carries the earliest iOS major it supports
so we never announce an impossible hardware/OS pairing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class IphonePreset:
    model: str
    name: str
    resolution: str
    scale: str
    dpi: str
    min_ios_major: int


IPHONE_PRESETS: list[IphonePreset] = [
    IphonePreset("iPhone11,8", "iPhone XR", "828x1792", "2.00", "326", 17),
    IphonePreset("iPhone11,2", "iPhone XS", "1125x2436", "3.00", "458", 17),
    IphonePreset("iPhone11,6", "iPhone XS Max", "1242x2688", "3.00", "458", 17),
    IphonePreset("iPhone12,1", "iPhone 11", "828x1792", "2.00", "326", 17),
    IphonePreset("iPhone12,3", "iPhone 11 Pro", "1125x2436", "3.00", "458", 17),
    IphonePreset("iPhone12,5", "iPhone 11 Pro Max", "1242x2688", "3.00", "458", 17),
    IphonePreset("iPhone13,1", "iPhone 12 mini", "1080x2340", "3.00", "476", 17),
    IphonePreset("iPhone13,2", "iPhone 12", "1170x2532", "3.00", "460", 17),
    IphonePreset("iPhone13,3", "iPhone 12 Pro", "1170x2532", "3.00", "460", 17),
    IphonePreset("iPhone13,4", "iPhone 12 Pro Max", "1284x2778", "3.00", "458", 17),
    IphonePreset("iPhone14,4", "iPhone 13 mini", "1080x2340", "3.00", "476", 17),
    IphonePreset("iPhone14,5", "iPhone 13", "1170x2532", "3.00", "460", 17),
    IphonePreset("iPhone14,2", "iPhone 13 Pro", "1170x2532", "3.00", "460", 17),
    IphonePreset("iPhone14,3", "iPhone 13 Pro Max", "1284x2778", "3.00", "458", 17),
    IphonePreset("iPhone14,7", "iPhone 14", "1170x2532", "3.00", "460", 17),
    IphonePreset("iPhone14,8", "iPhone 14 Plus", "1284x2778", "3.00", "458", 17),
    IphonePreset("iPhone15,2", "iPhone 14 Pro", "1179x2556", "3.00", "460", 17),
    IphonePreset("iPhone15,3", "iPhone 14 Pro Max", "1290x2796", "3.00", "460", 17),
    IphonePreset("iPhone15,4", "iPhone 15", "1179x2556", "3.00", "460", 17),
    IphonePreset("iPhone15,5", "iPhone 15 Plus", "1290x2796", "3.00", "460", 17),
    IphonePreset("iPhone16,1", "iPhone 15 Pro", "1179x2556", "3.00", "460", 17),
    IphonePreset("iPhone16,2", "iPhone 15 Pro Max", "1290x2796", "3.00", "460", 17),
    IphonePreset("iPhone17,3", "iPhone 16", "1179x2556", "3.00", "460", 18),
    IphonePreset("iPhone17,4", "iPhone 16 Plus", "1290x2796", "3.00", "460", 18),
    IphonePreset("iPhone17,1", "iPhone 16 Pro", "1206x2622", "3.00", "460", 18),
    IphonePreset("iPhone17,2", "iPhone 16 Pro Max", "1320x2868", "3.00", "460", 18),
]

IOS_VERSIONS: list[str] = [
    "17_0", "17_0_3", "17_1_1", "17_2_1", "17_3_1", "17_4_1", "17_5_1",
    "17_6_1", "18_0_1", "18_1_1", "18_2_1", "18_3_2", "18_4_1", "18_5",
]

IG_APP_VERSIONS: list[str] = [
    "448.0.0.39.66", "447.0.0.34.80", "437.0.0.22.50", "436.0.0", "435.1.0", "435.0.0", "434.0.0",
    "433.1.0", "432.0.0", "431.0.0", "430.0.0", "429.0.0", "428.2.0", "428.1.0",
]

LATEST_IG_APP_VERSION = IG_APP_VERSIONS[0]

# The app version we ACTUALLY send on the wire, pinned to the exact build the
# captured traffic came from so it stays consistent with the GraphQL doc_ids and
# the x-bloks-version-id we replay.
PINNED_IG_APP_VERSION = "448.0.0.39.66"

# Numeric "version code" (final UA field). Tied to the app BUILD, not the device,
# so it must be identical across all accounts running the pinned version.
PINNED_IG_VERSION_CODE = "1072661960"

DEFAULT_LOCALE = "en_US"
DEFAULT_TIMEZONE = "Europe/Moscow"


def get_preset(model: str) -> IphonePreset:
    for p in IPHONE_PRESETS:
        if p.model == model:
            return p
    return IPHONE_PRESETS[0]


def ios_major(version: str) -> int:
    try:
        return int((version or "").split("_")[0])
    except ValueError:
        return 0


def ios_versions_for_model(model: str) -> list[str]:
    preset = get_preset(model)
    return [v for v in IOS_VERSIONS if ios_major(v) >= preset.min_ios_major]


def resolve_ios_for_model(model: str, ios_version: str) -> str:
    """Clamp an iOS version to something the model supports."""
    allowed = ios_versions_for_model(model)
    if ios_version in allowed:
        return ios_version
    return allowed[-1] if allowed else IOS_VERSIONS[-1]


def normalize_locale(locale: str | None) -> str:
    """Normalise any stored value ("en-US", "", "en_us") to canonical xx_YY."""
    raw = (locale or "").strip().replace("-", "_")
    if not raw:
        return DEFAULT_LOCALE
    parts = raw.split("_")
    lang = parts[0]
    if not lang:
        return DEFAULT_LOCALE
    region = parts[1] if len(parts) > 1 else ""
    return f"{lang.lower()}_{region.upper()}" if region else lang.lower()


@dataclass(frozen=True)
class LocaleHeaders:
    accept_language: str
    app_locale: str
    device_locale: str
    mapped_locale: str


def locale_headers(locale: str | None) -> LocaleHeaders:
    """The consistent set of locale headers, all derived from one value."""
    norm = normalize_locale(locale)
    parts = norm.split("_")
    lang = parts[0]
    region = parts[1] if len(parts) > 1 else ""
    dash = f"{lang}-{region}" if region else lang
    return LocaleHeaders(
        accept_language=f"{dash};q=1.0",
        app_locale=lang,
        device_locale=dash,
        mapped_locale=(f"{lang}_{region}" if region else norm),
    )


def build_user_agent(
    *, app_version: str, iphone_model: str, ios_version: str, locale: str | None = None
) -> str:
    """Example:
    Instagram 437.0.0.22.50 (iPhone11,8; iOS 18_5; en_US; en; scale=2.00; 828x1792; 1010515070) AppleWebKit/420+
    """
    preset = get_preset(iphone_model)
    loc = normalize_locale(locale)
    lang = loc.split("_")[0]
    return (
        f"Instagram {app_version} ({preset.model}; iOS {ios_version}; {loc}; {lang}; "
        f"scale={preset.scale}; {preset.resolution}; {PINNED_IG_VERSION_CODE}) AppleWebKit/420+"
    )


def tz_offset_seconds(time_zone: str | None, at: datetime | None = None) -> int:
    """Current UTC offset (seconds, east-positive) for an IANA zone, DST-aware."""
    zone = (time_zone or "").strip() or DEFAULT_TIMEZONE
    try:
        moment = at or datetime.now(ZoneInfo(zone))
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=ZoneInfo(zone))
        else:
            moment = moment.astimezone(ZoneInfo(zone))
        offset = moment.utcoffset()
        return int(round(offset.total_seconds())) if offset else 0
    except Exception:
        return 0
