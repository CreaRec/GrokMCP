# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY prisma/ ./prisma/
COPY src/ ./src/
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers
COPY .npmrc package.json package-lock.json ./
COPY prisma/ ./prisma/
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci --omit=dev && \
  npx prisma generate && \
  npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/.cache/transformers && chown -R node:node /app/.cache
USER node
EXPOSE 8794
CMD ["node", "dist/http.js"]
