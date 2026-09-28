package main

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/proxy"
)

// dialTimeout is applied to the TCP + proxy-CONNECT phase.
const dialTimeout = 30 * time.Second

// dialUpstreamTCP opens a raw TCP connection to targetHostPort, optionally
// tunnelling through an upstream mobile proxy (HTTP-CONNECT or SOCKS5). The
// proxy URL comes from the account and is passed per-tunnel by the Node side.
func dialUpstreamTCP(targetHostPort, proxyRaw string) (net.Conn, error) {
	proxyRaw = strings.TrimSpace(proxyRaw)
	if proxyRaw == "" {
		return net.DialTimeout("tcp", targetHostPort, dialTimeout)
	}

	pu, err := normalizeProxyURL(proxyRaw)
	if err != nil {
		return nil, err
	}

	switch pu.Scheme {
	case "socks5", "socks5h":
		var auth *proxy.Auth
		if pu.User != nil {
			pw, _ := pu.User.Password()
			auth = &proxy.Auth{User: pu.User.Username(), Password: pw}
		}
		d, err := proxy.SOCKS5("tcp", pu.Host, auth, &net.Dialer{Timeout: dialTimeout})
		if err != nil {
			return nil, err
		}
		return d.Dial("tcp", targetHostPort)
	case "http", "https":
		return dialViaHTTPConnect(pu, targetHostPort)
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", pu.Scheme)
	}
}

// dialViaHTTPConnect performs an HTTP CONNECT handshake through an upstream
// proxy, including Proxy-Authorization when the URL carries credentials.
func dialViaHTTPConnect(pu *url.URL, targetHostPort string) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", pu.Host, dialTimeout)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\n", targetHostPort)
	fmt.Fprintf(&b, "Host: %s\r\n", targetHostPort)
	if pu.User != nil {
		pw, _ := pu.User.Password()
		token := base64.StdEncoding.EncodeToString([]byte(pu.User.Username() + ":" + pw))
		fmt.Fprintf(&b, "Proxy-Authorization: Basic %s\r\n", token)
	}
	b.WriteString("Proxy-Connection: Keep-Alive\r\n\r\n")
	if _, err := conn.Write([]byte(b.String())); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
	if err != nil {
		conn.Close()
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("upstream proxy CONNECT failed: %s", resp.Status)
	}
	return conn, nil
}

func normalizeProxyURL(raw string) (*url.URL, error) {
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return url.Parse(raw)
}

// newH2ClientConn dials the target through the (optional) upstream proxy, wraps
// the connection in a uTLS ClientHello matching the given profile, and returns
// an HTTP/2 client with iOS-matching SETTINGS / header order ready for
// RoundTrip. If ALPN does not negotiate h2 an error is returned.
func newH2ClientConn(host, appVersion, proxyRaw string) (*iosH2Client, net.Conn, error) {
	target := host
	if !strings.Contains(host, ":") {
		target = host + ":443"
	}
	hostname := host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		hostname = host[:i]
	}

	raw, err := dialUpstreamTCP(target, proxyRaw)
	if err != nil {
		return nil, nil, fmt.Errorf("dial upstream: %w", err)
	}

	profile := profileForVersion(appVersion)
	spec, err := profile.buildSpec()
	if err != nil {
		raw.Close()
		return nil, nil, fmt.Errorf("build clienthello spec: %w", err)
	}

	uconn := utls.UClient(raw, &utls.Config{ServerName: hostname, NextProtos: profile.ALPN}, utls.HelloCustom)
	if err := uconn.ApplyPreset(spec); err != nil {
		raw.Close()
		return nil, nil, fmt.Errorf("apply preset: %w", err)
	}
	uconn.SetDeadline(time.Now().Add(dialTimeout))
	if err := uconn.Handshake(); err != nil {
		raw.Close()
		return nil, nil, fmt.Errorf("utls handshake: %w", err)
	}
	uconn.SetDeadline(time.Time{})

	if state := uconn.ConnectionState(); state.NegotiatedProtocol != "h2" {
		uconn.Close()
		return nil, nil, fmt.Errorf("expected ALPN h2, got %q", state.NegotiatedProtocol)
	}

	// Use our custom iOS-fingerprinted HTTP/2 client instead of Go's
	// http2.Transport. It sends iOS-matching SETTINGS, pseudo-header order,
	// and stable regular-header order — none of which http2.Transport allows
	// customising.
	cc, err := newIOSH2Client(uconn)
	if err != nil {
		uconn.Close()
		return nil, nil, fmt.Errorf("new ios h2 conn: %w", err)
	}
	return cc, uconn, nil
}

// decodeBody transparently decompresses response bodies so the Node side always
// receives plaintext, regardless of the app's accept-encoding.
//
// This MUST cover every codec Instagram might pick, because writeResponse strips
// the content-encoding header before forwarding: if we hand back a body that is
// still compressed, axios sees no encoding header, assumes plaintext, fails to
// JSON.parse the binary, and callers silently get an empty result. That is
// exactly what produced the phantom "Refresh failed 200" — info_stream came back
// HTTP 200 but brotli/zstd-encoded, so no `user` was ever parsed. Node's axios
// advertises `br` by default and iOS advertises `zstd`, so both are required in
// addition to gzip/deflate.
func decodeBody(encoding string, body io.ReadCloser) (io.ReadCloser, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "gzip":
		zr, err := gzip.NewReader(body)
		if err != nil {
			return nil, err
		}
		return zr, nil
	case "deflate":
		return flate.NewReader(body), nil
	case "br":
		return io.NopCloser(brotli.NewReader(body)), nil
	case "zstd":
		zr, err := zstd.NewReader(body)
		if err != nil {
			return nil, err
		}
		// zstd.Decoder isn't an io.Closer in the usual sense; IOReadCloser wraps
		// it so Close() safely releases the decoder.
		return zr.IOReadCloser(), nil
	default:
		return body, nil
	}
}
