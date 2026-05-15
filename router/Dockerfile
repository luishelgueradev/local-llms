# Phase 2 router image — D-A2 four-stage build.
# Stages: deps -> build -> prod-deps -> runtime
# Runtime base: node:22-bookworm-slim (CLAUDE.md/STATE.md anti-pattern list
# forbids alpine and floating tags — musl libc breaks native deps).

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
ENV NODE_ENV=production
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
