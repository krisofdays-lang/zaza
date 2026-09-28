"""HTTP transport wired through the Go uTLS sidecar.

Mirrors buildAgent() in client.ts. Preferred path: send everything through the
loopback uTLS sidecar (TLS_PROXY_URL) so the TLS/JA4 + HTTP/2 fingerprint matches
a real iPhone. The account's mobile proxy and the pinned app version are handed
to the sidecar via CONNECT headers (x-upstream-proxy / x-app-version); the sidecar
chains to the mobile proxy and picks the version-matched ClientHello.

The client -> sidecar hop is loopback with a throwaway self-signed MITM cert, so
we disable verification for that hop only (verify=False). The security-relevant
sidecar -> Instagram handshake is done by the sidecar with uTLS and still fully
validates Instagram's real certificate.

We deliberately do NOT enable HTTP/2 on the client -> sidecar hop: Node/axios
speaks HTTP/1.1 over the MITM tunnel and the sidecar re-emits real HTTP/2 to
Instagram, so we keep the same shape to avoid an ALPN mismatch with the sidecar.
"""

from __future__ import annotations

import logging

import httpx

from .config import BASE_URL, TLS_PROXY_REQUIRED, TLS_PROXY_URL
from .devices import PINNED_IG_APP_VERSION
from .models import Account

log = logging.getLogger("ig.transport")

_warned_missing_proxy = False


def upstream_proxy_url(account: Account) -> str:
    """Normalise an account's proxy into a single URL string (or "" for direct)."""
    if not account.proxy_url or account.proxy_type == "none":
        return ""
    if account.proxy_type == "socks5":
        return account.proxy_url if account.proxy_url.startswith("socks") else f"socks5://{account.proxy_url}"
    return account.proxy_url if account.proxy_url.startswith("http") else f"http://{account.proxy_url}"


def _warn_missing_tls_proxy_once() -> None:
    global _warned_missing_proxy
    if _warned_missing_proxy:
        return
    _warned_missing_proxy = True
    log.warning(
        "TLS_PROXY_URL is not set - Instagram traffic is using Python's TLS/JA4 "
        "fingerprint, NOT an iPhone's. This mismatch against the iOS User-Agent is a "
        "primary ban signal. Start the uTLS sidecar and set TLS_PROXY_URL, or set "
        "TLS_PROXY_REQUIRED=1 to hard-fail instead of running in this unsafe mode."
    )


def build_client(account: Account, *, timeout: float = 30.0) -> httpx.Client:
    """Build a per-account httpx.Client routed through the uTLS sidecar."""
    upstream = upstream_proxy_url(account)

    if TLS_PROXY_URL:
        proxy = httpx.Proxy(
            url=TLS_PROXY_URL,
            headers={
                "x-upstream-proxy": upstream,
                "x-app-version": PINNED_IG_APP_VERSION,
            },
        )
        return httpx.Client(
            base_url=BASE_URL,  # requests pass relative paths (e.g. /api/v1/...)
            proxy=proxy,
            verify=False,  # loopback MITM hop only; sidecar validates IG's real cert
            http2=False,
            timeout=timeout,
            follow_redirects=False,  # surface 302 -> login instead of chasing it
        )

    # Legacy direct path (no sidecar): exposes Python's JA4. Loud, not silent.
    _warn_missing_tls_proxy_once()
    if TLS_PROXY_REQUIRED:
        raise RuntimeError(
            "TLS_PROXY_REQUIRED=1 but TLS_PROXY_URL is not set: refusing to send "
            "Instagram traffic with Python's JA3/JA4 fingerprint."
        )
    proxy = httpx.Proxy(url=upstream) if upstream else None
    return httpx.Client(
        base_url=BASE_URL,  # requests pass relative paths (e.g. /api/v1/...)
        proxy=proxy,
        timeout=timeout,
        follow_redirects=False,
    )
