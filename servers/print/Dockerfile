# syntax=docker/dockerfile:1

# Bookworm (not Alpine): LibreOffice headless is reliable on glibc/Debian and
# matches the debian-server ops docs. Writer-nogui converts txt/docx/odt/rtf/doc → PDF.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# cups-client: lp / lpstat → host CUPS via CUPS_SERVER (no cupsd in-container).
# libreoffice-writer-nogui: soffice --headless --convert-to pdf for office/text.
# fonts-dejavu-core: readable glyphs in converted PDFs.
# wget: compose healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cups-client \
    fonts-dejavu-core \
    libreoffice-writer-nogui \
    wget \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/tmp/print-mcp \
  && chown node:node /var/tmp/print-mcp
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8797
CMD ["node", "dist/http.js"]
