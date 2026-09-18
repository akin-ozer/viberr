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
# --foreground-scripts serializes install scripts. Without it a from-scratch
# install (changed lockfile and/or fresh base image, so no layer cache) can
# fail with ETXTBSY: esbuild's postinstall spawns its just-written binary for
# `--version` while overlayfs still counts a writer on it — observed live
# 2026-08-14 in this exact layer (esbuild rides the prod tree via tsx). The
# layer is lockfile-cached, so the serialization cost is paid only on real
# dependency changes.
RUN npm ci --omit=dev --foreground-scripts

# ============================================================================
# Build stage — the full tree (dev dependencies included) to compile the app.
# ============================================================================
FROM node:26-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Same ETXTBSY hardening as prod-deps above.
RUN npm ci --foreground-scripts

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

# Ruling 196 (owner, pass 37): the three an agent reaches for FIRST and cannot
# install for itself. Pass 37 measured the cost of their absence — 75
# `command not found` lines in a single pass, a monorepo committed around a
# package manager nothing here could run, a root Makefile whose every target
# exits 127, and a REQUIRED reviewer chartered to `make up` a stack, which
# could therefore never approve anything. Ruling 191 stopped agents
# rediscovering the gap one exit-127 at a time; this closes the part of it that
# is cheap to close.
#
# Docker is deliberately NOT here and is not coming from this ruling: an agent
# holding the daemon socket controls every container on the host, and
# docker-in-docker is a posture change that needs its own pass. A Compose stack
# still cannot come up in this image, and the shell inventory says so.
#
# pnpm comes from npm rather than corepack: Node unbundled corepack, and pass 37
# logged `corepack: command not found` beside the pnpm one. A pinned global
# install is one layer instead of a first-run download into a container-local
# cache. It is ONE version — a repository that pins a different one in
# `packageManager` reaches it with `npx pnpm@<version>`, which npm can do.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends make curl \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.4.1 && npm cache clean --force

# R19-19: agents get a real browser. Debian's chromium (~700MB installed with
# its dependency closure — the owner accepted the weight over a sidecar), driven
# by the @playwright/mcp server that ships in node_modules. The env var is how
# the mount builder finds it (`specialist-browser-mcp.server.ts`); when it is
# set the builder also passes --no-sandbox, because chromium's user-namespace
# sandbox cannot start under docker's default seccomp profile as a non-root
# user. Debian's package is used instead of `npx playwright install` for the
# same reason uv is copied above: a pinned binary in the image, not a first-run
# download into a container-local cache.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium

# STDIO MCP SERVERS. `specialist-mcp.server.ts` spawns a registered stdio
# server's command verbatim — there is no allow-list — so whatever the command
# names has to exist HERE. Node-based servers (`npx -y @modelcontextprotocol/
# server-…`) already worked because npx ships with the base image; the entire
# Python half of the ecosystem (`uvx mcp-server-…`) did not, and failed at
# registration with a bare ENOENT.
#
# uv is a single static binary and brings `uvx`, so this is two files rather
# than a Python toolchain: uv downloads and manages its own CPython on first
# use, which is also why a system python3 is deliberately NOT installed.
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /usr/local/bin/

# V11-9 (pass 32): build stamps for /resources/health and the boot integrity
# line (`build-info.server.ts` reads these first). Pass them at build time —
#   docker compose build --build-arg VIBERR_BUILD_SHA=$(git rev-parse HEAD) \
#     --build-arg VIBERR_BUILD_TIME=$(date -u +%FT%TZ)
# — or leave them empty: the image then falls back to package.json's version and
# reports a null revision, which the health endpoint says plainly.
ARG VIBERR_BUILD_VERSION=""
ARG VIBERR_BUILD_SHA=""
ARG VIBERR_BUILD_TIME=""
ENV VIBERR_BUILD_VERSION=$VIBERR_BUILD_VERSION
ENV VIBERR_BUILD_SHA=$VIBERR_BUILD_SHA
ENV VIBERR_BUILD_TIME=$VIBERR_BUILD_TIME
ENV NODE_ENV=production
# Canonical file store + SQLite projections live here; compose mounts a
# host directory (or named volume) at this path. Ruling 127: each person's own
# agent-backend sign-in and provider sessions live under
# /data/runtimes/users/<userId>/{claude-home,codex-home}, created 0o700 on
# demand, so they survive container restarts and a `docker compose up --build`.
# There is no image-level backend credential and no shared runtime home: a run
# gets the home and key of the ONE person it bills.
ENV VIBERR_DATA_ROOT=/data
# uv's package cache and its managed CPython, on the same volume for the same
# reason: both default under $HOME, which is container-local, so every
# `docker compose up` after a recreate would re-download an interpreter and
# every package before the first Python MCP server could answer.
ENV UV_CACHE_DIR=/data/runtimes/uv-cache
ENV UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python
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
# NOTE: this only takes effect when /data is NOT bind-mounted. compose.yml
# mounts ./docker-data over it, and a bind mount shadows the image directory
# completely — the host path's ownership is what the container sees. See
# "First run" in docs/operations/deployment.md for the one-line host-side fix.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

# No ENTRYPOINT (ruling 127). There used to be one — `scripts/docker-entrypoint.sh`,
# which seeded a Codex CLI login from a read-only host mount into a shared
# $CODEX_HOME before exec'ing the CMD. Both the mount and the shared home are
# gone: a credential seeded by the image is a credential every person's runs
# bill to whoever owns it. People sign in for themselves on Profile → Agent
# accounts. With no entrypoint the CMD below is pid 1 directly, and compose's
# `init: true` reaps orphans.
#
# react-router-serve honors $PORT (default above: 3000).
#
# The server binary directly, NOT `npm run start`: with npm in between, npm is
# pid 1 and node is its child, and a `docker compose stop` SIGTERM never
# reaches node. That is not cosmetic — node's shutdown handler is what
# checkpoints the WAL and RELEASES the data-root writer lock (B-FD1), so an
# npm-wrapped server left a lock file behind on every stop and the next boot
# could refuse to start.
CMD ["node", "/app/node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]
