# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json prisma.config.ts ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

RUN apt-get update && apt-get install -y --no-install-recommends \
  libgomp1 \
  libheif1 \
  libheif-examples \
  imagemagick \
  qpdf \
  poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY .npmrc package.json package-lock.json prisma.config.ts ./
COPY prisma/ ./prisma/
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci --omit=dev && \
  DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && \
  npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/.cache/transformers && chown -R node:node /app/.cache
USER node
CMD ["node", "dist/index.js"]
