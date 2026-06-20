# RecruitersOS production image
# Builds the Next.js app in integration/ (which also serves the marketing
# pages + portal from public/ via the prebuild sync) and runs it on :3000.
FROM node:22-alpine AS build
WORKDIR /app

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

# ffmpeg powers the picture-in-picture role-video compositor (lib/inmarket/roleVideo.ts):
# it overlays the recorded webcam clip onto the page-scroll capture and emits the MP4 + GIF.
RUN apk add --no-cache ffmpeg

COPY --from=build /app/integration/.next ./.next
COPY --from=build /app/integration/public ./public
COPY --from=build /app/integration/node_modules ./node_modules
COPY --from=build /app/integration/package.json ./package.json
COPY --from=build /app/integration/next.config.js ./next.config.js

EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
