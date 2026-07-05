# syntax=docker/dockerfile:1

# ============================================================================
# Build stage — install all deps (better-sqlite3 downloads a prebuilt binary
# for this base; the toolchain below is the fallback if that ever fails),
# compile the app, then prune node_modules down to production deps.
# ============================================================================
FROM node:22-slim AS build

# Native-module fallback toolchain (better-sqlite3 uses prebuild-install and
# normally never compiles; python3/make/g++ keep `npm ci` working when a
# prebuilt binary is unavailable for a future Node/platform combination).
# Distro-current toolchain: pinning apt versions (DL3008) breaks the build on
# every debian point release for zero reproducibility gain — the compiled
# artifact is governed by package-lock.json.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

# ============================================================================
# Runtime stage — same base as the build stage so the better-sqlite3 binary
# copied inside node_modules keeps working (same libc, same Node ABI).
# ============================================================================
FROM node:22-slim

# Real agent runs (Claude Agent SDK / Codex SDK) execute against a repo:
# the specialist run clones it and the coding agent shells out to git, so the
# runtime needs git + a CA bundle for HTTPS to github.com and the model APIs.
# (The SDKs' own native binaries are already inside node_modules from the
# linux `npm ci` in the build stage.)
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Canonical file store + SQLite projections live here; compose mounts a
# host directory (or named volume) at this path.
ENV VIBERR_DATA_ROOT=/data
# Persist Claude Agent SDK sessions on the data volume so resuming an agent
# (commenting on a task) survives container restarts.
ENV CLAUDE_CONFIG_DIR=/data/runtimes/claude-home
ENV PORT=3000

WORKDIR /app

# Production node_modules (native modules included) + built app.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# SQL migrations are applied automatically at boot (resolved from the
# working directory), and the ops scripts (`npm run migrate|seed|rescan`)
# need the migration files + TypeScript sources to run via tsx inside the
# container (e.g. `docker compose exec app npm run seed`).
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/app ./app
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json

# Data root must exist and be writable by the non-root user.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

# react-router-serve honors $PORT (default above: 3000).
CMD ["npm", "run", "start"]
