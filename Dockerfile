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
RUN cd integration && npm run build && npm prune --omit=dev

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
CMD ["npx", "next", "start", "-p", "3000"]
