// grafana-health-proxy serves GET /health in the sibling MCP JSON shape and
// reverse-proxies every other path to upstream mcp-grafana.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
}

func main() {
	listen := flag.String("listen", envOr("HEALTH_PROXY_LISTEN", "0.0.0.0:8000"), "proxy listen address")
	upstream := flag.String("upstream", envOr("HEALTH_PROXY_UPSTREAM", "http://127.0.0.1:8001"), "upstream mcp-grafana base URL")
	service := flag.String("service", envOr("HEALTH_PROXY_SERVICE", "grafana-mcp"), "service name in /health JSON")
	version := flag.String("version", envOr("HEALTH_PROXY_VERSION", "1.1.0"), "version in /health JSON")
	flag.Parse()

	handler, err := newHandler(*upstream, *service, *version)
	if err != nil {
		log.Fatalf("health proxy: %v", err)
	}

	server := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("grafana health proxy listening on http://%s (upstream %s)", *listen, *upstream)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("health proxy listen: %v", err)
	}
}

func newHandler(upstreamRaw, service, version string) (http.Handler, error) {
	upstreamURL, err := url.Parse(upstreamRaw)
	if err != nil {
		return nil, fmt.Errorf("parse upstream URL: %w", err)
	}
	if upstreamURL.Scheme == "" || upstreamURL.Host == "" {
		return nil, fmt.Errorf("upstream URL must include scheme and host: %q", upstreamRaw)
	}

	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		// Preserve the caller's Host for mcp-grafana allowed-hosts checks when
		// not using "*"; SingleHostReverseProxy rewrites Host to the upstream.
		// With compose --allowed-hosts "*", either form is fine.
		req.Host = upstreamURL.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("upstream proxy error method=%s path=%s err=%v", r.Method, r.URL.Path, err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeHealth(w, service, version)
	})
	mux.Handle("/", proxy)
	return mux, nil
}

func writeHealth(w http.ResponseWriter, service, version string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(healthResponse{
		Status:  "ok",
		Service: service,
		Version: version,
	})
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
