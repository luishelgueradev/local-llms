# Phase 2 router image — D-A2 four-stage build.
# Stages: deps -> build -> prod-deps -> runtime
# Runtime base: node:22-bookworm-slim (CLAUDE.md/STATE.md anti-pattern list
# forbids alpine and floating tags — musl libc breaks native deps).
#
# Phase 20 (v0.12.0 — OPS-02 / D-08): bake BUILD_SHA + BUILD_TIME for source/image
# skew detection. Default to 'unknown' sentinels so a docker build without
# --build-arg still completes successfully (Open Q5 — warn-only, not hard-fail).
# bin/deploy-router.sh full passes both args:
#   --build-arg BUILD_SHA=$(git rev-parse HEAD)
#   --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The runtime stage's ENV directives below project these args into process.env
# where router/src/version.ts reads them at module load time.

# ---- 1) deps: install all deps with cache ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# ---- 2) build: compile TS -> dist/ via tsup ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npx tsup

# ---- 3) prod-deps: clean prod-only node_modules for runtime ----
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- 4) runtime: minimal final image ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Phase 21 (v0.12.0 post-ship hygiene — HYG-02): bake `curl` into the runtime image.
# `bash bin/smoke-test-router.sh --profile prod` shells into this container via
# `docker compose exec router curl ...` to probe /healthz, /readyz, /v1/models, etc.
# from inside the network — the prod profile drops the host port (Plan 06-02), so a
# container-side probe is the only path. Without curl baked in, --profile prod
# fails with "curl: not found" at the first probe. --no-install-recommends keeps
# the image lean (~+3 MB). apt-list cleanup avoids retaining the package index.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
# Phase 20 (v0.12.0 — OPS-02): ARG at runtime-stage top so the ENV below sees them.
# Docker ARG scope is per-stage; declaring here (NOT inheriting from a global)
# keeps each stage's contract self-contained.
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV NODE_ENV=production
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME
# Copy compiled output + production-only deps
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
# Drizzle migration SQL + journal — runMigrations() reads ./db/migrations at boot.
COPY db ./db
# The bind-mounted models.yaml lands at /app/models.yaml at runtime per
# compose.yml; the file does NOT need to be baked into the image.
EXPOSE 3000
# Use exec form so signals reach node directly (graceful shutdown).
ENTRYPOINT ["node", "dist/index.js"]
