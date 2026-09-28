package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// hop-by-hop headers that must not be forwarded upstream.
var hopHeaders = map[string]bool{
	"connection":          true,
	"proxy-connection":    true,
	"keep-alive":          true,
	"proxy-authorization": true,
	"proxy-authenticate":  true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	// custom control headers the Node side attaches to the CONNECT request
	"x-upstream-proxy": true,
	"x-app-version":    true,
}

type Server struct {
	verbose bool
}

func (s *Server) logf(format string, args ...any) {
	if s.verbose {
		log.Printf(format, args...)
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		http.Error(w, "only CONNECT is supported", http.StatusMethodNotAllowed)
		return
	}
	s.handleConnect(w, r)
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	target := r.Host // e.g. "i.instagram.com:443"
	host := target
	if i := strings.IndexByte(target, ':'); i >= 0 {
		host = target[:i]
	}
	// Per-tunnel control values the Node client sets on the CONNECT request.
	upstreamProxy := r.Header.Get("X-Upstream-Proxy")
	appVersion := r.Header.Get("X-App-Version")

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		s.logf("hijack error: %v", err)
		return
	}
	defer clientConn.Close()

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}

	// Terminate Node's TLS locally (loopback, cert not verified by Node) so we
	// can read plaintext HTTP/1.1 and re-originate to Instagram with uTLS.
	cert, err := certForHost(host)
	if err != nil {
		s.logf("cert error for %s: %v", host, err)
		return
	}
	tlsConn := tlsServer(clientConn, cert)
	if err := tlsConn.Handshake(); err != nil {
		s.logf("node-side TLS handshake failed: %v", err)
		return
	}
	defer tlsConn.Close()

	s.pumpTunnel(tlsConn, host, appVersion, upstreamProxy)
}

// pumpTunnel reads successive HTTP/1.1 requests from the Node side and forwards
// each over a single HTTP/2 connection to Instagram, mirroring how the real app
// multiplexes one h2 connection per host.
func (s *Server) pumpTunnel(nodeConn net.Conn, host, appVersion, upstreamProxy string) {
	br := bufio.NewReader(nodeConn)
	var cc *iosH2Client
	var underlying net.Conn
	defer func() {
		if underlying != nil {
			underlying.Close()
		}
	}()

	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			if err != io.EOF {
				s.logf("read request: %v", err)
			}
			return
		}

		if cc == nil || !cc.CanTakeNewRequest() {
			if underlying != nil {
				underlying.Close()
			}
			cc, underlying, err = newH2ClientConn(host, appVersion, upstreamProxy)
			if err != nil {
				s.logf("connect to %s failed: %v", host, err)
				writeGatewayError(nodeConn, err)
				return
			}
		}

		resp, err := cc.RoundTrip(buildOutgoing(req, host))
		if err != nil {
			s.logf("roundtrip %s%s: %v", host, req.URL.Path, err)
			writeGatewayError(nodeConn, err)
			return
		}

		keepAlive, err := writeResponse(nodeConn, resp)
		resp.Body.Close()
		if err != nil {
			s.logf("write response: %v", err)
			return
		}
		if !keepAlive {
			return
		}
	}
}

// buildOutgoing converts a server-read request into an absolute-URL client
// request suitable for the h2 transport, stripping hop-by-hop headers while
// preserving the app's own headers (including accept-encoding) byte-for-byte.
func buildOutgoing(req *http.Request, host string) *http.Request {
	out := req.Clone(context.Background())
	out.RequestURI = ""
	out.URL.Scheme = "https"
	out.URL.Host = host
	if out.Host == "" {
		out.Host = host
	}
	for h := range out.Header {
		if hopHeaders[strings.ToLower(h)] {
			out.Header.Del(h)
		}
	}
	return out
}

// writeResponse serialises an upstream response back to the Node side as
// HTTP/1.1, transparently decompressing gzip/deflate so axios gets plaintext.
func writeResponse(nodeConn net.Conn, resp *http.Response) (keepAlive bool, err error) {
	encoding := resp.Header.Get("Content-Encoding")
	bodyReader, err := decodeBody(encoding, resp.Body)
	if err != nil {
		return false, err
	}
	body, err := io.ReadAll(bodyReader)
	if err != nil {
		return false, err
	}

	var b bytes.Buffer
	b.WriteString("HTTP/1.1 ")
	b.WriteString(strconv.Itoa(resp.StatusCode))
	b.WriteByte(' ')
	b.WriteString(http.StatusText(resp.StatusCode))
	b.WriteString("\r\n")

	for k, vals := range resp.Header {
		lk := strings.ToLower(k)
		if lk == "content-encoding" || lk == "content-length" || lk == "transfer-encoding" || lk == "connection" {
			continue
		}
		for _, v := range vals {
			b.WriteString(k)
			b.WriteString(": ")
			b.WriteString(v)
			b.WriteString("\r\n")
		}
	}
	b.WriteString("Content-Length: ")
	b.WriteString(strconv.Itoa(len(body)))
	b.WriteString("\r\n")
	b.WriteString("Connection: keep-alive\r\n\r\n")
	b.Write(body)

	if _, err := nodeConn.Write(b.Bytes()); err != nil {
		return false, err
	}
	return true, nil
}

func writeGatewayError(nodeConn net.Conn, cause error) {
	msg := cause.Error()
	var b bytes.Buffer
	b.WriteString("HTTP/1.1 502 Bad Gateway\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Length: ")
	b.WriteString(strconv.Itoa(len(msg)))
	b.WriteString("\r\n")
	b.WriteString("Connection: close\r\n\r\n")
	b.WriteString(msg)
	_ = nodeConn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = nodeConn.Write(b.Bytes())
}
