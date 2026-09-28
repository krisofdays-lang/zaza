# igtlsproxy — uTLS fingerprint sidecar

A tiny loopback forward-proxy (Go + [uTLS](https://github.com/refraction-networking/utls))
that gives the Node app a **byte-controllable TLS/JA4 + HTTP/2 fingerprint**
when talking to Instagram. Libraries like `curl_cffi` / `rnet` / `tls_client`
only replay *browser* presets and cannot reproduce the exact Instagram-app
ClientHello; uTLS `HelloCustom` can, because you specify every cipher, extension
(and its order), curve, and sigalg yourself.

## How it fits in

```
Node (InstagramClient, axios)
   │  HTTPS via proxy → CONNECT 127.0.0.1:8443
   │  CONNECT headers: X-Upstream-Proxy, X-App-Version
   ▼
igtlsproxy  (this sidecar)
   │  terminates Node's loopback TLS, reads plaintext HTTP/1.1
   │  re-originates with uTLS custom ClientHello + HTTP/2 (ALPN h2)
   │  chains through the account's mobile proxy (HTTP-CONNECT / SOCKS5)
   ▼
i.instagram.com
```

The Node → sidecar hop is loopback only, so the app connects with
`rejectUnauthorized:false` and the sidecar presents a throwaway self-signed
cert. The security-relevant handshake is the sidecar → Instagram hop.

## Enabling it

In Docker this is automatic: the image compiles the binary and the entrypoint
starts it, setting `TLS_PROXY_URL=http://127.0.0.1:8443`. Env overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TLS_PROXY_URL` | `http://127.0.0.1:8443` | Where **Node** sends traffic. Unset it to disable the sidecar (Node falls back to direct proxy + Node's own JA4). |
| `TLS_PROXY_LISTEN` | `127.0.0.1:8443` | Where the **sidecar** binds. |
| `TLS_PROXY_FINGERPRINTS` | (auto: `/data/fingerprints.json` if present) | JSON file with captured profiles. |
| `TLS_PROXY_VERBOSE` | `0` | `1` logs per-request diagnostics. |

Run standalone for local testing:

```bash
cd tls-proxy
go run . -listen 127.0.0.1:8443 -fingerprints ../fingerprints.json -verbose
```

## Making it byte-exact (required for a real JA4)

The built-in profile is a **structural placeholder** modelled on the iOS TLS 1.3
ClientHello shape. It is *not* guaranteed to match build 437 byte-for-byte. To
get a true match, capture the real handshake from an iPhone and drop it into a
`fingerprints.json`.

### Capture recipe (iPhone, needs a Mac)

1. Plug the iPhone into the Mac via USB and find its UDID (Finder / `idevice_id -l`).
2. Start a Remote Virtual Interface that mirrors the phone's traffic:
   ```bash
   rvictl -s <UDID>          # creates interface rvi0
   ```
3. Capture while you scroll the feed / open a reel in the **Instagram app**:
   ```bash
   sudo tcpdump -i rvi0 -w ig.pcap host i.instagram.com
   ```
4. Extract the ClientHello fields (needs a recent Wireshark/tshark with JA4):
   ```bash
   tshark -r ig.pcap -Y "tls.handshake.type == 1" -T fields \
     -e tls.handshake.ja4 \
     -e tls.handshake.ciphersuite \
     -e tls.handshake.extension.type \
     -e tls.handshake.extensions_supported_group \
     -e tls.handshake.sig_hash_alg
   ```
5. Stop mirroring when done: `rvictl -x <UDID>`.

> The `adb + tcpdump wlan0` recipe you may have seen is the **Android** path and
> yields an Android JA4 (e.g. `t13d0107...`). Since this app emulates iOS, you
> must capture from an iPhone, otherwise the TLS fingerprint won't match the iOS
> User-Agent the app sends.

### Transcribe into fingerprints.json

Key each profile by the app-version prefix the Node client sends
(`X-App-Version`, e.g. `437.0.0.22.50` → key `437`). See
[`fingerprints.example.json`](./fingerprints.example.json).

```jsonc
{
  "437": {
    "note": "iOS 18 / IG 437 — captured 2026-01",
    "ja4": "t13d...",                         // documentation only
    "cipher_suites": ["0x1301"],              // in ClientHello order
    "extension_order": ["server_name", "supported_groups", "..."],
    "supported_groups": ["x25519", "secp256r1"],
    "signature_algorithms": ["0x0403", "0x0804"],
    "alpn": ["h2", "http/1.1"],
    "key_share_groups": ["x25519"],
    "psk_key_exchange_modes": ["psk_dhe_ke"],
    "ec_point_formats": ["uncompressed"],
    "supported_versions": ["1.3", "1.2"],
    "cert_compression": ["zlib"]
  }
}
```

Supported `extension_order` names: `server_name`, `extended_master_secret`,
`renegotiation_info`, `supported_groups`, `ec_point_formats`, `alpn`,
`status_request`, `signature_algorithms`, `signed_certificate_timestamp`,
`key_share`, `psk_key_exchange_modes`, `supported_versions`,
`compress_certificate`, `application_settings`, `padding`.

Mount it (see the commented volume in `docker-compose.yml`) and rebuild — the
version-matched profile is picked automatically per request, so bumping the
pinned app version + its profile together keeps JA4 and User-Agent in sync.
