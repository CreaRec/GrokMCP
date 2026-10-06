# syntax=docker/dockerfile:1
# Thin wrapper around upstream grafana/mcp-grafana that adds sibling GET /health.

FROM golang:1.22-bookworm AS proxy-builder
WORKDIR /src
COPY proxy/go.mod ./
COPY proxy/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go test ./... \
  && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /grafana-health-proxy .

FROM grafana/mcp-grafana:1.1.0

USER root
# wget: compose healthcheck (siblings use the same pattern).
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*

COPY --from=proxy-builder /grafana-health-proxy /usr/local/bin/grafana-health-proxy
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh /usr/local/bin/grafana-health-proxy

USER mcp-grafana
EXPOSE 8000
ENV HEALTH_PROXY_VERSION=1.1.0
ENTRYPOINT ["/entrypoint.sh"]
