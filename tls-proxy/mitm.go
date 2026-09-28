package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"sync"
	"time"
)

// The Node -> Go hop is loopback only and Node connects with
// rejectUnauthorized:false, so these leaf certs exist purely to satisfy the TLS
// state machine for the SNI host. They are generated on the fly and cached per
// hostname. The security-sensitive handshake is the Go -> Instagram hop, which
// uses uTLS, not this.
var (
	certMu    sync.Mutex
	certCache = map[string]*tls.Certificate{}
)

func certForHost(host string) (*tls.Certificate, error) {
	certMu.Lock()
	defer certMu.Unlock()
	if c, ok := certCache[host]; ok {
		return c, nil
	}
	c, err := generateSelfSigned(host)
	if err != nil {
		return nil, err
	}
	certCache[host] = c
	return c, nil
}

// tlsServer wraps the hijacked Node connection as a TLS server. The Node side
// only ever speaks HTTP/1.1 to us, so we advertise just that; the h2 fingerprint
// that matters is applied on the Go -> Instagram hop.
func tlsServer(conn net.Conn, cert *tls.Certificate) *tls.Conn {
	return tls.Server(conn, &tls.Config{
		Certificates: []tls.Certificate{*cert},
		NextProtos:   []string{"http/1.1"},
		MinVersion:   tls.VersionTLS12,
	})
}

func generateSelfSigned(host string) (*tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour * 365),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, nil
}
