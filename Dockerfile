# RecruitersOS production image
# Builds the Next.js app in integration/ (which also serves the marketing
# pages + portal from public/ via the prebuild sync) and runs it on :3000.
FROM node:22-alpine AS build
WORKDIR /app

# Don't let Playwright's postinstall download its (glibc) browser — on Alpine we use the
# musl-native system Chromium at runtime instead (see the runtime stage).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install deps first for layer caching
COPY integration/package.json integration/package-lock.json integration/
RUN cd integration && npm ci

# Copy the rest of the repo (html + assets are needed by the prebuild sync)
COPY . .

# Build (prebuild copies ../*.html and ../assets into integration/public)
#
# The dependency gate runs AFTER `npm prune --omit=dev` on purpose: pruning is the
# step that removes packages, so checking before it proves nothing. It fails the
# build if the compiled server requires a package that is not in the node_modules
# we are about to ship. That is the exact shape of the 2026-07-30 outage, where an
# undeclared `undici` import built fine, got pruned, and then 500'd 157 routes
# (JD Sourcing included) on their first request with a clean-looking image.
RUN cd integration && npm run build && npm prune --omit=dev \
 && node scripts/check-bundle-deps.mjs

# ---- runtime image ----
FROM node:22-alpine
WORKDIR /app/integration
ENV NODE_ENV=production
ENV PORT=3000

# Runtime deps for the hiring-signal video pipeline:
#  - ffmpeg: the PiP compositor + MP4/GIF/teaser encoder (lib/inmarket/roleVideo + roleShot).
#  - chromium (+ font/lib deps): the page-scroll CAPTURE (Playwright). On Alpine/musl, Playwright's
#    own download won't run, so we install the system Chromium and point Playwright at it below.
RUN apk add --no-cache ffmpeg chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium-browser

COPY --from=build /app/integration/.next ./.next
COPY --from=build /app/integration/public ./public
COPY --from=build /app/integration/node_modules ./node_modules
COPY --from=build /app/integration/package.json ./package.json
COPY --from=build /app/integration/next.config.js ./next.config.js

EXPOSE 3000
# --keepAliveTimeout: Node closes an idle connection after 5s by default, while the
# edge pools and reuses upstream connections. When the edge picks a socket in the
# instant Node is closing it, the request dies with "connection reset by peer" and
# the recruiter gets a 502 from a server that never faulted. The Caddyfile now
# releases pooled connections after 2s, and this raises our side to 45s: the app
# holds every socket the edge could still reach, by a margin no scheduling jitter
# closes. (Stays under Node's 60s headersTimeout, which must remain the longer of
# the two.)
CMD ["npx", "next", "start", "-p", "3000", "--keepAliveTimeout", "45000"]
