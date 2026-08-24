# syntax=docker/dockerfile:1

# Use glibc-based Debian image instead of Alpine (musl) because
# @xenova/transformers + onnxruntime-node require glibc native bindings

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

# Install runtime dependencies:
# - wget: required for docker-compose healthcheck
# - libgomp1: OpenMP runtime needed by ONNX Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
  wget \
  libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY .npmrc package.json package-lock.json ./
COPY prisma/ ./prisma/
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci --omit=dev && \
  npx prisma generate && \
  npm cache clean --force
COPY prisma.config.ts ./
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && \
  mkdir -p /app/.cache/transformers && chown -R node:node /app/.cache
USER node
EXPOSE 8794
ENTRYPOINT ["./docker-entrypoint.sh"]
