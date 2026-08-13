# syntax=docker/dockerfile:1

# ============================================================================
# Production dependency tree.
#
# Its own stage, keyed ONLY on the lockfile — which is the whole point. The
# runtime tree used to be produced by `npm ci && npm run build && npm prune
# --omit=dev` in the build stage, AFTER `COPY . .`, so every source edit
# re-ran the prune: ~150 seconds of rewriting a 900MB node_modules over the
# VM's filesystem, printing nothing while it worked. It reliably read as a
# hung build (it was not; it was silent).
#
# Installing the production tree directly removes the prune entirely. This
# layer now survives any source change, and buildkit runs it in PARALLEL with
# the build below, so an ordinary code change rebuilds in seconds.
# ============================================================================
FROM node:26-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ============================================================================
# Build stage — the full tree (dev dependencies included) to compile the app.
# ============================================================================
FROM node:26-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build --no-audit --no-fund

# ============================================================================
# Runtime stage.
# ============================================================================
FROM node:26-slim

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
# Keep Codex sessions and optional cached ChatGPT login on the same managed
# data volume; never import the host user's full ~/.codex directory.
ENV CODEX_HOME=/data/runtimes/codex-home
ENV PORT=3000

WORKDIR /app

# Production node_modules (native modules included) + built app. The tree comes
# from the prod-deps stage, which installed it directly — the build stage's
# tree still carries the dev dependencies it needed to compile.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

# SQL migrations are applied automatically at boot (resolved from the
# working directory), and the ops scripts (`npm run seed|rescan`)
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

# Seeds the Codex CLI login from the optional read-only host mount into the
# writable $CODEX_HOME when the volume lacks it (see the script's rationale),
# then execs the CMD. `sh`-prefixed so the file's exec bit can't matter.
ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]

# react-router-serve honors $PORT (default above: 3000).
#
# The server binary directly, NOT `npm run start`: with npm in between, npm is
# pid 1 and node is its child, and a `docker compose stop` SIGTERM never
# reaches node. That is not cosmetic — node's shutdown handler is what
# checkpoints the WAL and RELEASES the data-root writer lock (B-FD1), so an
# npm-wrapped server left a lock file behind on every stop and the next boot
# could refuse to start. `exec` in the entrypoint makes this pid 1.
CMD ["node", "/app/node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]
