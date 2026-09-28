package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	utls "github.com/refraction-networking/utls"
)

// A Profile is a byte-exact description of the TLS ClientHello a specific
// Instagram build sends on iOS. Every field maps to something tshark reports
// from a real `rvictl` capture, so a captured fingerprint can be transcribed
// here (or into a JSON override file) without touching Go code.
//
// The active profile (447) is transcribed byte-for-byte from a real rvictl +
// tshark capture of the Instagram iOS app, so its JA3/JA4 match the app on the
// wire. The older 437 profile is kept only as a fallback for legacy callers.
type Profile struct {
	// Human note, e.g. "iOS 18 / IG 437 (PLACEHOLDER)".
	Note string `json:"note"`
	// JA4 string this profile is meant to reproduce (documentation only).
	JA4 string `json:"ja4"`

	// Ordered cipher suites (hex strings like "0x1301" or decimal ints).
	CipherSuites []HexU16 `json:"cipher_suites"`
	// Ordered list of extension identifiers (see buildExtension for names).
	ExtensionOrder []string `json:"extension_order"`
	// Named curves / groups for supported_groups + key_share.
	SupportedGroups []string `json:"supported_groups"`
	// Signature algorithms (hex strings like "0x0403").
	SignatureAlgorithms []HexU16 `json:"signature_algorithms"`
	// ALPN protocols, in order (e.g. ["h2","http/1.1"]).
	ALPN []string `json:"alpn"`
	// Which groups get a client key_share entry (usually just x25519).
	KeyShareGroups []string `json:"key_share_groups"`
	// PSK key exchange modes (usually ["psk_dhe_ke"] => 0x01).
	PSKModes []string `json:"psk_key_exchange_modes"`
	// EC point formats (usually ["uncompressed"] => 0x00).
	ECPointFormats []string `json:"ec_point_formats"`
	// Supported TLS versions, high to low (e.g. ["1.3","1.2"]).
	SupportedVersions []string `json:"supported_versions"`
	// Certificate compression algorithms (e.g. ["zlib"]).
	CertCompression []string `json:"cert_compression"`
}

// HexU16 accepts either a JSON number or a "0x...."/decimal string and yields a
// uint16, so captured hex values can be pasted verbatim.
type HexU16 uint16

func (h *HexU16) UnmarshalJSON(b []byte) error {
	// number form
	var n uint64
	if err := json.Unmarshal(b, &n); err == nil {
		*h = HexU16(n)
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := parseUint16(s)
	if err != nil {
		return err
	}
	*h = HexU16(v)
	return nil
}

var (
	profilesMu sync.RWMutex
	// version prefix (e.g. "437") -> profile. The Node side sends the pinned
	// app version; we match on the leading numeric segment so "437.0.0.22.50"
	// resolves to the "437" profile.
	profiles = map[string]*Profile{}
)

func init() {
	profiles["default"] = iosIG448Profile()
	profiles["448"] = iosIG448Profile()
	profiles["447"] = iosIG447Profile()
	profiles["437"] = iosIG437Profile()
}

// iosIG448Profile reuses the same ClientHello shape as build 447 — the TLS
// stack (BoringSSL/Fizz) did not change between these minor bumps, so the
// byte-exact capture is identical. We keep a separate entry so the version
// prefix "448" resolves correctly and the default always tracks the pinned
// app version.
func iosIG448Profile() *Profile {
	p := iosIG447Profile()
	p.Note = "iOS / Instagram build 448 (same ClientHello as 447; JA4 t13d2812h2, JA3 5659c10619c455ea477287b12cf3f7e7)"
	return p
}

// iosIG447Profile is the byte-exact ClientHello captured from the Instagram iOS
// app (build 447) via rvictl + tshark, hitting graph.instagram.com.
//
//	JA3: 5659c10619c455ea477287b12cf3f7e7
//	JA4: t13d2812h2  (28 ciphers, 12 extensions, ALPN h2, TLS 1.3)
//
// This is a modern BoringSSL/Fizz-style hello: a post-quantum X25519MLKEM768
// hybrid key share (0x11ec), NO GREASE, the full legacy cipher tail, and the
// TLS 1.2-era extensions (ec_point_formats, session_ticket, encrypt_then_mac,
// extended_master_secret) that the app still advertises even though the
// connection negotiates TLS 1.3.
//
// NOTE: the X25519MLKEM768 group (0x11ec) requires utls >= v1.7.x — older uTLS
// cannot generate the hybrid key_share and the handshake will fail. The group
// is written as a raw hex CurveID so no exported uTLS constant is referenced.
func iosIG447Profile() *Profile {
	return &Profile{
		Note: "iOS / Instagram build 447 (byte-exact; JA4 t13d2812h2, JA3 5659c10619c455ea477287b12cf3f7e7)",
		JA4:  "t13d2812h2",
		CipherSuites: []HexU16{
			0x1302, 0x1303, 0x1301, 0xc02b, 0xc02f, 0xc02c, 0xc030,
			0xcca9, 0xcca8, 0x009e, 0x009f, 0xccaa, 0xc023, 0xc027,
			0xc009, 0xc013, 0xc024, 0xc028, 0xc00a, 0xc014, 0x0067,
			0x006b, 0x009c, 0x009d, 0x003c, 0x003d, 0x002f, 0x0035,
		},
		ExtensionOrder: []string{
			"renegotiation_info", "server_name", "ec_point_formats",
			"supported_groups", "session_ticket", "alpn",
			"encrypt_then_mac", "extended_master_secret",
			"signature_algorithms", "supported_versions",
			"psk_key_exchange_modes", "key_share",
		},
		SupportedGroups: []string{"0x11ec", "x25519", "secp256r1", "0x001e", "secp384r1", "secp521r1", "0x0100", "0x0101"},
		SignatureAlgorithms: []HexU16{
			0x0905, 0x0906, 0x0904, 0x0403, 0x0503, 0x0603, 0x0807,
			0x0808, 0x081a, 0x081b, 0x081c, 0x0809, 0x080a, 0x080b,
			0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0303,
			0x0301, 0x0302, 0x0402, 0x0502, 0x0602,
		},
		ALPN:              []string{"h2"},
		KeyShareGroups:    []string{"0x11ec", "x25519"},
		PSKModes:          []string{"psk_dhe_ke"},
		ECPointFormats:    []string{"0", "1", "2"},
		SupportedVersions: []string{"1.3", "1.2"},
		CertCompression:   nil,
	}
}

// iosIG437Profile is the byte-exact FULL-handshake ClientHello captured from the
// Instagram iOS app (build 437) hitting gateway.instagram.com, transcribed from
// a real rvictl + tshark capture:
//
//	JA3 fullstring: 771,4865-255,0-16-43-51-45-10-13-41,29-23,
//	JA4 (full handshake, no PSK): t13d0207h2_...   (7 extensions)
//	JA4 (on TLS session resumption, +pre_shared_key): t13d0208h2_ec078ce24869_b24438ea4fae
//
// We model the FULL handshake here (7 extensions), because that is exactly what
// the app sends on a fresh connection with no cached session ticket. The 8th
// extension (pre_shared_key, ext 41) only appears on resumption and is bound to
// a real prior session — it cannot be hardcoded byte-exact (a stale PSK binder
// would fail validation and stand out). Resumption/PSK is handled dynamically by
// the TLS stack via a session cache, matching the real app's two-phase behavior.
//
// Ciphers (in order): 0x1301 TLS_AES_128_GCM_SHA256, 0x00ff TLS_EMPTY_RENEGOTIATION_INFO_SCSV.
// Extensions (in order): server_name, alpn, supported_versions, key_share,
// psk_key_exchange_modes, supported_groups, signature_algorithms.
func iosIG437Profile() *Profile {
	return &Profile{
		Note:                "iOS / Instagram build 437 (byte-exact full handshake; JA3 771,4865-255,0-16-43-51-45-10-13-41,29-23)",
		JA4:                 "t13d0207h2", // full handshake; resumption yields t13d0208h2_ec078ce24869_b24438ea4fae
		CipherSuites:        []HexU16{0x1301, 0x00ff},
		ExtensionOrder:      []string{"server_name", "alpn", "supported_versions", "key_share", "psk_key_exchange_modes", "supported_groups", "signature_algorithms"},
		SupportedGroups:     []string{"x25519", "secp256r1"},
		SignatureAlgorithms: []HexU16{0x0403, 0x0503, 0x0806, 0x0805, 0x0804, 0x0601, 0x0501, 0x0401},
		ALPN:                []string{"h2"},
		KeyShareGroups:      []string{"x25519"},
		PSKModes:            []string{"psk_dhe_ke"},
		ECPointFormats:      nil,
		SupportedVersions:   []string{"1.3"},
		CertCompression:     nil,
	}
}

// LoadProfilesFromFile merges a JSON override of the form
// { "437": { ...Profile... }, "default": { ... } } into the registry.
func LoadProfilesFromFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var m map[string]*Profile
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	profilesMu.Lock()
	defer profilesMu.Unlock()
	for k, v := range m {
		if v != nil {
			profiles[k] = v
		}
	}
	return nil
}

// profileForVersion resolves the app version prefix to a profile, falling back
// to "default".
func profileForVersion(version string) *Profile {
	prefix := version
	for i, c := range version {
		if c == '.' {
			prefix = version[:i]
			break
		}
	}
	profilesMu.RLock()
	defer profilesMu.RUnlock()
	if p, ok := profiles[prefix]; ok {
		return p
	}
	return profiles["default"]
}

// buildSpec turns a Profile into a utls.ClientHelloSpec.
func (p *Profile) buildSpec() (*utls.ClientHelloSpec, error) {
	ciphers := make([]uint16, 0, len(p.CipherSuites))
	for _, c := range p.CipherSuites {
		ciphers = append(ciphers, uint16(c))
	}
	exts := make([]utls.TLSExtension, 0, len(p.ExtensionOrder))
	for _, name := range p.ExtensionOrder {
		ext, err := p.buildExtension(name)
		if err != nil {
			return nil, err
		}
		if ext != nil {
			exts = append(exts, ext)
		}
	}
	return &utls.ClientHelloSpec{
		CipherSuites:       ciphers,
		CompressionMethods: []byte{0x00},
		Extensions:         exts,
	}, nil
}

func (p *Profile) buildExtension(name string) (utls.TLSExtension, error) {
	switch name {
	case "server_name":
		return &utls.SNIExtension{}, nil
	case "extended_master_secret":
		return &utls.ExtendedMasterSecretExtension{}, nil
	case "renegotiation_info":
		return &utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient}, nil
	case "session_ticket":
		return &utls.SessionTicketExtension{}, nil
	case "encrypt_then_mac":
		// uTLS has no first-class ETM extension (Go's stack never negotiates it,
		// and it is ignored under TLS 1.3). Advertise it verbatim as an empty
		// extension so the ClientHello byte shape matches the capture.
		return &utls.GenericExtension{Id: 0x0016}, nil
	case "supported_groups":
		return &utls.SupportedCurvesExtension{Curves: curveIDs(p.SupportedGroups)}, nil
	case "ec_point_formats":
		return &utls.SupportedPointsExtension{SupportedPoints: pointFormats(p.ECPointFormats)}, nil
	case "alpn":
		return &utls.ALPNExtension{AlpnProtocols: p.ALPN}, nil
	case "status_request":
		return &utls.StatusRequestExtension{}, nil
	case "signature_algorithms":
		return &utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: sigSchemes(p.SignatureAlgorithms)}, nil
	case "signed_certificate_timestamp":
		return &utls.SCTExtension{}, nil
	case "key_share":
		return &utls.KeyShareExtension{KeyShares: keyShares(p.KeyShareGroups)}, nil
	case "psk_key_exchange_modes":
		return &utls.PSKKeyExchangeModesExtension{Modes: pskModes(p.PSKModes)}, nil
	case "supported_versions":
		return &utls.SupportedVersionsExtension{Versions: tlsVersions(p.SupportedVersions)}, nil
	case "compress_certificate":
		return &utls.UtlsCompressCertExtension{Algorithms: certCompression(p.CertCompression)}, nil
	case "application_settings":
		return &utls.ApplicationSettingsExtension{SupportedProtocols: p.ALPN}, nil
	case "padding":
		return &utls.UtlsPaddingExtension{GetPaddingLen: utls.BoringPaddingStyle}, nil
	default:
		return nil, fmt.Errorf("unknown extension %q", name)
	}
}
