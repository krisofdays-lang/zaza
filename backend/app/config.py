"""Static wire constants shared by every Instagram request.

These are copied verbatim from the TypeScript client so the Python service
presents a byte-identical fingerprint. Keep BLOKS_VERSION_ID aligned with the
pinned app version in devices.py if either is bumped.
"""

from __future__ import annotations

import os

BASE_URL = "https://i.instagram.com"
APP_ID = "124024574287414"

# The Bloks bundle hash the real iOS app sends on EVERY request. Its absence
# (while every other device header is present) is one of the strongest "this is
# not the real app" signals, so we always replay a known-good captured value.
BLOKS_VERSION_ID = "962e8adcff14724d83afff88f2db8ff321b1d3cf53fee9b37a9fcaa1eb9a0306"

# Static Bloks/Prism UI feature flags the app attaches to every request. Real
# traffic always carries this exact block; device headers WITHOUT it is an
# inconsistency antifingerprinting looks for.
BLOKS_PRISM_HEADERS: dict[str, str] = {
    "x-bloks-is-prism-enabled": "true",
    "x-bloks-prism-ax-base-colors-enabled": "true",
    "x-bloks-prism-button-version": "INDIGO_PRIMARY_BORDERED_SECONDARY",
    "x-bloks-prism-colors-enabled": "true",
    "x-bloks-prism-extended-palette-gray": "true",
    "x-bloks-prism-extended-palette-gray-10-variant": "1",
    "x-bloks-prism-extended-palette-indigo": "true",
    "x-bloks-prism-extended-palette-polish-enabled": "true",
    "x-bloks-prism-extended-palette-red": "true",
    "x-bloks-prism-extended-palette-rest-of-colors": "true",
    "x-bloks-prism-font-enabled": "false",
    "x-bloks-prism-link-colors-enabled": "1",
}

# The loopback uTLS sidecar (tls-proxy/). When set, ALL Instagram traffic is
# routed through it so the TLS/JA4 + HTTP/2 fingerprint matches a real iPhone
# instead of Python's OpenSSL stack. The account's real mobile proxy is chained
# downstream by the sidecar (passed per-account on the CONNECT headers).
TLS_PROXY_URL = os.environ.get("TLS_PROXY_URL", "")

# Opt-in hard stop: set TLS_PROXY_REQUIRED=1 in production so a misconfigured
# deploy fails fast instead of silently sending Python's JA4 fingerprint.
TLS_PROXY_REQUIRED = os.environ.get("TLS_PROXY_REQUIRED", "") == "1"

# ffmpeg binary used for reel cover-frame extraction (best-effort).
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
