package main

import (
	"strconv"
	"strings"

	utls "github.com/refraction-networking/utls"
)

// parseUint16 accepts "0x1301", "4865", etc.
func parseUint16(s string) (uint16, error) {
	s = strings.TrimSpace(s)
	base := 10
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		s = s[2:]
		base = 16
	}
	v, err := strconv.ParseUint(s, base, 16)
	return uint16(v), err
}

func curveIDs(names []string) []utls.CurveID {
	out := make([]utls.CurveID, 0, len(names))
	for _, n := range names {
		switch strings.ToLower(n) {
		case "x25519":
			out = append(out, utls.X25519)
		case "secp256r1", "p256":
			out = append(out, utls.CurveP256)
		case "secp384r1", "p384":
			out = append(out, utls.CurveP384)
		case "secp521r1", "p521":
			out = append(out, utls.CurveP521)
		default:
			if v, err := parseUint16(n); err == nil {
				out = append(out, utls.CurveID(v))
			}
		}
	}
	return out
}

func pointFormats(names []string) []byte {
	if len(names) == 0 {
		return []byte{0x00}
	}
	out := make([]byte, 0, len(names))
	for _, n := range names {
		switch strings.ToLower(n) {
		case "uncompressed":
			out = append(out, 0x00)
		default:
			if v, err := strconv.Atoi(n); err == nil {
				out = append(out, byte(v))
			}
		}
	}
	return out
}

func sigSchemes(vals []HexU16) []utls.SignatureScheme {
	out := make([]utls.SignatureScheme, 0, len(vals))
	for _, v := range vals {
		out = append(out, utls.SignatureScheme(v))
	}
	return out
}

func keyShares(names []string) []utls.KeyShare {
	out := make([]utls.KeyShare, 0, len(names))
	for _, id := range curveIDs(names) {
		out = append(out, utls.KeyShare{Group: id})
	}
	return out
}

func pskModes(names []string) []uint8 {
	if len(names) == 0 {
		return []uint8{utls.PskModeDHE}
	}
	out := make([]uint8, 0, len(names))
	for _, n := range names {
		switch strings.ToLower(n) {
		case "psk_dhe_ke", "dhe":
			out = append(out, utls.PskModeDHE)
		case "psk_ke", "plain":
			out = append(out, utls.PskModePlain)
		default:
			if v, err := strconv.Atoi(n); err == nil {
				out = append(out, uint8(v))
			}
		}
	}
	return out
}

func tlsVersions(names []string) []uint16 {
	out := make([]uint16, 0, len(names))
	for _, n := range names {
		switch strings.TrimSpace(n) {
		case "1.3", "tls1.3", "0x0304":
			out = append(out, utls.VersionTLS13)
		case "1.2", "tls1.2", "0x0303":
			out = append(out, utls.VersionTLS12)
		default:
			if v, err := parseUint16(n); err == nil {
				out = append(out, v)
			}
		}
	}
	if len(out) == 0 {
		out = []uint16{utls.VersionTLS13, utls.VersionTLS12}
	}
	return out
}

func certCompression(names []string) []utls.CertCompressionAlgo {
	out := make([]utls.CertCompressionAlgo, 0, len(names))
	for _, n := range names {
		switch strings.ToLower(n) {
		case "zlib":
			out = append(out, utls.CertCompressionZlib)
		case "brotli":
			out = append(out, utls.CertCompressionBrotli)
		case "zstd":
			out = append(out, utls.CertCompressionZstd)
		}
	}
	if len(out) == 0 {
		out = []utls.CertCompressionAlgo{utls.CertCompressionZlib}
	}
	return out
}
