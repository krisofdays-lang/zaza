# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build producing a small, self-contained Next.js runtime image.
# Uses Next's "standalone" output so the final image carries only the server
# bundle + the node_modules it actually needs.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
# libc6-compat keeps some native deps (e.g. the pg driver) happy on Alpine.
# fontconfig + a sans font are required by sharp/librsvg to render the text in
# baked story link stickers — without a font the pill text comes out blank.
RUN apk add --no-cache libc6-compat fontconfig ttf-dejavu \
  && fc-cache -f
# Enable corepack; it reads the "packageManager" field in package.json and
# pulls that exact pnpm version (no interactive download prompt in CI).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- deps: install all dependencies against the lockfile ----
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# ---- gobuilder: compile the uTLS TLS-fingerprint sidecar ----
# A tiny Go forward-proxy (tls-proxy/) gives the Node app a byte-controllable
# TLS/JA4 + HTTP/2 fingerprint when talking to Instagram. `go mod tidy` resolves
# and pins deps (utls, x/net) during the build, which has network access.
FROM golang:1.24-alpine AS gobuilder
WORKDIR /src
COPY tls-proxy/ ./
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /igtlsproxy .

# ---- builder: compile the Next.js app ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# sharp's native addon loads libvips via dlopen from a separate platform
# package (@img/sharp-libvips-linuxmusl-x64). Next's standalone tracing can't
# follow a dlopen, so that shared library never makes it into the standalone
# output. Stage the whole libvips lib dir (the .so + its bundled glib) into a
# fixed location so the runner can put it on the loader path. The shell expands
# the pnpm version-hashed path here.
# Use -RL (recursive, dereference) rather than -a: pnpm stores files as
# hardlinks into its global store, and -a tries to recreate those hardlinks at
# the destination which fails ("can't create link"). -L copies real file
# contents instead.
RUN mkdir -p /sharp-libvips \
  && cp -RL node_modules/.pnpm/@img+sharp-libvips-linuxmusl-x64@*/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/. /sharp-libvips/

# ---- runner: minimal production image ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Media is stored on a mounted volume so uploads survive rebuilds.
ENV MEDIA_ROOT=/data/media

# Python runtime for the FastAPI Instagram request service (backend/). ffmpeg is
# used for best-effort reel cover-frame extraction. The service runs in-process
# on loopback and egresses through the same uTLS sidecar as the Node app.
RUN apk add --no-cache python3 py3-pip ffmpeg

# Install the Python service dependencies into a venv (Alpine's Python is
# externally-managed, so a venv avoids the PEP 668 block and keeps them isolated).
ENV IG_PY_VENV=/opt/ig-backend-venv
COPY backend/requirements.txt /tmp/ig-requirements.txt
RUN python3 -m venv "$IG_PY_VENV" \
  && "$IG_PY_VENV/bin/pip" install --no-cache-dir -r /tmp/ig-requirements.txt

# Run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server + static assets + public files. Next traces every module
# the app actually imports (including the pg driver) into .next/standalone, so
# we don't need to hand-copy node_modules.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy the bootstrap script explicitly (don't rely on Next's tracing to include
# it). It resolves the pg driver from the standalone node_modules above.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# libvips shared library for sharp (see the builder stage). Placed on the
# loader search path so sharp's native addon resolves libvips-cpp.so at runtime.
COPY --from=builder /sharp-libvips /usr/local/lib/sharp-libvips
ENV LD_LIBRARY_PATH=/usr/local/lib/sharp-libvips

# uTLS fingerprint sidecar binary (see the gobuilder stage). The entrypoint
# launches it on loopback and points the Node app at it via TLS_PROXY_URL.
COPY --from=gobuilder --chown=nextjs:nodejs /igtlsproxy ./igtlsproxy

# FastAPI Instagram request service. The entrypoint launches uvicorn on loopback
# and Next.js reaches it via IG_SERVICE_URL. It shares the sidecar via TLS_PROXY_URL.
COPY --chown=nextjs:nodejs backend ./backend

# Entrypoint runs the idempotent DB bootstrap script before the server.
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh \
  && mkdir -p /data/media \
  && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
