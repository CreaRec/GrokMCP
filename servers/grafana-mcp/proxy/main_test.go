package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthMatchesSiblingShape(t *testing.T) {
	handler, err := newHandler("http://127.0.0.1:9", "grafana-mcp", "1.1.0")
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type=%q want application/json", ct)
	}

	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health JSON: %v body=%s", err, rec.Body.String())
	}
	if body.Status != "ok" || body.Service != "grafana-mcp" || body.Version != "1.1.0" {
		t.Fatalf("unexpected health body: %+v", body)
	}
}

func TestHealthRejectsPost(t *testing.T) {
	handler, err := newHandler("http://127.0.0.1:9", "grafana-mcp", "1.1.0")
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/health", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestProxiesNonHealthPaths(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" {
			t.Fatalf("upstream path=%s want=/mcp", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"proxied":true}`)
	}))
	t.Cleanup(upstream.Close)

	handler, err := newHandler(upstream.URL, "grafana-mcp", "1.1.0")
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"proxied":true`) {
		t.Fatalf("body=%s want proxied payload", rec.Body.String())
	}
}

func TestHealthDoesNotHitUpstream(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	t.Cleanup(upstream.Close)

	handler, err := newHandler(upstream.URL, "grafana-mcp", "1.1.0")
	if err != nil {
		t.Fatalf("newHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want=%d", rec.Code, http.StatusOK)
	}
	if upstreamHits != 0 {
		t.Fatalf("upstream hits=%d want=0", upstreamHits)
	}
}
