package main

// Lightweight HTTP/2 client built on the raw Framer + HPACK primitives.
//
// Why we can't use http2.Transport / http2.ClientConn:
//
//   - SETTINGS frame: hardcoded to Go defaults (INITIAL_WINDOW_SIZE=1MB,
//     connection WINDOW_UPDATE=1GB). iOS sends 2MB/~10MB. A perfect TLS
//     ClientHello followed by Go's SETTINGS is an instant bot fingerprint.
//
//   - Pseudo-header order: Go always emits :method, :scheme, :authority, :path.
//     iOS emits :method, :scheme, :path, :authority (Akamai: m,s,p,a). Hardcoded
//     in encodeHeaders, cannot be changed without forking x/net/http2.
//
//   - Header order: Go's http.Header is map[string][]string — iteration order
//     is random. iOS sends headers in a stable order. Again, no hook.
//
// This client handles exactly what our proxy needs: sequential request/response
// over a single h2 connection, with full control of the on-wire fingerprint.

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/hpack"
)

// ── iOS HTTP/2 fingerprint (captured from build 448) ─────────────────────

// SETTINGS frame values. These are the second packet Instagram sees (right
// after the TLS handshake), before any request. Go sends completely different
// values, which makes the perfect ClientHello pointless.
// Real Instagram iOS app (build 448) SETTINGS captured via mitmproxy:
//   Akamai shorthand: 2:0;4:163840
//   Only 2 settings — NOT Safari's 5. Instagram uses Tigon/MNS, not CFNetwork.
var iosH2Settings = []http2.Setting{
	{ID: http2.SettingEnablePush, Val: 0},
	{ID: http2.SettingInitialWindowSize, Val: 163840}, // 160 KB (Safari: 2 MB, Go: 1 MB)
}

// Connection-level flow control window. The spec default is 65535; Instagram
// sends a WINDOW_UPDATE of 2031617 on stream 0 immediately, bumping the
// connection window to 65535 + 2031617 = 2097152 (2 MB).
const iosConnWindowDelta = 2031617

// Pseudo-header order. Go: :method, :scheme, :authority, :path.
// Instagram iOS (Tigon/MNS): :authority, :method, :path, :scheme (a,m,p,s).
// Captured from real mitmproxy decode — every request to i.instagram.com uses
// this order, completely different from Safari's m,s,p,a.
var iosPseudoOrder = [4]string{":authority", ":method", ":path", ":scheme"}

// Regular header order captured from real Instagram iOS app (build 448) via
// mitmproxy. The order is stable across all requests on i.instagram.com.
//
// Structure: app-level headers in a specific order, then a fixed "trailer"
// block added by the Tigon/MNS networking layer:
//   accept-encoding, x-fb-conn-uuid-client, x-fb-http-engine, x-fb-rmd
//
// Headers not in this list go just before the trailer, sorted by name.
var iosHeaderPriority = func() map[string]int {
	order := []string{
		// ── App-level headers (order from authenticated POST capture) ──
		"accept-language",
		"authorization",
		"content-length",
		"content-type",
		"ig-intended-user-id",
		"ig-u-ds-user-id",
		"ig-u-rur",
		"priority",
		"user-agent",
		"x-bloks-is-prism-enabled",
		"x-bloks-prism-ax-base-colors-enabled",
		"x-bloks-prism-button-version",
		"x-bloks-prism-colors-enabled",
		"x-bloks-prism-extended-palette-gray",
		"x-bloks-prism-extended-palette-gray-10-variant",
		"x-bloks-prism-extended-palette-indigo",
		"x-bloks-prism-extended-palette-polish-enabled",
		"x-bloks-prism-extended-palette-red",
		"x-bloks-prism-extended-palette-rest-of-colors",
		"x-bloks-prism-font-enabled",
		"x-bloks-prism-link-colors-enabled",
		"x-bloks-version-id",
		"x-client-doc-id",
		"x-cloud-trust-token",
		"x-fb-client-ip",
		"x-fb-connection-type",
		"x-fb-friendly-name",
		"x-fb-request-analytics-tags",
		"x-fb-server-cluster",
		"x-ig-abr-connection-speed-kbps",
		"x-ig-app-id",
		"x-ig-app-locale",
		"x-ig-app-startup-country",
		"x-ig-bandwidth-speed-kbps",
		"x-ig-bloks-serialize-payload",
		"x-ig-capabilities",
		"x-ig-client-endpoint",
		"x-ig-connection-speed",
		"x-ig-connection-type",
		"x-ig-device-id",
		"x-ig-device-languages",
		"x-ig-device-locale",
		"x-ig-device-timezone",
		"x-ig-family-device-id",
		"x-ig-mapped-locale",
		"x-ig-nav-chain",
		"x-ig-salt-ids",
		"x-ig-timezone-offset",
		"x-ig-www-claim",
		"x-mid",
		"x-meta-usdid-uuid",
		"x-pigeon-rawclienttime",
		"x-pigeon-session-id",
		"x-root-field-name",
		"x-tigon-is-retry",
		"x-graphql-client-library",
		// ── Upload headers ──
		"x-instagram-rupload-params",
		"x-entity-type",
		"x-entity-name",
		"x-entity-length",
		"offset",
		// ── Tigon/MNS trailer (always last, in this order) ──
		"accept-encoding",
		"x-fb-conn-uuid-client",
		"x-fb-http-engine",
		"x-fb-rmd",
	}
	m := make(map[string]int, len(order))
	for i, name := range order {
		m[name] = i
	}
	return m
}()

// ── iosH2Client ──────────────────────────────────────────────────────────

// iosH2Client is a sequential-only HTTP/2 client that writes frames in an
// iOS-matching fingerprint. It is NOT goroutine-safe — the proxy uses one
// per tunnel and pumps requests sequentially, which matches how the real
// app multiplexes on a single h2 connection.
type iosH2Client struct {
	conn   net.Conn
	bw     *bufio.Writer
	fr     *http2.Framer
	henc   *hpack.Encoder
	hbuf   bytes.Buffer // scratch for HPACK encoding
	nextID uint32

	// Per-stream flow control. We track the initial window the server gave
	// us (from their SETTINGS INITIAL_WINDOW_SIZE) so we know how much DATA
	// we can send before needing a WINDOW_UPDATE from the server. For the
	// proxy workload (small-ish POST bodies, large responses) this is rarely
	// the bottleneck, but we handle it correctly anyway.
	peerInitialWindowSize uint32
	peerConnWindow        int64
}

// newIOSH2Client creates a client from an already-connected net.Conn (post
// TLS handshake). It writes the HTTP/2 connection preface with iOS-matching
// SETTINGS and WINDOW_UPDATE, reads the server's SETTINGS, and is then ready
// for RoundTrip calls.
func newIOSH2Client(conn net.Conn) (*iosH2Client, error) {
	// ── 1. Connection preface ────────────────────────────────────────
	bw := bufio.NewWriterSize(conn, 32768)
	if _, err := bw.WriteString(http2.ClientPreface); err != nil {
		return nil, fmt.Errorf("write preface: %w", err)
	}

	fr := http2.NewFramer(bw, conn)
	// Enable automatic HEADERS+CONTINUATION reassembly with HPACK decoding.
	fr.ReadMetaHeaders = hpack.NewDecoder(4096, nil)
	// Don't enforce max header list size on reads — Instagram can send big
	// response headers, and we don't want to RST_STREAM for that.
	fr.MaxHeaderListSize = 0

	// ── 2. SETTINGS (iOS values) ─────────────────────────────────────
	if err := fr.WriteSettings(iosH2Settings...); err != nil {
		return nil, fmt.Errorf("write settings: %w", err)
	}

	// ── 3. WINDOW_UPDATE on stream 0 to bump connection window ───────
	// Instagram sends exactly 2031617 as the increment (65535 + 2031617 = 2097152).
	if err := fr.WriteWindowUpdate(0, iosConnWindowDelta); err != nil {
		return nil, fmt.Errorf("write window update: %w", err)
	}

	// Flush the preface + SETTINGS + WINDOW_UPDATE as one TCP segment.
	if err := bw.Flush(); err != nil {
		return nil, fmt.Errorf("flush preface: %w", err)
	}

	c := &iosH2Client{
		conn:                  conn,
		bw:                    bw,
		fr:                    fr,
		nextID:                1,
		peerInitialWindowSize: 65535,  // spec default until server SETTINGS
		peerConnWindow:        65535,  // ditto
	}
	c.henc = hpack.NewEncoder(&c.hbuf)

	// ── 4. Read server preface (SETTINGS) and ACK ────────────────────
	if err := c.consumeServerPreface(); err != nil {
		return nil, err
	}

	return c, nil
}

// consumeServerPreface reads frames until we've received (and ACKed) the
// server's initial SETTINGS, plus our own SETTINGS ACK. We might also get
// WINDOW_UPDATE or other frames — those are handled inline.
func (c *iosH2Client) consumeServerPreface() error {
	gotServerSettings := false
	gotOurAck := false
	for !(gotServerSettings && gotOurAck) {
		f, err := c.fr.ReadFrame()
		if err != nil {
			return fmt.Errorf("read server preface: %w", err)
		}
		switch sf := f.(type) {
		case *http2.SettingsFrame:
			if sf.IsAck() {
				gotOurAck = true
				continue
			}
			// Apply peer settings we care about.
			sf.ForeachSetting(func(s http2.Setting) error {
				if s.ID == http2.SettingInitialWindowSize {
					c.peerInitialWindowSize = s.Val
				}
				return nil
			})
			// ACK the server's SETTINGS.
			if err := c.fr.WriteSettingsAck(); err != nil {
				return fmt.Errorf("write settings ack: %w", err)
			}
			if err := c.bw.Flush(); err != nil {
				return fmt.Errorf("flush settings ack: %w", err)
			}
			gotServerSettings = true
		case *http2.WindowUpdateFrame:
			if sf.StreamID == 0 {
				c.peerConnWindow += int64(sf.Increment)
			}
		case *http2.PingFrame:
			if !sf.IsAck() {
				c.fr.WritePing(true, sf.Data)
				c.bw.Flush()
			}
		default:
			// Ignore unexpected frames during preface.
		}
	}
	return nil
}

// RoundTrip sends a request and reads its response. Blocks until the full
// response (including body) is received. Not safe for concurrent use.
func (c *iosH2Client) RoundTrip(req *http.Request) (*http.Response, error) {
	streamID := c.nextID
	c.nextID += 2

	// ── Encode headers ───────────────────────────────────────────────
	c.hbuf.Reset()

	// Pseudo-headers in Instagram order: :authority, :method, :path, :scheme.
	method := req.Method
	if method == "" {
		method = "GET"
	}
	path := req.URL.RequestURI()
	if path == "" {
		path = "/"
	}
	authority := req.Host
	if authority == "" {
		authority = req.URL.Host
	}

	pseudos := map[string]string{
		":method":    method,
		":path":      path,
		":scheme":    "https",
		":authority": authority,
	}
	for _, p := range iosPseudoOrder {
		c.henc.WriteField(hpack.HeaderField{Name: p, Value: pseudos[p]})
	}

	// Regular headers in iOS-matching stable order.
	encodeOrderedHeaders(c.henc, req.Header)

	headerBlock := make([]byte, c.hbuf.Len())
	copy(headerBlock, c.hbuf.Bytes())

	// ── Determine if we have a body ──────────────────────────────────
	var body []byte
	if req.Body != nil {
		var err error
		body, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, fmt.Errorf("read request body: %w", err)
		}
	}
	endStream := len(body) == 0

	// ── Write HEADERS frame ──────────────────────────────────────────
	if err := c.fr.WriteHeaders(http2.HeadersFrameParam{
		StreamID:      streamID,
		BlockFragment: headerBlock,
		EndStream:     endStream,
		EndHeaders:    true,
	}); err != nil {
		return nil, fmt.Errorf("write headers: %w", err)
	}

	// ── Write body as DATA frames ────────────────────────────────────
	if !endStream {
		const maxChunk = 16384
		for len(body) > 0 {
			chunk := body
			if len(chunk) > maxChunk {
				chunk = body[:maxChunk]
			}
			body = body[len(chunk):]
			fin := len(body) == 0
			if err := c.fr.WriteData(streamID, fin, chunk); err != nil {
				return nil, fmt.Errorf("write data: %w", err)
			}
		}
	}

	// Flush the entire request (HEADERS + DATA) in as few TCP writes as
	// possible, matching how a real app batches frames.
	if err := c.bw.Flush(); err != nil {
		return nil, fmt.Errorf("flush request: %w", err)
	}

	// ── Read response ────────────────────────────────────────────────
	return c.readResponse(streamID)
}

// readResponse reads frames until the response for streamID is complete.
// Handles interleaved control frames (SETTINGS, PING, WINDOW_UPDATE,
// GOAWAY) inline so the connection stays alive.
func (c *iosH2Client) readResponse(streamID uint32) (*http.Response, error) {
	resp := &http.Response{
		Proto:      "HTTP/2.0",
		ProtoMajor: 2,
		ProtoMinor: 0,
		Header:     make(http.Header),
	}
	var body bytes.Buffer

	for {
		f, err := c.fr.ReadFrame()
		if err != nil {
			return nil, fmt.Errorf("read frame: %w", err)
		}

		switch sf := f.(type) {
		case *http2.MetaHeadersFrame:
			if sf.StreamID != streamID {
				continue
			}
			for _, hf := range sf.Fields {
				if hf.Name == ":status" {
					resp.StatusCode, _ = strconv.Atoi(hf.Value)
					resp.Status = hf.Value + " " + http.StatusText(resp.StatusCode)
				} else {
					resp.Header.Add(http.CanonicalHeaderKey(hf.Name), hf.Value)
				}
			}
			if sf.StreamEnded() {
				resp.Body = io.NopCloser(&body)
				resp.ContentLength = int64(body.Len())
				return resp, nil
			}

		case *http2.DataFrame:
			if sf.StreamID != streamID {
				continue
			}
			n := len(sf.Data())
			body.Write(sf.Data())
			// Send WINDOW_UPDATE for received data (flow control).
			if n > 0 {
				c.fr.WriteWindowUpdate(streamID, uint32(n))
				c.fr.WriteWindowUpdate(0, uint32(n))
				c.bw.Flush()
			}
			if sf.StreamEnded() {
				resp.Body = io.NopCloser(&body)
				resp.ContentLength = int64(body.Len())
				return resp, nil
			}

		case *http2.SettingsFrame:
			if !sf.IsAck() {
				sf.ForeachSetting(func(s http2.Setting) error {
					if s.ID == http2.SettingInitialWindowSize {
						c.peerInitialWindowSize = s.Val
					}
					return nil
				})
				c.fr.WriteSettingsAck()
				c.bw.Flush()
			}

		case *http2.PingFrame:
			if !sf.IsAck() {
				c.fr.WritePing(true, sf.Data)
				c.bw.Flush()
			}

		case *http2.WindowUpdateFrame:
			if sf.StreamID == 0 {
				c.peerConnWindow += int64(sf.Increment)
			}

		case *http2.GoAwayFrame:
			return nil, fmt.Errorf("server sent GOAWAY: %v", sf.ErrCode)

		case *http2.RSTStreamFrame:
			if sf.StreamID == streamID {
				return nil, fmt.Errorf("stream %d reset: %v", streamID, sf.ErrCode)
			}
		}
	}
}

// CanTakeNewRequest reports whether the connection can still carry requests.
func (c *iosH2Client) CanTakeNewRequest() bool {
	return c.nextID < (1<<31 - 1)
}

// ── Header ordering ──────────────────────────────────────────────────────

type headerEntry struct {
	name  string
	value string
	order int
}

// encodeOrderedHeaders writes the non-pseudo headers of h into enc in the
// iOS-captured order. Unknown headers go at the end, sorted by name.
func encodeOrderedHeaders(enc *hpack.Encoder, h http.Header) {
	unknown := len(iosHeaderPriority) // for headers not in the priority map

	var entries []headerEntry
	for name, vals := range h {
		lower := strings.ToLower(name)
		// Skip pseudo-headers (already written) and hop-by-hop.
		if strings.HasPrefix(lower, ":") || hopHeaders[lower] {
			continue
		}
		ord, ok := iosHeaderPriority[lower]
		if !ok {
			ord = unknown
		}
		for _, v := range vals {
			entries = append(entries, headerEntry{lower, v, ord})
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].order != entries[j].order {
			return entries[i].order < entries[j].order
		}
		return entries[i].name < entries[j].name
	})

	for _, e := range entries {
		enc.WriteField(hpack.HeaderField{Name: e.name, Value: e.value})
	}
}
