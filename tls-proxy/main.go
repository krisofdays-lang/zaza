// Command igtlsproxy is a loopback MITM forward-proxy that gives the Node app a
// byte-controllable TLS/JA4 + HTTP/2 fingerprint when talking to Instagram.
//
// Node points its HTTPS proxy at this process (http://127.0.0.1:PORT) and sets
// two headers on the CONNECT request:
//
//	X-Upstream-Proxy: the account's real mobile proxy (http(s):// or socks5://),
//	                  empty for a direct connection.
//	X-App-Version:    the pinned Instagram app version, used to pick the
//	                  version-matched TLS profile.
//
// We terminate Node's (loopback) TLS, then re-originate to Instagram using uTLS
// with a custom ClientHello and HTTP/2, chaining through the mobile proxy.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
)

func main() {
	defaultAddr := os.Getenv("TLS_PROXY_LISTEN")
	if defaultAddr == "" {
		defaultAddr = "127.0.0.1:8443"
	}

	addr := flag.String("listen", defaultAddr, "address to listen on (host:port)")
	fpFile := flag.String("fingerprints", os.Getenv("TLS_PROXY_FINGERPRINTS"), "optional JSON file with version->profile overrides")
	verbose := flag.Bool("verbose", os.Getenv("TLS_PROXY_VERBOSE") == "1", "log per-request diagnostics")
	flag.Parse()

	if *fpFile != "" {
		if err := LoadProfilesFromFile(*fpFile); err != nil {
			log.Fatalf("[tls-proxy] failed to load fingerprints from %s: %v", *fpFile, err)
		}
		log.Printf("[tls-proxy] loaded fingerprint overrides from %s", *fpFile)
	} else {
		log.Printf("[tls-proxy] using built-in captured iOS/IG-448 fingerprint (JA4 t13d2812h2); " +
			"set TLS_PROXY_FINGERPRINTS to override or add more app versions")
	}

	srv := &Server{verbose: *verbose}
	httpSrv := &http.Server{
		Addr:    *addr,
		Handler: srv,
	}
	log.Printf("[tls-proxy] listening on %s", *addr)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("[tls-proxy] server error: %v", err)
	}
}
