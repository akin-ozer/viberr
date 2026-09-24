# syntax=docker/dockerfile:1

# Ruling 460's numbers, declared once for the two stages that use them: the
# launcher compiles them in, the runtime stage creates the group and the data
# root. `agent-isolation.server.ts` holds the same three numbers and
# `agent-isolation.server.test.ts` pins them against these defaults.
ARG VIBERR_AGENT_UID_FLOOR=20001
ARG VIBERR_AGENT_UID_MAX=59999
ARG VIBERR_AGENT_GID=20000
ARG VIBERR_DATA_ROOT=/data

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
# The agent launcher (ruling 460) — see "every agent process runs as its
# person's own OS user" in the runtime stage for what it is.
#
# Its own stage because the runtime stage carries no compiler: the slim base
# has none, and none of the runtime packages pulls one in. (The ruling's spec
# said gcc was already in the final stage; it was, in an image built on an
# older base, and the current base does not have it — measured 2026-09-24.)
# Same base image as the runtime stage, so the binary links against exactly
# the glibc it runs on. The layer is keyed on the one C file, so it rebuilds
# only when the launcher changes, in parallel with the app build.
# ============================================================================
FROM node:26-slim AS launcher

ARG VIBERR_AGENT_UID_FLOOR
ARG VIBERR_AGENT_UID_MAX
ARG VIBERR_AGENT_GID
ARG VIBERR_DATA_ROOT

# hadolint ignore=DL3008
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && node -p 'require("tls").rootCertificates.join(require("os").EOL)' > /tmp/node-roots.pem \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem update \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* /tmp/node-roots.pem

COPY tools/viberr-launch/viberr-launch.c /src/viberr-launch.c
# The uid range, the agent gid, the server's ids and the data root are
# compiled in: the binary is setuid root and reads none of them from the
# environment it is handed.
RUN mkdir -p /out \
    && gcc -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
        -fPIE -pie -Wl,-z,relro,-z,now \
        -DAGENT_UID_FLOOR="${VIBERR_AGENT_UID_FLOOR}" -DAGENT_UID_MAX="${VIBERR_AGENT_UID_MAX}" \
        -DAGENT_GID="${VIBERR_AGENT_GID}" -DSERVER_UID="$(id -u node)" -DSERVER_GID="$(id -g node)" \
        -DDATA_ROOT="\"${VIBERR_DATA_ROOT}\"" \
        -o /out/viberr-launch /src/viberr-launch.c

# ============================================================================
# Runtime stage.
# ============================================================================
FROM node:26-slim

# Real agent runs (Claude Agent SDK / Codex SDK) execute against a repo:
# the specialist run clones it and the coding agent shells out to git, so the
# runtime needs git + a CA bundle for HTTPS to github.com and the model APIs.
# (The SDKs' own native binaries are already inside node_modules from the
# linux `npm ci` in the build stage.)
#
# APT OVER HTTPS, from the first fetch. The base image names its mirror as
# `http://deb.debian.org`, and on a connection that shapes port 80 the three
# apt layers of this stage crawl. Measured 2026-09-20 on the owner's
# connection: 20–50 KB/s over plain HTTP to every Debian mirror tried, 3.6 MB/s
# to the SAME host over HTTPS. The 9.6 MB package index alone took three
# minutes, the chromium closure below would have taken hours, and a
# `docker compose up -d --build` was cancelled at 2m49s looking hung. The
# layer cache hides this until it is cold (a fresh machine, a builder prune, a
# base-image bump), which is exactly when it surfaces as "the build hangs".
#
# apt has spoken HTTPS natively since 1.5, but the slim image ships no CA
# bundle — `ca-certificates` is one of the two packages this layer installs —
# so the first fetch has nothing to trust the mirror with. Node does: its
# binary embeds Mozilla's root store (`tls.rootCertificates`), written out
# here as the trust anchor for THIS layer's two apt calls only
# (`Acquire::https::CaInfo`). The `ca-certificates` install creates the
# system store, every later apt call uses that, and the bootstrap file goes
# out with the lists. Integrity was never the question — every package is
# signature-checked over either transport; throughput was.
# hadolint ignore=DL3008
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && node -p 'require("tls").rootCertificates.join(require("os").EOL)' > /tmp/node-roots.pem \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem update \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/node-roots.pem

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
# /data/runtimes/users/<userId>/{claude-home,codex-home}, owned by that
# person's agent uid (ruling 460), so they survive container restarts and a
# `docker compose up --build`. There is no image-level backend credential and
# no shared runtime home: a run gets the home and key of the ONE person it
# bills. The launcher is compiled against the same root (the global ARG).
ARG VIBERR_DATA_ROOT
ENV VIBERR_DATA_ROOT=$VIBERR_DATA_ROOT
# uv's package cache and its managed CPython, on the same volume for the same
# reason: both default under $HOME, which is container-local, so every
# `docker compose up` after a recreate would re-download an interpreter and
# every package before the first Python MCP server could answer.
ENV UV_CACHE_DIR=/data/runtimes/uv-cache
ENV UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python
ENV PORT=3000

# Ruling 460: every agent process runs as its person's own OS user.
#
# Before it, the server (`node`) spawned every Claude and Codex CLI as `node`
# too, so a run's shell could read the server's /proc/<pid>/environ (the
# secret-encryption key, the session secret), the projection database and every
# other person's sign-in. Now each person gets a stable uid from
# VIBERR_AGENT_UID_FLOOR up (`agent_os_users`), every agent shares the primary
# group `viberr-agents`, and `node` is a supplementary member of that group, so
# the server reads and writes what agents share (workspaces, attachments, the uv
# caches) while an agent reaches nothing of the server's and nothing of another
# person's home.
#
# The one privileged step is `viberr-launch` (tools/viberr-launch/viberr-launch.c,
# built in the `launcher` stage above): root:node 4750, so only root and the
# server's group can execute it — agents are not in group `node`.
#
# `safe.directory=*` and `core.sharedRepository=group` go in the SYSTEM git
# config: git refuses a repository another uid owns ("dubious ownership"), and a
# workspace is cloned by the server and edited by agents. /etc/gitconfig is
# root-owned, so no agent can change it, and it binds every git invocation —
# the server's, an agent's shell, a tool that clears its environment — where
# an environment variable would reach only the processes it was passed to.
ARG VIBERR_AGENT_GID
COPY --from=launcher /out/viberr-launch /usr/local/libexec/viberr-launch
RUN groupadd --gid "${VIBERR_AGENT_GID}" viberr-agents \
    && usermod --append --groups viberr-agents node \
    && git config --system safe.directory '*' \
    && git config --system core.sharedRepository group \
    && chown root:node /usr/local/libexec/viberr-launch \
    && chmod 4750 /usr/local/libexec/viberr-launch

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

# The data root: the server's, traversable by the agent group and by nobody
# else (ruling 460). A NAMED volume mounted here is initialised from this
# directory, ownership and mode included; compose.yml mounts one
# (`viberr-data`), because a macOS bind mount does not enforce file permissions
# between uids at all (measured: uid 65534 read a 0600 file owned by 1000).
# The server re-asserts the layout below it on every boot.
RUN mkdir -p /data && chown node:viberr-agents /data && chmod 0750 /data

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
