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
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# cups-client provides lp / lpstat; talk to host CUPS via CUPS_SERVER (no cupsd in-container).
RUN apk add --no-cache cups-client \
  && mkdir -p /var/tmp/print-mcp \
  && chown node:node /var/tmp/print-mcp
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
  NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 8797
CMD ["node", "dist/http.js"]
