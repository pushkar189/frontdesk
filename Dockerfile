# ── Stage 1: build web ──────────────────────────────────────────────────
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci --include=dev --legacy-peer-deps
COPY web/ ./
RUN npm run build

# ── Stage 2: build server ────────────────────────────────────────────────
FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --include=dev --legacy-peer-deps
COPY server/ ./
RUN npm run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Production server deps only
COPY server/package.json ./
COPY server/package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps

# Server build output
COPY --from=server-builder /app/server/dist ./dist
COPY --from=server-builder /app/server/migrations ./migrations

# Web build (served by Express in production)
COPY --from=web-builder /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
